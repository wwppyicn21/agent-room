import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { agents, events, type EventRow, groupMembers } from "@room/database";
import type { RoomContext } from "./context.js";
import { liveSessionAgentIds } from "./agentAuth.js";
import { requireGroupMember } from "./permissions.js";

/** How long a browser has to redeem its one-time WebSocket ticket. */
export const REALTIME_TICKET_TTL_MS = 60_000;
/** Upper bound for one browser frame before the socket is closed. */
const MAX_FRAME_BYTES = 64 * 1024;
/** How many persisted events one subscription poll may deliver at once. */
const EVENT_BATCH = 100;

interface RealtimeTicket {
  userId: string;
  expiresAt: number;
}

const tickets = new Map<string, RealtimeTicket>();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sweepTickets(now: number): void {
  for (const [key, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(key);
  }
}

export interface IssuedRealtimeTicket {
  ticket: string;
  expiresAt: number;
}

/**
 * Issue a short-lived, single-use ticket for the browser WebSocket. Browsers
 * cannot set the Authorization header on an upgrade, so they trade their
 * authenticated REST session for this opaque ticket instead of putting a JWT
 * or dev identity in the URL.
 */
export function issueRealtimeTicket(
  ctx: RoomContext,
  userId: string,
  ttlMs: number = REALTIME_TICKET_TTL_MS,
): IssuedRealtimeTicket {
  const now = ctx.now();
  sweepTickets(now);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + ttlMs;
  tickets.set(digest(token), { userId, expiresAt });
  return { ticket: token, expiresAt };
}

export function consumeRealtimeTicket(ctx: RoomContext, token: string | null): string | null {
  if (!token) return null;
  const key = digest(token);
  const ticket = tickets.get(key);
  if (!ticket) return null;
  tickets.delete(key);
  if (ticket.expiresAt <= ctx.now()) return null;
  return ticket.userId;
}

export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (raw: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
}

function serialiseEvent(row: EventRow): Record<string, unknown> {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    payload = {};
  }
  return {
    seq: row.seq,
    id: row.id,
    type: row.type,
    groupId: row.groupId,
    threadId: row.threadId,
    taskId: row.taskId,
    actorType: row.actorType,
    actorId: row.actorId,
    payload,
    createdAt: row.createdAt,
  };
}

/**
 * Attach one authenticated browser socket. The socket subscribes to exactly
 * one Group at a time; events are replayed from the persisted `events` table
 * (`seq` cursor) so reconnect and refresh do not depend on memory-only fanout.
 */
export function handleRealtimeSocket(
  ctx: RoomContext,
  socket: RealtimeSocket,
  userId: string,
  pollMs = 300,
  presenceTtlMs = 60_000,
): void {
  const actor = { type: "user" as const, id: userId };
  let groupId: string | null = null;
  let cursor = 0;
  let closed = false;
  let presenceSignature = "";

  const send = (frame: Record<string, unknown>): void => {
    if (closed) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      closed = true;
    }
  };

  const deliver = (): void => {
    if (groupId === null) return;
    const rows = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.groupId, groupId), gt(events.seq, cursor)))
      .orderBy(asc(events.seq))
      .limit(EVENT_BATCH)
      .all();
    for (const row of rows) {
      cursor = row.seq;
      send({ type: "event", event: serialiseEvent(row) });
    }
  };

  const presence = (): Array<Record<string, unknown>> => {
    if (groupId === null) return [];
    const online = liveSessionAgentIds(ctx, presenceTtlMs);
    return ctx.db
      .select({
        agentId: agents.id,
        displayName: agents.displayName,
        status: agents.status,
      })
      .from(groupMembers)
      .innerJoin(agents, eq(agents.id, groupMembers.memberId))
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.memberType, "agent")))
      .orderBy(asc(agents.createdAt), asc(agents.id))
      .all()
      .map((agent) => ({ ...agent, online: online.has(agent.agentId) }));
  };

  const sendPresence = (force = false): void => {
    if (groupId === null) return;
    const snapshot = presence();
    const signature = JSON.stringify(snapshot);
    if (!force && signature === presenceSignature) return;
    presenceSignature = signature;
    send({ type: "presence", groupId, agents: snapshot });
  };

  const poll = setInterval(() => {
    deliver();
    sendPresence();
  }, pollMs);
  poll.unref();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
  };

  socket.on("close", cleanup);

  const latestSeq = (targetGroupId: string): number => {
    return (
      ctx.db
        .select({ seq: events.seq })
        .from(events)
        .where(eq(events.groupId, targetGroupId))
        .orderBy(desc(events.seq))
        .limit(1)
        .get()?.seq ?? 0
    );
  };

  socket.on("message", (raw: Buffer) => {
    if (closed) return;
    if (raw.byteLength > MAX_FRAME_BYTES) {
      send({ type: "error", code: "frame_too_large" });
      cleanup();
      socket.close(1009, "frame too large");
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      send({ type: "error", code: "invalid_json" });
      return;
    }
    if (typeof frame !== "object" || frame === null || !("type" in frame)) {
      send({ type: "error", code: "invalid_frame" });
      return;
    }
    const type = (frame as { type: unknown }).type;
    if (type === "ping") {
      send({ type: "pong", now: ctx.now() });
      return;
    }
    if (type === "unsubscribe") {
      groupId = null;
      presenceSignature = "";
      send({ type: "unsubscribed" });
      return;
    }
    if (type !== "subscribe") {
      send({ type: "error", code: "unknown_frame" });
      return;
    }
    const value = frame as { groupId?: unknown; afterSeq?: unknown };
    if (typeof value.groupId !== "string" || value.groupId.length === 0) {
      send({ type: "error", code: "groupId_required" });
      return;
    }
    if (
      value.afterSeq !== undefined &&
      (typeof value.afterSeq !== "number" ||
        !Number.isInteger(value.afterSeq) ||
        value.afterSeq < 0)
    ) {
      send({ type: "error", code: "afterSeq_invalid" });
      return;
    }
    try {
      requireGroupMember(ctx.db, value.groupId, actor);
    } catch {
      send({ type: "error", code: "forbidden" });
      return;
    }
    groupId = value.groupId;
    cursor = value.afterSeq === undefined ? latestSeq(value.groupId) : (value.afterSeq as number);
    send({ type: "subscribed", groupId, afterSeq: cursor });
    sendPresence(true);
  });

  send({ type: "hello", userId, now: ctx.now(), pollMs });
}
