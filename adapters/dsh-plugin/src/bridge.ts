import { join } from "node:path";
import {
  AgentClient,
  type AgentClientOptions,
  type AgentEvent,
  type AgentTaskView,
  type SendMessageOptions,
  type TaskCancelCommand,
  type WebSocketLike,
} from "@room/agent-sdk";
import {
  type PluginConfig,
  assertMappings,
  defaultDataDir,
  resolvePluginConfig,
} from "./config.js";
import { ensureAgentKey, type AgentKeyPair } from "./keys.js";
import { DeliveryStore, isTerminalTurnState, type PendingTurnRecord } from "./store.js";

export interface DshLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DshSessionEvent {
  type: string;
  data?: {
    message?: { content?: readonly { type?: string; text?: string; [key: string]: unknown }[] };
    reason?: { kind?: string };
    turn?: number;
    source?: { rpcId?: string };
  };
}

export interface DshContextLike {
  logger: DshLogger;
  get(service: string): unknown;
  effect(callback: () => (() => void) | void): void;
  on(
    event: "session/event",
    listener: (session: { id: string }, event: DshSessionEvent) => void,
  ): (() => void) | void;
}

export interface RoomClientLike {
  connect(): Promise<unknown>;
  open(): Promise<{ agentId: string }>;
  close(): void;
  sendMessage(groupId: string, content: string, options?: SendMessageOptions): void;
  sendMessageWithAck?(
    groupId: string,
    content: string,
    options?: SendMessageOptions,
    timeoutMs?: number,
  ): Promise<void>;
  getTask?(taskId: string): Promise<AgentTaskView>;
}

interface SessionControllerLike {
  prompt(
    request: {
      requestId: string;
      sessionId: string;
      mode: "queue" | "steer";
      content: readonly { type: "text"; text: string }[];
    },
    signal?: AbortSignal,
  ): Promise<{ accepted: true }>;
  cancel(input: { sessionId: string }): void;
  resolveAgent?(sessionId: string): Promise<{ agent?: { id: string }; error?: unknown }>;
}

interface SessionQueryLike {
  readSession(sessionId: string): unknown;
}

export interface BridgeStatus {
  enabled: boolean;
  connected: boolean;
  agentId: string | null;
  fingerprint: string | null;
  groups: number;
  deliveries: Record<string, number>;
  lastError: string | null;
}

export interface BridgeDeps {
  ctx: DshContextLike;
  /** Test seam: replace the Room SDK client. */
  createClient?: (options: AgentClientOptions) => RoomClientLike;
  /** Test seam: replace DSH session lookup. */
  readSession?: (sessionId: string) => Promise<unknown>;
  now?: () => number;
}

interface PendingTurn extends PendingTurnRecord {
  timer: ReturnType<typeof setTimeout> | null;
}

const SKIP_PATTERN = /^\[skip\](?:\s|$)/i;

/**
 * Bridges explicitly mapped Room groups to DSH sessions. Room authentication,
 * leases and acks stay in @room/agent-sdk; this class only maps deliveries to
 * prompts, extracts the public assistant output and posts it back.
 */
export class RoomBridge {
  private config: PluginConfig;
  private readonly rawConfig: Partial<PluginConfig>;
  private configTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deps: BridgeDeps;
  private readonly logger: DshLogger;
  private readonly store: DeliveryStore;
  private readonly mappings = new Map<
    string,
    { groupId: string; sessionId: string; label: string }
  >();
  private readonly validSessions = new Set<string>();
  private readonly pendingBySession = new Map<string, PendingTurn[]>();
  private activeBySession = new Map<string, PendingTurn>();
  private readonly taskSessions = new Map<string, string>();
  private recovering = false;
  private client: RoomClientLike | null = null;
  private keys: AgentKeyPair | null = null;
  private agentId: string | null = null;
  private connected = false;
  private started = false;
  private stopped = false;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposeSessionEvents: (() => void) | void = undefined;

  constructor(config: Partial<PluginConfig>, deps: BridgeDeps) {
    this.rawConfig = config;
    this.config = resolvePluginConfig(config);
    this.deps = deps;
    this.logger = deps.ctx.logger;
    const dataDir = this.config.dataDir || defaultDataDir();
    this.store = new DeliveryStore(join(dataDir, "deliveries.json"));
  }

