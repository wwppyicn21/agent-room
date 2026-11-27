import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeHub, handleRealtimeSocket } from "../src/modules/realtime.js";
import { seedGroup, seedUser, createTestRoom, type TestRoom } from "./helpers.js";

class FakeSocket {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  failSend = false;
  private listeners = new Map<string, ((event?: unknown) => void)[]>();

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  on(type: string, listener: (event?: unknown) => void): void {
    this.addEventListener(type, listener);
  }

  send(data: string): void {
    if (this.failSend) throw new Error("socket is gone");
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.emit("close", { code, reason });
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let room: TestRoom;

afterEach(() => {
  room?.close();
  vi.restoreAllMocks();
});

describe("realtime socket cleanup", () => {
  it("unregisters and stops polling when a send throws", () => {
    room = createTestRoom();
    const user = seedUser(room.ctx, "Owner", "owner");
    seedGroup(room.ctx, user);
    const clear = vi.spyOn(globalThis, "clearInterval");
    const hub = new RealtimeHub();
    const socket = new FakeSocket();
    socket.failSend = true;

    handleRealtimeSocket(room.ctx, socket as never, user, { hub, pollMs: 5 });

    expect(hub.count()).toBe(0);
    expect(clear).toHaveBeenCalled();
    expect(socket.closed?.code).toBe(1011);
    // The transport's close event and repeated cleanup are harmless.
    socket.emit("close", { code: 1011, reason: "send_failed" });
    expect(hub.count()).toBe(0);
    expect(() => socket.emit("close")).not.toThrow();
  });

  it("releases a live connection exactly once on a server-side close", () => {
    room = createTestRoom();
    const user = seedUser(room.ctx, "Owner", "owner");
    seedGroup(room.ctx, user);
    const clear = vi.spyOn(globalThis, "clearInterval");
    const hub = new RealtimeHub();
    const socket = new FakeSocket();

    handleRealtimeSocket(room.ctx, socket as never, user, { hub, pollMs: 5 });
    expect(hub.count()).toBe(1);

    hub.closeUser(user, "user_disabled");
    expect(hub.count()).toBe(0);
    expect(socket.closed).toEqual({ code: 1008, reason: "user_disabled" });
    expect(clear).toHaveBeenCalledTimes(1);
    socket.emit("close", { code: 1008, reason: "user_disabled" });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
