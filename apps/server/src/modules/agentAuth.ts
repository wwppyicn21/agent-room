import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { and, eq, gt, inArray, isNull, isNotNull, lt, lte, ne, or } from "drizzle-orm";
import {
  agentChallenges,
  agentDeliveries,
  agentKeys,
  agentSessions,
  agentSocketTickets,
  agents,
  type AgentKeyRow,
  type AgentRow,
  type AgentSessionRow,
  systemMeta,
} from "@room/database";
import {
  AGENT_AUTH_PURPOSE,
  AGENT_PROTOCOL_VERSION,
  buildAgentChallengeString,
  newId,
} from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { RateLimitError, UnauthorizedError } from "./errors.js";
import { appendEvent } from "./events.js";
import { requireAgent } from "./permissions.js";

const SERVER_ID_KEY = "server_id";

/** Public challenge endpoint writes rows; cap open challenges per key. */
export const MAX_ACTIVE_CHALLENGES_PER_KEY = 5;

/** Stable per-database server identity, bound into every signed challenge. */
export function getServerId(ctx: RoomContext): string {
  const row = ctx.db.select().from(systemMeta).where(eq(systemMeta.key, SERVER_ID_KEY)).get();
  if (row) return row.value;
  const value = `srv_${randomBytes(16).toString("hex")}`;
  const now = ctx.now();
  ctx.db
    .insert(systemMeta)
    .values({ key: SERVER_ID_KEY, value, updatedAt: new Date(now) })
    .onConflictDoNothing()
    .run();
  return (
    ctx.db.select().from(systemMeta).where(eq(systemMeta.key, SERVER_ID_KEY)).get()?.value ?? value
  );
}

export interface ChallengeView {
  readonly protocolVersion: number;
  readonly serverId: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly clientNonce: string;
  readonly agentId: string;
  readonly keyFingerprint: string;
  readonly expiresAt: number;
  readonly purpose: string;
}

function challengeCanonical(
  ctx: RoomContext,
  input: {
    challengeId: string;
    nonce: string;
    clientNonce: string;
    agentId: string;
    keyFingerprint: string;
    expiresAt: number;
    purpose: string;
    protocolVersion: number;
  },
): string {
  return buildAgentChallengeString({
    serverId: getServerId(ctx),
    challengeId: input.challengeId,
    nonce: input.nonce,
    clientNonce: input.clientNonce,
    agentId: input.agentId,
    keyFingerprint: input.keyFingerprint,
    expiresAt: input.expiresAt,
    purpose: input.purpose,
    protocolVersion: input.protocolVersion,
  });
}

function challengeView(
  ctx: RoomContext,
  challenge: {
    id: string;
    nonce: string;
    clientNonce: string;
    agentId: string;
    keyId: string;
    expiresAt: number;
    purpose: string;
    protocolVersion: number;
  },
): ChallengeView {
  const key = ctx.db.select().from(agentKeys).where(eq(agentKeys.id, challenge.keyId)).get();
  if (!key) throw new UnauthorizedError("challenge key is no longer registered");
  return {
    protocolVersion: challenge.protocolVersion,
    serverId: getServerId(ctx),
    challengeId: challenge.id,
    nonce: challenge.nonce,
    clientNonce: challenge.clientNonce,
    agentId: challenge.agentId,
    keyFingerprint: key.fingerprint,
    expiresAt: challenge.expiresAt,
    purpose: challenge.purpose,
  };
}

/**
 * The identity of an agent comes from the key it can prove possession of; an
 * agentId in the request is only a hint and never trusted (plan §8.4).
 */
export function findAgentForKeyFingerprint(
  ctx: RoomContext,
  fingerprint: string,
): { agent: AgentRow; key: AgentKeyRow } {
  const key = ctx.db
    .select()
    .from(agentKeys)
    .where(and(eq(agentKeys.fingerprint, fingerprint), eq(agentKeys.status, "active")))
    .get();
  if (!key) throw new UnauthorizedError("unknown or revoked key fingerprint");
  let agent: AgentRow;
  try {
    agent = requireAgent(ctx.db, key.agentId);
  } catch {
    throw new UnauthorizedError("agent for this key is not available");
  }
  return { agent, key };
}

