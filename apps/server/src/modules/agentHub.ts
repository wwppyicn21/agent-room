/**
 * In-process registry of authenticated agent WebSockets. The hub never stores
 * durable state: presence and the inbox live in SQLite so a crash or restart
 * loses only the socket, never a delivery (plan §5.7).
 */
export interface AgentSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class AgentHub {
  private readonly sockets = new Map<string, Set<AgentSocket>>();

  register(agentId: string, socket: AgentSocket): void {
    const set = this.sockets.get(agentId) ?? new Set<AgentSocket>();
    set.add(socket);
    this.sockets.set(agentId, set);
  }

  unregister(agentId: string, socket: AgentSocket): void {
    const set = this.sockets.get(agentId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(agentId);
  }

  /** Sends a frame to every live socket of the agent; returns the send count. */
  send(agentId: string, message: unknown): number {
    const set = this.sockets.get(agentId);
    if (!set || set.size === 0) return 0;
    const payload = JSON.stringify(message);
    let sent = 0;
    for (const socket of set) {
      try {
        socket.send(payload);
        sent += 1;
      } catch {
        set.delete(socket);
      }
    }
    if (set.size === 0) this.sockets.delete(agentId);
    return sent;
  }

  /** Notifies the agent and drops its sockets, e.g. after a key revocation. */
  closeAgent(agentId: string, reason: string): number {
    const set = this.sockets.get(agentId);
    if (!set) return 0;
    const payload = JSON.stringify({ type: "error", code: "session_closed", message: reason });
    for (const socket of set) {
      try {
        socket.send(payload);
      } catch {
        // A dead socket needs no further notification.
      }
      try {
        socket.close(1008, reason);
      } catch {
        // Already closed.
      }
    }
    this.sockets.delete(agentId);
    return set.size;
  }

  has(agentId: string): boolean {
    return (this.sockets.get(agentId)?.size ?? 0) > 0;
  }

  count(): number {
    let total = 0;
    for (const set of this.sockets.values()) total += set.size;
    return total;
  }
}
