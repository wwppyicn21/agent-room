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
import { DeliveryStore } from "./store.js";

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

interface PendingTurn {
  eventId: string;
  groupId: string;
  threadId: string | null;
  replyToMessageId: string | null;
  text: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const SKIP_PATTERN = /^\[skip\](?:\s|$)/i;

/**
 * Bridges explicitly mapped Room groups to DSH sessions. Room authentication,
 * leases and acks stay in @room/agent-sdk; this class only maps deliveries to
 * prompts, extracts the public assistant output and posts it back.
 */
export class RoomBridge {
  private readonly config: PluginConfig;
  private readonly deps: BridgeDeps;
  private readonly logger: DshLogger;
  private readonly store: DeliveryStore;
  private readonly mappings = new Map<
    string,
    { groupId: string; sessionId: string; label: string }
  >();
  private readonly validSessions = new Set<string>();
  private readonly pendingBySession = new Map<string, PendingTurn[]>();
  private readonly taskSessions = new Map<string, string>();
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
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const turns of this.pendingBySession.values()) {
      for (const turn of turns) if (turn.timer) clearTimeout(turn.timer);
    }
    this.pendingBySession.clear();
    if (typeof this.disposeSessionEvents === "function") this.disposeSessionEvents();
    this.disposeSessionEvents = undefined;
    this.client?.close();
    this.client = null;
    this.connected = false;
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
      this.lastError = errorText(error);
      this.connected = false;
      this.logger.error(`agent-room: connect failed: ${this.lastError}`);
      this.scheduleReconnect();
    });
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || !this.keys) return;
    if (!this.client) {
      this.client = this.createClient();
    }
    await this.client.connect();
    const hello = await this.client.open();
    this.agentId = hello.agentId;
    this.connected = true;
    this.lastError = null;
    this.reconnectAttempts = 0;
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
    if (event.eventType !== "message.created") return;
    const groupId = event.groupId;
    if (!groupId) return;
    const senderType = typeof event.payload.senderType === "string" ? event.payload.senderType : "";
    const senderId = typeof event.payload.senderId === "string" ? event.payload.senderId : "";
    if (senderType === "system") return;
    if (senderType === "agent" && this.agentId && senderId === this.agentId) return;
    if (this.store.state(event.eventId) === "completed") return;
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
    await this.store.begin(event.eventId);
    await this.store.markProcessing(event.eventId);
    const controller = this.deps.ctx.get("sessionController") as SessionControllerLike | undefined;
    if (!controller) {
      await this.store.markFailed(event.eventId, "sessionController service is unavailable");
      this.lastError = "sessionController service is unavailable";
      this.logger.error("agent-room: sessionController service is unavailable");
      return;
    }
    const threadId = event.threadId ?? null;
    const taskId = event.taskId ?? null;
    if (taskId) this.taskSessions.set(taskId, mapping.sessionId);
    const text = renderPrompt(event, mapping, this.config.replyPrefix);
    try {
      await controller.prompt(
        {
          requestId: `room-${event.eventId}`,
          sessionId: mapping.sessionId,
          mode: "queue",
          content: [{ type: "text", text }],
        },
        undefined,
      );
      await this.store.markCompleted(event.eventId);
      this.enqueuePending(
        {
          eventId: event.eventId,
          groupId,
          threadId,
          replyToMessageId:
            typeof event.payload.messageId === "string" ? event.payload.messageId : null,
          text: "",
          timer: null,
        },
        mapping.sessionId,
      );
    } catch (error) {
      const reason = errorText(error);
      await this.store.markFailed(event.eventId, reason);
      this.lastError = reason;
      this.logger.error(`agent-room: prompt for ${event.eventId} failed: ${reason}`);
    }
  }

  private enqueuePending(turn: PendingTurn, sessionId: string): void {
    const queue = this.pendingBySession.get(sessionId) ?? [];
    turn.timer = setTimeout(() => {
      const current = this.pendingBySession.get(sessionId);
      if (!current) return;
      const index = current.indexOf(turn);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.pendingBySession.delete(sessionId);
      this.logger.warn(`agent-room: turn for ${turn.eventId} timed out; no reply sent`);
    }, this.config.turnTimeoutMs);
    turn.timer.unref?.();
    queue.push(turn);
    this.pendingBySession.set(sessionId, queue);
  }

  private handleSessionEvent(sessionId: string, event: DshSessionEvent): void {
    const queue = this.pendingBySession.get(sessionId);
    if (!queue || queue.length === 0) return;
    const turn = queue[0];
    if (event.type === "assistant/message") {
      const text = extractAssistantText(event.data?.message?.content);
      if (text) turn.text = text;
      return;
    }
    if (event.type !== "turn/end") return;
    if (turn.timer) clearTimeout(turn.timer);
    queue.shift();
    if (queue.length === 0) this.pendingBySession.delete(sessionId);
    const reason = event.data?.reason?.kind ?? "completed";
    if (reason !== "completed") {
      this.logger.warn(`agent-room: turn for ${turn.eventId} ended with ${reason}; no reply`);
      return;
    }
    const text = turn.text.trim();
    if (!text || SKIP_PATTERN.test(text)) {
      this.logger.info(`agent-room: agent skipped ${turn.eventId}`);
      return;
    }
    const content = truncate(`${this.config.replyPrefix}${text}`, this.config.maxReplyChars);
    this.client?.sendMessage(turn.groupId, content, {
      threadId: turn.threadId ?? undefined,
      replyToMessageId: turn.replyToMessageId ?? undefined,
      clientMessageId: `plugin-reply-${turn.eventId}`,
    });
  }

  private async handleTaskCancel(command: TaskCancelCommand): Promise<void> {
    const sessionId = this.taskSessions.get(command.taskId) ?? null;
    if (!sessionId) {
      this.logger.warn(
        `agent-room: cancel for task ${command.taskId} has no known session; ignoring`,
      );
      return;
    }
    const controller = this.deps.ctx.get("sessionController") as SessionControllerLike | undefined;
    if (!controller) return;
    controller.cancel({ sessionId });
    const queue = this.pendingBySession.get(sessionId);
    for (const turn of queue ?? []) if (turn.timer) clearTimeout(turn.timer);
    this.pendingBySession.delete(sessionId);
    this.taskSessions.delete(command.taskId);
    this.logger.info(`agent-room: cancelled session ${sessionId} for task ${command.taskId}`);
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

function renderPrompt(
  event: AgentEvent,
  mapping: { groupId: string; sessionId: string; label: string },
  _prefix: string,
): string {
  const payload = event.payload;
  const senderType = typeof payload.senderType === "string" ? payload.senderType : "unknown";
  const senderId = typeof payload.senderId === "string" ? payload.senderId : "unknown";
  const content = typeof payload.content === "string" ? payload.content : "";
  const messageId = typeof payload.messageId === "string" ? payload.messageId : event.eventId;
  const lines = [
    "[Agent Room message]",
    `group: ${mapping.label || mapping.groupId}`,
    `group_id: ${mapping.groupId}`,
    `thread_id: ${event.threadId ?? "-"}`,
    `task_id: ${event.taskId ?? "-"}`,
    `message_id: ${messageId}`,
    `sender: ${senderType}:${senderId}`,
    `reply_to: ${typeof payload.replyToMessageId === "string" ? payload.replyToMessageId : "-"}`,
    "",
    content,
  ];
  return lines.join("\n");
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

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
