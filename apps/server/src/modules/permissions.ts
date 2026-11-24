import { and, eq } from "drizzle-orm";
import {
  agents,
  type AgentRow,
  groupMembers,
  type GroupMemberRow,
  groups,
  type GroupRow,
  type UserRow,
  users,
} from "@room/database";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import type { RoomDb } from "./context.js";

export interface UserActor {
  readonly type: "user";
  readonly id: string;
}

export interface AgentActor {
  readonly type: "agent";
  readonly id: string;
}

export type Actor = UserActor | AgentActor;

export function userActor(id: string): UserActor {
  return { type: "user", id };
}

export function agentActor(id: string): AgentActor {
  return { type: "agent", id };
}

export function isSystemAdmin(user: UserRow): boolean {
  return user.role === "owner" || user.role === "admin";
}

export function requireUser(db: RoomDb, userId: string): UserRow {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new NotFoundError(`user ${userId} not found`);
  if (user.status !== "active") throw new ForbiddenError(`user ${userId} is disabled`);
  return user;
}

export function requireAgent(db: RoomDb, agentId: string): AgentRow {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent) throw new NotFoundError(`agent ${agentId} not found`);
  if (agent.status === "disabled") throw new ForbiddenError(`agent ${agentId} is disabled`);
  return agent;
}

export function requireActor(db: RoomDb, actor: Actor): UserRow | AgentRow {
  return actor.type === "user" ? requireUser(db, actor.id) : requireAgent(db, actor.id);
}

export function requireSystemAdmin(db: RoomDb, userId: string): UserRow {
  const user = requireUser(db, userId);
  if (!isSystemAdmin(user)) {
    throw new ForbiddenError(`user ${userId} is not an owner or admin`);
  }
  return user;
}

export function requireOwner(db: RoomDb, userId: string): UserRow {
  const user = requireUser(db, userId);
  if (user.role !== "owner") {
    throw new ForbiddenError(`user ${userId} is not the system owner`);
  }
  return user;
}

/** Readonly users keep read access but may never write. */
export function requireWriteUser(db: RoomDb, userId: string): UserRow {
  const user = requireUser(db, userId);
  if (user.role === "readonly") {
    throw new ForbiddenError(`user ${userId} is readonly`);
  }
  return user;
}

export function requireWritableActor(db: RoomDb, actor: Actor): UserRow | AgentRow {
  return actor.type === "user" ? requireWriteUser(db, actor.id) : requireAgent(db, actor.id);
}

export function requireGroup(db: RoomDb, groupId: string): GroupRow {
  const group = db.select().from(groups).where(eq(groups.id, groupId)).get();
  if (!group) throw new NotFoundError(`group ${groupId} not found`);
  return group;
}

export function requireActiveGroup(db: RoomDb, groupId: string): GroupRow {
  const group = requireGroup(db, groupId);
  if (group.status !== "active") throw new ForbiddenError(`group ${groupId} is archived`);
  return group;
}

export function isGroupMember(
  db: RoomDb,
  groupId: string,
  memberType: "user" | "agent",
  memberId: string,
): boolean {
  const membership = db
    .select({ id: groupMembers.id })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.memberType, memberType),
        eq(groupMembers.memberId, memberId),
      ),
    )
    .get();
  return membership !== undefined;
}

/** Membership is the authorization source; a Task assignment is not a standing grant. */
export function isAgentGroupMember(db: RoomDb, groupId: string, agentId: string): boolean {
  return isGroupMember(db, groupId, "agent", agentId);
}

export function requireGroupMember(db: RoomDb, groupId: string, actor: Actor): GroupMemberRow {
  requireGroup(db, groupId);
  requireActor(db, actor);
  const membership = db
    .select()
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.memberType, actor.type),
        eq(groupMembers.memberId, actor.id),
      ),
    )
    .get();
  if (!membership) {
    throw new ForbiddenError(`${actor.type} ${actor.id} is not a member of group ${groupId}`);
  }
  return membership;
}

/**
 * Group-level management (members, settings, thread closing) requires either a
 * system owner/admin or a group owner/admin. Message *reads* stay member-only.
 */
export function requireGroupManager(db: RoomDb, groupId: string, actor: Actor): void {
  if (actor.type === "agent") {
    throw new ForbiddenError("agents cannot manage groups");
  }
  requireGroup(db, groupId);
  const user = requireUser(db, actor.id);
  // System owners/admins manage any group, including groups they did not join.
  if (isSystemAdmin(user)) return;
  const membership = db
    .select()
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.memberType, "user"),
        eq(groupMembers.memberId, actor.id),
      ),
    )
    .get();
  if (!membership || (membership.memberRole !== "owner" && membership.memberRole !== "admin")) {
    throw new ForbiddenError(`user ${actor.id} cannot manage group ${groupId}`);
  }
}

export function validateTitle(value: string, field: string, max = 200): string {
  const title = value.trim();
  if (title.length === 0) throw new ValidationError(`${field} must not be empty`);
  if (title.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return title;
}

export function assertKnownMember(
  db: RoomDb,
  groupId: string,
  memberType: "user" | "agent",
  memberId: string,
): void {
  requireGroup(db, groupId);
  if (memberType === "user") requireUser(db, memberId);
  else requireAgent(db, memberId);
}
