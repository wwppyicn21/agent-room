import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@room/config";
import { agentCommands, agentDeliveries, agents, events, users } from "@room/database";
import { buildAgentChallengeString } from "@room/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { sweepStaleSessions } from "../src/modules/agentAuth.js";
import { addMember, removeMember } from "../src/modules/groups.js";
import { postMessage } from "../src/modules/messages.js";
import { createTaskFromMessage, startTask } from "../src/modules/tasks.js";
import { registerAgentWithKey } from "../src/modules/agents.js";
import { appendEvent, enqueueDelivery, markDeliveryDelivered } from "../src/modules/events.js";
import { createTestRoom, seedGroup, seedUser, type TestRoom } from "./helpers.js";

interface TestSocket {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

class Frames {
  private readonly socket: TestSocket;
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: ((frame: Record<string, unknown>) => void)[] = [];

  constructor(socket: TestSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
  }

  next(timeoutMs = 4_000): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.socket.close();
  }

  async nextOf(type: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 10; i += 1) {
      const frame = await this.next();
      if (frame.type === type) return frame;
    }
    throw new Error(`no ${type} frame arrived`);
  }
}

interface Harness {
  room: TestRoom;
  app: FastifyInstance;
  baseUrl: string;
}

const baseUrls = new WeakMap<FastifyInstance, string>();

const open: Harness[] = [];

async function setup(now?: () => number): Promise<Harness> {
  const room = createTestRoom(now);
  const app = await buildApp({
    config: loadConfig({ LOG_LEVEL: "silent", AGENT_SESSION_TTL_MS: "60000" }),
    database: room.handle,
    now,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  baseUrls.set(app, baseUrl);
  const harness = { room, app, baseUrl };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.app.close();
    harness.room.close();
  }
});

function dev(userId: string): { headers: Record<string, string> } {
  return { headers: { "x-dev-user-id": userId } };
}

function pair(): { publicKey: KeyObject; privateKey: KeyObject; pem: string } {
  const keys = generateKeyPairSync("ed25519");
  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function completeConnect(
  app: FastifyInstance,
  keys: { privateKey: KeyObject },
  fingerprint: string,
): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
  challenge?: Record<string, unknown>;
}> {
  const challengeResponse = await app.inject({
    method: "POST",
    url: "/api/v1/agent/challenge",
    payload: { fingerprint, clientNonce: "client-nonce-1" },
  });
  if (challengeResponse.statusCode !== 200) {
    return { statusCode: challengeResponse.statusCode, body: challengeResponse.json() };
  }
  const challenge = challengeResponse.json();
  const canonical = buildAgentChallengeString({
    serverId: challenge.serverId,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    clientNonce: challenge.clientNonce,
    agentId: challenge.agentId,
    keyFingerprint: challenge.keyFingerprint,
    expiresAt: Date.parse(challenge.expiresAt),
    purpose: challenge.purpose,
    protocolVersion: challenge.protocolVersion,
  });
  const signature = sign(null, Buffer.from(canonical, "utf8"), keys.privateKey).toString("base64");
  const connect = await app.inject({
    method: "POST",
    url: "/api/v1/agent/connect",
    payload: { challengeId: challenge.challengeId, signature },
  });
  return { statusCode: connect.statusCode, body: connect.json(), challenge };
}

type WebSocketConstructor = new (url: string) => TestSocket & {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
};

