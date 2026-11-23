import { randomBytes, sign as signBytes, type KeyObject } from "node:crypto";
import {
  AGENT_PROTOCOL_VERSION,
  buildAgentChallengeString,
  fingerprintOfPublicKeyDer,
} from "@room/protocol";

/** Minimal WebSocket surface the SDK needs; tests inject a fake implementation. */
export interface WebSocketLike {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export interface AgentEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  correlationId: string;
  causationId: string | null;
  groupId: string | null;
  threadId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
}

export interface AgentSessionInfo {
  agentId: string;
  displayName: string;
  runtime: string;
  token: string;
  expiresAt: string;
}

/**
 * What the Agent decided for a delivered group message (plan §5.5):
 * `reply` posts a public message, `skip` consumes the delivery without one.
 */
export type ParticipationResult =
  { action: "reply"; text: string } | { action: "skip"; reason?: string };

export interface AgentClientOptions {
  baseUrl: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: new (url: string) => WebSocketLike;
  /**
   * Delivery handler. Delivery is at-least-once: the same `deliveryId` can be
   * redelivered after a missing ack or a reconnect, and `attempt` counts the
   * deliveries observed by this client. Applications must be idempotent per
   * `deliveryId` if they perform side effects.
   */
  onEvent?: (
    event: AgentEvent,
    context: { deliveryId: string; attempt: number },
  ) => void | ParticipationResult | Promise<void | ParticipationResult>;
  /**
   * Acknowledge deliveries after `onEvent` resolves (default true). Without an
   * `onEvent` handler nothing is acknowledged, so events are never silently
   * dropped and the server keeps redelivering them.
   */
  autoAck?: boolean;
}

export function publicKeyFingerprint(publicKey: KeyObject): string {
  return fingerprintOfPublicKeyDer(publicKey.export({ type: "spki", format: "der" }) as Buffer);
}

export function signChallenge(
  privateKey: KeyObject,
  challenge: {
    serverId: string;
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
  const canonical = buildAgentChallengeString(challenge);
  return signBytes(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
}

function defaultWebSocket(): new (url: string) => WebSocketLike {
  const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike })
    .WebSocket;
  if (!ctor) throw new Error("no global WebSocket; pass WebSocketImpl");
  return ctor;
}

/**
 * Reference Agent client for the Room protocol (plan §9). It performs the
 * Ed25519 challenge/response, keeps the WSS connection alive, acknowledges
 * deliveries and exposes a `sendMessage` helper.
 */
export class AgentClient {
  private readonly options: Required<
    Pick<AgentClientOptions, "baseUrl" | "privateKey" | "publicKey">
  > &
    AgentClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: new (url: string) => WebSocketLike;
  private socket: WebSocketLike | undefined;
  private token: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly fingerprint: string;
  private readonly deliveryAttempts = new Map<string, number>();

  constructor(options: AgentClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.WebSocketImpl = options.WebSocketImpl ?? defaultWebSocket();
    this.fingerprint = publicKeyFingerprint(options.publicKey);
  }

  get keyFingerprint(): string {
    return this.fingerprint;
  }

  get sessionToken(): string | undefined {
    return this.token;
  }

