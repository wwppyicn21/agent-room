import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentClient,
  type AgentClientOptions,
  type AgentEvent,
  type ParticipationResult,
  type WebSocketLike,
  publicKeyFingerprint,
} from "../src/index.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, ((event: unknown) => void)[]> = {
    message: [],
    close: [],
    error: [],
  };

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: "message" | "close" | "error", listener: (event: never) => void): void {
    this.listeners[type].push(listener as (event: unknown) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    for (const listener of this.listeners.close) listener(undefined);
  }

  emit(frame: unknown): void {
    for (const listener of this.listeners.message) listener({ data: JSON.stringify(frame) });
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

interface Harness {
  client: AgentClient;
  ticketRequests: RequestInit[];
}

function createHarness(
  onEvent?: (
    event: AgentEvent,
    context: { deliveryId: string; attempt: number },
  ) => void | ParticipationResult,
  overrides: Partial<AgentClientOptions> = {},
): Harness {
  const keys = generateKeyPairSync("ed25519");
  const fingerprint = publicKeyFingerprint(keys.publicKey);
  const ticketRequests: RequestInit[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    const path = String(url);
    if (path.endsWith("/api/v1/agent/challenge")) {
      return Response.json({
        protocolVersion: 1,
        serverId: "srv_test",
        challengeId: "chl_1",
        nonce: "a".repeat(64),
        clientNonce: "b".repeat(16),
        agentId: "agt_1",
        keyFingerprint: fingerprint,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        purpose: "agent-connect",
      });
    }
    if (path.endsWith("/api/v1/agent/connect")) {
      return Response.json({
        sessionToken: "ses_secret_token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        agent: { id: "agt_1", displayName: "agent", runtime: "test" },
      });
    }
    if (path.endsWith("/api/v1/agent/socket-ticket")) {
      ticketRequests.push(init ?? {});
      return Response.json({ ticket: "tkt_one", expiresAt: "2026-01-01T00:00:00.000Z" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const client = new AgentClient({
    baseUrl: "http://127.0.0.1:8787",
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    fetchImpl,
    WebSocketImpl: FakeSocket as unknown as new (url: string) => WebSocketLike,
    onEvent,
    ...overrides,
  });
  return { client, ticketRequests };
}

async function openClient(
  onEvent?: (
    event: AgentEvent,
    context: { deliveryId: string; attempt: number },
  ) => void | ParticipationResult,
  overrides: Partial<AgentClientOptions> = {},
): Promise<{ client: AgentClient; socket: FakeSocket; harness: Harness }> {
  const harness = createHarness(onEvent, overrides);
  await harness.client.connect();
  const opened = harness.client.open();
  await flush();
  const socket = FakeSocket.instances.at(-1)!;
  socket.emit({
    type: "hello",
    heartbeatMs: 60_000,
    agent: { id: "agt_1" },
    outstanding: 0,
  });
  await opened;
  return { client: harness.client, socket, harness };
}

function eventFrame(deliveryId = "evd_1"): Record<string, unknown> {
  return {
    type: "event.deliver",
    protocolVersion: 1,
    deliveryId,
    event: {
      eventId: "evt_1",
      eventType: "message.created",
      timestamp: "2026-01-01T00:00:00.000Z",
      correlationId: "evt_1",
      causationId: null,
      groupId: "grp_1",
      threadId: null,
      taskId: null,
      payload: {},
    } satisfies AgentEvent,
  };
}

function ackFrames(socket: FakeSocket): Record<string, unknown>[] {
  return socket.frames().filter((frame) => frame.type === "event.ack");
}

function replyFrames(socket: FakeSocket): Record<string, unknown>[] {
  return socket.frames().filter((frame) => frame.type === "message.send");
}

describe("agent sdk delivery handling", () => {
  it("never acknowledges a delivery when no handler is configured", async () => {
    const { socket } = await openClient();
    socket.emit(eventFrame());
    await flush();
    expect(ackFrames(socket)).toHaveLength(0);
  });

  it("leaves a delivery unacked when the handler throws", async () => {
    const { socket } = await openClient(() => {
      throw new Error("boom");
    });
    socket.emit(eventFrame());
    await flush();
    expect(ackFrames(socket)).toHaveLength(0);
  });

  it("acks the delivery id after the handler resolves", async () => {
    const { socket } = await openClient(() => undefined);
    socket.emit(eventFrame());
    await flush();
    const acks = ackFrames(socket);
    expect(acks).toHaveLength(1);
    expect(acks[0]!.deliveryIds).toEqual(["evd_1"]);
  });

  it("sends a delivery-derived client id and only acks after message.sent", async () => {
    const { socket } = await openClient((event) => {
      event.payload = { messageId: "msg_1", rootMessageId: "msg_root" };
      return { action: "reply", text: "hello back" };
    });
    socket.emit(eventFrame());
    await flush();
    const sends = socket.frames().filter((frame) => frame.type === "message.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      groupId: "grp_1",
      content: "hello back",
      replyToMessageId: "msg_1",
      rootMessageId: "msg_root",
      clientMessageId: "sdk-reply-evd_1",
    });
    expect(ackFrames(socket)).toHaveLength(0);
    socket.emit({
      type: "message.sent",
      messageId: "msg_2",
      seq: 2,
      clientMessageId: "sdk-reply-evd_1",
    });
    await flush();
    expect(ackFrames(socket)).toHaveLength(1);
  });

  it("does not send a second reply while the first awaits confirmation", async () => {
    const { socket } = await openClient(() => ({ action: "reply", text: "hello back" }));
    socket.emit(eventFrame());
    socket.emit(eventFrame());
    await flush();
    expect(socket.frames().filter((frame) => frame.type === "message.send")).toHaveLength(1);
    expect(ackFrames(socket)).toHaveLength(0);
  });

  it("resends the same reply after a retryable error backoff, then acks on confirmation", async () => {
    const { socket } = await openClient(() => ({ action: "reply", text: "hello back" }), {
      replyRetryBackoffMs: 20,
      replyAckTimeoutMs: 1_000,
    });
    socket.emit(eventFrame());
    await wait(5);
    expect(replyFrames(socket)).toHaveLength(1);
    socket.emit({
      type: "error",
      code: "rate_limited",
      message: "slow down",
      clientMessageId: "sdk-reply-evd_1",
    });
    await wait(10);
    expect(replyFrames(socket)).toHaveLength(1);
    expect(ackFrames(socket)).toHaveLength(0);

    await wait(40);
    const retried = replyFrames(socket);
    expect(retried).toHaveLength(2);
    expect(retried[1]).toMatchObject({
      content: "hello back",
      clientMessageId: "sdk-reply-evd_1",
    });

    socket.emit({
      type: "message.sent",
      messageId: "msg_2",
      seq: 2,
      clientMessageId: "sdk-reply-evd_1",
    });
    await wait(60);
    expect(replyFrames(socket)).toHaveLength(2);
    expect(ackFrames(socket)).toHaveLength(1);
  });

  it("resends after the confirmation timeout with the same client id, then stops on confirmation", async () => {
    const { socket } = await openClient(() => ({ action: "reply", text: "hello back" }), {
      replyAckTimeoutMs: 20,
      replyRetryBackoffMs: 1_000,
    });
    socket.emit(eventFrame());
    await wait(5);
    expect(replyFrames(socket)).toHaveLength(1);
    await wait(60);
    const retried = replyFrames(socket);
    expect(retried.length).toBeGreaterThanOrEqual(2);
    expect(retried[1]).toMatchObject({
      content: "hello back",
      clientMessageId: "sdk-reply-evd_1",
    });

    socket.emit({
      type: "message.sent",
      messageId: "msg_2",
      seq: 2,
      clientMessageId: "sdk-reply-evd_1",
    });
    await wait(60);
    const countAfterAck = replyFrames(socket).length;
    await wait(60);
    expect(replyFrames(socket)).toHaveLength(countAfterAck);
    expect(ackFrames(socket)).toHaveLength(1);
  });

  it("keeps a single retry flow when the same delivery arrives twice", async () => {
    const { socket } = await openClient(() => ({ action: "reply", text: "hello back" }), {
      replyAckTimeoutMs: 30,
      replyRetryBackoffMs: 1_000,
    });
    socket.emit(eventFrame());
    socket.emit(eventFrame());
    await wait(5);
    expect(replyFrames(socket)).toHaveLength(1);
    // One confirmation timeout produces exactly one retry, not one per redelivery.
    await wait(40);
    expect(replyFrames(socket)).toHaveLength(2);
    socket.emit({
      type: "message.sent",
      messageId: "msg_2",
      seq: 2,
      clientMessageId: "sdk-reply-evd_1",
    });
    await wait(5);
    expect(ackFrames(socket)).toHaveLength(1);
    await wait(80);
    expect(replyFrames(socket)).toHaveLength(2);
  });

  it("never sends after close and clears running timers", async () => {
    const { client, socket } = await openClient(() => ({ action: "reply", text: "hello back" }), {
      replyAckTimeoutMs: 20,
    });
    socket.emit(eventFrame());
    await wait(5);
    expect(replyFrames(socket)).toHaveLength(1);
    client.close();
    await wait(80);
    expect(replyFrames(socket)).toHaveLength(1);
  });

  it("keeps a pending reply across a socket close and resends it on reconnect", async () => {
    const { client, socket } = await openClient(() => ({ action: "reply", text: "hello back" }), {
      replyAckTimeoutMs: 20,
      replyRetryBackoffMs: 1_000,
    });
    socket.emit(eventFrame());
    await wait(5);
    expect(replyFrames(socket)).toHaveLength(1);

    socket.close();
    await wait(60);
    expect(replyFrames(socket)).toHaveLength(1);

    const reopened = client.open();
    await flush();
    const next = FakeSocket.instances.at(-1)!;
    next.emit({
      type: "hello",
      heartbeatMs: 60_000,
      agent: { id: "agt_1" },
      outstanding: 0,
    });
    await reopened;
    await wait(5);
    expect(replyFrames(next)).toHaveLength(1);
    expect(replyFrames(next)[0]).toMatchObject({ clientMessageId: "sdk-reply-evd_1" });

    next.emit({
      type: "message.sent",
      messageId: "msg_2",
      seq: 2,
      clientMessageId: "sdk-reply-evd_1",
    });
    await wait(5);
    expect(ackFrames(next)).toHaveLength(1);
  });

  it("acks the delivery after a terminal reply error so the chain stops", async () => {
    const { socket } = await openClient(() => ({ action: "reply", text: "hello back" }));
    socket.emit(eventFrame());
    await flush();
    socket.emit({
      type: "error",
      code: "conflict",
      message: "reply budget spent",
      clientMessageId: "sdk-reply-evd_1",
    });
    await flush();
    expect(ackFrames(socket)).toHaveLength(1);
    await wait(40);
    expect(replyFrames(socket)).toHaveLength(1);
  });

  it("does not send a message when the handler decides to skip", async () => {
    const { socket } = await openClient(() => ({ action: "skip", reason: "nothing to add" }));
    socket.emit(eventFrame());
    await flush();
    expect(socket.frames().filter((frame) => frame.type === "message.send")).toHaveLength(0);
    expect(ackFrames(socket)).toHaveLength(1);
  });

  it("passes the delivery id and increments attempts on redelivery", async () => {
    const seen: { deliveryId: string; attempt: number }[] = [];
    const { socket } = await openClient((_event, context) => {
      seen.push(context);
    });
    socket.emit(eventFrame("evd_1"));
    await flush();
    socket.emit(eventFrame("evd_1"));
    await flush();
    expect(seen).toEqual([
      { deliveryId: "evd_1", attempt: 1 },
      { deliveryId: "evd_1", attempt: 2 },
    ]);
  });

  it("clears attempt tracking once the server confirms the ack", async () => {
    const seen: number[] = [];
    const { socket } = await openClient((_event, context) => {
      seen.push(context.attempt);
    });
    socket.emit(eventFrame("evd_1"));
    await flush();
    socket.emit({ type: "ack.ok", deliveryIds: ["evd_1"] });
    await flush();
    // A redelivery after a confirmed ack starts at attempt 1 again; the map no
    // longer grows with every event the agent has already processed.
    socket.emit(eventFrame("evd_1"));
    await flush();
    expect(seen).toEqual([1, 1]);
  });

  it("uses a one-time ticket instead of the session token in the socket URL", async () => {
    const { socket, harness } = await openClient();
    expect(socket.url).toContain("ticket=tkt_one");
    expect(socket.url).not.toContain("ses_secret_token");
    expect(socket.url).not.toContain("token=");
    expect(harness.ticketRequests).toHaveLength(1);
    expect((harness.ticketRequests[0]!.headers as Record<string, string>).authorization).toBe(
      "Bearer ses_secret_token",
    );
  });
});
