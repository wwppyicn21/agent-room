import type { FastifyInstance } from "fastify";
import { loadConfig } from "@room/config";
import { agentKeys, agentSessions, events } from "@room/database";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { newId } from "@room/protocol";
import { registerAgent } from "../src/modules/agents.js";
import { addMember } from "../src/modules/groups.js";
import { listMessages, postMessage } from "../src/modules/messages.js";
import { createTestRoom, seedGroup, seedUser, type TestRoom } from "./helpers.js";

interface TestSocket {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

type WebSocketConstructor = new (url: string) => TestSocket;

class Frames {
  private readonly socket: TestSocket;
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: ((frame: Record<string, unknown> | null) => void)[] = [];
  private readonly closers: ((event: { code?: number; reason?: string }) => void)[] = [];

  constructor(socket: TestSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    socket.addEventListener("close", (event) => {
      for (const closer of this.closers.splice(0)) closer(event);
      // Unblock pending readers with a null frame.
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  next(timeoutMs = 4_000): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        if (frame === null) reject(new Error("socket closed"));
        else resolve(frame);
      });
    });
  }

  async nextOf(type: string, timeoutMs = 4_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.next(Math.max(1, deadline - Date.now()));
      if (frame.type === type) return frame;
    }
  }

  async expectSilence(ms = 700): Promise<void> {
    const queued = this.queue.shift();
    if (queued) throw new Error(`unexpected frame ${String(queued.type)}`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      }, ms);
      const waiter = (frame: Record<string, unknown> | null): void => {
        clearTimeout(timer);
        throw new Error(`unexpected frame ${String(frame?.type)}`);
      };
      this.waiters.push(waiter);
    });
  }

  closeEvent(timeoutMs = 4_000): Promise<{ code?: number; reason?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
      this.closers.push((event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.socket.close();
  }
}

interface Harness {
  room: TestRoom;
  app: FastifyInstance;
  origin: string;
  owner: string;
  groupId: string;
}

const open: Frames[] = [];
const apps: FastifyInstance[] = [];

async function setup(): Promise<Harness> {
  const room = createTestRoom();
  const app = await buildApp({
    config: loadConfig({ AUTH_MODE: "dev", DATABASE_PATH: room.path }),
    database: room.handle,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  const owner = seedUser(room.ctx, "owner@example.com", "owner");
  const groupId = seedGroup(room.ctx, owner, "writers");
  apps.push(app);
  return {
    room,
    app,
    origin: `127.0.0.1:${address.port}`,
    owner,
    groupId,
  };
}

async function issueTicket(harness: Harness, userId: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/realtime/ticket",
    headers: { "x-dev-user-id": userId },
  });
  expect(response.statusCode).toBe(200);
  return response.json().ticket as string;
}

function seedAgent(harness: Harness, displayName: string): string {
  const agent = registerAgent(harness.room.ctx, {
    displayName,
    runtime: "test",
    actorUserId: harness.owner,
  });
  addMember(harness.room.ctx, {
    groupId: harness.groupId,
    actorUserId: harness.owner,
    memberType: "agent",
    memberId: agent.id,
  });
  return agent.id;
}

function markAgentOnline(harness: Harness, agentId: string): void {
  const ctx = harness.room.ctx;
  const keyId = newId("key");
  const now = ctx.now();
  ctx.db
    .insert(agentKeys)
    .values({
      id: keyId,
      agentId,
      publicKey: `pem-${keyId}`,
      fingerprint: `fp-${keyId}`,
      createdAt: now,
    })
    .run();
  ctx.db
    .insert(agentSessions)
    .values({
      id: newId("ses"),
      agentId,
      keyId,
      tokenHash: `hash-${keyId}`,
      createdAt: now,
      expiresAt: now + 3_600_000,
      lastSeenAt: now,
    })
    .run();
}

async function connect(harness: Harness, ticket: string): Promise<Frames> {
  const Constructor = (globalThis as unknown as { WebSocket: WebSocketConstructor }).WebSocket;
  const socket = new Constructor(`ws://${harness.origin}/api/v1/realtime/ws?ticket=${ticket}`);
  const frames = new Frames(socket);
  open.push(frames);
  return frames;
}

afterEach(async () => {
  for (const frames of open.splice(0)) {
    try {
      frames.close();
    } catch {
      // already closed
    }
  }
  for (const app of apps.splice(0)) await app.close();
});

describe("browser realtime", () => {
  it("requires an authenticated user to mint a ticket", async () => {
    const harness = await setup();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/realtime/ticket",
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an invalid or reused ticket", async () => {
    const harness = await setup();
    const frames = await connect(harness, "not-a-real-ticket");
    const closed = await frames.closeEvent();
    expect(closed.code).toBe(1008);
  });

  it("only redeems a ticket once", async () => {
    const harness = await setup();
    const ticket = await issueTicket(harness, harness.owner);
    const first = await connect(harness, ticket);
    await first.nextOf("hello");

    const second = await connect(harness, ticket);
    const closed = await second.closeEvent();
    expect(closed.code).toBe(1008);
  });

  it("replays events after the message history event cursor", async () => {
    const harness = await setup();
    const first = postMessage(harness.room.ctx, {
      groupId: harness.groupId,
      actor: { type: "user", id: harness.owner },
      content: "before the cursor",
    });
    const history = listMessages(harness.room.ctx, {
      groupId: harness.groupId,
      viewer: { type: "user", id: harness.owner },
    });
    expect(history.eventCursor).toBeGreaterThan(0);
    expect(history.items.map((item) => item.id)).toContain(first.id);

    const ticket = await issueTicket(harness, harness.owner);
    const frames = await connect(harness, ticket);
    await frames.nextOf("hello");
    frames.send({ type: "subscribe", groupId: harness.groupId, afterSeq: history.eventCursor });
    await frames.nextOf("subscribed");

    const second = postMessage(harness.room.ctx, {
      groupId: harness.groupId,
      actor: { type: "user", id: harness.owner },
      content: "after the cursor",
    });
    const event = await frames.nextOf("event");
    const delivered = event.event as { seq: number; payload: { messageId?: string } };
    expect(delivered.seq).toBeGreaterThan(history.eventCursor);
    expect(delivered.payload.messageId).toBe(second.id);
  });

  it("sends an agent presence snapshot and updates it on connect", async () => {
    const harness = await setup();
    const agentId = seedAgent(harness, "presence-agent");
    const ticket = await issueTicket(harness, harness.owner);
    const frames = await connect(harness, ticket);
    await frames.nextOf("hello");
    frames.send({ type: "subscribe", groupId: harness.groupId });
    await frames.nextOf("subscribed");

    const first = await frames.nextOf("presence");
    const before = (first.agents as Array<{ agentId: string; online: boolean }>).find(
      (agent) => agent.agentId === agentId,
    );
    expect(before?.online).toBe(false);

    markAgentOnline(harness, agentId);
    const updated = await frames.nextOf("presence", 6_000);
    const after = (updated.agents as Array<{ agentId: string; online: boolean }>).find(
      (agent) => agent.agentId === agentId,
    );
    expect(after?.online).toBe(true);
  });

  it("streams persisted group events to a member", async () => {
    const harness = await setup();
    const ticket = await issueTicket(harness, harness.owner);
    const frames = await connect(harness, ticket);
    const hello = await frames.nextOf("hello");
    expect(hello.userId).toBe(harness.owner);

    frames.send({ type: "subscribe", groupId: harness.groupId });
    const subscribed = await frames.nextOf("subscribed");
    expect(subscribed.groupId).toBe(harness.groupId);

    postMessage(harness.room.ctx, {
      groupId: harness.groupId,
      actor: { type: "user", id: harness.owner },
      content: "hello realtime",
    });

    const frame = await frames.nextOf("event");
    const event = frame.event as { type: string; groupId: string; payload: { content?: string } };
    expect(event.type).toBe("message.created");
    expect(event.groupId).toBe(harness.groupId);
    expect(event.payload.content).toBe("hello realtime");
  });

  it("replays events after the supplied seq cursor", async () => {
    const harness = await setup();
    postMessage(harness.room.ctx, {
      groupId: harness.groupId,
      actor: { type: "user", id: harness.owner },
      content: "first",
    });
    const rows = harness.room.ctx.db
      .select()
      .from(events)
      .where(eq(events.groupId, harness.groupId))
      .orderBy(asc(events.seq))
      .all();
    const firstMessage = rows.find((row) => row.type === "message.created");
    expect(firstMessage).toBeTruthy();

    postMessage(harness.room.ctx, {
      groupId: harness.groupId,
      actor: { type: "user", id: harness.owner },
      content: "second",
    });

    const ticket = await issueTicket(harness, harness.owner);
    const frames = await connect(harness, ticket);
    await frames.nextOf("hello");
    frames.send({ type: "subscribe", groupId: harness.groupId, afterSeq: firstMessage!.seq });
    await frames.nextOf("subscribed");

    const frame = await frames.nextOf("event");
    const event = frame.event as { payload: { content?: string } };
    expect(event.payload.content).toBe("second");
  });

  it("forbids subscribing to a group the user is not in", async () => {
    const harness = await setup();
    const outsider = seedUser(harness.room.ctx, "outsider@example.com", "member");
    const ticket = await issueTicket(harness, outsider);
    const frames = await connect(harness, ticket);
    await frames.nextOf("hello");

    frames.send({ type: "subscribe", groupId: harness.groupId });
    const frame = await frames.nextOf("error");
    expect(frame.code).toBe("forbidden");

    postMessage(harness.room.ctx, {
      groupId: harness.groupId,
      actor: { type: "user", id: harness.owner },
      content: "private",
    });
    await frames.expectSilence();
  });

  it("supports ping and unsubscribe", async () => {
    const harness = await setup();
    const frames = await connect(harness, await issueTicket(harness, harness.owner));
    await frames.nextOf("hello");

    frames.send({ type: "ping" });
    expect((await frames.nextOf("pong")).now).toBeTypeOf("number");

    frames.send({ type: "subscribe", groupId: harness.groupId });
    await frames.nextOf("subscribed");
    frames.send({ type: "unsubscribe" });
    await frames.nextOf("unsubscribed");

    postMessage(harness.room.ctx, {
      groupId: harness.groupId,
      actor: { type: "user", id: harness.owner },
      content: "after unsubscribe",
    });
    await frames.expectSilence();
  });
});