async function openSocketWithQuery(app: FastifyInstance, query: string): Promise<Frames> {
  const baseUrl = baseUrls.get(app);
  if (!baseUrl) throw new Error("test app has no base url");
  const Constructor = (globalThis as unknown as { WebSocket: WebSocketConstructor }).WebSocket;
  const socket = new Constructor(`${baseUrl}/api/v1/agent/connect?${query}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return new Frames(socket);
}

async function openSocket(app: FastifyInstance, token: string): Promise<Frames> {
  const ticketResponse = await app.inject({
    method: "POST",
    url: "/api/v1/agent/socket-ticket",
    headers: { authorization: `Bearer ${token}` },
  });
  if (ticketResponse.statusCode !== 200) {
    throw new Error(`ticket request failed (${ticketResponse.statusCode})`);
  }
  const ticket = String(ticketResponse.json().ticket);
  return openSocketWithQuery(app, `ticket=${encodeURIComponent(ticket)}`);
}

describe("dev auth and agent registration", () => {
  it("requires a provisioned, active user for admin routes", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");

    expect((await app.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/me",
          headers: { "x-dev-user-id": "usr_none" },
        })
      ).statusCode,
    ).toBe(401);

    const me = await app.inject({ method: "GET", url: "/api/v1/me", ...dev(owner) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(owner);

    room.ctx.db.update(users).set({ status: "disabled" }).where(eq(users.id, owner)).run();
    expect((await app.inject({ method: "GET", url: "/api/v1/me", ...dev(owner) })).statusCode).toBe(
      403,
    );
  });

  it("only owners and admins can register agents", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");
    const member = seedUser(room.ctx, "member");
    const keys = pair();
    const body = { displayName: "dsh", runtime: "dsh", publicKey: keys.pem };

    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      ...dev(member),
      payload: body,
    });
    expect(denied.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      ...dev(owner),
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(created.json().agent.displayName).toBe("dsh");
  });

  it("never derives identity from an unregistered fingerprint or a forged agentId", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");
    const first = pair();
    const second = pair();
    const agent = registerAgentWithKey(room.ctx, {
      displayName: "a1",
      runtime: "test",
      publicKey: first.pem,
      actorUserId: owner,
    });
    const other = registerAgentWithKey(room.ctx, {
      displayName: "a2",
      runtime: "test",
      publicKey: second.pem,
      actorUserId: owner,
    });

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/agent/challenge",
      payload: { fingerprint: "0".repeat(64) },
    });
    expect(unknown.statusCode).toBe(401);

    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/agent/challenge",
      payload: { fingerprint: agent.key.fingerprint, agentId: other.agent.id },
    });
    expect(forged.statusCode).toBe(401);
  });
});

describe("agent challenge/response", () => {
  it("connects with a valid signature and refuses to reuse the challenge", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");
    const keys = pair();
    const { key } = registerAgentWithKey(room.ctx, {
      displayName: "dsh",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });

    const first = await completeConnect(app, keys, key.fingerprint);
    expect(first.statusCode).toBe(200);
    expect(first.body.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/agent/connect",
      payload: { challengeId: String(first.challenge!.challengeId), signature: "A".repeat(64) },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects a signature made with a different key", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");
    const keys = pair();
    const impostor = pair();
    const { key } = registerAgentWithKey(room.ctx, {
      displayName: "dsh",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    const result = await completeConnect(app, impostor, key.fingerprint);
    expect(result.statusCode).toBe(401);
  });

  it("revokes a key, disconnects the live socket and refuses new connects", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");
    const keys = pair();
    const { agent, key } = registerAgentWithKey(room.ctx, {
      displayName: "dsh",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    const connected = await completeConnect(app, keys, key.fingerprint);
    const frames = await openSocket(app, String(connected.body.sessionToken));
    expect((await frames.nextOf("hello")).agent).toMatchObject({ id: agent.id });

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.id}/keys/${key.id}/revoke`,
      ...dev(owner),
    });
    expect(revoked.statusCode).toBe(200);
    const frame = await frames.next();
    expect(frame).toMatchObject({ type: "error", code: "session_closed" });

    expect((await completeConnect(app, keys, key.fingerprint)).statusCode).toBe(401);
  });
});