export function createAgentChallenge(
  ctx: RoomContext,
  input: { fingerprint: string; agentId?: string; clientNonce?: string; ttlMs: number },
): ChallengeView {
  const { agent, key } = findAgentForKeyFingerprint(ctx, input.fingerprint);
  if (input.agentId && input.agentId !== agent.id) {
    throw new UnauthorizedError("agentId does not match the registered key");
  }
  const now = ctx.now();
  const active = ctx.db
    .select({ id: agentChallenges.id })
    .from(agentChallenges)
    .where(
      and(
        eq(agentChallenges.keyId, key.id),
        isNull(agentChallenges.usedAt),
        gt(agentChallenges.expiresAt, now),
      ),
    )
    .all().length;
  if (active >= MAX_ACTIVE_CHALLENGES_PER_KEY) {
    throw new RateLimitError(
      `too many open challenges for this key (max ${MAX_ACTIVE_CHALLENGES_PER_KEY}); retry after the open ones expire`,
    );
  }
  const challenge = {
    id: newId("chl"),
    agentId: agent.id,
    keyId: key.id,
    nonce: randomBytes(32).toString("hex"),
    clientNonce: input.clientNonce?.trim() || randomBytes(16).toString("hex"),
    purpose: AGENT_AUTH_PURPOSE,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    expiresAt: now + input.ttlMs,
    createdAt: now,
  };
  ctx.db.insert(agentChallenges).values(challenge).run();
  return challengeView(ctx, challenge);
}

/** Removes used or expired challenges; valid, unconsumed ones are kept. */
export function cleanupExpiredChallenges(ctx: RoomContext, now = ctx.now()): number {
  const removed = ctx.db
    .delete(agentChallenges)
    .where(or(isNotNull(agentChallenges.usedAt), lte(agentChallenges.expiresAt, now)))
    .run();
  return removed.changes;
}

