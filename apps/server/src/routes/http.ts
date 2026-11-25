import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { rbacRoleSchema } from "@room/protocol";
import type { AgentHub } from "../modules/agentHub.js";
import {
  addAgentKey,
  getAgent,
  listAgentKeys,
  listAgents,
  registerAgentWithKey,
  revokeAgentKey,
} from "../modules/agents.js";
import { closeAgentSessionsForKey, getServerId } from "../modules/agentAuth.js";
import type { RoomContext } from "../modules/context.js";
import { ForbiddenError, ValidationError } from "../modules/errors.js";
import { normalizeEd25519PublicKey } from "../modules/keys.js";
import { recordAudit } from "../modules/audit.js";
import { createUser, disableUser, enableUser, listUsers, setUserRole } from "../modules/users.js";
import { requireUserPrincipal } from "../auth/plugin.js";

export interface HttpRouteDependencies {
  ctx: RoomContext;
  hub: AgentHub;
}

const createUserBodySchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).optional(),
  role: rbacRoleSchema.optional(),
});

const registerAgentBodySchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  runtime: z.string().trim().min(1).max(60),
  model: z.string().trim().max(120).optional(),
  capabilities: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  publicKey: z.string().min(32).max(4096),
});

const addKeyBodySchema = z.object({
  publicKey: z.string().min(32).max(4096),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
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

function params<T>(request: FastifyRequest): T {
  return request.params as T;
}

export function registerHttpRoutes(app: FastifyInstance, deps: HttpRouteDependencies): void {
  const { ctx, hub } = deps;

  app.get("/api/v1/me", async (request) => {
    const principal = requireUserPrincipal(request);
    return {
      user: {
        id: principal.userId,
        displayName: principal.displayName,
        email: principal.email,
        role: principal.role,
      },
      server: { serverId: getServerId(ctx) },
    };
  });

  app.get("/api/v1/users", async (request) => {
    const principal = requireUserPrincipal(request);
    const users = listUsers(ctx, { actorUserId: principal.userId });
    return { users };
  });

  app.post("/api/v1/users", async (request) => {
    const principal = requireUserPrincipal(request);
    const body = parseBody(createUserBodySchema, request.body);
    const user = createUser(ctx, {
      displayName: body.displayName,
      email: body.email ?? null,
      role: body.role,
      actorUserId: principal.userId,
    });
    return { user };
  });

  app.patch("/api/v1/users/:userId", async (request) => {
    const principal = requireUserPrincipal(request);
    const { userId } = params<{ userId: string }>(request);
    const body = parseBody(z.object({ role: rbacRoleSchema }), request.body);
    return {
      user: setUserRole(ctx, {
        userId,
        role: body.role,
        actorUserId: principal.userId,
      }),
    };
  });

  app.post("/api/v1/users/:userId/disable", async (request) => {
    const principal = requireUserPrincipal(request);
    const { userId } = params<{ userId: string }>(request);
    return { user: disableUser(ctx, { userId, actorUserId: principal.userId }) };
  });

  app.post("/api/v1/users/:userId/enable", async (request) => {
    const principal = requireUserPrincipal(request);
    const { userId } = params<{ userId: string }>(request);
    return { user: enableUser(ctx, { userId, actorUserId: principal.userId }) };
  });

  app.get("/api/v1/agents", async (request) => {
    const principal = requireUserPrincipal(request);
    return { agents: listAgents(ctx, { actorUserId: principal.userId }) };
  });

  app.post("/api/v1/agents", async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const body = parseBody(registerAgentBodySchema, request.body);
    const result = registerAgentWithKey(ctx, {
      displayName: body.displayName,
      runtime: body.runtime,
      model: body.model ?? null,
      capabilities: body.capabilities,
      publicKey: body.publicKey,
      actorUserId: principal.userId,
    });
    return reply.status(201).send({
      agent: result.agent,
      key: {
        id: result.key.id,
        fingerprint: result.key.fingerprint,
        algorithm: result.key.algorithm,
        status: result.key.status,
      },
    });
  });

  app.get("/api/v1/agents/:agentId", async (request) => {
    const principal = requireUserPrincipal(request);
    if (principal.role !== "owner" && principal.role !== "admin") {
      throw new ForbiddenError("only owners and admins can inspect any agent");
    }
    return { agent: getAgent(ctx, params<{ agentId: string }>(request).agentId) };
  });

  app.get("/api/v1/agents/:agentId/keys", async (request) => {
    const principal = requireUserPrincipal(request);
    return {
      keys: listAgentKeys(ctx, {
        agentId: params<{ agentId: string }>(request).agentId,
        actorUserId: principal.userId,
      }),
    };
  });

  app.post("/api/v1/agents/:agentId/keys", async (request, reply) => {
    const principal = requireUserPrincipal(request);
    const agentId = params<{ agentId: string }>(request).agentId;
    const body = parseBody(addKeyBodySchema, request.body);
    const normalized = normalizeEd25519PublicKey(body.publicKey);
    const key = addAgentKey(ctx, {
      agentId,
      publicKey: normalized.publicKey,
      fingerprint: normalized.fingerprint,
      actorUserId: principal.userId,
    });
    return reply.status(201).send({
      key: {
        id: key.id,
        fingerprint: key.fingerprint,
        algorithm: key.algorithm,
        status: key.status,
      },
    });
  });

  app.post("/api/v1/agents/:agentId/keys/:keyId/revoke", async (request) => {
    const principal = requireUserPrincipal(request);
    const { agentId, keyId } = params<{ agentId: string; keyId: string }>(request);
    const key = revokeAgentKey(ctx, { keyId, actorUserId: principal.userId });
    const affected = closeAgentSessionsForKey(ctx, keyId, "key-revoked");
    for (const id of affected) hub.closeAgent(id, "key revoked");
    recordAudit(ctx.db, {
      actorType: "user",
      actorId: principal.userId,
      action: "agent.key_revoke.disconnect",
      targetType: "agent",
      targetId: agentId,
      metadata: { keyId, sessionsClosed: affected.length },
      createdAt: ctx.now(),
    });
    return {
      key: { id: key.id, status: key.status, revokedAt: key.revokedAt },
      sessionsClosed: affected.length,
    };
  });
}