  /** Runs challenge/response and returns the session token. */
  async connect(): Promise<AgentSessionInfo> {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const clientNonce = randomBytes(8).toString("hex");
    const challengeResponse = await this.fetchImpl(`${base}/api/v1/agent/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: this.fingerprint, clientNonce }),
    });
    if (!challengeResponse.ok) {
      throw new Error(`challenge failed (${challengeResponse.status})`);
    }
    const challenge = (await challengeResponse.json()) as {
      protocolVersion: number;
      serverId: string;
      challengeId: string;
      nonce: string;
      clientNonce: string;
      agentId: string;
      keyFingerprint: string;
      expiresAt: string;
      purpose: string;
    };
    const signature = signChallenge(this.options.privateKey, {
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
    const connectResponse = await this.fetchImpl(`${base}/api/v1/agent/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
    });
    if (!connectResponse.ok) {
      throw new Error(`connect failed (${connectResponse.status})`);
    }
    const connected = (await connectResponse.json()) as {
      sessionToken: string;
      expiresAt: string;
      agent: { id: string; displayName: string; runtime: string };
    };
    this.token = connected.sessionToken;
    return {
      agentId: connected.agent.id,
      displayName: connected.agent.displayName,
      runtime: connected.agent.runtime,
      token: connected.sessionToken,
      expiresAt: connected.expiresAt,
    };
  }

  /**
   * Opens the authenticated socket; resolves after the server `hello`. The
   * long-lived session token never enters the URL: it is exchanged over HTTPS
   * for a short-lived, single-use upgrade ticket.
   */
  async open(): Promise<{ agentId: string; heartbeatMs: number; outstanding: number }> {
    if (!this.token) throw new Error("connect() first");
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const ticketResponse = await this.fetchImpl(`${base}/api/v1/agent/socket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!ticketResponse.ok) {
      throw new Error(`socket ticket failed (${ticketResponse.status})`);
    }
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const wsBase = base.replace(/^http/, "ws");
    const socket = new this.WebSocketImpl(
      `${wsBase}/api/v1/agent/connect?ticket=${encodeURIComponent(ticket)}`,
    );
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let settled = false;
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.type === "hello" && !settled) {
          settled = true;
          this.startHeartbeat(frame.heartbeatMs as number);
          resolve({
            agentId: (frame.agent as { id: string }).id,
            heartbeatMs: frame.heartbeatMs as number,
            outstanding: frame.outstanding as number,
          });
          return;
        }
        if (frame.type === "event.deliver") {
          void this.handleDelivery(frame);
          return;
        }
        if (frame.type === "ack.ok") {
          this.forgetAcknowledged(frame.deliveryIds);
          return;
        }
        if (frame.type === "error") {
          if (!settled) {
            settled = true;
            reject(new Error(String(frame.message ?? frame.code)));
          }
        }
      });
      socket.addEventListener("error", (event) => {
        if (!settled) {
          settled = true;
          reject(event instanceof Error ? event : new Error("websocket error"));
        }
      });
      socket.addEventListener("close", () => {
        this.stopHeartbeat();
        if (!settled) {
          settled = true;
          reject(new Error("websocket closed before hello"));
        }
      });
    });
  }

  /** Drops attempt counters once the server confirms the ack. */
  private forgetAcknowledged(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const id of value) this.deliveryAttempts.delete(String(id));
  }

  private async handleDelivery(frame: Record<string, unknown>): Promise<void> {
    const deliveryId = String(frame.deliveryId);
    const handler = this.options.onEvent;
    if (!handler) {
      // No handler means nobody has seen the event: leave it unacked so the
      // server redelivers it instead of losing it silently.
      return;
    }
    const attempt = (this.deliveryAttempts.get(deliveryId) ?? 0) + 1;
    this.deliveryAttempts.set(deliveryId, attempt);
    try {
      const result = await handler(frame.event as AgentEvent, { deliveryId, attempt });
      if (result && result.action === "reply" && result.text.trim()) {
        const event = frame.event as AgentEvent;
        const messageId =
          typeof event.payload.messageId === "string" ? event.payload.messageId : null;
        const rootId =
          typeof event.payload.rootMessageId === "string" ? event.payload.rootMessageId : null;
        if (event.groupId) {
          this.sendMessage(event.groupId, result.text, {
            threadId: event.threadId ?? undefined,
            rootMessageId: rootId ?? messageId ?? undefined,
            replyToMessageId: messageId ?? undefined,
          });
        }
      }
      if (this.options.autoAck !== false) {
        this.ack([deliveryId]);
      }
      // Attempts are kept for the socket lifetime: if the ack is lost and the
      // server redelivers, the handler still sees attempt 2 and can ignore it.
    } catch {
      // A failed handler leaves the delivery unacked; the server redelivers on
      // reconnect. The attempt count only resets after a successful ack.
    }
  }

  ack(deliveryIds: string[]): void {
    this.send({ type: "event.ack", deliveryIds });
  }

  sendMessage(
    groupId: string,
    content: string,
    options: {
      threadId?: string;
      rootMessageId?: string;
      replyToMessageId?: string;
      clientMessageId?: string;
    } = {},
  ): void {
    this.send({
      type: "message.send",
      groupId,
      content,
      threadId: options.threadId ?? null,
      rootMessageId: options.rootMessageId ?? null,
      replyToMessageId: options.replyToMessageId ?? null,
      clientMessageId: options.clientMessageId ?? null,
    });
  }

  setStatus(status: "online" | "offline"): void {
    this.send({ type: "agent.status", status });
  }

  close(): void {
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = undefined;
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ type: "ping" }), intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.socket) throw new Error("socket is not open");
    this.socket.send(JSON.stringify({ ...frame, protocolVersion: AGENT_PROTOCOL_VERSION }));
  }
}
