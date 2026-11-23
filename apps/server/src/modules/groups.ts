import { and, desc, eq, sql } from "drizzle-orm";
import {
  agents,
  groupMembers,
  type GroupMemberRow,
  type GroupRow,
  groups,
  type UserRow,
  users,
} from "@room/database";
import { newId } from "@room/protocol";
import {
  groupAISettingsSchema,
  groupRoleSchema,
  memberTypeSchema,
  type GroupAISettings,
} from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { recordAudit } from "./audit.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from "./errors.js";
import { appendEvent } from "./events.js";
import {
  assertKnownMember,
  requireActiveGroup,
  requireGroup,
  requireGroupManager,
  requireGroupMember,
  requireUser,
  requireWriteUser,
  validateTitle,
} from "./permissions.js";

export function createGroup(
  ctx: RoomContext,
  input: { name: string; description?: string | null; createdByUserId: string },
): GroupRow {
  const name = validateTitle(input.name, "name", 120);
  const creator = requireWriteUser(ctx.db, input.createdByUserId);
  const now = ctx.now();
  const groupId = newId("grp");
  const membershipId = newId("mem");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.insert(groups)
      .values({
        id: groupId,
        name,
        description: input.description ?? null,
        createdByUserId: creator.id,
        participationMode: "all",
        allowAgentMessages: true,
        maxHops: 4,
        maxRepliesPerRoot: 20,
        maxAgentMessagesPerMinute: 10,
        maxTokensPerRoot: null,
        systemPrompt: null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(groupMembers)
      .values({
        id: membershipId,
        groupId,
        memberType: "user",
        memberId: creator.id,
        memberRole: "owner",
        joinedAt: now,
      })
      .run();
    appendEvent(db, {
      type: "group.created",
      actor: { type: "user", id: creator.id },
      groupId,
      payload: { groupId, name },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: creator.id,
      action: "group.create",
      targetType: "group",
      targetId: groupId,
      metadata: { name },
      createdAt: now,
    });
    return db.select().from(groups).where(eq(groups.id, groupId)).get()!;
  });
}

export function getGroup(ctx: RoomContext, groupId: string): GroupRow {
  return requireGroup(ctx.db, groupId);
}

export function listGroupsForUser(
  ctx: RoomContext,
  input: { userId: string; limit?: number },
): GroupRow[] {
  requireUser(ctx.db, input.userId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return ctx.db
    .select({ group: groups })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.memberType, "user"), eq(groupMembers.memberId, input.userId)))
    .orderBy(desc(groups.createdAt))
    .limit(limit)
    .all()
    .map((row) => row.group);
}

export function addMember(
  ctx: RoomContext,
  input: {
    groupId: string;
    actorUserId: string;
    memberType: "user" | "agent";
    memberId: string;
    memberRole?: "owner" | "admin" | "member";
  },
): GroupMemberRow {
  requireGroupManager(ctx.db, input.groupId, { type: "user", id: input.actorUserId });
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, input.groupId);
  const memberType = memberTypeSchema.parse(input.memberType);
  const memberRole = groupRoleSchema.parse(input.memberRole ?? "member");
  if (memberType === "agent" && memberRole !== "member") {
    throw new ValidationError("agents can only be group members, not owners or admins");
  }
  assertKnownMember(ctx.db, input.groupId, memberType, input.memberId);
  const now = ctx.now();
  const id = newId("mem");
  try {
    return ctx.db.transaction((transaction) => {
      const db = transaction as unknown as RoomDb;
      db.insert(groupMembers)
        .values({
          id,
          groupId: input.groupId,
          memberType,
          memberId: input.memberId,
          memberRole,
          joinedAt: now,
        })
        .run();
      appendEvent(db, {
        type: "group.member_added",
        actor: { type: "user", id: input.actorUserId },
        groupId: input.groupId,
        payload: { memberType, memberId: input.memberId, memberRole },
        createdAt: now,
      });
      recordAudit(db, {
        actorType: "user",
        actorId: input.actorUserId,
        action: "group.member_add",
        targetType: "group",
        targetId: input.groupId,
        metadata: { memberType, memberId: input.memberId, memberRole },
        createdAt: now,
      });
      return db.select().from(groupMembers).where(eq(groupMembers.id, id)).get()!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`${memberType} ${input.memberId} is already a member`);
    }
    throw error;
  }
}

