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
import { cancelAgentTasksForGroupRemoval } from "./tasks.js";
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
import { appendEvent, revokeGroupAgentDeliveries } from "./events.js";
import {
  assertKnownMember,
  requireActiveGroup,
  requireGroup,
  requireGroupManager,
  requireGroupMember,
  requireAgent,
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

export function listGroupsForAgent(
  ctx: RoomContext,
  input: { agentId: string; limit?: number },
): GroupRow[] {
  requireAgent(ctx.db, input.agentId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return ctx.db
    .select({ group: groups })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.memberType, "agent"), eq(groupMembers.memberId, input.agentId)))
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

/** Changes a member's group role with last-owner and owner-only escalation guards. */
export function updateMemberRole(
  ctx: RoomContext,
  input: {
    groupId: string;
    actorUserId: string;
    memberType: "user" | "agent";
    memberId: string;
    memberRole: "owner" | "admin" | "member";
  },
): GroupMemberRow {
  requireGroupManager(ctx.db, input.groupId, { type: "user", id: input.actorUserId });
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, input.groupId);
  const memberType = memberTypeSchema.parse(input.memberType);
  const memberRole = groupRoleSchema.parse(input.memberRole);
  if (memberType === "agent" && memberRole !== "member") {
    throw new ValidationError("agents can only be group members, not owners or admins");
  }
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
  if (membership.memberRole === memberRole) return membership;

  if (memberRole === "owner" || membership.memberRole === "owner") {
    const actor = ctx.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, input.actorUserId))
      .get();
    const systemAdmin = actor?.role === "owner" || actor?.role === "admin";
    const actorMembership = ctx.db
      .select({ memberRole: groupMembers.memberRole })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, input.groupId),
          eq(groupMembers.memberType, "user"),
          eq(groupMembers.memberId, input.actorUserId),
        ),
      )
      .get();
    if (!systemAdmin && actorMembership?.memberRole !== "owner") {
      throw new ForbiddenError("only group owners can change the group owner role");
    }
  }

  if (membership.memberRole === "owner" && memberRole !== "owner") {
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
    if (!otherOwner) throw new ConflictError("cannot demote the last group owner");
  }

  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(groupMembers).set({ memberRole }).where(eq(groupMembers.id, membership.id)).run();
    appendEvent(db, {
      type: "group.member_updated",
      actor: { type: "user", id: input.actorUserId },
      groupId: input.groupId,
      payload: {
        memberType,
        memberId: input.memberId,
        previousRole: membership.memberRole,
        memberRole,
      },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "group.member_role",
      targetType: "group",
      targetId: input.groupId,
      metadata: {
        memberType,
        memberId: input.memberId,
        previousRole: membership.memberRole,
        memberRole,
      },
      createdAt: now,
    });
    return db.select().from(groupMembers).where(eq(groupMembers.id, membership.id)).get()!;
  });
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
    if (memberType === "agent") {
      cancelAgentTasksForGroupRemoval(db, {
        groupId: input.groupId,
        agentId: input.memberId,
        actorUserId: input.actorUserId,
        now,
      });
      revokeGroupAgentDeliveries(db, { agentId: input.memberId, groupId: input.groupId });
    }
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
  if (memberType === "user") {
    ctx.realtime?.revokeGroup(input.groupId, input.memberId, "membership_revoked");
  }
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

export function updateGroup(
  ctx: RoomContext,
  input: {
    groupId: string;
    actorUserId: string;
    name?: string;
    description?: string | null;
  },
): GroupRow {
  requireGroupManager(ctx.db, input.groupId, { type: "user", id: input.actorUserId });
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, input.groupId);
  const patch: { name?: string; description?: string | null; updatedAt: number } = {
    updatedAt: ctx.now(),
  };
  if (input.name !== undefined) patch.name = validateTitle(input.name, "name", 120);
  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    if (description && description.length > 2000) {
      throw new ValidationError("description must be at most 2000 characters");
    }
    patch.description = description;
  }
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(groups).set(patch).where(eq(groups.id, input.groupId)).run();
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "group.updated",
      targetType: "group",
      targetId: input.groupId,
      metadata: patch,
      createdAt: ctx.now(),
    });
    return db.select().from(groups).where(eq(groups.id, input.groupId)).get()!;
  });
}