describe("agent websocket deliveries", () => {
  it("delivers, acks, and redelivers an unacked event after reconnect", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");
    const groupId = seedGroup(room.ctx, owner);
    const keys = pair();
    const { agent, key } = registerAgentWithKey(room.ctx, {
      displayName: "dsh",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    addMember(room.ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent.id });

    const first = await completeConnect(app, keys, key.fingerprint);
    const frames = await openSocket(app, String(first.body.sessionToken));
    const hello = await frames.nextOf("hello");
    expect(hello.outstanding).toBe(0);
    postMessage(room.ctx, { groupId, actor: { type: "user", id: owner }, content: "first" });
    const delivery = await frames.nextOf("event.deliver");
    expect((delivery.event as Record<string, unknown>).eventType).toBe("message.created");
    const deliveryId = delivery.deliveryId as string;

    // Close without acking: the delivery must stay recoverable.
    frames.close();

    const second = await completeConnect(app, keys, key.fingerprint);
    const frames2 = await openSocket(app, String(second.body.sessionToken));
    await frames2.nextOf("hello");
    const redelivered = await frames2.nextOf("event.deliver");
    expect(redelivered.deliveryId).toBe(deliveryId);

    frames2.send({ type: "event.ack", deliveryIds: [deliveryId] });
    const ack = await frames2.nextOf("ack.ok");
    expect(ack.deliveryIds).toEqual([deliveryId]);
    frames2.close();

    const pending = room.ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.agentId, agent.id))
      .all();
    expect(pending.map((row) => row.status)).toEqual(["acked"]);
  }, 20_000);

  it("refuses the session token in the websocket URL and reuse of a ticket", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");
    const keys = pair();
    const { key } = registerAgentWithKey(room.ctx, {
      displayName: "dsh",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    const connected = await completeConnect(app, keys, key.fingerprint);
    const token = String(connected.body.sessionToken);

    // ?token= is gone: the long-lived credential is never a URL parameter.
    const byToken = await openSocketWithQuery(app, `token=${encodeURIComponent(token)}`);
    expect(await byToken.next()).toMatchObject({ type: "error", code: "unauthorized" });

    const ticketResponse = await app.inject({
      method: "POST",
      url: "/api/v1/agent/socket-ticket",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ticketResponse.statusCode).toBe(200);
    const ticket = String(ticketResponse.json().ticket);
    const first = await openSocketWithQuery(app, `ticket=${encodeURIComponent(ticket)}`);
    await first.nextOf("hello");
    first.close();

    const replay = await openSocketWithQuery(app, `ticket=${encodeURIComponent(ticket)}`);
    expect(await replay.next()).toMatchObject({ type: "error", code: "unauthorized" });
  }, 20_000);

  it("rejects an expired upgrade ticket", async () => {
    let clock = Date.now();
    const { room, app } = await setup(() => clock);
    const owner = seedUser(room.ctx, "owner", "owner");
    const keys = pair();
    const { key } = registerAgentWithKey(room.ctx, {
      displayName: "dsh",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    const connected = await completeConnect(app, keys, key.fingerprint);
    const token = String(connected.body.sessionToken);
    const ticketResponse = await app.inject({
      method: "POST",
      url: "/api/v1/agent/socket-ticket",
      headers: { authorization: `Bearer ${token}` },
    });
    const ticket = String(ticketResponse.json().ticket);

    clock += 120_000;
    const expired = await openSocketWithQuery(app, `ticket=${encodeURIComponent(ticket)}`);
    expect(await expired.next()).toMatchObject({ type: "error", code: "unauthorized" });
  }, 20_000);

  it("closes a live socket when the session TTL elapses and refuses reconnection", async () => {
    let clock = Date.now();
    const { room, app } = await setup(() => clock);
    const owner = seedUser(room.ctx, "owner", "owner");
    const keys = pair();
    const { agent, key } = registerAgentWithKey(room.ctx, {
      displayName: "dsh",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    const connected = await completeConnect(app, keys, key.fingerprint);
    const token = String(connected.body.sessionToken);
    const frames = await openSocket(app, token);
    await frames.nextOf("hello");

    clock += 61_000; // session TTL is 60s in this harness
    const expired = await frames.next(6_000);
    expect(expired).toMatchObject({ type: "error", code: "session_expired" });
    await waitFor(() => statusOf(room, agent.id) === "offline");

    const reconnect = await app.inject({
      method: "POST",
      url: "/api/v1/agent/socket-ticket",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reconnect.statusCode).toBe(401);
  }, 20_000);

  it("marks the agent offline on disconnect and after a stale lease", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");
    const keys = pair();
    const { agent, key } = registerAgentWithKey(room.ctx, {
      displayName: "dsh",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    const connected = await completeConnect(app, keys, key.fingerprint);
    const frames = await openSocket(app, String(connected.body.sessionToken));
    await frames.nextOf("hello");
    expect(statusOf(room, agent.id)).toBe("online");

    frames.close();
    await waitFor(() => statusOf(room, agent.id) === "offline");

    // A session that never says goodbye still expires after its presence lease.
    await completeConnect(app, keys, key.fingerprint);
    room.ctx.db.update(agents).set({ status: "online" }).where(eq(agents.id, agent.id)).run();
    const offline = sweepStaleSessions(room.ctx, {
      presenceTtlMs: 1,
      now: room.ctx.now() + 60_000,
    });
    expect(offline).toContain(agent.id);
  }, 20_000);

  it("rejects a socket without a valid ticket", async () => {
    const { app } = await setup();
    const frames = await openSocketWithQuery(app, "ticket=not-a-ticket");
    const frame = await frames.next();
    expect(frame).toMatchObject({ type: "error", code: "unauthorized" });
  }, 10_000);

  it("fans a user message out to two connected agents and chains one reply", async () => {
    const { room, app } = await setup();
    const owner = seedUser(room.ctx, "owner", "owner");
    const groupId = seedGroup(room.ctx, owner);
    const keysA = pair();
    const keysB = pair();
    const a = registerAgentWithKey(room.ctx, {
      displayName: "AgentA",
      runtime: "test",
      publicKey: keysA.pem,
      actorUserId: owner,
    });
    const b = registerAgentWithKey(room.ctx, {
      displayName: "AgentB",
      runtime: "test",
      publicKey: keysB.pem,
      actorUserId: owner,
    });
    addMember(room.ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: a.agent.id });
    addMember(room.ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: b.agent.id });

    const connectedA = await completeConnect(app, keysA, a.key.fingerprint);
    const connectedB = await completeConnect(app, keysB, b.key.fingerprint);
    expect(connectedA.statusCode).toBe(200);
    expect(connectedB.statusCode).toBe(200);
    const socketA = await openSocket(app, String(connectedA.body.sessionToken));
    const socketB = await openSocket(app, String(connectedB.body.sessionToken));
    expect((await socketA.next()).type).toBe("hello");
    expect((await socketB.next()).type).toBe("hello");

    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "hello team",
    });
    const frameA = await socketA.next();
    const frameB = await socketB.next();
    expect(frameA.type).toBe("event.deliver");
    expect(frameB.type).toBe("event.deliver");
    expect((frameA.event as Record<string, unknown>).payload).toMatchObject({
      messageId: source.id,
    });
    expect((frameB.event as Record<string, unknown>).payload).toMatchObject({
      messageId: source.id,
    });
    socketA.send({ type: "event.ack", deliveryIds: [frameA.deliveryId] });
    socketB.send({ type: "event.ack", deliveryIds: [frameB.deliveryId] });

    socketA.send({
      type: "message.send",
      groupId,
      content: "AgentA here",
      rootMessageId: source.id,
      replyToMessageId: source.id,
    });
    const sent = await socketA.nextOf("message.sent");
    expect(sent).toMatchObject({ type: "message.sent" });
    const replyId = String(sent.messageId);

    const replyFrame = await socketB.nextOf("event.deliver");
    expect(replyFrame.type).toBe("event.deliver");
    expect((replyFrame.event as Record<string, unknown>).payload).toMatchObject({
      messageId: replyId,
      content: "AgentA here",
      hop: 1,
      rootMessageId: source.id,
    });

    const replyEvent = room.ctx.db
      .select()
      .from(events)
      .where(eq(events.groupId, groupId))
      .all()
      .find((event) => event.payload.includes(replyId));
    expect(replyEvent).toBeDefined();
    const replyDeliveries = room.ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.eventId, replyEvent!.id))
      .all();
    expect(replyDeliveries.map((row) => row.agentId)).toEqual([b.agent.id]);
  }, 20_000);
});

