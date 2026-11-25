import type { FastifyInstance } from "fastify";
import { requireUserPrincipal } from "../auth/plugin.js";
import type { RoomContext } from "../modules/context.js";
import {
  consumeRealtimeTicket,
  handleRealtimeSocket,
  issueRealtimeTicket,
  type RealtimeSocket,
} from "../modules/realtime.js";

export interface RealtimeRouteDependencies {
  ctx: RoomContext;
  agentPresenceTtlMs?: number;
}

export function registerRealtimeRoutes(
  app: FastifyInstance,
  dependencies: RealtimeRouteDependencies,
): void {
  const { ctx, agentPresenceTtlMs } = dependencies;

  // Browsers cannot attach an Authorization header to a WebSocket upgrade, so
  // they exchange their authenticated REST session for a one-time ticket.
  app.post("/api/v1/realtime/ticket", async (request) => {
    const principal = requireUserPrincipal(request);
    const issued = issueRealtimeTicket(ctx, principal.userId);
    return { ticket: issued.ticket, expiresAt: issued.expiresAt };
  });

  app.get("/api/v1/realtime/ws", { websocket: true }, (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    const userId = consumeRealtimeTicket(ctx, url.searchParams.get("ticket"));
    if (!userId) {
      socket.close(1008, "invalid realtime ticket");
      return;
    }
    handleRealtimeSocket(
      ctx,
      socket as unknown as RealtimeSocket,
      userId,
      undefined,
      agentPresenceTtlMs,
    );
  });
}
