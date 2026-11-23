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
  getServerId,
  createAgentChallenge,
  liveSessionAgentIds,
  requireAgentSession,
  setAgentStatus,
  touchAgentSession,
} from "../modules/agentAuth.js";
import type { AgentHub, AgentSocket } from "../modules/agentHub.js";
import type { RoomContext } from "../modules/context.js";
import { UnauthorizedError, ValidationError } from "../modules/errors.js";
import {
  ackDelivery,
  listOutstandingDeliveries,
  markDeliveryDelivered,
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

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || undefined;
  }
  const url = new URL(request.url, "http://localhost");
  return url.searchParams.get("token") ?? undefined;
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

  app.get("/api/v1/agent/connect", { websocket: true }, (socket, request) => {
    const token = bearerToken(request);
    let identity: ReturnType<typeof requireAgentSession>;
    try {
      if (!token) throw new UnauthorizedError("missing agent session token");
      identity = requireAgentSession(ctx, token);
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
    const sent = new Set<string>();
    hub.register(agent.id, socket as unknown as AgentSocket);
    touchAgentSession(ctx, session.id);
    setAgentStatus(ctx, agent.id, "online", "connected");

    const deliverOutstanding = (): void => {
      const outstanding = listOutstandingDeliveries(ctx, { agentId: agent.id, limit: 100 });
      for (const delivery of outstanding) {
        if (sent.has(delivery.id)) continue;
        const event = ctx.db.select().from(events).where(eq(events.id, delivery.eventId)).get();
        if (!event) continue;
        if (delivery.status === "pending") {
          markDeliveryDelivered(ctx, { deliveryId: delivery.id, agentId: agent.id });
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
        sent.add(delivery.id);
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
      outstanding: listOutstandingDeliveries(ctx, { agentId: agent.id, limit: 200 }).length,
    });
    deliverOutstanding();

    const poll = setInterval(() => {
      try {
        deliverOutstanding();
      } catch (error) {
        app.log.warn({ err: error, agentId: agent.id }, "delivery poll failed");
      }
    }, 1_000);
    poll.unref();

    socket.on("message", (raw: Buffer) => {
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
        if (message.type === "event.ack") {
          const acked: string[] = [];
          for (const deliveryId of message.deliveryIds) {
            try {
              ackDelivery(ctx, { deliveryId, agentId: agent.id });
              acked.push(deliveryId);
              sent.delete(deliveryId);
            } catch {
              // Unknown or not-yet-delivered ids are reported as errors below.
            }
          }
          send(socket, { type: "ack.ok", deliveryIds: acked });
          return;
        }
        if (message.type === "message.send") {
          const posted = postMessage(ctx, {
            groupId: message.groupId,
            actor: { type: "agent", id: agent.id },
            content: message.content,
            threadId: message.threadId ?? undefined,
            rootMessageId: message.rootMessageId ?? undefined,
            clientMessageId: message.clientMessageId ?? undefined,
          });
          send(socket, {
            type: "message.sent",
            messageId: posted.id,
            seq: posted.seq,
            clientMessageId: posted.clientMessageId,
          });
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
          code: "command_failed",
          message: error instanceof Error ? error.message : "command failed",
        });
      }
    });

    socket.on("close", () => {
      clearInterval(poll);
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
