import { asc, eq } from "drizzle-orm";
import { type WorkspaceRow, workspaces } from "@room/database";
import { newId } from "@room/protocol";
import { recordAudit } from "./audit.js";
import type { RoomContext, RoomDb } from "./context.js";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from "./errors.js";
import {
  requireActiveGroup,
  requireGroupManager,
  requireGroupMember,
  requireWriteUser,
  validateTitle,
} from "./permissions.js";

export function createWorkspace(
  ctx: RoomContext,
  input: { groupId: string; actorUserId: string; name: string },
): WorkspaceRow {
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, input.groupId);
  requireGroupManager(ctx.db, input.groupId, { type: "user", id: input.actorUserId });
  const name = validateTitle(input.name, "name", 100);
  const now = ctx.now();
  const id = newId("wks");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    try {
      db.insert(workspaces)
        .values({
          id,
          groupId: input.groupId,
          name,
          createdByUserId: input.actorUserId,
          createdAt: now,
        })
        .run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`workspace ${name} already exists in group ${input.groupId}`);
      }
      throw error;
    }
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "workspace.create",
      targetType: "workspace",
      targetId: id,
      metadata: { groupId: input.groupId, name },
      createdAt: now,
    });
    return db.select().from(workspaces).where(eq(workspaces.id, id)).get()!;
  });
}

export function listWorkspaces(
  ctx: RoomContext,
  input: { groupId: string; viewerUserId: string },
): WorkspaceRow[] {
  requireGroupMember(ctx.db, input.groupId, { type: "user", id: input.viewerUserId });
  return ctx.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.groupId, input.groupId))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .all();
}

export function getWorkspaceRow(ctx: RoomContext, workspaceId: string): WorkspaceRow {
  const workspace = ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!workspace) throw new NotFoundError(`workspace ${workspaceId} not found`);
  return workspace;
}

export function getWorkspace(
  ctx: RoomContext,
  input: { workspaceId: string; viewerUserId: string },
): WorkspaceRow {
  const workspace = getWorkspaceRow(ctx, input.workspaceId);
  requireGroupMember(ctx.db, workspace.groupId, { type: "user", id: input.viewerUserId });
  return workspace;
}

/**
 * Resolve a task's workspace and enforce the group boundary. This is the single
 * policy check used by task creation; a task can never point at a workspace of
 * another group, and the server (not a plugin) owns the check.
 */
export function workspaceForTask(
  ctx: RoomContext,
  input: { workspaceId: string; groupId: string },
): WorkspaceRow {
  const workspace = getWorkspaceRow(ctx, input.workspaceId);
  if (workspace.groupId !== input.groupId) {
    throw new ValidationError("workspace belongs to a different group");
  }
  return workspace;
}
