import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodType } from "zod";
import { events } from "@room/database";
import type { Config } from "@room/config";
import {
  AGENT_PROTOCOL_VERSION,
  agentChallengeRequestSchema,
  agentClientMessageSchema,
  agentConnectRequestSchema,
  toIso,
} from "@room/protocol";
import {
  closeAgentSession,
  connectAgent,
  consumeSocketTicket,
  getServerId,
  createAgentChallenge,
  isSessionExpired,
  issueSocketTicket,
  liveSessionAgentIds,
  requireAgentSession,
  requireAgentSessionById,
  setAgentStatus,
  touchAgentSession,
} from "../modules/agentAuth.js";
import type { AgentHub, AgentSocket } from "../modules/agentHub.js";
import type { RoomContext } from "../modules/context.js";
import { isGroupMember } from "../modules/permissions.js";
import {
  ackCommand,
  countUnackedCommands,
  listAgentCommands,
  markCommandDelivered,
} from "../modules/agentCommands.js";
import { DomainError, UnauthorizedError, ValidationError } from "../modules/errors.js";
import {
  ackDelivery,
  failDelivery,
  listOutstandingDeliveries,
  markDeliveryDelivered,
  MAX_DELIVERY_ATTEMPTS,
  redeliverDelivery,
} from "../modules/events.js";
import { postMessage } from "../modules/messages.js";

export interface AgentRouteDependencies {
  config: Config;
  ctx: RoomContext;
  hub: AgentHub;
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new ValidationError(
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; "),
    );
  }
  return result.data;
}

/**
 * Session tokens only travel in the Authorization header. WebSocket upgrades
 * use a short-lived single-use ticket instead, so long-lived credentials never
 * end up in URLs (and therefore never in access logs).
 */
function sessionTokenFromHeader(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || undefined;
  }
  return undefined;
}