/** Used or expired upgrade tickets are useless; deleting them bounds the table. */
export function cleanupExpiredSocketTickets(ctx: RoomContext, now = ctx.now()): number {
  const removed = ctx.db
    .delete(agentSocketTickets)
    .where(or(isNotNull(agentSocketTickets.usedAt), lte(agentSocketTickets.expiresAt, now)))
    .run();
  return removed.changes;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function openSession(
  db: RoomDb,
  agentId: string,
  keyId: string,
  now: number,
  sessionTtlMs: number,
): { session: AgentSessionRow; token: string } {
  const token = `agt_${randomBytes(32).toString("base64url")}`;
  const session = {
    id: newId("ses"),
    agentId,
    keyId,
    tokenHash: hashSessionToken(token),
    createdAt: now,
    expiresAt: now + sessionTtlMs,
    lastSeenAt: now,
  };
  db.insert(agentSessions).values(session).run();
  return {
    session: db.select().from(agentSessions).where(eq(agentSessions.id, session.id)).get()!,
    token,
  };
}

/**
 * Consumes a challenge exactly once and returns a bearer session token. The
 * update is guarded by `used_at IS NULL`, so two concurrent connects cannot
 * both win; the signature is checked before the challenge is burned.
 */
export function connectAgent(
  ctx: RoomContext,
  input: { challengeId: string; signature: string; sessionTtlMs: number },
): { agent: AgentRow; sessionToken: string; expiresAt: number; session: AgentSessionRow } {
  const challenge = ctx.db
    .select()
    .from(agentChallenges)
    .where(eq(agentChallenges.id, input.challengeId))
    .get();
  if (!challenge) throw new UnauthorizedError("unknown challenge");
  if (challenge.usedAt !== null) throw new UnauthorizedError("challenge has already been used");
  const now = ctx.now();
  if (challenge.expiresAt <= now) throw new UnauthorizedError("challenge has expired");

  const key = ctx.db.select().from(agentKeys).where(eq(agentKeys.id, challenge.keyId)).get();
  if (!key || key.status !== "active") throw new UnauthorizedError("agent key is revoked");
  let agent: AgentRow;
  try {
    agent = requireAgent(ctx.db, challenge.agentId);
  } catch {
    throw new UnauthorizedError("agent is disabled");
  }

  const canonical = challengeCanonical(ctx, {
    challengeId: challenge.id,
    nonce: challenge.nonce,
    clientNonce: challenge.clientNonce,
    agentId: challenge.agentId,
    keyFingerprint: key.fingerprint,
    expiresAt: challenge.expiresAt,
    purpose: challenge.purpose,
    protocolVersion: challenge.protocolVersion,
  });
  let signatureValid = false;
  try {
    signatureValid = verifySignature(
      null,
      Buffer.from(canonical, "utf8"),
      createPublicKey(key.publicKey),
      Buffer.from(input.signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new UnauthorizedError("challenge signature is invalid");

  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    const consumed = db
      .update(agentChallenges)
      .set({ usedAt: now })
      .where(and(eq(agentChallenges.id, challenge.id), isNull(agentChallenges.usedAt)))
      .run();
    if (consumed.changes !== 1) throw new UnauthorizedError("challenge has already been used");
    const { session, token } = openSession(db, agent.id, key.id, now, input.sessionTtlMs);
    return { agent, sessionToken: token, expiresAt: session.expiresAt, session };
  });
}

function validateSession(
  ctx: RoomContext,
  session: AgentSessionRow,
): { agent: AgentRow; session: AgentSessionRow; key: AgentKeyRow } {
  if (session.closedAt !== null) throw new UnauthorizedError("agent session is closed");
  const now = ctx.now();
  if (session.expiresAt <= now) {
    closeAgentSession(ctx, session.id, "expired");
    throw new UnauthorizedError("agent session has expired");
  }
  let agent: AgentRow;
  try {
    agent = requireAgent(ctx.db, session.agentId);
  } catch {
    throw new UnauthorizedError("agent is disabled");
  }
  const key = ctx.db.select().from(agentKeys).where(eq(agentKeys.id, session.keyId)).get();
  if (!key || key.status !== "active") throw new UnauthorizedError("agent key is revoked");
  return { agent, session, key };
}

export function isSessionExpired(session: AgentSessionRow, now: number): boolean {
  return session.expiresAt <= now;
}

/** Resolves a session row by id; disabled agents and revoked keys are rejected. */
export function requireAgentSessionById(
  ctx: RoomContext,
  sessionId: string,
): { agent: AgentRow; session: AgentSessionRow; key: AgentKeyRow } {
  const session = ctx.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
  if (!session) throw new UnauthorizedError("unknown agent session");
  return validateSession(ctx, session);
}

/** Resolves a WS bearer token; disabled agents and revoked keys are rejected. */
export function requireAgentSession(
  ctx: RoomContext,
  token: string,
): { agent: AgentRow; session: AgentSessionRow; key: AgentKeyRow } {
  const session = ctx.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.tokenHash, hashSessionToken(token)))
    .get();
  if (!session) throw new UnauthorizedError("invalid agent session token");
  return validateSession(ctx, session);
}

/**
 * Issues a short-lived, single-use ticket for the WebSocket upgrade. The
 * long-lived session token stays in the Authorization header of the POST; a
 * browser-style WebSocket cannot set headers, so only this ticket is in the URL.
 */
export function issueSocketTicket(
  ctx: RoomContext,
  input: { sessionId: string; ttlMs: number },
): { token: string; expiresAt: number } {
  const { session } = requireAgentSessionById(ctx, input.sessionId);
  const token = randomBytes(32).toString("base64url");
  const now = ctx.now();
  const expiresAt = now + input.ttlMs;
  ctx.db
    .insert(agentSocketTickets)
    .values({
      id: newId("tkt"),
      sessionId: session.id,
      ticketHash: hashSessionToken(token),
      expiresAt,
      createdAt: now,
    })
    .run();
  return { token, expiresAt };
}

/** Atomically consumes an upgrade ticket exactly once and returns its session. */
export function consumeSocketTicket(ctx: RoomContext, token: string): string {
  const ticket = ctx.db
    .select()
    .from(agentSocketTickets)
    .where(eq(agentSocketTickets.ticketHash, hashSessionToken(token)))
    .get();
  if (!ticket) throw new UnauthorizedError("invalid socket ticket");
  const now = ctx.now();
  if (ticket.usedAt !== null) throw new UnauthorizedError("socket ticket has already been used");
  if (ticket.expiresAt <= now) throw new UnauthorizedError("socket ticket has expired");
  const consumed = ctx.db
    .update(agentSocketTickets)
    .set({ usedAt: now })
    .where(
      and(
        eq(agentSocketTickets.id, ticket.id),
        isNull(agentSocketTickets.usedAt),
        gt(agentSocketTickets.expiresAt, now),
      ),
    )
    .run();
  if (consumed.changes !== 1) throw new UnauthorizedError("socket ticket is no longer valid");
  return ticket.sessionId;
}

