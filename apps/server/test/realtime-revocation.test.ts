import type { FastifyInstance } from "fastify";
import { loadConfig } from "@room/config";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { addMember, removeMember } from "../src/modules/groups.js";
import { postMessage } from "../src/modules/messages.js";
import { isRealtimeOriginAllowed } from "../src/modules/realtime.js";
import { disableUser } from "../src/modules/users.js";
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
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: ((frame: Record<string, unknown> | null) => void)[] = [];
  private readonly closers: ((event: { code?: number; reason?: string }) => void)[] = [];
  private closeEvent: { code?: number; reason?: string } | null = null;

  constructor(private readonly socket: TestSocket) {
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    socket.addEventListener("close", (event) => {
      this.closeEvent = event;
      for (const closer of this.closers.splice(0)) closer(event);
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  next(timeoutMs = 4_000): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closeEvent) return Promise.reject(new Error("socket closed"));
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
    if (this.queue.length > 0) throw new Error("unexpected queued frame");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      }, ms);
      const waiter = (frame: Record<string, unknown> | null): void => {
        clearTimeout(timer);
        reject(new Error(`unexpected frame ${String(frame?.type)}`));
      };
      this.waiters.push(waiter);
    });
  }

  waitForClose(timeoutMs = 4_000): Promise<{ code?: number; reason?: string }> {
    if (this.closeEvent) return Promise.resolve(this.closeEvent);
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

const opened: Frames[] = [];
const apps: FastifyInstance[] = [];

async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const room = createTestRoom();
  const app = await buildApp({
    config: loadConfig({ AUTH_MODE: "dev", DATABASE_PATH: room.path, ...env }),
    database: room.handle,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  const owner = seedUser(room.ctx, "owner@example.com", "owner");
  const groupId = seedGroup(room.ctx, owner, "writers");
  apps.push(app);
  return { room, app, origin: `127.0.0.1:${address.port}`, owner, groupId };
}

async function ticket(harness: Harness, userId: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/realtime/ticket",
    headers: { "x-dev-user-id": userId },
  });
  expect(response.statusCode).toBe(200);
  return response.json().ticket as string;
}

async function connect(harness: Harness, token: string): Promise<Frames> {
  const Constructor = (globalThis as unknown as { WebSocket: WebSocketConstructor }).WebSocket;
  const frames = new Frames(
    new Constructor(`ws://${harness.origin}/api/v1/realtime/ws?ticket=${token}`),
  );
  opened.push(frames);
  return frames;
}

async function subscribe(harness: Harness, userId: string): Promise<Frames> {
  const frames = await connect(harness, await ticket(harness, userId));
  await frames.nextOf("hello");
  frames.send({ type: "subscribe", groupId: harness.groupId });
  await frames.nextOf("subscribed");
  return frames;
}

afterEach(async () => {
  for (const frames of opened.splice(0)) {
    try {
      frames.close();
    } catch {
      // already closed
    }
  }
  for (const app of apps.splice(0)) await app.close();
});

describe("realtime permission revocation", () => {
  it("revokes a live subscription when the member is removed", async () => {
    const harness = await setup();
    const member = seedUser(harness.room.ctx, "member@example.com");
    addMember(harness.room.ctx, {
      groupId: harness.groupId,
      actorUserId: harness.owner,
      memberType: "user",
      memberId: member,
    });
    const frames = await subscribe(harness, member);

    postMessage(harness.app.roomContext, {
      groupId: harness.groupId,
      actor: { type: "user", id: harness.owner },
      content: "before removal",
    });
    await frames.nextOf("event");

    removeMember(harness.app.roomContext, {
      groupId: harness.groupId,
      actorUserId: harness.owner,
      memberType: "user",
      memberId: member,
    });
    const revoked = await frames.nextOf("error");
    expect(revoked.code).toBe("membership_revoked");

    postMessage(harness.app.roomContext, {
      groupId: harness.groupId,
      actor: { type: "user", id: harness.owner },
      content: "after removal",
    });
    await frames.expectSilence(700);
  });

  it("closes every live socket when the user is disabled", async () => {
    const harness = await setup();
    const member = seedUser(harness.room.ctx, "member@example.com");
    addMember(harness.room.ctx, {
      groupId: harness.groupId,
      actorUserId: harness.owner,
      memberType: "user",
      memberId: member,
    });
    const first = await subscribe(harness, member);
    const second = await subscribe(harness, member);
    const firstClosed = first.waitForClose();
    const secondClosed = second.waitForClose();

    disableUser(harness.app.roomContext, { userId: member, actorUserId: harness.owner });

    expect((await firstClosed).code).toBe(1008);
    expect((await secondClosed).code).toBe(1008);
  });

  it("refuses a ticket that was issued before the user was disabled", async () => {
    const harness = await setup();
    const member = seedUser(harness.room.ctx, "member@example.com");
    const before = await ticket(harness, member);
    disableUser(harness.app.roomContext, { userId: member, actorUserId: harness.owner });
    const frames = await connect(harness, before);
    expect((await frames.waitForClose()).code).toBe(1008);
  });

  it("rejects a subscribe for a group the user does not belong to", async () => {
    const harness = await setup();
    const outsider = seedUser(harness.room.ctx, "outsider@example.com");
    const frames = await connect(harness, await ticket(harness, outsider));
    await frames.nextOf("hello");
    frames.send({ type: "subscribe", groupId: harness.groupId });
    const error = await frames.nextOf("error");
    expect(error.code).toBe("forbidden");
  });

  it("enforces the per-user connection limit", async () => {
    const harness = await setup({ REALTIME_MAX_CONNECTIONS_PER_USER: "1" });
    const first = await connect(harness, await ticket(harness, harness.owner));
    await first.nextOf("hello");
    const second = await connect(harness, await ticket(harness, harness.owner));
    expect((await second.waitForClose()).code).toBe(1008);
  });

  it("rate limits ticket minting", async () => {
    const harness = await setup({ REALTIME_TICKETS_PER_MINUTE: "1" });
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/v1/realtime/ticket",
      headers: { "x-dev-user-id": harness.owner },
    });
    const second = await harness.app.inject({
      method: "POST",
      url: "/api/v1/realtime/ticket",
      headers: { "x-dev-user-id": harness.owner },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("rate_limited");
  });
});

describe("realtime origin allowlist", () => {
  it("allows non-browser clients without an Origin", () => {
    expect(
      isRealtimeOriginAllowed(undefined, ["https://room.example.com"], "room.example.com"),
    ).toBe(true);
  });

  it("rejects an origin outside an explicit allowlist", () => {
    expect(
      isRealtimeOriginAllowed(
        "https://evil.example",
        ["https://room.example.com"],
        "room.example.com",
      ),
    ).toBe(false);
  });

  it("falls back to same-host when the allowlist is empty", () => {
    expect(isRealtimeOriginAllowed("https://room.example.com", [], "room.example.com")).toBe(true);
    expect(isRealtimeOriginAllowed("https://evil.example", [], "room.example.com")).toBe(false);
  });
});
