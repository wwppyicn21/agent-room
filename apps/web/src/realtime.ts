import type { ApiClient, EventRow } from "./api";

export interface PresenceAgent {
  agentId: string;
  displayName: string;
  status: string;
  online: boolean;
}

export interface Presence {
  groupId: string;
  agents: PresenceAgent[];
}

export interface RealtimeHandlers {
  onEvent(event: EventRow): void;
  onPresence(presence: Presence): void;
  onState(state: "connecting" | "open" | "closed", error?: string): void;
}

type Frame =
  | { type: "subscribed"; groupId: string; afterSeq: number }
  | { type: "event"; event: EventRow }
  | { type: "presence"; groupId: string; agents: PresenceAgent[] }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private closed = false;
  private afterSeq: number;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 500;

  constructor(
    private readonly api: ApiClient,
    private readonly groupId: string,
    private readonly handlers: RealtimeHandlers,
    afterSeq = 0,
  ) {
    this.afterSeq = afterSeq;
  }

  connect(): void {
    this.closed = false;
    void this.open();
  }

  /** Drop the current socket; the normal close handler reconnects with the cursor. */
  dropConnection(): void {
    this.socket?.close(1000, "test drop");
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.socket?.close(1000, "client closed");
    this.socket = null;
    this.handlers.onState("closed");
  }

  private clearTimers(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    this.retry = null;
    this.ping = null;
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    this.handlers.onState("connecting");
    try {
      const { ticket } = await this.api.realtimeTicket();
      if (this.closed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/api/v1/realtime/ws?ticket=${encodeURIComponent(ticket)}`,
      );
      this.socket = socket;
      socket.onopen = () => {
        this.backoffMs = 500;
        socket.send(
          JSON.stringify({ type: "subscribe", groupId: this.groupId, afterSeq: this.afterSeq }),
        );
        this.ping = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, 20_000);
      };
      socket.onmessage = (message) => this.handleFrame(message.data);
      socket.onerror = () => this.handlers.onState("closed", "websocket error");
      socket.onclose = (event) => {
        this.stopSocket();
        if (this.closed) return;
        this.handlers.onState("closed", event.reason || "connection closed");
        this.scheduleReconnect();
      };
    } catch (error) {
      if (this.closed) return;
      this.handlers.onState("closed", error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
    }
  }

  private stopSocket(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retry) return;
    const delay = Math.min(this.backoffMs, 30_000);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.open();
    }, delay);
  }

  private handleFrame(raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (frame.type === "subscribed") {
      this.handlers.onState("open");
      return;
    }
    if (frame.type === "event") {
      if (frame.event.seq > this.afterSeq) this.afterSeq = frame.event.seq;
      this.handlers.onEvent(frame.event);
      return;
    }
    if (frame.type === "presence") {
      this.handlers.onPresence({ groupId: frame.groupId, agents: frame.agents });
      return;
    }
    if (frame.type === "error") {
      this.handlers.onState("closed", frame.message);
    }
  }
}