  get deliveryStore(): DeliveryStore {
    return this.store;
  }

  get dataDirectory(): string {
    return this.config.dataDir || defaultDataDir();
  }

  status(): BridgeStatus {
    return {
      enabled: this.config.enabled,
      connected: this.connected,
      agentId: this.agentId,
      fingerprint: this.keys?.fingerprint ?? null,
      groups: this.mappings.size,
      deliveries: this.store.counts(),
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.config.enabled) {
      this.logger.info("agent-room: plugin disabled by configuration");
      return;
    }
    assertMappings(this.config.groups);
    for (const group of this.config.groups) this.mappings.set(group.groupId, group);
    if (this.config.groups.length === 0) {
      this.logger.warn("agent-room: no group -> session mappings configured; bridging is idle");
    }
    await this.store.load();
    await this.store.prune({ retentionDays: this.config.deliveryRetentionDays });
    const keyPath = this.config.agentKeyPath || join(this.dataDirectory, "agent-key.pem");
    this.keys = await ensureAgentKey(keyPath);
    this.logger.info(
      `agent-room: identity fingerprint ${this.keys.fingerprint} (key stored locally)`,
    );
    this.disposeSessionEvents = this.deps.ctx.on("session/event", (session, event) =>
      this.handleSessionEvent(session.id, event),
    );
    await this.warnMissingSessions();
    this.connectLoop();
    this.configTimer = setInterval(() => this.refreshConfig(), 1_000);
    this.configTimer.unref?.();
  }

