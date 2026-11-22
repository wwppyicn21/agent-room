import { and, desc, eq } from "drizzle-orm";
import { threads, type ThreadRow } from "@room/database";
import { newId } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { recordAudit } from "./audit.js";
import { ForbiddenError, NotFoundError } from "./errors.js";
import { appendEvent } from "./events.js";
import { getGroupMessageRow } from "./messages.js";
import {
  type Actor,
  requireActiveGroup,
  requireGroupManager,
  requireGroupMember,
  validateTitle,
} from "./permissions.js";

export function createThread(
  ctx: RoomContext,
  input: {
    groupId: string;
    sourceMessageId: string;
    title: string;
    createdByUserId: string;
  },
): ThreadRow {
  requireActiveGroup(ctx.db, input.groupId);
  requireGroupMember(ctx.db, input.groupId, { type: "user", id: input.createdByUserId });
  getGroupMessageRow(ctx, input.groupId, input.sourceMessageId);
  const title = validateTitle(input.title, "title");
  const now = ctx.now();
  const id = newId("thr");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.insert(threads)
      .values({
        id,
        groupId: input.groupId,
        sourceMessageId: input.sourceMessageId,
        title,
        status: "open",
        createdByUserId: input.createdByUserId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    appendEvent(db, {
      type: "thread.created",
      actor: { type: "user", id: input.createdByUserId },
      groupId: input.groupId,
      threadId: id,
      payload: { threadId: id, sourceMessageId: input.sourceMessageId, title },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.createdByUserId,
      action: "thread.create",
      targetType: "thread",
      targetId: id,
      metadata: { groupId: input.groupId, sourceMessageId: input.sourceMessageId },
      createdAt: now,
    });
    return db.select().from(threads).where(eq(threads.id, id)).get()!;
  });
}

export function getThread(ctx: RoomContext, input: { threadId: string; viewer: Actor }): ThreadRow {
  const thread = ctx.db.select().from(threads).where(eq(threads.id, input.threadId)).get();
  if (!thread) throw new NotFoundError(`thread ${input.threadId} not found`);
  requireGroupMember(ctx.db, thread.groupId, input.viewer);
  return thread;
}

export function listThreads(
  ctx: RoomContext,
  input: { groupId: string; viewer: Actor; limit?: number },
): ThreadRow[] {
  requireGroupMember(ctx.db, input.groupId, input.viewer);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return ctx.db
    .select()
    .from(threads)
    .where(eq(threads.groupId, input.groupId))
    .orderBy(desc(threads.createdAt), desc(threads.id))
    .limit(limit)
    .all();
}

export function closeThread(
  ctx: RoomContext,
  input: { threadId: string; actorUserId: string },
): ThreadRow {
  const thread = getThread(ctx, {
    threadId: input.threadId,
    viewer: { type: "user", id: input.actorUserId },
  });
  if (thread.status === "closed") return thread;
  const isCreator = thread.createdByUserId === input.actorUserId;
  if (!isCreator) {
    requireGroupManager(ctx.db, thread.groupId, { type: "user", id: input.actorUserId });
  }
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(threads)
      .set({ status: "closed", closedAt: now, updatedAt: now })
      .where(eq(threads.id, thread.id))
      .run();
    appendEvent(db, {
      type: "thread.closed",
      actor: { type: "user", id: input.actorUserId },
      groupId: thread.groupId,
      threadId: thread.id,
      payload: { threadId: thread.id },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "thread.close",
      targetType: "thread",
      targetId: thread.id,
      metadata: { groupId: thread.groupId },
      createdAt: now,
    });
    return db.select().from(threads).where(eq(threads.id, thread.id)).get()!;
  });
}

export function findOpenThreadForSource(
  ctx: RoomContext,
  groupId: string,
  sourceMessageId: string,
): ThreadRow | undefined {
  return ctx.db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.groupId, groupId),
        eq(threads.sourceMessageId, sourceMessageId),
        eq(threads.status, "open"),
      ),
    )
    .get();
}

export function assertThreadInGroup(thread: ThreadRow, groupId: string): void {
  if (thread.groupId !== groupId) throw new ForbiddenError("thread belongs to a different group");
}
