import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { agents, events, groupMembers, users, type EventRow } from "@room/database";
import type { RoomContext } from "./context.js";
import { liveSessionAgentIds } from "./agentAuth.js";
import { RateLimitError } from "./errors.js";
import { requireGroupMember } from "./permissions.js";

/** How long a browser has to redeem its one-time WebSocket ticket. */
export const REALTIME_TICKET_TTL_MS = 60_000;
/** Upper bound for one browser frame before the socket is closed. */
const MAX_FRAME_BYTES = 64 * 1024;
/** How many persisted events one subscription poll may deliver at once. */
const EVENT_BATCH = 100;
/** Ticket issuance window used by the per-user rate limit. */
const TICKET_RATE_WINDOW_MS = 60_000;

interface RealtimeTicket {
  userId: string;
  expiresAt: number;
}

const tickets = new Map<string, RealtimeTicket>();
/** Ticket issuance timestamps per user, used to cap reconnect storms. */
const ticketIssued = new Map<string, number[]>();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sweepTickets(now: number): void {
  for (const [key, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(key);
  }
  for (const [userId, timestamps] of ticketIssued) {
    const recent = timestamps.filter((at) => at > now - TICKET_RATE_WINDOW_MS);
    if (recent.length === 0) ticketIssued.delete(userId);
    else ticketIssued.set(userId, recent);
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
  limitPerMinute = 30,
): IssuedRealtimeTicket {
  const now = ctx.now();
  sweepTickets(now);
  const recent = ticketIssued.get(userId) ?? [];
  if (recent.length >= limitPerMinute) {
    throw new RateLimitError(
      `user ${userId} requested more than ${limitPerMinute} realtime tickets per minute`,
    );
  }
  recent.push(now);
  ticketIssued.set(userId, recent);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + ttlMs;
  tickets.set(digest(token), { userId, expiresAt });
  return { ticket: token, expiresAt };
}

/**
 * Redeem a ticket. The user is looked up again here: a ticket issued before a
 * disable cannot be redeemed afterwards, and a deleted user never connects.
 */
export function consumeRealtimeTicket(ctx: RoomContext, token: string | null): string | null {
  if (!token) return null;
  const key = digest(token);
  const ticket = tickets.get(key);
  if (!ticket) return null;
  tickets.delete(key);
  if (ticket.expiresAt <= ctx.now()) return null;
  const user = ctx.db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, ticket.userId))
    .get();
  if (!user || user.status !== "active") return null;
  return ticket.userId;
}

/**
 * Check a browser `Origin` against the configured allowlist. Non-browser
 * clients (CLI tools, tests) send no Origin and remain supported; they still
 * have to present a valid one-time ticket.
 */
export function isRealtimeOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[],
  host: string | undefined,
): boolean {
  if (!origin) return true;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  for (const entry of allowed) {
    try {
      if (new URL(entry).origin === normalized) return true;
    } catch {
      // Ignore malformed allowlist entries; configuration validation rejects
      // them before this point, and a bad entry must never broaden access.
    }
  }
  if (allowed.length > 0) return false;
  try {
    return new URL(normalized).host === host;
  } catch {
    return false;
  }
}

export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (raw: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
}

export interface RealtimeConnection {
  readonly userId: string;
  /** Drop a Group subscription without closing the socket. */
  revokeGroup(groupId: string, reason: string): void;
  /** Terminate the socket (used when the user is disabled). */
  close(reason: string): void;
}

/**
 * Tracks live browser sockets so permission changes can be enforced on
 * connections that are already open. Every revoke also re-checks membership at
 * delivery time, so a race between the database write and the notification
 * cannot leak one extra event.
 */
export class RealtimeHub {
  private readonly bySocket = new Map<RealtimeSocket, RealtimeConnection>();
  private readonly byUser = new Map<string, Set<RealtimeConnection>>();

  register(socket: RealtimeSocket, connection: RealtimeConnection): void {
    this.bySocket.set(socket, connection);
    const set = this.byUser.get(connection.userId) ?? new Set<RealtimeConnection>();
    set.add(connection);
    this.byUser.set(connection.userId, set);
  }