export function touchAgentSession(ctx: RoomContext, sessionId: string): void {
  const now = ctx.now();
  ctx.db
    .update(agentSessions)
    .set({ lastSeenAt: now })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.closedAt)))
    .run();
}

export function closeAgentSession(ctx: RoomContext, sessionId: string, reason: string): void {
  const now = ctx.now();
  ctx.db
    .update(agentSessions)
    .set({ closedAt: now, closeReason: reason, lastSeenAt: now })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.closedAt)))
    .run();
}

export function closeAgentSessionsForKey(
  ctx: RoomContext,
  keyId: string,
  reason: string,
): string[] {
  const open = ctx.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.keyId, keyId), isNull(agentSessions.closedAt)))
    .all();
  for (const session of open) closeAgentSession(ctx, session.id, reason);
  return [...new Set(open.map((session) => session.agentId))];
}

/** Closes every open session for one Agent (used when an admin disables it). */
export function closeAgentSessionsForAgent(
  ctx: RoomContext,
  agentId: string,
  reason: string,
): string[] {
  const open = ctx.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.agentId, agentId), isNull(agentSessions.closedAt)))
    .all();
  for (const session of open) closeAgentSession(ctx, session.id, reason);
  return [...new Set(open.map((session) => session.id))];
}

/** Updates presence and emits `agent.status.changed` only on a real transition. */
export function setAgentStatus(
  ctx: RoomContext,
  agentId: string,
  status: "online" | "offline",
  reason: string,
): boolean {
  const agent = ctx.db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || agent.status === status) return false;
  // A disabled Agent can never be brought back online by a stale heartbeat or
  // WebSocket close callback; only an explicit admin re-enable may change it.
  if (agent.status === "disabled") return false;
  const now = ctx.now();
  const updated = ctx.db
    .update(agents)
    .set({ status, updatedAt: now })
    .where(and(eq(agents.id, agentId), ne(agents.status, "disabled")))
    .run();
  if (updated.changes !== 1) return false;
  appendEvent(ctx.db, {
    type: "agent.status.changed",
    actor: { type: "system", id: "agent-hub" },
    payload: { agentId, status, reason },
    createdAt: now,
  });
  return true;
}

export function liveSessionAgentIds(ctx: RoomContext, presenceTtlMs: number): Set<string> {
  const now = ctx.now();
  const sessions = ctx.db
    .select()
    .from(agentSessions)
    .where(
      and(
        isNull(agentSessions.closedAt),
        gt(agentSessions.lastSeenAt, now - presenceTtlMs),
        gt(agentSessions.expiresAt, now),
      ),
    )
    .all();
  return new Set(sessions.map((session) => session.agentId));
}

/**
 * Lease-based presence: a silent session is closed after the presence TTL and
 * its agent goes offline only when no other live session remains (plan §5.7).
 */
export function sweepStaleSessions(
  ctx: RoomContext,
  input: { presenceTtlMs: number; now?: number },
): string[] {
  const now = input.now ?? ctx.now();
  const stale = ctx.db
    .select()
    .from(agentSessions)
    .where(
      and(isNull(agentSessions.closedAt), lt(agentSessions.lastSeenAt, now - input.presenceTtlMs)),
    )
    .all();
  const offline: string[] = [];
  for (const session of stale) {
    closeAgentSession(ctx, session.id, "presence-timeout");
    const stillLive = liveSessionAgentIds(ctx, input.presenceTtlMs);
    if (!stillLive.has(session.agentId)) {
      setAgentStatus(ctx, session.agentId, "offline", "presence-timeout");
      offline.push(session.agentId);
    }
  }
  return offline;
}

/** Outstanding (pending or delivered-but-unacked) work, for the hello frame. */
export function countOutstandingDeliveries(ctx: RoomContext, agentId: string): number {
  return ctx.db
    .select({ id: agentDeliveries.id })
    .from(agentDeliveries)
    .where(
      and(
        eq(agentDeliveries.agentId, agentId),
        inArray(agentDeliveries.status, ["pending", "delivered"]),
      ),
    )
    .all().length;
}