function send(socket: AgentSocket, message: unknown): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket is gone; the close handler cleans up.
  }
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDependencies): void {
  const { ctx, config, hub } = deps;

  app.post("/api/v1/agent/challenge", async (request) => {
    const body = parseBody(agentChallengeRequestSchema, request.body);
    const view = createAgentChallenge(ctx, {
      fingerprint: body.fingerprint,
      agentId: body.agentId,
      clientNonce: body.clientNonce,
      ttlMs: config.agentChallengeTtlMs,
    });
    return {
      protocolVersion: view.protocolVersion,
      serverId: view.serverId,
      challengeId: view.challengeId,
      nonce: view.nonce,
      clientNonce: view.clientNonce,
      agentId: view.agentId,
      keyFingerprint: view.keyFingerprint,
      expiresAt: toIso(view.expiresAt),
      purpose: view.purpose,
    };
  });

  app.post("/api/v1/agent/connect", async (request) => {
    const body = parseBody(agentConnectRequestSchema, request.body);
    const result = connectAgent(ctx, {
      challengeId: body.challengeId,
      signature: body.signature,
      sessionTtlMs: config.agentSessionTtlMs,
    });
    const capabilities = JSON.parse(result.agent.capabilities) as string[];
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionToken: result.sessionToken,
      expiresAt: toIso(result.expiresAt),
      agent: {
        id: result.agent.id,
        displayName: result.agent.displayName,
        runtime: result.agent.runtime,
        capabilities,
      },
    };
  });

  app.post("/api/v1/agent/socket-ticket", async (request) => {
    const token = sessionTokenFromHeader(request);
    if (!token) throw new UnauthorizedError("missing agent session token");
    const identity = requireAgentSession(ctx, token);
    const ticket = issueSocketTicket(ctx, {
      sessionId: identity.session.id,
      ttlMs: config.agentSocketTicketTtlMs,
    });
    return { ticket: ticket.token, expiresAt: toIso(ticket.expiresAt) };
  });

  app.get("/api/v1/agent/connect", { websocket: true }, (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    const ticket = url.searchParams.get("ticket");
    const headerToken = sessionTokenFromHeader(request);
    let identity: ReturnType<typeof requireAgentSession>;
    try {
      if (headerToken) {
        identity = requireAgentSession(ctx, headerToken);
      } else if (ticket) {
        identity = requireAgentSessionById(ctx, consumeSocketTicket(ctx, ticket));
      } else {
        throw new UnauthorizedError("missing agent session ticket");
      }
    } catch (error) {
      send(socket, {
        type: "error",
        code: "unauthorized",
        message: error instanceof Error ? error.message : "unauthorized",
      });
      socket.close(1008, "unauthorized");
      return;
    }

    const { agent, session } = identity;
    const capabilities = JSON.parse(agent.capabilities) as string[];
    const timers: { poll?: NodeJS.Timeout; expiryTimer?: NodeJS.Timeout } = {};
    let closed = false;

    const sessionExpired = (): boolean => isSessionExpired(session, ctx.now());

    /**
     * TTL is enforced on live connections, not only at upgrade time: the timer
     * closes idle sockets and every inbound frame re-checks the deadline.
     */
    const closeForExpiry = (): void => {
      if (closed) return;
      closed = true;
      if (timers.poll) clearInterval(timers.poll);
      if (timers.expiryTimer) clearTimeout(timers.expiryTimer);
      send(socket, {
        type: "error",
        code: "session_expired",
        message: "agent session has expired",
      });
      try {
        closeAgentSession(ctx, session.id, "expired");
        if (!liveSessionAgentIds(ctx, config.agentPresenceTtlMs).has(agent.id)) {
          setAgentStatus(ctx, agent.id, "offline", "session-expired");
        }
      } catch (error) {
        app.log.warn({ err: error, agentId: agent.id }, "expired session cleanup failed");
      }
      try {
        socket.close(1008, "session expired");
      } catch {
        // already closing
      }
    };
    hub.register(agent.id, socket as unknown as AgentSocket);
    touchAgentSession(ctx, session.id);
    setAgentStatus(ctx, agent.id, "online", "connected");

    const deliverOutstanding = (includeUnacked = false): void => {
      const outstanding = listOutstandingDeliveries(ctx, {
        agentId: agent.id,
        limit: 100,
        includeUnacked,
      });
      for (const delivery of outstanding) {
        if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
          try {
            failDelivery(ctx, {
              deliveryId: delivery.id,
              agentId: agent.id,
              error: "max delivery attempts reached",
            });
          } catch (error) {
            app.log.warn({ err: error, deliveryId: delivery.id }, "delivery quarantine failed");
          }
          continue;
        }
        const event = ctx.db.select().from(events).where(eq(events.id, delivery.eventId)).get();
        if (!event) continue;
        // Membership may have been revoked after the delivery row was listed.
        if (event.groupId && !isGroupMember(ctx.db, event.groupId, "agent", agent.id)) {
          try {
            failDelivery(ctx, {
              deliveryId: delivery.id,
              agentId: agent.id,
              error: "group membership revoked",
            });
          } catch (error) {
            app.log.warn({ err: error, deliveryId: delivery.id }, "delivery revocation failed");
          }
          continue;
        }
        if (delivery.status === "pending") {
          markDeliveryDelivered(ctx, { deliveryId: delivery.id, agentId: agent.id });
        } else {
          // Leased but unacked: retry with the same delivery id.
          redeliverDelivery(ctx, { deliveryId: delivery.id, agentId: agent.id });
        }
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(event.payload) as Record<string, unknown>;
        } catch {
          payload = {};
        }
        send(socket, {
          type: "event.deliver",
          protocolVersion: AGENT_PROTOCOL_VERSION,
          deliveryId: delivery.id,
          event: {
            eventId: event.id,
            eventType: event.type,
            timestamp: toIso(event.createdAt),
            correlationId: event.id,
            causationId: null,
            groupId: event.groupId,
            threadId: event.threadId,
            taskId: event.taskId,
            payload,
          },
        });
      }
    };

    const deliverCommands = (includeDelivered = false): void => {
      const commands = listAgentCommands(ctx, { agentId: agent.id, includeDelivered });
      for (const command of commands) {
        if (command.status === "pending") {
          markCommandDelivered(ctx, { commandId: command.id, agentId: agent.id });
        }
        send(socket, {
          type: "command",
          protocolVersion: AGENT_PROTOCOL_VERSION,
          command: {
            commandId: command.id,
            type: command.commandType,
            taskId: command.taskId,
            runId: command.runId,
            reason: command.reason,
            createdAt: toIso(command.createdAt),
          },
        });
      }
    };

    send(socket, {
      type: "hello",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      serverId: getServerId(ctx),
      heartbeatMs: config.agentHeartbeatMs,
      sessionExpiresAt: toIso(session.expiresAt),
      agent: {
        id: agent.id,
        displayName: agent.displayName,
        runtime: agent.runtime,
        capabilities,
      },
      outstanding: listOutstandingDeliveries(ctx, {
        agentId: agent.id,
        limit: 200,
        includeUnacked: true,
      }).length,
      outstandingCommands: countUnackedCommands(ctx, agent.id),
    });
    deliverOutstanding(true);
    deliverCommands(true);

    timers.poll = setInterval(() => {
      if (closed) return;
      try {
        if (sessionExpired()) {
          closeForExpiry();
          return;
        }
        deliverOutstanding();
        deliverCommands();
      } catch (error) {
        app.log.warn({ err: error, agentId: agent.id }, "delivery poll failed");
      }
    }, 1_000);
    timers.poll.unref();

    timers.expiryTimer = setTimeout(closeForExpiry, Math.max(0, session.expiresAt - ctx.now()));
    timers.expiryTimer.unref();

    socket.on("message", (raw: Buffer) => {
      if (closed) return;
      if (sessionExpired()) {
        closeForExpiry();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", code: "invalid_json", message: "frame is not valid JSON" });
        return;
      }
      const result = agentClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        send(socket, {
          type: "error",
          code: "invalid_message",
          message: result.error.issues.map((issue) => issue.message).join("; "),
        });
        return;
      }
      touchAgentSession(ctx, session.id);
      const message = result.data;
      try {
        if (message.type === "ping") {
          send(socket, {
            type: "pong",
            time: toIso(ctx.now()),
            serverId: getServerId(ctx),
          });
          return;
        }
        if (message.type === "command.ack") {
          const command = ackCommand(ctx, { commandId: message.commandId, agentId: agent.id });
          send(socket, { type: "command.ack.ok", commandId: command.id });
          return;
        }
        if (message.type === "event.ack") {
          const acked: string[] = [];
          for (const deliveryId of message.deliveryIds) {
            try {
              ackDelivery(ctx, { deliveryId, agentId: agent.id });
              acked.push(deliveryId);
            } catch {
              // Unknown or not-yet-delivered ids are reported as errors below.
            }
          }
          send(socket, { type: "ack.ok", deliveryIds: acked });
          return;
        }
        if (message.type === "message.send") {
          try {
            const posted = postMessage(ctx, {
              groupId: message.groupId,
              actor: { type: "agent", id: agent.id },
              content: message.content,
              threadId: message.threadId ?? undefined,
              rootMessageId: message.rootMessageId ?? undefined,
              replyToMessageId: message.replyToMessageId ?? undefined,
              clientMessageId: message.clientMessageId ?? undefined,
              presenceTtlMs: config.agentPresenceTtlMs,
            });
            send(socket, {
              type: "message.sent",
              messageId: posted.id,
              seq: posted.seq,
              clientMessageId: posted.clientMessageId,
            });
          } catch (error) {
            const code = error instanceof DomainError ? error.code : "internal_error";
            send(socket, {
              type: "error",
              code,
              message: error instanceof Error ? error.message : "message send failed",
              clientMessageId: message.clientMessageId ?? null,
            });
          }
          return;
        }
        if (message.type === "agent.status") {
          if (message.status === "offline") {
            setAgentStatus(ctx, agent.id, "offline", "agent-requested-offline");
            closeAgentSession(ctx, session.id, "agent-requested-offline");
            hub.closeAgent(agent.id, "agent requested offline");
          } else {
            setAgentStatus(ctx, agent.id, "online", "agent-requested-online");
          }
        }
      } catch (error) {
        send(socket, {
          type: "error",
          code: error instanceof DomainError ? error.code : "command_failed",
          message: error instanceof Error ? error.message : "command failed",
        });
      }
    });

    socket.on("close", () => {
      closed = true;
      if (timers.poll) clearInterval(timers.poll);
      if (timers.expiryTimer) clearTimeout(timers.expiryTimer);
      // Cleanup can race with a server shutdown that already closed the
      // database; failing to persist "offline" must never crash the process.
      try {
        hub.unregister(agent.id, socket as unknown as AgentSocket);
        closeAgentSession(ctx, session.id, "socket-closed");
        if (!liveSessionAgentIds(ctx, config.agentPresenceTtlMs).has(agent.id)) {
          setAgentStatus(ctx, agent.id, "offline", "socket-closed");
        }
      } catch (error) {
        app.log.warn({ err: error, agentId: agent.id }, "agent socket cleanup failed");
      }
    });

    socket.on("error", (error: Error) => {
      app.log.warn({ err: error, agentId: agent.id }, "agent websocket error");
    });
  });
}