function statusOf(room: TestRoom, agentId: string): string | undefined {
  return room.ctx.db.select().from(agents).where(eq(agents.id, agentId)).get()?.status;
}

function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("condition not met in time"));
      }
    }, 25);
  });
}

async function framesUntil(frames: Frames, timeoutMs: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return out;
    try {
      out.push(await frames.next(remaining));
    } catch {
      return out;
    }
  }
}
describe("M5 review fix 3 delivery revocation", () => {
  it("does not send or replay a revoked Group's pending and unacked deliveries", async () => {
    const { room, app } = await setup();
    const ctx = room.ctx;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner, "revoked");
    const otherGroup = seedGroup(ctx, owner, "kept");
    const keys = pair();
    const { agent, key } = registerAgentWithKey(ctx, {
      displayName: "revoked-agent",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    for (const group of [groupId, otherGroup]) {
      addMember(ctx, {
        groupId: group,
        actorUserId: owner,
        memberType: "agent",
        memberId: agent.id,
      });
    }
    const session = await completeConnect(app, keys, key.fingerprint);
    const frames = await openSocket(app, String(session.body.sessionToken));
    expect((await frames.nextOf("hello")).outstanding).toBe(0);

    const pendingEvent = appendEvent(ctx.db, {
      type: "message.created",
      actor: { type: "user", id: owner },
      groupId,
      payload: { messageId: "msg_pending" },
      createdAt: ctx.now(),
    });
    const pending = enqueueDelivery(ctx.db, {
      agentId: agent.id,
      eventId: pendingEvent.id,
      createdAt: ctx.now(),
    });
    const unackedEvent = appendEvent(ctx.db, {
      type: "message.created",
      actor: { type: "user", id: owner },
      groupId,
      payload: { messageId: "msg_unacked" },
      createdAt: ctx.now(),
    });
    const unacked = enqueueDelivery(ctx.db, {
      agentId: agent.id,
      eventId: unackedEvent.id,
      createdAt: ctx.now(),
    });
    markDeliveryDelivered(ctx, { deliveryId: unacked.id, agentId: agent.id });
    const otherEvent = appendEvent(ctx.db, {
      type: "message.created",
      actor: { type: "user", id: owner },
      groupId: otherGroup,
      payload: { messageId: "msg_kept" },
      createdAt: ctx.now(),
    });
    enqueueDelivery(ctx.db, { agentId: agent.id, eventId: otherEvent.id, createdAt: ctx.now() });

    removeMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agent.id,
    });

    // The live socket polls once per second. Group B deliveries may still arrive,
    // but nothing from the revoked Group may be sent.
    const afterRemoval = await framesUntil(frames, 1_500);
    for (const frame of afterRemoval) {
      if (frame.type !== "event.deliver") continue;
      const event = frame.event as { groupId?: string };
      expect(event.groupId).not.toBe(groupId);
    }
    for (const deliveryId of [pending.id, unacked.id]) {
      const row = ctx.db
        .select()
        .from(agentDeliveries)
        .where(eq(agentDeliveries.id, deliveryId))
        .get();
      expect(row?.status).toBe("failed");
    }

    const late = appendEvent(ctx.db, {
      type: "message.created",
      actor: { type: "user", id: owner },
      groupId,
      payload: { messageId: "msg_late" },
      createdAt: ctx.now(),
    });
    const lateDelivery = enqueueDelivery(ctx.db, {
      agentId: agent.id,
      eventId: late.id,
      createdAt: ctx.now(),
    });
    const afterLate = await framesUntil(frames, 1_500);
    for (const frame of afterLate) {
      if (frame.type !== "event.deliver") continue;
      const event = frame.event as { groupId?: string };
      expect(event.groupId).not.toBe(groupId);
    }
    expect(
      ctx.db.select().from(agentDeliveries).where(eq(agentDeliveries.id, lateDelivery.id)).get()
        ?.status,
    ).toBe("failed");

    frames.close();
    const reconnected = await openSocket(app, String(session.body.sessionToken));
    await reconnected.nextOf("hello");
    const replayed = await framesUntil(reconnected, 1_200);
    for (const frame of replayed) {
      if (frame.type !== "event.deliver") continue;
      const event = frame.event as { groupId?: string; eventId?: string };
      expect(event.groupId).not.toBe(groupId);
      expect([pendingEvent.id, unackedEvent.id, late.id]).not.toContain(event.eventId);
    }
    reconnected.close();
  });
});

