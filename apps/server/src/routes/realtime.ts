import type { FastifyInstance } from "fastify";
import { requireUserPrincipal } from "../auth/plugin.js";
import type { RoomContext } from "../modules/context.js";
import {
  REALTIME_TICKET_TTL_MS,
  consumeRealtimeTicket,
  handleRealtimeSocket,
  isRealtimeOriginAllowed,
  issueRealtimeTicket,
  type RealtimeHub,
  type RealtimeSocket,
} from "../modules/realtime.js";

export interface RealtimeRouteDependencies {
  ctx: RoomContext;
  hub: RealtimeHub;
  agentPresenceTtlMs?: number;
  allowedOrigins: readonly string[];
  maxConnectionsPerUser: number;
  ticketsPerMinute: number;
}

export function registerRealtimeRoutes(
  app: FastifyInstance,
  dependencies: RealtimeRouteDependencies,
): void {
  const { ctx, hub, agentPresenceTtlMs } = dependencies;

  // Browsers cannot attach an Authorization header to a WebSocket upgrade, so
  // they exchange their authenticated REST session for a one-time ticket.
  app.post("/api/v1/realtime/ticket", async (request) => {
    const principal = requireUserPrincipal(request);
    const issued = issueRealtimeTicket(
      ctx,
      principal.userId,
      REALTIME_TICKET_TTL_MS,
      dependencies.ticketsPerMinute,
    );
    return { ticket: issued.ticket, expiresAt: issued.expiresAt };
  });

  app.get("/api/v1/realtime/ws", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (
      !isRealtimeOriginAllowed(
        typeof origin === "string" ? origin : undefined,
        dependencies.allowedOrigins,
        request.headers.host,
      )
    ) {
      socket.close(1008, "origin not allowed");
      return;
    }
    const url = new URL(request.url, "http://localhost");
    const userId = consumeRealtimeTicket(ctx, url.searchParams.get("ticket"));
    if (!userId) {
      socket.close(1008, "invalid realtime ticket");
      return;
    }
    if (hub.countForUser(userId) >= dependencies.maxConnectionsPerUser) {
      socket.close(1008, "too many realtime connections");
      return;
    }
    handleRealtimeSocket(ctx, socket as unknown as RealtimeSocket, userId, {
      presenceTtlMs: agentPresenceTtlMs,
      hub,
    });
  });
}