  unregister(socket: RealtimeSocket): void {
    const connection = this.bySocket.get(socket);
    if (!connection) return;
    this.bySocket.delete(socket);
    const set = this.byUser.get(connection.userId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) this.byUser.delete(connection.userId);
  }

  countForUser(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  count(): number {
    return this.bySocket.size;
  }

  closeUser(userId: string, reason = "user_disabled"): number {
    const set = this.byUser.get(userId);
    if (!set) return 0;
    const connections = [...set];
    for (const connection of connections) connection.close(reason);
    return connections.length;
  }

  revokeGroup(groupId: string, userId: string, reason = "membership_revoked"): number {
    const set = this.byUser.get(userId);
    if (!set) return 0;
    let revoked = 0;
    for (const connection of set) {
      connection.revokeGroup(groupId, reason);
      revoked += 1;
    }
    return revoked;
  }
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

export interface RealtimeSocketOptions {
  pollMs?: number;
  presenceTtlMs?: number;
  hub?: RealtimeHub;
}

/**
 * Attach one authenticated browser socket. The socket subscribes to exactly
 * one Group at a time; events are replayed from the persisted `events` table
 * (`seq` cursor) so reconnect and refresh do not depend on memory-only fanout.
 *
 * Permissions are re-checked before every delivery batch, and the optional hub
 * lets the service layer push revocations into sockets that are already open.
 */
export function handleRealtimeSocket(
  ctx: RoomContext,
  socket: RealtimeSocket,
  userId: string,
  options: RealtimeSocketOptions = {},
): void {
  const pollMs = options.pollMs ?? 300;
  const presenceTtlMs = options.presenceTtlMs ?? 60_000;
  const hub = options.hub;
  const actor = { type: "user" as const, id: userId };
  let groupId: string | null = null;
  let cursor = 0;
  // `closed` stops further frames; `cleaned` guarantees the poll timer and hub
  // registration are released exactly once. A send failure sets both.
  let closed = false;
  let cleaned = false;
  let socketClosed = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  let presenceSignature = "";

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
    hub?.unregister(socket);
  };

  const closeSocket = (code: number, reason: string): void => {
    if (socketClosed) return;
    socketClosed = true;
    try {
      socket.close(code, reason);
    } catch {
      // The transport may already be gone; cleanup already ran.
    }
  };

  const send = (frame: Record<string, unknown>): void => {
    if (closed) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      closed = true;
      cleanup();
      closeSocket(1011, "send_failed");
    }
  };

  const isActiveUser = (): boolean => {
    const row = ctx.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    return row?.status === "active";
  };

  const isMember = (groupIdToCheck: string): boolean => {
    try {
      requireGroupMember(ctx.db, groupIdToCheck, actor);
      return true;
    } catch {
      return false;
    }
  };

  const revokeCurrent = (reason: string): void => {
    if (groupId === null) return;
    const revoked = groupId;
    groupId = null;
    presenceSignature = "";
    send({ type: "error", code: reason, groupId: revoked });
  };

  const deliver = (): void => {
    if (groupId === null) return;
    if (!isActiveUser()) {
      revokeCurrent("user_disabled");
      return;
    }
    if (!isMember(groupId)) {
      revokeCurrent("membership_revoked");
      return;
    }
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
    if (!isActiveUser() || !isMember(groupId)) {
      revokeCurrent(isActiveUser() ? "membership_revoked" : "user_disabled");
      return;
    }
    const snapshot = presence();
    const signature = JSON.stringify(snapshot);
    if (!force && signature === presenceSignature) return;
    presenceSignature = signature;
    send({ type: "presence", groupId, agents: snapshot });
  };

  poll = setInterval(() => {
    if (closed) return;
    deliver();
    sendPresence();
  }, pollMs);
  poll.unref();

  const connection: RealtimeConnection = {
    userId,
    revokeGroup: (revokedGroupId: string, reason: string) => {
      if (closed) return;
      if (groupId === revokedGroupId) revokeCurrent(reason);
    },
    close: (reason: string) => {
      if (!closed) {
        send({ type: "error", code: reason });
        closed = true;
      }
      cleanup();
      closeSocket(1008, reason);
    },
  };
  hub?.register(socket, connection);

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
    if (!isActiveUser()) {
      connection.close("user_disabled");
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
    if (!isMember(value.groupId)) {
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
