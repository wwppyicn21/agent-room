import { and, desc, eq, ne } from "drizzle-orm";
import { externalIdentities, type ExternalIdentityRow, users, type UserRow } from "@room/database";
import { newId } from "@room/protocol";
import { rbacRoleSchema, type RbacRole } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from "./errors.js";
import { recordAudit } from "./audit.js";
import { appendEvent } from "./events.js";
import { requireSystemAdmin, requireUser } from "./permissions.js";

export function createUser(
  ctx: RoomContext,
  input: { displayName: string; email?: string | null; role?: RbacRole; actorUserId?: string },
): UserRow {
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 120) {
    throw new ValidationError("displayName must be 1-120 characters");
  }
  const hasUsers = ctx.db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
  const role = rbacRoleSchema.parse(input.role ?? (hasUsers ? "member" : "owner"));
  if (!hasUsers) {
    // The very first user is the bootstrap owner and cannot be created by anybody.
    if (input.actorUserId !== undefined) {
      throw new ValidationError("cannot pass actorUserId when creating the bootstrap owner");
    }
    if (role !== "owner") {
      throw new ValidationError("the bootstrap user must have the owner role");
    }
  } else {
    if (!input.actorUserId) {
      throw new ForbiddenError("actorUserId is required to create a user");
    }
    const actor = requireSystemAdmin(ctx.db, input.actorUserId);
    if ((role === "owner" || role === "admin") && actor.role !== "owner") {
      throw new ForbiddenError("only the owner can create owners or admins");
    }
  }
  const now = ctx.now();
  const id = newId("usr");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.insert(users)
      .values({
        id,
        displayName,
        email: input.email ?? null,
        role,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    appendEvent(db, {
      type: "user.created",
      actor: { type: "system", id: "system" },
      payload: { userId: id, role },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: input.actorUserId ? "user" : "system",
      actorId: input.actorUserId ?? "system",
      action: "user.create",
      targetType: "user",
      targetId: id,
      metadata: { role },
      createdAt: now,
    });
    return db.select().from(users).where(eq(users.id, id)).get()!;
  });
}

export function getUser(ctx: RoomContext, userId: string): UserRow {
  return requireUser(ctx.db, userId);
}

export function listUsers(
  ctx: RoomContext,
  input: { actorUserId: string; limit?: number },
): UserRow[] {
  requireSystemAdmin(ctx.db, input.actorUserId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return ctx.db.select().from(users).orderBy(desc(users.createdAt)).limit(limit).all();
}

export function setUserRole(
  ctx: RoomContext,
  input: { userId: string; role: RbacRole; actorUserId: string },
): UserRow {
  const actor = requireSystemAdmin(ctx.db, input.actorUserId);
  const role = rbacRoleSchema.parse(input.role);
  const target = requireUser(ctx.db, input.userId);
  // Only the owner may hand out or take away owner/admin roles.
  if (
    (role === "owner" || role === "admin" || target.role === "owner" || target.role === "admin") &&
    actor.role !== "owner"
  ) {
    throw new ForbiddenError("only the owner can change owner or admin roles");
  }
  if (target.role === "owner" && role !== "owner") {
    assertAnotherActiveOwner(ctx.db, target.id);
  }
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(users).set({ role, updatedAt: now }).where(eq(users.id, target.id)).run();
    appendEvent(db, {
      type: "user.role_changed",
      actor: { type: "user", id: input.actorUserId },
      payload: { userId: target.id, from: target.role, to: role },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "user.role_change",
      targetType: "user",
      targetId: target.id,
      metadata: { from: target.role, to: role },
      createdAt: now,
    });
    return db.select().from(users).where(eq(users.id, target.id)).get()!;
  });
}

export function disableUser(
  ctx: RoomContext,
  input: { userId: string; actorUserId: string },
): UserRow {
  const actor = requireSystemAdmin(ctx.db, input.actorUserId);
  const target = requireUser(ctx.db, input.userId);
  if ((target.role === "owner" || target.role === "admin") && actor.role !== "owner") {
    throw new ForbiddenError("only the owner can disable owners or admins");
  }
  if (target.role === "owner") assertAnotherActiveOwner(ctx.db, target.id);
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(users)
      .set({ status: "disabled", updatedAt: now })
      .where(eq(users.id, target.id))
      .run();
    appendEvent(db, {
      type: "user.disabled",
      actor: { type: "user", id: input.actorUserId },
      payload: { userId: target.id },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "user.disable",
      targetType: "user",
      targetId: target.id,
      createdAt: now,
    });
    return db.select().from(users).where(eq(users.id, target.id)).get()!;
  });
}

export function linkExternalIdentity(
  ctx: RoomContext,
  input: { userId: string; issuer: string; subject: string; email?: string | null },
): ExternalIdentityRow {
  requireUser(ctx.db, input.userId);
  const issuer = input.issuer.trim();
  const subject = input.subject.trim();
  if (issuer.length === 0 || subject.length === 0) {
    throw new ValidationError("issuer and subject must not be empty");
  }
  const now = ctx.now();
  const id = newId("ext");
  try {
    return ctx.db.transaction((transaction) => {
      const db = transaction as unknown as RoomDb;
      db.insert(externalIdentities)
        .values({
          id,
          userId: input.userId,
          issuer,
          subject,
          email: input.email ?? null,
          createdAt: now,
        })
        .run();
      appendEvent(db, {
        type: "identity.linked",
        actor: { type: "system", id: "system" },
        payload: { identityId: id, userId: input.userId, issuer, subject },
        createdAt: now,
      });
      recordAudit(db, {
        actorType: "system",
        actorId: "system",
        action: "identity.link",
        targetType: "user",
        targetId: input.userId,
        metadata: { issuer, subject },
        createdAt: now,
      });
      return db.select().from(externalIdentities).where(eq(externalIdentities.id, id)).get()!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`external identity ${issuer}/${subject} is already linked`);
    }
    throw error;
  }
}

export function findUserByExternalIdentity(
  ctx: RoomContext,
  input: { issuer: string; subject: string },
): UserRow | undefined {
  const identity = ctx.db
    .select()
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.issuer, input.issuer),
        eq(externalIdentities.subject, input.subject),
      ),
    )
    .get();
  if (!identity) return undefined;
  return ctx.db.select().from(users).where(eq(users.id, identity.userId)).get();
}

function assertAnotherActiveOwner(db: RoomDb, excludingUserId: string): void {
  const other = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "owner"), eq(users.status, "active"), ne(users.id, excludingUserId)))
    .get();
  if (!other) {
    throw new ConflictError("cannot remove the last active owner");
  }
}

export function requireExistingUser(ctx: RoomContext, userId: string): UserRow {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new NotFoundError(`user ${userId} not found`);
  return user;
}
