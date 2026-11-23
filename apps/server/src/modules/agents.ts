import { and, desc, eq } from "drizzle-orm";
import { agentKeys, type AgentKeyRow, type AgentRow, agents } from "@room/database";
import { newId } from "@room/protocol";
import { agentCapabilitiesSchema } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { recordAudit } from "./audit.js";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from "./errors.js";
import { appendEvent } from "./events.js";
import { normalizeEd25519PublicKey } from "./keys.js";
import { requireAgent, requireSystemAdmin, validateTitle } from "./permissions.js";

export function registerAgent(
  ctx: RoomContext,
  input: {
    displayName: string;
    runtime: string;
    model?: string | null;
    capabilities?: string[];
    hostId?: string | null;
    actorUserId: string;
  },
): AgentRow {
  requireSystemAdmin(ctx.db, input.actorUserId);
  const displayName = validateTitle(input.displayName, "displayName", 120);
  const runtime = validateTitle(input.runtime, "runtime", 60);
  const capabilities = agentCapabilitiesSchema.parse(input.capabilities ?? []);
  const now = ctx.now();
  const id = newId("agt");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.insert(agents)
      .values({
        id,
        displayName,
        hostId: input.hostId ?? null,
        runtime,
        model: input.model ?? null,
        capabilities: JSON.stringify(capabilities),
        status: "offline",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    appendEvent(db, {
      type: "agent.registered",
      actor: { type: "user", id: input.actorUserId },
      payload: { agentId: id, runtime },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "agent.register",
      targetType: "agent",
      targetId: id,
      metadata: { runtime },
      createdAt: now,
    });
    return db.select().from(agents).where(eq(agents.id, id)).get()!;
  });
}

export function getAgent(ctx: RoomContext, agentId: string): AgentRow {
  return requireAgent(ctx.db, agentId);
}

export function listAgents(
  ctx: RoomContext,
  input: { actorUserId: string; limit?: number },
): AgentRow[] {
  requireSystemAdmin(ctx.db, input.actorUserId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return ctx.db.select().from(agents).orderBy(desc(agents.createdAt)).limit(limit).all();
}

export function addAgentKey(
  ctx: RoomContext,
  input: {
    agentId: string;
    publicKey: string;
    fingerprint: string;
    algorithm?: string;
    actorUserId: string;
  },
): AgentKeyRow {
  requireSystemAdmin(ctx.db, input.actorUserId);
  requireAgent(ctx.db, input.agentId);
  const publicKey = input.publicKey.trim();
  const fingerprint = input.fingerprint.trim();
  if (publicKey.length === 0 || publicKey.length > 4096) {
    throw new ValidationError("publicKey must be 1-4096 characters");
  }
  if (fingerprint.length === 0 || fingerprint.length > 200) {
    throw new ValidationError("fingerprint must be 1-200 characters");
  }
  const now = ctx.now();
  const id = newId("key");
  try {
    return ctx.db.transaction((transaction) => {
      const db = transaction as unknown as RoomDb;
      db.insert(agentKeys)
        .values({
          id,
          agentId: input.agentId,
          publicKey,
          fingerprint,
          algorithm: input.algorithm ?? "ed25519",
          status: "active",
          createdAt: now,
        })
        .run();
      appendEvent(db, {
        type: "agent.key_registered",
        actor: { type: "user", id: input.actorUserId },
        payload: { agentId: input.agentId, fingerprint },
        createdAt: now,
      });
      recordAudit(db, {
        actorType: "user",
        actorId: input.actorUserId,
        action: "agent.key_register",
        targetType: "agent",
        targetId: input.agentId,
        metadata: { fingerprint },
        createdAt: now,
      });
      return db.select().from(agentKeys).where(eq(agentKeys.id, id)).get()!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`fingerprint ${fingerprint} is already registered`);
    }
    throw error;
  }
}

export function revokeAgentKey(
  ctx: RoomContext,
  input: { keyId: string; actorUserId: string },
): AgentKeyRow {
  requireSystemAdmin(ctx.db, input.actorUserId);
  const key = ctx.db.select().from(agentKeys).where(eq(agentKeys.id, input.keyId)).get();
  if (!key) throw new NotFoundError(`agent key ${input.keyId} not found`);
  if (key.status === "revoked") return key;
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(agentKeys)
      .set({ status: "revoked", revokedAt: now })
      .where(eq(agentKeys.id, key.id))
      .run();
    appendEvent(db, {
      type: "agent.key_revoked",
      actor: { type: "user", id: input.actorUserId },
      payload: { agentId: key.agentId, fingerprint: key.fingerprint },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "agent.key_revoke",
      targetType: "agent",
      targetId: key.agentId,
      metadata: { fingerprint: key.fingerprint },
      createdAt: now,
    });
    return db.select().from(agentKeys).where(eq(agentKeys.id, key.id)).get()!;
  });
}