export function removeMember(
  ctx: RoomContext,
  input: { groupId: string; actorUserId: string; memberType: "user" | "agent"; memberId: string },
): void {
  requireGroupManager(ctx.db, input.groupId, { type: "user", id: input.actorUserId });
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, input.groupId);
  const memberType = memberTypeSchema.parse(input.memberType);
  const membership = ctx.db
    .select()
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, input.groupId),
        eq(groupMembers.memberType, memberType),
        eq(groupMembers.memberId, input.memberId),
      ),
    )
    .get();
  if (!membership) throw new NotFoundError("membership not found");
  if (memberType === "user" && membership.memberRole === "owner") {
    const otherOwner = ctx.db
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, input.groupId),
          eq(groupMembers.memberType, "user"),
          eq(groupMembers.memberRole, "owner"),
          sql`${groupMembers.id} <> ${membership.id}`,
        ),
      )
      .get();
    if (!otherOwner) throw new ConflictError("cannot remove the last group owner");
  }
  const now = ctx.now();
  ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.delete(groupMembers).where(eq(groupMembers.id, membership.id)).run();
    appendEvent(db, {
      type: "group.member_removed",
      actor: { type: "user", id: input.actorUserId },
      groupId: input.groupId,
      payload: { memberType, memberId: input.memberId },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "group.member_remove",
      targetType: "group",
      targetId: input.groupId,
      metadata: { memberType, memberId: input.memberId },
      createdAt: now,
    });
  });
}

export function updateGroupAISettings(
  ctx: RoomContext,
  input: { groupId: string; actorUserId: string; settings: GroupAISettings },
): GroupRow {
  requireGroupManager(ctx.db, input.groupId, { type: "user", id: input.actorUserId });
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, input.groupId);
  const settings = groupAISettingsSchema.parse(input.settings);
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(groups)
      .set({
        participationMode: settings.participationMode,
        allowAgentMessages: settings.allowAgentMessages,
        maxHops: settings.maxHops,
        maxRepliesPerRoot: settings.maxRepliesPerRoot,
        maxAgentMessagesPerMinute: settings.maxAgentMessagesPerMinute,
        maxTokensPerRoot: settings.maxTokensPerRoot ?? null,
        updatedAt: now,
      })
      .where(eq(groups.id, input.groupId))
      .run();
    appendEvent(db, {
      type: "group.updated",
      actor: { type: "user", id: input.actorUserId },
      groupId: input.groupId,
      payload: { settings },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "group.settings_update",
      targetType: "group",
      targetId: input.groupId,
      metadata: { settings },
      createdAt: now,
    });
    return db.select().from(groups).where(eq(groups.id, input.groupId)).get()!;
  });
}

export function requireGroupAccess(ctx: RoomContext, groupId: string, userId: string): UserRow[] {
  const group = requireActiveGroup(ctx.db, groupId);
  requireGroupMember(ctx.db, groupId, { type: "user", id: userId });
  if (group.status !== "active") throw new ForbiddenError("group is archived");
  return [];
}

export function listGroupMembers(
  ctx: RoomContext,
  input: { groupId: string; viewerUserId: string; limit?: number },
): GroupMemberRow[] {
  requireGroupMember(ctx.db, input.groupId, { type: "user", id: input.viewerUserId });
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  return ctx.db
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.groupId, input.groupId))
    .orderBy(groupMembers.joinedAt)
    .limit(limit)
    .all();
}

export function lookupAgentMembership(
  ctx: RoomContext,
  groupId: string,
  agentId: string,
): GroupMemberRow | undefined {
  return ctx.db
    .select()
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.memberType, "agent"),
        eq(groupMembers.memberId, agentId),
      ),
    )
    .get();
}

export function findAgent(ctx: RoomContext, agentId: string) {
  return ctx.db.select().from(agents).where(eq(agents.id, agentId)).get();
}

export function findUser(ctx: RoomContext, userId: string) {
  return ctx.db.select().from(users).where(eq(users.id, userId)).get();
}
