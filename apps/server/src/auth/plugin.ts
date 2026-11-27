import type { FastifyInstance } from "fastify";
import type { Config } from "@room/config";
import type { RoomContext } from "../modules/context.js";
import { requireAgentSession } from "../modules/agentAuth.js";
import { UnauthorizedError } from "../modules/errors.js";
import { AccessTokenVerifier, resolveAccessUser } from "./access.js";
import { resolveDevPrincipal } from "./dev.js";
import type { Principal } from "./principal.js";

/** Routes that must work before a principal exists. */
const PUBLIC_PATHS = new Set([
  "/healthz",
  "/readyz",
  "/ws",
  "/api/v1/agent/challenge",
  "/api/v1/agent/connect",
  "/api/v1/agent/socket-ticket",
  "/api/v1/realtime/ws",
  "/api/v1/auth-info",
]);

export interface AuthDependencies {
  config: Config;
  ctx: RoomContext;
  verifier?: AccessTokenVerifier;
}

export function createAccessVerifier(config: Config): AccessTokenVerifier | undefined {
  if (config.authMode !== "access") return undefined;
  return new AccessTokenVerifier({
    issuer: config.accessTeamDomain!,
    audience: config.accessAudience!,
  });
}

export async function registerAuth(
  app: FastifyInstance,
  dependencies: AuthDependencies,
): Promise<void> {
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] ?? request.url;
    // Only the versioned API needs a principal; health, 404s and the legacy
    // compatibility socket stay reachable so probes and tests are unaffected.
    if (!path.startsWith("/api/")) return;
    if (PUBLIC_PATHS.has(path)) return;
    // Agent endpoints authenticate their own opaque session token; they never
    // resolve a user principal.
    if (path.startsWith("/api/v1/agent/")) return;
    // Agent bearer tokens are never exchanged for a user principal, but the
    // prefix alone must not bypass user authentication: validate the session
    // before letting the route rely on it.
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Bearer agt_")) {
      const token = authorization.slice(7).trim();
      if (!token) throw new UnauthorizedError("agent bearer token required");
      requireAgentSession(dependencies.ctx, token);
      return;
    }
    if (dependencies.config.authMode === "dev") {
      request.principal = resolveDevPrincipal(
        dependencies.ctx,
        request.headers as Record<string, string | string[] | undefined>,
      );
      return;
    }
    const header = request.headers["cf-access-jwt-assertion"];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) throw new UnauthorizedError("missing Cf-Access-Jwt-Assertion header");
    const verifier = dependencies.verifier;
    if (!verifier) throw new UnauthorizedError("access verifier is not configured");
    const identity = await verifier.verify(token);
    request.principal = resolveAccessUser(dependencies.ctx, identity);
  });
}

export function requireUserPrincipal(request: {
  principal?: Principal;
}): Extract<Principal, { type: "user" }> {
  if (!request.principal || request.principal.type !== "user") {
    throw new UnauthorizedError("this endpoint requires a signed-in user");
  }
  return request.principal;
}
