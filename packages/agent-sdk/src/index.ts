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
   * Acknowledge deliveries after the handler resolves (default true). Automatic
   * replies are acknowledged only after the server confirms `message.sent` for
   * the derived `clientMessageId`; terminal rejections end the delivery, while
   * retryable errors keep it unacked with a backoff.
   */
  autoAck?: boolean;
  /** How long to wait for `message.sent` before leaving a reply unacked (default 10s). */
  replyAckTimeoutMs?: number;
  /** Backoff before retrying a reply after a retryable error (default 5s). */
  replyRetryBackoffMs?: number;
  /**
   * Called after a (re)connect with the tasks this Agent still owns. Use it to
   * reload Thread context and resume work after a crash or a server restart.
   */
  onRecover?: (tasks: AgentTaskView[]) => void;
  /**
   * A server-issued control command. The SDK awaits the handler and only then
   * acknowledges the command; throwing leaves it unacknowledged so a reconnect
   * retries it. Use `commandId` to deduplicate side effects.
   */
  onTaskCancel?: (command: TaskCancelCommand) => void | Promise<void>;
}

/** A durable control instruction addressed to this Agent. */
export interface TaskCancelCommand {
  commandId: string;
  type: "task.cancel";
  taskId: string;
  runId: string | null;
  reason: string | null;
  createdAt: string;
}