describe("M5 review fix 4 control command delivery", () => {
  it("pushes a durable task.cancel command to a live removed agent and records the ack", async () => {
    const { room, app } = await setup();
    const ctx = room.ctx;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner, "commands");
    const keys = pair();
    const { agent, key } = registerAgentWithKey(ctx, {
      displayName: "commanded",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent.id });
    const source = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "build it",
    });
    const { task } = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "write report",
      createdByUserId: owner,
      assignedAgentId: agent.id,
    });
    startTask(ctx, { taskId: task.id, agentId: agent.id });

    const session = await completeConnect(app, keys, key.fingerprint);
    const frames = await openSocket(app, String(session.body.sessionToken));
    await frames.nextOf("hello");

    removeMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent.id });

    const commandFrame = await frames.nextOf("command");
    const command = commandFrame.command as Record<string, unknown>;
    expect(command).toMatchObject({
      type: "task.cancel",
      taskId: task.id,
      reason: "agent removed from group",
    });
    expect(typeof command.runId).toBe("string");

    frames.send({ type: "command.ack", commandId: command.commandId });
    const ack = await frames.nextOf("command.ack.ok");
    expect(ack.commandId).toBe(command.commandId);
    const row = ctx.db
      .select()
      .from(agentCommands)
      .where(eq(agentCommands.id, String(command.commandId)))
      .get();
    expect(row?.status).toBe("acked");
    frames.close();
  });

  it("recovers an unacked command on reconnect and refuses another agent's ack", async () => {
    const { room, app } = await setup();
    const ctx = room.ctx;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner, "commands-recovery");
    const keys = pair();
    const { agent, key } = registerAgentWithKey(ctx, {
      displayName: "offline-commanded",
      runtime: "dsh",
      publicKey: keys.pem,
      actorUserId: owner,
    });
    addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent.id });
    const source = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "build offline",
    });
    const { task } = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "offline work",
      createdByUserId: owner,
      assignedAgentId: agent.id,
    });
    startTask(ctx, { taskId: task.id, agentId: agent.id });

    const firstSession = await completeConnect(app, keys, key.fingerprint);
    const firstSocket = await openSocket(app, String(firstSession.body.sessionToken));
    await firstSocket.nextOf("hello");
    firstSocket.close();

    removeMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent.id });

    const secondSession = await completeConnect(app, keys, key.fingerprint);
    const reconnected = await openSocket(app, String(secondSession.body.sessionToken));
    const commandFrame = await reconnected.nextOf("command");
    const command = commandFrame.command as Record<string, unknown>;
    expect(command).toMatchObject({ type: "task.cancel", taskId: task.id });

    // Another Agent cannot acknowledge (or probe) this command.
    const otherKeys = pair();
    const bystander = registerAgentWithKey(ctx, {
      displayName: "bystander",
      runtime: "dsh",
      publicKey: otherKeys.pem,
      actorUserId: owner,
    });
    const otherSession = await completeConnect(app, otherKeys, bystander.key.fingerprint);
    const otherSocket = await openSocket(app, String(otherSession.body.sessionToken));
    await otherSocket.nextOf("hello");
    otherSocket.send({ type: "command.ack", commandId: command.commandId });
    const error = await otherSocket.nextOf("error");
    expect(error.code).toBe("not_found");
    expect(
      ctx.db
        .select()
        .from(agentCommands)
        .where(eq(agentCommands.id, String(command.commandId)))
        .get()?.status,
    ).not.toBe("acked");

    reconnected.send({ type: "command.ack", commandId: command.commandId });
    expect((await reconnected.nextOf("command.ack.ok")).commandId).toBe(command.commandId);
    reconnected.close();
    otherSocket.close();

    const thirdSession = await completeConnect(app, keys, key.fingerprint);
    const reopened = await openSocket(app, String(thirdSession.body.sessionToken));
    const hello = await reopened.nextOf("hello");
    expect(hello.outstandingCommands).toBe(0);
    const after = await framesUntil(reopened, 1_200);
    expect(after.some((frame) => frame.type === "command")).toBe(false);
    reopened.close();
  });
});