export function listAgentKeys(
  ctx: RoomContext,
  input: { agentId: string; actorUserId: string },
): AgentKeyRow[] {
  requireSystemAdmin(ctx.db, input.actorUserId);
  requireAgent(ctx.db, input.agentId);
  return ctx.db
    .select()
    .from(agentKeys)
    .where(and(eq(agentKeys.agentId, input.agentId), eq(agentKeys.status, "active")))
    .orderBy(desc(agentKeys.createdAt))
    .all();
}

/**
 * Registers an agent and its first Ed25519 key in one transaction. The key is
 * normalized and its fingerprint derived here; the caller never supplies a
 * fingerprint (plan §8.4).
 */
export function registerAgentWithKey(
  ctx: RoomContext,
  input: {
    displayName: string;
    runtime: string;
    model?: string | null;
    capabilities?: string[];
    hostId?: string | null;
    publicKey: string;
    actorUserId: string;
  },
): { agent: AgentRow; key: AgentKeyRow } {
  requireSystemAdmin(ctx.db, input.actorUserId);
  const displayName = validateTitle(input.displayName, "displayName", 120);
  const runtime = validateTitle(input.runtime, "runtime", 60);
  const capabilities = agentCapabilitiesSchema.parse(input.capabilities ?? []);
  const normalized = normalizeEd25519PublicKey(input.publicKey);
  const now = ctx.now();
  const agentId = newId("agt");
  const keyId = newId("key");
  try {
    return ctx.db.transaction((transaction) => {
      const db = transaction as unknown as RoomDb;
      db.insert(agents)
        .values({
          id: agentId,
          displayName,
          hostId: input.hostId ?? null,
          runtime,
          model: input.model ?? null,
          capabilities: JSON.stringify(capabilities),
          status: "offline",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(agentKeys)
        .values({
          id: keyId,
          agentId,
          publicKey: normalized.publicKey,
          fingerprint: normalized.fingerprint,
          algorithm: "ed25519",
          status: "active",
          createdAt: now,
        })
        .run();
      appendEvent(db, {
        type: "agent.registered",
        actor: { type: "user", id: input.actorUserId },
        payload: { agentId, runtime, fingerprint: normalized.fingerprint },
        createdAt: now,
      });
      appendEvent(db, {
        type: "agent.key_registered",
        actor: { type: "user", id: input.actorUserId },
        payload: { agentId, fingerprint: normalized.fingerprint },
        createdAt: now,
      });
      recordAudit(db, {
        actorType: "user",
        actorId: input.actorUserId,
        action: "agent.register",
        targetType: "agent",
        targetId: agentId,
        metadata: { runtime, fingerprint: normalized.fingerprint },
        createdAt: now,
      });
      recordAudit(db, {
        actorType: "user",
        actorId: input.actorUserId,
        action: "agent.key_register",
        targetType: "agent",
        targetId: agentId,
        metadata: { fingerprint: normalized.fingerprint },
        createdAt: now,
      });
      return {
        agent: db.select().from(agents).where(eq(agents.id, agentId)).get()!,
        key: db.select().from(agentKeys).where(eq(agentKeys.id, keyId)).get()!,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`fingerprint ${normalized.fingerprint} is already registered`);
    }
    throw error;
  }
}
