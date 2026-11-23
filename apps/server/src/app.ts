import websocket from "@fastify/websocket";
import type { Config } from "@room/config";
import type { DatabaseHandle } from "@room/database";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { createAccessVerifier, registerAuth } from "./auth/plugin.js";
import type { AccessTokenVerifier } from "./auth/access.js";
import { AgentHub } from "./modules/agentHub.js";
import { createRoomContext, type RoomContext } from "./modules/context.js";
import { DomainError } from "./modules/errors.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerHttpRoutes } from "./routes/http.js";

export interface BuildAppOptions {
  config: Config;
  database: DatabaseHandle;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Tests can inject a local-JWKS verifier instead of fetching team JWKS. */
  accessVerifier?: AccessTokenVerifier;
}

declare module "fastify" {
  interface FastifyInstance {
    roomConfig: Config;
    roomDatabase: DatabaseHandle;
    roomContext: RoomContext;
    agentHub: AgentHub;
  }
}

export async function buildApp({
  config,
  database,
  now,
  accessVerifier: injectedAccessVerifier,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
    },
  });
  const ctx = createRoomContext(database, now);
  const hub = new AgentHub();

  app.decorate("roomConfig", config);
  app.decorate("roomDatabase", database);
  app.decorate("roomContext", ctx);
  app.decorate("agentHub", hub);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof DomainError) {
      request.log.info({ err: error, code: error.code }, "request rejected");
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    const statusCode = error.statusCode ?? 500;
    request.log.error({ err: error }, "request failed");
    return reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? "internal_error" : "bad_request",
        message: statusCode >= 500 ? "Internal Server Error" : error.message,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: { code: "not_found", message: `Route ${request.method} ${request.url} not found` },
    });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async () => {
    database.sqlite.prepare("select 1").get();
    return { status: "ready", database: "ok" };
  });

  await app.register(websocket);

  const accessVerifier = injectedAccessVerifier ?? createAccessVerifier(config);
  await registerAuth(app, { config, ctx, verifier: accessVerifier });
  registerAgentRoutes(app, { config, ctx, hub });
  registerHttpRoutes(app, { ctx, hub });

  // Legacy shell endpoint kept for compatibility; business traffic uses the
  // authenticated `/api/v1/agent/connect` socket.
  app.get("/ws", { websocket: true }, (socket) => {
    socket.send(
      JSON.stringify({ type: "hello", server: "agent-room", time: new Date().toISOString() }),
    );

    socket.on("message", (raw: Buffer) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", code: "invalid_json" }));
        return;
      }

      if (typeof message === "object" && message !== null && "type" in message) {
        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", time: new Date().toISOString() }));
          return;
        }
      }
      socket.send(JSON.stringify({ type: "error", code: "unknown_type" }));
    });

    socket.on("error", (error: Error) => {
      app.log.warn({ err: error }, "websocket error");
    });
  });

  return app;
}
