import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentClient,
  type AgentEvent,
  type WebSocketLike,
  publicKeyFingerprint,
} from "../src/index.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

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
  onEvent?: (event: AgentEvent, context: { deliveryId: string; attempt: number }) => void,
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
  });
  return { client, ticketRequests };
}

async function openClient(
  onEvent?: (event: AgentEvent, context: { deliveryId: string; attempt: number }) => void,
): Promise<{ client: AgentClient; socket: FakeSocket; harness: Harness }> {
  const harness = createHarness(onEvent);
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