  /** Re-read volatile settings without restarting the plugin. */
  private refreshConfig(): void {
    let next: PluginConfig;
    try {
      next = resolvePluginConfig(this.rawConfig);
      assertMappings(next.groups);
    } catch (error) {
      this.logger.warn(`agent-room: ignoring invalid live configuration: ${errorText(error)}`);
      return;
    }
    const urlChanged = next.roomBaseUrl !== this.config.roomBaseUrl;
    this.config = next;
    this.mappings.clear();
    for (const group of next.groups) this.mappings.set(group.groupId, group);
    if (urlChanged && this.client) {
      this.connected = false;
      const client = this.client;
      this.client = null;
      try {
        client.close();
      } catch {
        // ignore close errors; reconnect below
      }
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.configTimer) clearInterval(this.configTimer);
    this.configTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const turns of this.pendingBySession.values()) {
      for (const turn of turns) if (turn.timer) clearTimeout(turn.timer);
    }
    this.pendingBySession.clear();
    this.activeBySession.clear();
    if (typeof this.disposeSessionEvents === "function") this.disposeSessionEvents();
    this.disposeSessionEvents = undefined;
    this.client?.close();
    this.client = null;
    this.connected = false;
    try {
      await this.store.flush();
    } catch (error) {
      this.logger.warn(`agent-room: delivery store flush failed during stop: ${errorText(error)}`);
    }
  }

  private async warnMissingSessions(): Promise<void> {
    for (const mapping of this.mappings.values()) {
      try {
        await this.readSession(mapping.sessionId);
      } catch (error) {
        this.logger.warn(
          `agent-room: group ${mapping.groupId} is mapped to unavailable session ${mapping.sessionId}: ${errorText(error)}`,
        );
      }
    }
  }

  private connectLoop(): void {
    if (this.stopped) return;
    void this.connectOnce().catch((error) => {
      if (this.stopped) return;
      this.lastError = errorText(error);
      this.connected = false;
      this.logger.error(`agent-room: connect failed: ${this.lastError}`);
      this.scheduleReconnect();
    });
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || !this.keys) return;
    const client = this.client ?? (this.client = this.createClient());
    await client.connect();
    if (this.stopped || this.client !== client) {
      client.close();
      return;
    }
    const hello = await client.open();
    if (this.stopped || this.client !== client) {
      client.close();
      return;
    }
    this.agentId = hello.agentId;
    this.connected = true;
    this.lastError = null;
    this.reconnectAttempts = 0;
    void this.flushPendingReplies().then(() => this.recoverPendingTurns());
    this.logger.info(
      `agent-room: connected as ${hello.agentId} with ${this.mappings.size} group mapping(s)`,
    );
  }

  private createClient(): RoomClientLike {
    const options: AgentClientOptions & { onSocketClosed?: () => void } = {
      baseUrl: this.config.roomBaseUrl,
      privateKey: this.keys!.privateKey,
      publicKey: this.keys!.publicKey,
      onEvent: (event, context) => this.handleDelivery(event, context),
      onTaskCancel: (command) => this.handleTaskCancel(command),
      onRecover: (tasks) => this.handleRecover(tasks),
    };
    if (this.deps.createClient) return this.deps.createClient(options);
    const WebSocketImpl = this.trackedWebSocket();
    return new AgentClient({ ...options, WebSocketImpl });
  }

  /** Wraps the host WebSocket so a dropped socket triggers reconnect. */
  private trackedWebSocket(): new (url: string) => WebSocketLike {
    const onClose = (): void => this.handleSocketClosed();
    const Base = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike })
      .WebSocket;
    if (!Base) throw new Error("global WebSocket is unavailable in this DSH runtime");
    return class TrackedSocket extends Base {
      constructor(url: string) {
        super(url);
        this.addEventListener("close", () => {
          onClose();
        });
      }
    };
  }

  private handleSocketClosed(): void {
    this.connected = false;
    this.logger.warn("agent-room: socket closed; reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempts, 6));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.client?.close();
      this.client = null;
      this.connectLoop();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async readSession(sessionId: string): Promise<unknown> {
    if (this.deps.readSession) return this.deps.readSession(sessionId);
    const query = this.deps.ctx.get("sessionQuery") as SessionQueryLike | undefined;
    if (!query) throw new Error("sessionQuery service is unavailable");
    return query.readSession(sessionId);
  }

  private async handleDelivery(
    event: AgentEvent,
    _context: { deliveryId: string; attempt: number },
  ): Promise<void> {
    if (event.eventType === "task.cancelled") {
      if (event.taskId) await this.cancelTaskTurns(event.taskId, "task cancelled event");
      return;
    }
    if (event.eventType !== "message.created") return;
    const groupId = event.groupId;
    if (!groupId) return;
    const senderType = typeof event.payload.senderType === "string" ? event.payload.senderType : "";
    const senderId = typeof event.payload.senderId === "string" ? event.payload.senderId : "";
    if (senderType === "system") return;
    if (senderType === "agent" && this.agentId && senderId === this.agentId) return;
    if (this.store.state(event.eventId) === "completed") return;
    if (this.store.getTurn(event.eventId)?.state === "cancelled") return;
    const mapping = this.mappings.get(groupId);
    if (!mapping) {
      await this.store.markFailed(event.eventId, `no session mapping for group ${groupId}`);
      this.lastError = `no session mapping for group ${groupId}`;
      this.logger.warn(`agent-room: dropping delivery ${event.eventId}: ${this.lastError}`);
      return;
    }
    try {
      await this.readSession(mapping.sessionId);
    } catch (error) {
      const reason = `session ${mapping.sessionId} is unavailable: ${errorText(error)}`;
      await this.store.markFailed(event.eventId, reason);
      this.lastError = reason;
      this.logger.error(`agent-room: delivery ${event.eventId} failed: ${reason}`);
      return;
    }
    const controller = this.deps.ctx.get("sessionController") as SessionControllerLike | undefined;
    if (!controller) {
      await this.store.markFailed(event.eventId, "sessionController service is unavailable");
      this.lastError = "sessionController service is unavailable";
      this.logger.error("agent-room: sessionController service is unavailable");
      return;
    }
    // A persisted Session is cold at process start. Prompting without resuming
    // its Agent is accepted but the turn ends as "blocked"; resolve it first.
    if (controller.resolveAgent) {
      try {
        const resolved = await controller.resolveAgent(mapping.sessionId);
        if (resolved.error) {
          const reason = `session ${mapping.sessionId} agent is unavailable: ${JSON.stringify(resolved.error)}`;
          await this.store.markFailed(event.eventId, reason);
          this.lastError = reason;
          this.logger.error(`agent-room: delivery ${event.eventId} failed: ${reason}`);
          return;
        }
      } catch (error) {
        const reason = `session ${mapping.sessionId} agent failed to resume: ${errorText(error)}`;
        await this.store.markFailed(event.eventId, reason);
        this.lastError = reason;
        this.logger.error(`agent-room: delivery ${event.eventId} failed: ${reason}`);
        return;
      }
    }
    const requestId = `room-${event.eventId}`;
    const previous = this.store.getTurn(event.eventId);
    if (previous) {
      // Never re-run a Turn that already reached a terminal state, and never
      // blindly re-prompt an ambiguous "prompting" state left by a crash.
      if (isTerminalTurnState(previous.state)) {
        if (previous.state === "completed") await this.store.markCompleted(event.eventId);
        else await this.store.markFailed(event.eventId, `turn is ${previous.state}`);
        return;
      }
      if (previous.state === "awaiting_response") {
        // The delivery ack was lost after the prompt was accepted. Re-attach the
        // persisted turn instead of prompting the Session a second time.
        this.enqueuePending(previous);
        await this.store.markCompleted(event.eventId);
        return;
      }
      if (previous.state === "reply_pending") {
        // The reply was generated before the crash; resend the durable text,
        // never ask the model to produce it again.
        try {
          await this.deliverReply(previous, previous.text);
          await this.store.updateTurn(previous.eventId, {
            state: "completed",
            text: previous.text,
          });
          await this.store.markCompleted(event.eventId);
        } catch (error) {
          await this.store.markFailed(event.eventId, `reply pending: ${errorText(error)}`);
        }
        return;
      }
      if (previous.state === "cancelled") {
        await this.store.markCompleted(event.eventId);
        return;
      }
      if (previous.state === "failed") {
        await this.store.markFailed(event.eventId, previous.error ?? "turn failed");
        return;
      }
      if (previous.state === "prompting") {
        // The prompt may or may not have reached DSH before the crash. The
        // session log is authoritative: attach if the request is recorded,
        // otherwise stop and require an explicit recovery instead of running
        // the Turn twice.
        let snapshot: { events?: readonly SnapshotEvent[] };
        try {
          snapshot = (await this.readSession(mapping.sessionId)) as {
            events?: readonly SnapshotEvent[];
          };
        } catch (error) {
          await this.store.markFailed(event.eventId, `cannot inspect session: ${errorText(error)}`);
          return;
        }
        const events = Array.isArray(snapshot.events) ? snapshot.events : [];
        const recorded = events.find(
          (item) => item.type === "user/message" && item.data?.source?.rpcId === previous.requestId,
        );
        if (recorded) {
          this.enqueuePending(previous);
          await this.store.updateTurn(previous.eventId, { state: "awaiting_response" });
          await this.store.markCompleted(event.eventId);
        } else {
          await this.store.markFailed(
            event.eventId,
            "prompt state is ambiguous after restart; refusing to execute twice",
          );
        }
        return;
      }
    }
    const threadId = event.threadId ?? null;
    const taskId = event.taskId ?? null;
    if (taskId) this.taskSessions.set(taskId, mapping.sessionId);
    const replyToMessageId =
      typeof event.payload.messageId === "string" ? event.payload.messageId : null;
    const promptText = renderPrompt(event);
    const now = new Date().toISOString();
    const pending: PendingTurnRecord = {
      eventId: event.eventId,
      requestId,
      sessionId: mapping.sessionId,
      groupId,
      threadId,
      replyToMessageId,
      messageId: replyToMessageId,
      taskId,
      turnNumber: null,
      prompt: promptText,
      text: "",
      state: "prompting",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.begin(event.eventId);
    await this.store.markProcessing(event.eventId);
    await this.store.recordTurn(pending);
    // Register the pending turn before prompting: DSH can emit user/message and
    // turn/end before prompt() resolves, and those events must find the turn.
    this.enqueuePending(pending);
    try {
      await controller.prompt(
        {
          requestId,
          sessionId: mapping.sessionId,
          mode: "queue",
          content: [{ type: "text", text: promptText }],
        },
        new AbortController().signal,
      );
      // The turn may already have completed while prompt() was in flight; never
      // overwrite a terminal state, but still mark the delivery acknowledged.
      const current = this.store.getTurn(event.eventId);
      if (!current || !isTerminalTurnState(current.state)) {
        await this.store.updateTurn(event.eventId, { state: "awaiting_response" });
      }
      await this.store.markCompleted(event.eventId);
    } catch (error) {
      const reason = errorText(error);
      this.removePending(mapping.sessionId, event.eventId);
      await this.store.updateTurn(event.eventId, { state: "failed", error: reason });
      await this.store.markFailed(event.eventId, reason);
      this.lastError = reason;
      this.logger.error(`agent-room: prompt for ${event.eventId} failed: ${reason}`);
    }
  }

  private removePending(sessionId: string, eventId: string): void {
    const queue = this.pendingBySession.get(sessionId);
    if (!queue) return;
    const index = queue.findIndex((turn) => turn.eventId === eventId);
    if (index >= 0) {
      const [removed] = queue.splice(index, 1);
      if (removed?.timer) clearTimeout(removed.timer);
    }
    if (queue.length === 0) this.pendingBySession.delete(sessionId);
    if (this.activeBySession.get(sessionId)?.eventId === eventId) {
      this.activeBySession.delete(sessionId);
    }
  }

  private enqueuePending(record: PendingTurnRecord): PendingTurn {
    const queue = this.pendingBySession.get(record.sessionId) ?? [];
    const existing = queue.find((turn) => turn.eventId === record.eventId);
    if (existing) return existing;
    const turn: PendingTurn = { ...record, timer: null };
    turn.timer = setTimeout(() => {
      void (async () => {
        if (this.stopped) return;
        const current = this.pendingBySession.get(record.sessionId);
        const index = current ? current.indexOf(turn) : -1;
        if (!current || index < 0) return;
        current.splice(index, 1);
        if (current.length === 0) this.pendingBySession.delete(record.sessionId);
        const persisted = this.store.getTurn(record.eventId);
        // The active pointer must not survive a timeout, otherwise a late
        // assistant/turn-end event would be attributed to the dead turn.
        if (this.activeBySession.get(record.sessionId)?.eventId === record.eventId) {
          this.activeBySession.delete(record.sessionId);
        }
        // A late turn/end may have completed the same turn just before the
        // timer fired; never overwrite a terminal state.
        if (!persisted || isTerminalTurnState(persisted.state)) return;
        await this.store.updateTurn(record.eventId, { state: "failed", error: "turn_timeout" });
        this.logger.warn(
          `agent-room: turn for ${turn.eventId} timed out; marked failed and ignored any late events`,
        );
      })();
    }, this.config.turnTimeoutMs);
    turn.timer.unref?.();
    queue.push(turn);
    this.pendingBySession.set(record.sessionId, queue);
    return turn;
  }

  private handleSessionEvent(sessionId: string, event: DshSessionEvent): void {
    const queue = this.pendingBySession.get(sessionId);
    if (!queue || queue.length === 0) return;
    // Correlate events strictly through the Room request id (rpcId) and the DSH
    // turn number. A human DSH conversation or an unrelated queued turn must
    // never be attributed to a Room delivery, so there is no queue[0] fallback.
    if (event.type === "user/message") {
      const rpcId = event.data?.source?.rpcId;
      if (!rpcId) return;
      const turn = queue.find((candidate) => candidate.requestId === rpcId);
      if (!turn) return;
      const turnNumber = event.data?.turn;
      if (typeof turnNumber === "number") {
        turn.turnNumber = turnNumber;
        void this.store
          .updateTurn(turn.eventId, { turnNumber })
          .catch((error: unknown) =>
            this.logger.warn(`agent-room: cannot persist turn number: ${errorText(error)}`),
          );
      }
      this.activeBySession.set(sessionId, turn);
      return;
    }
    const eventTurn = event.data?.turn;
    // Prefer the exact DSH turn number carried by the event; the single active
    // pointer is only a fallback for events that do not identify a turn.
    let turn: PendingTurn | undefined =
      typeof eventTurn === "number"
        ? queue.find((candidate) => candidate.turnNumber === eventTurn)
        : undefined;
    if (!turn) turn = this.activeBySession.get(sessionId);
    if (!turn) return;
    if (
      typeof eventTurn === "number" &&
      typeof turn.turnNumber === "number" &&
      eventTurn !== turn.turnNumber
    ) {
      return;
    }
    if (event.type === "assistant/message") {
      const text = extractAssistantText(event.data?.message?.content);
      if (text) turn.text = text;
      return;
    }
    if (event.type !== "turn/end") return;
    if (this.activeBySession.get(sessionId)?.eventId === turn.eventId) {
      this.activeBySession.delete(sessionId);
    }
    if (turn.timer) clearTimeout(turn.timer);
    const index = queue.findIndex((candidate) => candidate.eventId === turn.eventId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.pendingBySession.delete(sessionId);
    const persisted = this.store.getTurn(turn.eventId);
    if (persisted && isTerminalTurnState(persisted.state)) return;
    const reason = event.data?.reason?.kind ?? "completed";
    void this.finishTurn(turn, reason);
  }

  private async finishTurn(turn: PendingTurn, reason: string): Promise<void> {
    const current = this.store.getTurn(turn.eventId);
    if (current && isTerminalTurnState(current.state)) return;
    if (reason !== "completed") {
      this.logger.warn(`agent-room: turn for ${turn.eventId} ended with ${reason}; no reply`);
      await this.store.updateTurn(turn.eventId, { state: "failed", error: `turn ${reason}` });
      return;
    }
    const text = turn.text.trim();
    if (!text || SKIP_PATTERN.test(text)) {
      this.logger.info(`agent-room: agent skipped ${turn.eventId}`);
      await this.store.updateTurn(turn.eventId, { state: "completed", text: "" });
      return;
    }
    // Persist the reply before any socket write: a crash or disconnect between
    // here and the server ACK must leave a durable, retryable reply_pending.
    await this.store.updateTurn(turn.eventId, { state: "reply_pending", text });
    try {
      await this.deliverReply(turn, text);
      const after = this.store.getTurn(turn.eventId);
      if (!after || !isTerminalTurnState(after.state)) {
        await this.store.updateTurn(turn.eventId, { state: "completed", text });
      }
    } catch (error) {
      // Keep the generated text durable; a reconnect retries the same
      // clientMessageId, so the server can deduplicate a late first attempt.
      this.logger.warn(`agent-room: reply for ${turn.eventId} is pending: ${errorText(error)}`);
    }
  }

  /** Sends a reply and waits for the server's persisted-message ACK. */
  private async deliverReply(turn: PendingTurnRecord, text: string): Promise<void> {
    if (!this.client) throw new Error("room client is not connected");
    const content = truncate(`${this.config.replyPrefix}${text}`, this.config.maxReplyChars);
    const options = {
      threadId: turn.threadId ?? undefined,
      replyToMessageId: turn.replyToMessageId ?? undefined,
      clientMessageId: `plugin-reply-${turn.eventId}`,
    };
    if (this.client.sendMessageWithAck) {
      await this.client.sendMessageWithAck(turn.groupId, content, options, 10_000);
      return;
    }
    // Legacy test doubles without the ACK method keep the old local-write
    // behaviour; production always uses AgentClient.sendMessageWithAck.
    this.client.sendMessage(turn.groupId, content, options);
  }

  /** Retry replies generated while the socket was down (idempotent send). */
  private async flushPendingReplies(): Promise<void> {
    for (const turn of this.store.listTurns(["reply_pending"])) {
      if (this.stopped) return;
      try {
        await this.deliverReply(turn, turn.text);
        const current = this.store.getTurn(turn.eventId);
        if (!current || !isTerminalTurnState(current.state)) {
          await this.store.updateTurn(turn.eventId, { state: "completed", text: turn.text });
        }
      } catch (error) {
        // One permanently rejected reply (removed member, deleted thread, ...)
        // must not block unrelated groups; transient failures keep retrying.
        if (isPermanentDeliveryError(error)) {
          await this.store.updateTurn(turn.eventId, {
            state: "failed",
            error: `reply rejected: ${errorText(error)}`,
          });
          this.logger.warn(
            `agent-room: pending reply for ${turn.eventId} was rejected permanently: ${errorText(error)}`,
          );
        } else {
          this.logger.warn(
            `agent-room: pending reply for ${turn.eventId} is still undeliverable: ${errorText(error)}`,
          );
        }
      }
    }
  }

  /**
   * Re-attach turns that were open when the plugin stopped. The DSH session log
   * is the source of truth: if the turn already ended while the plugin was down,
   * the persisted prompt is resolved from the snapshot; if it is still running,
   * the in-memory waiter is restored for the next `turn/end`; if the prompt was
   * never accepted, it is retried with the same requestId (DSH deduplicates it).
   */
  private async recoverPendingTurns(): Promise<void> {
    if (this.recovering || this.stopped) return;
    this.recovering = true;
    try {
      const turns = this.store.listTurns(["prompting", "awaiting_response"]);
      for (const record of turns) {
        if (this.stopped) return;
        if (!this.mappings.has(record.groupId)) {
          await this.store.updateTurn(record.eventId, {
            state: "failed",
            error: `group ${record.groupId} is no longer mapped`,
          });
          continue;
        }
        let snapshot: { events?: readonly SnapshotEvent[] };
        try {
          snapshot = (await this.readSession(record.sessionId)) as {
            events?: readonly SnapshotEvent[];
          };
        } catch (error) {
          const reason = `session ${record.sessionId} is unavailable: ${errorText(error)}`;
          await this.store.updateTurn(record.eventId, { state: "failed", error: reason });
          this.logger.warn(`agent-room: cannot recover ${record.eventId}: ${reason}`);
          continue;
        }
        const events = Array.isArray(snapshot.events) ? snapshot.events : [];
        const userEvent = events.find(
          (event) =>
            event.type === "user/message" && event.data?.source?.rpcId === record.requestId,
        );
        if (!userEvent) {
          if (record.state === "prompting") {
            await this.retryPrompt(record);
          } else {
            await this.store.updateTurn(record.eventId, {
              state: "failed",
              error: "prompt was not recorded in the session log",
            });
          }
          continue;
        }
        const turnNumber = userEvent.data?.turn;
        if (typeof turnNumber !== "number") continue;
        const ended = events.find(
          (event) => event.type === "turn/end" && event.data?.turn === turnNumber,
        );
        if (!ended) {
          const userTurn = userEvent.data?.turn;
          if (typeof userTurn === "number") record.turnNumber = userTurn;
          const turn = this.enqueuePending(record);
          if (typeof userTurn === "number") turn.turnNumber = userTurn;
          this.activeBySession.set(record.sessionId, turn);
          continue;
        }
        const reason = ended.data?.reason?.kind ?? "completed";
        if (reason !== "completed") {
          await this.store.updateTurn(record.eventId, {
            state: "failed",
            error: `turn ${reason}`,
          });
          continue;
        }
        const text = lastAssistantText(events, turnNumber);
        if (!text || SKIP_PATTERN.test(text)) {
          await this.store.updateTurn(record.eventId, { state: "completed", text: "" });
          continue;
        }
        await this.store.updateTurn(record.eventId, { state: "reply_pending", text });
        try {
          await this.deliverReply(record, text);
          await this.store.updateTurn(record.eventId, { state: "completed", text });
        } catch (error) {
          this.logger.warn(
            `agent-room: recovered reply for ${record.eventId} is pending: ${errorText(error)}`,
          );
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  private async retryPrompt(record: PendingTurnRecord): Promise<void> {
    const controller = this.deps.ctx.get("sessionController") as SessionControllerLike | undefined;
    if (!controller) return;
    try {
      // Recovery follows the same rules as first delivery: resume the Agent,
      // register the waiter before prompting, then persist the acceptance.
      if (controller.resolveAgent) {
        const resolved = await controller.resolveAgent(record.sessionId);
        if (resolved.error) {
          throw new Error(`session agent is unavailable: ${JSON.stringify(resolved.error)}`);
        }
      }
      const pending = this.enqueuePending({ ...record, state: "prompting" });
      await this.store.updateTurn(record.eventId, { state: "prompting" });
      await controller.prompt(
        {
          requestId: record.requestId,
          sessionId: record.sessionId,
          mode: "queue",
          content: [{ type: "text", text: record.prompt }],
        },
        new AbortController().signal,
      );
      const current = this.store.getTurn(record.eventId);
      if (!current || !isTerminalTurnState(current.state)) {
        await this.store.updateTurn(record.eventId, { state: "awaiting_response" });
      }
      if (!this.activeBySession.has(record.sessionId)) {
        this.activeBySession.set(record.sessionId, pending);
      }
    } catch (error) {
      this.removePending(record.sessionId, record.eventId);
      await this.store.updateTurn(record.eventId, { state: "failed", error: errorText(error) });
    }
  }

  private async cancelTaskTurns(taskId: string, reason: string): Promise<boolean> {
    const activeStates = ["prompting", "awaiting_response", "reply_pending"] as const;
    const turns = this.store.listTurns(activeStates).filter((turn) => turn.taskId === taskId);
    const sessionId =
      this.taskSessions.get(taskId) ??
      turns[0]?.sessionId ??
      this.store.listTurns().find((turn) => turn.taskId === taskId)?.sessionId ??
      null;
    if (!sessionId) return false;
    // Persist cancellations before touching the Session so a restart cannot
    // resume a task the user already cancelled.
    for (const turn of turns) {
      await this.store.updateTurn(turn.eventId, { state: "cancelled", error: reason });
      if (this.activeBySession.get(turn.sessionId)?.eventId === turn.eventId) {
        this.activeBySession.delete(turn.sessionId);
      }
      const queue = this.pendingBySession.get(turn.sessionId);
      if (!queue) continue;
      const index = queue.findIndex((candidate) => candidate.eventId === turn.eventId);
      if (index >= 0) {
        const [removed] = queue.splice(index, 1);
        if (removed?.timer) clearTimeout(removed.timer);
      }
      if (queue.length === 0) this.pendingBySession.delete(turn.sessionId);
    }
    // Cancel the DSH Session only when no unrelated turn (another task or a
    // plain group message) still uses it; otherwise cancel just this task's turns.
    const stillBusy =
      (this.pendingBySession.get(sessionId)?.length ?? 0) > 0 ||
      this.activeBySession.has(sessionId) ||
      this.store
        .listTurns(activeStates)
        .some((turn) => turn.sessionId === sessionId && turn.taskId !== taskId);
    if (!stillBusy) {
      const controller = this.deps.ctx.get("sessionController") as
        SessionControllerLike | undefined;
      controller?.cancel({ sessionId });
    } else {
      this.logger.warn(
        `agent-room: task ${taskId} cancelled without stopping session ${sessionId} (other work is active)`,
      );
    }
    this.taskSessions.delete(taskId);
    this.logger.info(`agent-room: cancelled task ${taskId} on session ${sessionId}`);
    return true;
  }

  private async handleTaskCancel(command: TaskCancelCommand): Promise<void> {
    const cancelled = await this.cancelTaskTurns(command.taskId, "task cancelled");
    if (!cancelled) {
      // The recovery mapping may not be populated yet. Throwing leaves the
      // command unacknowledged so the server redelivers it after recovery.
      throw new Error(`task ${command.taskId} is not recovered yet`);
    }
  }

  private handleRecover(tasks: AgentTaskView[]): void {
    for (const view of tasks) {
      const task = view.task as { id?: string; groupId?: string };
      if (!task?.id || !task.groupId) continue;
      const mapping = this.mappings.get(task.groupId);
      if (mapping) this.taskSessions.set(task.id, mapping.sessionId);
    }
    this.logger.info(`agent-room: recovered ${tasks.length} owned task(s)`);
  }
}

interface SnapshotEvent {
  type?: string;
  data?: {
    turn?: number;
    source?: { rpcId?: string };
    reason?: { kind?: string };
    message?: { content?: readonly { type?: string; text?: string }[] };
  };
}

function lastAssistantText(events: readonly SnapshotEvent[], turn: number): string {
  let text = "";
  for (const event of events) {
    if (event.type !== "assistant/message" || event.data?.turn !== turn) continue;
    const candidate = extractAssistantText(event.data?.message?.content);
    if (candidate) text = candidate;
  }
  return text;
}

function renderPrompt(event: AgentEvent): string {
  const content = event.payload.content;
  return typeof content === "string" ? content : "";
}

function extractAssistantText(
  content: readonly { type?: string; text?: string }[] | undefined,
): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function isPermanentDeliveryError(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  return status === 400 || status === 403 || status === 404 || status === 409;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