/** A task owned by this Agent, as returned by the recovery endpoints. */
export interface AgentTaskView {
  task: Record<string, unknown>;
  run: Record<string, unknown> | null;
  thread: Record<string, unknown> | null;
  workspace: Record<string, unknown> | null;
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

export interface SendMessageOptions {
  threadId?: string;
  rootMessageId?: string;
  replyToMessageId?: string;
  clientMessageId?: string;
}

interface PendingReply {
  readonly deliveryId: string;
  readonly groupId: string;
  readonly content: string;
  readonly options: SendMessageOptions & { clientMessageId: string };
  timer: ReturnType<typeof setTimeout> | null;
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
  private socketOpen = false;
  private token: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly fingerprint: string;
  private readonly deliveryAttempts = new Map<string, number>();
  private readonly pendingReplies = new Map<string, PendingReply>();
  private readonly ackedCommands = new Set<string>();
  private readonly replyTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  private async getJson(path: string): Promise<Record<string, unknown>> {
    if (!this.token) throw new Error("connect() first");
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const response = await this.fetchImpl(`${base}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Tasks this Agent still owns (queued/assigned/running/waiting_approval/paused).
   * This is the supported recovery path after a reconnect.
   */
  async listTasks(options: { includeTerminal?: boolean } = {}): Promise<AgentTaskView[]> {
    const suffix = options.includeTerminal ? "?includeTerminal=true" : "";
    const body = await this.getJson(`/api/v1/agent/tasks${suffix}`);
    return (body.tasks as AgentTaskView[]) ?? [];
  }

  async getTask(taskId: string): Promise<AgentTaskView> {
    return (await this.getJson(
      `/api/v1/agent/tasks/${encodeURIComponent(taskId)}`,
    )) as unknown as AgentTaskView;
  }

  /** Thread history for a task this Agent is assigned to. */
  async listThreadMessages(
    threadId: string,
    options: { limit?: number; cursor?: number } = {},
  ): Promise<{ items: Record<string, unknown>[]; nextCursor: number | null }> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor !== undefined) params.set("cursor", String(options.cursor));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.getJson(
      `/api/v1/agent/threads/${encodeURIComponent(threadId)}/messages${suffix}`,
    );
    return {
      items: (body.items as Record<string, unknown>[]) ?? [],
      nextCursor: (body.nextCursor as number | null) ?? null,
    };
  }

  private async recoverTasks(): Promise<void> {
    try {
      const tasks = await this.listTasks();
      this.options.onRecover?.(tasks);
    } catch {
      // Recovery is best-effort; the next reconnect retries it.
    }
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
          this.socketOpen = true;
          this.startHeartbeat(frame.heartbeatMs as number);
          resolve({
            agentId: (frame.agent as { id: string }).id,
            heartbeatMs: frame.heartbeatMs as number,
            outstanding: frame.outstanding as number,
          });
          this.flushPendingReplies();
          if (this.options.onRecover) void this.recoverTasks();
          return;
        }
        if (frame.type === "event.deliver") {
          void this.handleDelivery(frame);
          return;
        }
        if (frame.type === "command") {
          void this.handleCommand(frame.command);
          return;
        }
        if (frame.type === "ack.ok") {
          this.forgetAcknowledged(frame.deliveryIds);
          return;
        }
        if (frame.type === "message.sent") {
          const clientMessageId =
            typeof frame.clientMessageId === "string" ? frame.clientMessageId : null;
          if (clientMessageId) this.confirmReply(clientMessageId);
          return;
        }
        if (frame.type === "error") {
          const clientMessageId =
            typeof frame.clientMessageId === "string" ? frame.clientMessageId : null;
          if (clientMessageId) this.failReply(clientMessageId, String(frame.code));
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
        this.socketOpen = false;
        this.stopHeartbeat();
        for (const clientMessageId of [...this.replyTimers.keys()]) {
          this.clearReplyTimer(clientMessageId);
        }
        if (!settled) {
          settled = true;
          reject(new Error("websocket closed before hello"));
        }
      });
    });
  }

  /** Executes a control command, then acknowledges it only after success. */
  private async handleCommand(command: unknown): Promise<void> {
    const value = command as Record<string, unknown> | null;
    if (!value || value.type !== "task.cancel" || typeof value.commandId !== "string") return;
    const commandId = value.commandId;
    if (this.ackedCommands.has(commandId)) {
      this.sendCommandAck(commandId);
      return;
    }
    const handler = this.options.onTaskCancel;
    if (!handler) return;
    try {
      await handler(value as unknown as TaskCancelCommand);
      this.ackedCommands.add(commandId);
      this.sendCommandAck(commandId);
    } catch {
      // Leave the command unacknowledged; the next reconnect retries it.
    }
  }

  private sendCommandAck(commandId: string): void {
    if (!this.socketOpen || !this.socket) return;
    this.send({ type: "command.ack", commandId });
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
        const clientMessageId = `sdk-reply-${deliveryId}`;
        if (this.pendingReplies.has(clientMessageId)) {
          // One retry flow per delivery: a concurrent redelivery must not create
          // a second pending send or timer.
          return;
        }
        const event = frame.event as AgentEvent;
        const messageId =
          typeof event.payload.messageId === "string" ? event.payload.messageId : null;
        const rootId =
          typeof event.payload.rootMessageId === "string" ? event.payload.rootMessageId : null;
        if (event.groupId) {
          this.pendingReplies.set(clientMessageId, {
            deliveryId,
            groupId: event.groupId,
            content: result.text,
            options: {
              threadId: event.threadId ?? undefined,
              rootMessageId: rootId ?? messageId ?? undefined,
              replyToMessageId: messageId ?? undefined,
              clientMessageId,
            },
            timer: null,
          });
          this.sendPendingReply(clientMessageId);
        } else if (this.options.autoAck !== false) {
          // An event without a group cannot be answered; consume it.
          this.ack([deliveryId]);
        }
        return;
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

  /**
   * One retry flow per pending reply. A pending reply is kept until the server
   * confirms `message.sent`, a terminal error ends it, or the client is closed;
   * retryable errors and confirmation timeouts resend the *same* payload with
   * the same `clientMessageId`, so a lost confirmation cannot create a duplicate.
   */
  private sendPendingReply(clientMessageId: string): void {
    const pending = this.pendingReplies.get(clientMessageId);
    if (!pending) return;
    this.clearReplyTimer(clientMessageId);
    if (!this.socket || !this.socketOpen) {
      // Keep the payload for a later reconnect; do not send on a closed socket.
      pending.timer = null;
      return;
    }
    this.sendMessage(pending.groupId, pending.content, pending.options);
    this.armReplyAck(clientMessageId);
  }

  private armReplyAck(clientMessageId: string): void {
    this.clearReplyTimer(clientMessageId);
    const timer = setTimeout(() => {
      this.replyTimers.delete(clientMessageId);
      const pending = this.pendingReplies.get(clientMessageId);
      if (!pending) return;
      pending.timer = null;
      this.sendPendingReply(clientMessageId);
    }, this.options.replyAckTimeoutMs ?? 10_000);
    (timer as { unref?: () => void }).unref?.();
    this.replyTimers.set(clientMessageId, timer);
    const pending = this.pendingReplies.get(clientMessageId);
    if (pending) pending.timer = timer;
  }

  private clearReplyTimer(clientMessageId: string): void {
    const timer = this.replyTimers.get(clientMessageId);
    if (timer) clearTimeout(timer);
    this.replyTimers.delete(clientMessageId);
    const pending = this.pendingReplies.get(clientMessageId);
    if (pending) pending.timer = null;
  }

  private confirmReply(clientMessageId: string): void {
    const pending = this.pendingReplies.get(clientMessageId);
    if (!pending) return;
    this.clearReplyTimer(clientMessageId);
    this.pendingReplies.delete(clientMessageId);
    if (this.options.autoAck !== false) this.ack([pending.deliveryId]);
  }

  private failReply(clientMessageId: string, code: string): void {
    const pending = this.pendingReplies.get(clientMessageId);
    if (!pending) return;
    this.clearReplyTimer(clientMessageId);
    if (["conflict", "forbidden", "validation_error", "not_found"].includes(code)) {
      // The discussion chain is over or the request can never succeed: stop the
      // redelivery loop instead of retrying the same rejected reply.
      this.pendingReplies.delete(clientMessageId);
      if (this.options.autoAck !== false) this.ack([pending.deliveryId]);
      return;
    }
    // Retryable (rate_limited, internal_error, ...): keep the reply pending and
    // resend the same payload after a backoff.
    const timer = setTimeout(() => {
      this.replyTimers.delete(clientMessageId);
      const current = this.pendingReplies.get(clientMessageId);
      if (!current) return;
      current.timer = null;
      this.sendPendingReply(clientMessageId);
    }, this.options.replyRetryBackoffMs ?? 5_000);
    (timer as { unref?: () => void }).unref?.();
    this.replyTimers.set(clientMessageId, timer);
    pending.timer = timer;
  }

  private flushPendingReplies(): void {
    for (const clientMessageId of [...this.pendingReplies.keys()]) {
      this.sendPendingReply(clientMessageId);
    }
  }

  ack(deliveryIds: string[]): void {
    this.send({ type: "event.ack", deliveryIds });
  }

  sendMessage(groupId: string, content: string, options: SendMessageOptions = {}): void {
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
    for (const clientMessageId of [...this.replyTimers.keys()]) {
      this.clearReplyTimer(clientMessageId);
    }
    this.replyTimers.clear();
    this.pendingReplies.clear();
    this.socketOpen = false;
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
