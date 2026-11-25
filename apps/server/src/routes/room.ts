import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RoomContext } from "../modules/context.js";
import {
  addMember,
  createGroup,
  getGroup,
  listGroupMembers,
  listGroupsForAgent,
  listGroupsForUser,
  removeMember,
  updateGroup,
  updateMemberRole,
  updateGroupAISettings,
} from "../modules/groups.js";
import {
  deleteMessage,
  getMessage,
  listMessages,
  listThreadMessages,
  listThreadMessagesForAgent,
  postMessage,
} from "../modules/messages.js";
import { closeThread, createThread, getThreadDetail, listThreads } from "../modules/threads.js";
import {
  assignTask,
  cancelTask,
  completeTask,
  createTaskFromMessage,
  getAgentTask,
  getTask,
  listAgentTasks,
  listTasks,
  pauseTask,
  reportTaskProgress,
  resumeTask,
  startTask,
} from "../modules/tasks.js";
import { createWorkspace, getWorkspace, listWorkspaces } from "../modules/workspaces.js";
import {
  approveApproval,
  getApproval,
  listTaskApprovals,
  rejectApproval,
  requestApproval,
} from "../modules/approvals.js";
import {
  groupDeliveryStats,
  listGroupDeliveries,
  listGroupEvents,
  listThreadEvents,
} from "../modules/events.js";
import { requireAgentSession } from "../modules/agentAuth.js";
import { UnauthorizedError, ValidationError } from "../modules/errors.js";
import { requireGroupMember } from "../modules/permissions.js";
import { groupAISettingsSchema } from "@room/protocol";
import { requireUserPrincipal } from "../auth/plugin.js";

export interface RoomRouteDependencies {
  ctx: RoomContext;
}

function actorOf(request: FastifyRequest): { type: "user"; id: string } {
  const principal = requireUserPrincipal(request);
  return { type: "user", id: principal.userId };
}

function agentOf(ctx: RoomContext, request: FastifyRequest): string {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !token.startsWith("agt_")) {
    throw new UnauthorizedError("agent bearer token required");
  }
  return requireAgentSession(ctx, token).agent.id;
}

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

function query<T>(request: FastifyRequest): T {
  return (request.query ?? {}) as T;
}

function params<T>(request: FastifyRequest): T {
  return request.params as T;
}

function limitOf(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const createGroupBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullish(),
});

const updateGroupBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullish(),
  settings: groupAISettingsSchema.optional(),
});

const addMemberBody = z.object({
  memberType: z.enum(["user", "agent"]),
  memberId: z.string().trim().min(1).max(80),
  memberRole: z.enum(["owner", "admin", "member"]).optional(),
});

const updateMemberRoleBody = z.object({
  memberRole: z.enum(["owner", "admin", "member"]),
});

const postMessageBody = z.object({
  content: z.string().min(1).max(20000),
  threadId: z.string().trim().min(1).nullish(),
  replyToMessageId: z.string().trim().min(1).nullish(),
  rootMessageId: z.string().trim().min(1).nullish(),
  clientMessageId: z.string().trim().min(1).max(120).nullish(),
});

const createThreadBody = z.object({
  sourceMessageId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
});

const createTaskBody = z.object({
  sourceMessageId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullish(),
  assignedAgentId: z.string().trim().min(1).nullish(),
  workspaceId: z.string().trim().min(1).nullish(),
  idempotencyKey: z.string().trim().min(1).max(120).nullish(),
});

const createWorkspaceBody = z.object({ name: z.string().trim().min(1).max(100) });

const assignTaskBody = z.object({ agentId: z.string().trim().min(1) });
const progressBody = z.object({
  percent: z.number().int().min(0).max(100).optional(),
  stage: z.string().trim().max(200).optional(),
  message: z.string().trim().max(2000).optional(),
});
const completeBody = z.object({
  outcome: z.enum(["succeeded", "failed"]),
  summary: z.string().trim().min(1).max(10000),
  result: z.string().max(20000).nullish(),
  error: z.string().max(4000).nullish(),
});
const cancelBody = z.object({ reason: z.string().trim().max(2000).nullish() });
const approvalBody = z.object({
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().max(4000).nullish(),
  expiresAt: z.number().int().positive().nullish(),
});
const rejectBody = z.object({ reason: z.string().trim().min(1).max(2000) });

export function registerRoomRoutes(app: FastifyInstance, deps: RoomRouteDependencies): void {
  const { ctx } = deps;

  app.get("/api/v1/groups", async (request) => {
    const actor = actorOf(request);
    return { groups: listGroupsForUser(ctx, { userId: actor.id }) };
  });

  app.post("/api/v1/groups", async (request, reply) => {
    const actor = actorOf(request);
    const body = parseBody(createGroupBody, request.body);
    const group = createGroup(ctx, {
      name: body.name,
      description: body.description ?? null,
      createdByUserId: actor.id,
    });
    reply.code(201);
    return { group };
  });

  app.get("/api/v1/groups/:groupId", async (request) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    requireGroupMember(ctx.db, groupId, actor);
    return { group: getGroup(ctx, groupId) };
  });

  app.patch("/api/v1/groups/:groupId", async (request) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const body = parseBody(updateGroupBody, request.body);
    let group = updateGroup(ctx, {
      groupId,
      actorUserId: actor.id,
      name: body.name,
      description: body.description,
    });
    if (body.settings) {
      group = updateGroupAISettings(ctx, {
        groupId,
        actorUserId: actor.id,
        settings: body.settings,
      });
    }
    return { group };
  });

  app.get("/api/v1/groups/:groupId/members", async (request) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    return {
      members: listGroupMembers(ctx, { groupId, viewerUserId: actor.id }),
    };
  });

  app.post("/api/v1/groups/:groupId/members", async (request, reply) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const body = parseBody(addMemberBody, request.body);
    const member = addMember(ctx, {
      groupId,
      actorUserId: actor.id,
      memberType: body.memberType,
      memberId: body.memberId,
      memberRole: body.memberRole,
    });
    reply.code(201);
    return { member };
  });

  app.patch("/api/v1/groups/:groupId/members/:memberType/:memberId", async (request) => {
    const actor = actorOf(request);
    const { groupId, memberType, memberId } = params<{
      groupId: string;
      memberType: "user" | "agent";
      memberId: string;
    }>(request);
    const body = parseBody(updateMemberRoleBody, request.body);
    return {
      member: updateMemberRole(ctx, {
        groupId,
        actorUserId: actor.id,
        memberType,
        memberId,
        memberRole: body.memberRole,
      }),
    };
  });

  app.delete("/api/v1/groups/:groupId/members/:memberType/:memberId", async (request, reply) => {
    const actor = actorOf(request);
    const { groupId, memberType, memberId } = params<{
      groupId: string;
      memberType: "user" | "agent";
      memberId: string;
    }>(request);
    removeMember(ctx, { groupId, actorUserId: actor.id, memberType, memberId });
    reply.code(204);
  });

  app.get("/api/v1/groups/:groupId/messages", async (request) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const { limit, cursor } = query<{ limit?: string; cursor?: string }>(request);
    return listMessages(ctx, {
      groupId,
      viewer: actor,
      limit: limitOf(limit, 50),
      cursor: cursor ? Number(cursor) : undefined,
    });
  });

  app.post("/api/v1/groups/:groupId/messages", async (request, reply) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const body = parseBody(postMessageBody, request.body);
    const message = postMessage(ctx, {
      groupId,
      actor,
      content: body.content,
      threadId: body.threadId ?? null,
      replyToMessageId: body.replyToMessageId ?? null,
      clientMessageId: body.clientMessageId ?? null,
    });
    reply.code(201);
    return { message };
  });

  app.delete("/api/v1/messages/:messageId", async (request, reply) => {
    const actor = actorOf(request);
    const { messageId } = params<{ messageId: string }>(request);
    deleteMessage(ctx, { messageId, actor });
    reply.code(204);
  });

  app.get("/api/v1/messages/:messageId", async (request) => {
    const actor = actorOf(request);
    const { messageId } = params<{ messageId: string }>(request);
    return { message: getMessage(ctx, { messageId, viewer: actor }) };
  });

  app.get("/api/v1/groups/:groupId/threads", async (request) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const { status, limit, cursor } = query<{
      status?: "open" | "closed" | "failed";
      limit?: string;
      cursor?: string;
    }>(request);
    return listThreads(ctx, {
      groupId,
      viewer: actor,
      status,
      limit: limitOf(limit, 50),
      cursor: cursor || undefined,
    });
  });

  app.post("/api/v1/groups/:groupId/threads", async (request, reply) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const body = parseBody(createThreadBody, request.body);
    const thread = createThread(ctx, {
      groupId,
      sourceMessageId: body.sourceMessageId,
      title: body.title,
      createdByUserId: actor.id,
    });
    reply.code(201);
    return { thread };
  });

  app.get("/api/v1/threads/:threadId", async (request) => {
    const actor = actorOf(request);
    const { threadId } = params<{ threadId: string }>(request);
    return getThreadDetail(ctx, { threadId, viewer: actor });
  });

  app.post("/api/v1/threads/:threadId/close", async (request) => {
    const actor = actorOf(request);
    const { threadId } = params<{ threadId: string }>(request);
    return { thread: closeThread(ctx, { threadId, actorUserId: actor.id }) };
  });

  app.get("/api/v1/threads/:threadId/messages", async (request) => {
    const actor = actorOf(request);
    const { threadId } = params<{ threadId: string }>(request);
    const { limit, cursor } = query<{ limit?: string; cursor?: string }>(request);
    return listThreadMessages(ctx, {
      threadId,
      viewer: actor,
      limit: limitOf(limit, 50),
      cursor: cursor ? Number(cursor) : undefined,
    });
  });

  app.post("/api/v1/threads/:threadId/messages", async (request, reply) => {
    const actor = actorOf(request);
    const { threadId } = params<{ threadId: string }>(request);
    const body = parseBody(postMessageBody, request.body);
    const detail = getThreadDetail(ctx, { threadId, viewer: actor });
    const message = postMessage(ctx, {
      groupId: detail.thread.groupId,
      actor,
      content: body.content,
      threadId,
      replyToMessageId: body.replyToMessageId ?? null,
      clientMessageId: body.clientMessageId ?? null,
    });
    reply.code(201);
    return { message };
  });

  app.get("/api/v1/threads/:threadId/events", async (request) => {
    const actor = actorOf(request);
    const { threadId } = params<{ threadId: string }>(request);
    const { limit, cursor } = query<{ limit?: string; cursor?: string }>(request);
    return listThreadEvents(ctx, {
      threadId,
      viewer: actor,
      limit: limitOf(limit, 50),
      cursor,
    });
  });

  app.get("/api/v1/groups/:groupId/tasks", async (request) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const { status, limit, cursor } = query<{
      status?: string;
      limit?: string;
      cursor?: string;
    }>(request);
    return listTasks(ctx, {
      groupId,
      viewerUserId: actor.id,
      status: status as never,
      limit: limitOf(limit, 50),
      cursor,
    });
  });

  app.post("/api/v1/groups/:groupId/tasks", async (request, reply) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const body = parseBody(createTaskBody, request.body);
    const created = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: body.sourceMessageId,
      title: body.title,
      description: body.description ?? null,
      assignedAgentId: body.assignedAgentId ?? null,
      workspaceId: body.workspaceId ?? null,
      createdByUserId: actor.id,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    reply.code(201);
    return created;
  });

  app.get("/api/v1/groups/:groupId/workspaces", async (request) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    return { workspaces: listWorkspaces(ctx, { groupId, viewerUserId: actor.id }) };
  });

  app.post("/api/v1/groups/:groupId/workspaces", async (request, reply) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const body = parseBody(createWorkspaceBody, request.body);
    const workspace = createWorkspace(ctx, {
      groupId,
      actorUserId: actor.id,
      name: body.name,
    });
    reply.code(201);
    return { workspace };
  });

  app.get("/api/v1/workspaces/:workspaceId", async (request) => {
    const actor = actorOf(request);
    const { workspaceId } = params<{ workspaceId: string }>(request);
    return { workspace: getWorkspace(ctx, { workspaceId, viewerUserId: actor.id }) };
  });

  app.get("/api/v1/groups/:groupId/deliveries/stats", async (request) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    return groupDeliveryStats(ctx, { groupId, viewer: actor });
  });

  app.get("/api/v1/groups/:groupId/deliveries", async (request) => {
    const actor = actorOf(request);
    const { groupId } = params<{ groupId: string }>(request);
    const { limit, cursor, status, agentId } = query<{
      limit?: string;
      cursor?: string;
      status?: string;
      agentId?: string;
    }>(request);
    return listGroupDeliveries(ctx, {
      groupId,
      viewer: actor,
      limit: limitOf(limit, 50),
      cursor,
      status:
        status === "pending" || status === "delivered" || status === "acked" || status === "failed"
          ? status
          : undefined,
      agentId,
    });
  });

  app.get("/api/v1/agent/groups", async (request) => {
    const agentId = agentOf(ctx, request);
    const { limit } = query<{ limit?: string }>(request);
    return { groups: listGroupsForAgent(ctx, { agentId, limit: limitOf(limit, 50) }) };
  });

  app.get("/api/v1/agent/groups/:groupId/messages", async (request) => {
    const agentId = agentOf(ctx, request);
    const { groupId } = params<{ groupId: string }>(request);
    const { limit, cursor } = query<{ limit?: string; cursor?: string }>(request);
    return listMessages(ctx, {
      groupId,
      viewer: { type: "agent", id: agentId },
      limit: limitOf(limit, 50),
      cursor: cursor ? Number(cursor) : undefined,
    });
  });

  app.post("/api/v1/agent/groups/:groupId/messages", async (request, reply) => {
    const agentId = agentOf(ctx, request);
    const { groupId } = params<{ groupId: string }>(request);
    const body = parseBody(postMessageBody, request.body);
    const message = postMessage(ctx, {
      groupId,
      actor: { type: "agent", id: agentId },
      content: body.content,
      threadId: body.threadId ?? null,
      rootMessageId: body.rootMessageId ?? null,
      replyToMessageId: body.replyToMessageId ?? null,
      clientMessageId: body.clientMessageId ?? null,
    });
    reply.code(201);
    return { message };
  });

  app.get("/api/v1/agent/groups/:groupId/events", async (request) => {
    const agentId = agentOf(ctx, request);
    const { groupId } = params<{ groupId: string }>(request);
    const { limit, cursor } = query<{ limit?: string; cursor?: string }>(request);
    return listGroupEvents(ctx, {
      groupId,
      viewer: { type: "agent", id: agentId },
      limit: limitOf(limit, 50),
      cursor,
    });
  });

  app.get("/api/v1/agent/tasks", async (request) => {
    const agentId = agentOf(ctx, request);
    const { includeTerminal } = query<{ includeTerminal?: string }>(request);
    return {
      tasks: listAgentTasks(ctx, {
        agentId,
        includeTerminal: includeTerminal === "true",
      }),
    };
  });

  app.get("/api/v1/agent/tasks/:taskId", async (request) => {
    const agentId = agentOf(ctx, request);
    const { taskId } = params<{ taskId: string }>(request);
    return getAgentTask(ctx, { agentId, taskId });
  });

  app.get("/api/v1/agent/threads/:threadId/messages", async (request) => {
    const agentId = agentOf(ctx, request);
    const { threadId } = params<{ threadId: string }>(request);
    const { limit, cursor } = query<{ limit?: string; cursor?: string }>(request);
    return listThreadMessagesForAgent(ctx, {
      agentId,
      threadId,
      limit: limitOf(limit, 50),
      cursor: cursor ? Number(cursor) : undefined,
    });
  });

  app.get("/api/v1/tasks/:taskId", async (request) => {
    const actor = actorOf(request);
    const { taskId } = params<{ taskId: string }>(request);
    return { task: getTask(ctx, { taskId, viewerUserId: actor.id }) };
  });

  app.post("/api/v1/tasks/:taskId/assign", async (request) => {
    const actor = actorOf(request);
    const { taskId } = params<{ taskId: string }>(request);
    const body = parseBody(assignTaskBody, request.body);
    return { task: assignTask(ctx, { taskId, agentId: body.agentId, actorUserId: actor.id }) };
  });

  app.post("/api/v1/tasks/:taskId/start", async (request) => {
    const agentId = agentOf(ctx, request);
    const { taskId } = params<{ taskId: string }>(request);
    return startTask(ctx, { taskId, agentId });
  });

  app.post("/api/v1/tasks/:taskId/progress", async (request) => {
    const agentId = agentOf(ctx, request);
    const { taskId } = params<{ taskId: string }>(request);
    const body = parseBody(progressBody, request.body);
    return reportTaskProgress(ctx, {
      taskId,
      agentId,
      percent: body.percent,
      stage: body.stage,
      message: body.message,
    });
  });

  app.post("/api/v1/tasks/:taskId/complete", async (request) => {
    const agentId = agentOf(ctx, request);
    const { taskId } = params<{ taskId: string }>(request);
    const body = parseBody(completeBody, request.body);
    return completeTask(ctx, {
      taskId,
      agentId,
      outcome: body.outcome,
      summary: body.summary,
      result: body.result ?? null,
      error: body.error ?? null,
    });
  });

  app.post("/api/v1/tasks/:taskId/pause", async (request) => {
    const actor = actorOf(request);
    const { taskId } = params<{ taskId: string }>(request);
    return pauseTask(ctx, { taskId, actorUserId: actor.id });
  });

  app.post("/api/v1/tasks/:taskId/resume", async (request) => {
    const actor = actorOf(request);
    const { taskId } = params<{ taskId: string }>(request);
    return resumeTask(ctx, { taskId, actorUserId: actor.id });
  });

  app.post("/api/v1/tasks/:taskId/cancel", async (request) => {
    const actor = actorOf(request);
    const { taskId } = params<{ taskId: string }>(request);
    const body = parseBody(cancelBody, request.body);
    return { task: cancelTask(ctx, { taskId, actorUserId: actor.id, reason: body.reason }) };
  });

  app.get("/api/v1/tasks/:taskId/approvals", async (request) => {
    const actor = actorOf(request);
    const { taskId } = params<{ taskId: string }>(request);
    return { approvals: listTaskApprovals(ctx, { taskId, viewerUserId: actor.id }) };
  });

  app.post("/api/v1/tasks/:taskId/approvals", async (request, reply) => {
    const agentId = agentOf(ctx, request);
    const { taskId } = params<{ taskId: string }>(request);
    const body = parseBody(approvalBody, request.body);
    const approval = requestApproval(ctx, {
      taskId,
      agentId,
      title: body.title,
      details: body.details ?? null,
      expiresAt: body.expiresAt ?? null,
    });
    reply.code(201);
    return { approval };
  });

  app.get("/api/v1/approvals/:approvalId", async (request) => {
    const actor = actorOf(request);
    const { approvalId } = params<{ approvalId: string }>(request);
    return getApproval(ctx, { approvalId, viewerUserId: actor.id });
  });

  app.post("/api/v1/approvals/:approvalId/approve", async (request) => {
    const actor = actorOf(request);
    const { approvalId } = params<{ approvalId: string }>(request);
    return approveApproval(ctx, { approvalId, actorUserId: actor.id });
  });

  app.post("/api/v1/approvals/:approvalId/reject", async (request) => {
    const actor = actorOf(request);
    const { approvalId } = params<{ approvalId: string }>(request);
    const body = parseBody(rejectBody, request.body);
    return rejectApproval(ctx, {
      approvalId,
      actorUserId: actor.id,
      reason: body.reason,
    });
  });

  app.get("/api/v1/events", async (request) => {
    const actor = actorOf(request);
    const { groupId, limit, cursor } = query<{
      groupId?: string;
      limit?: string;
      cursor?: string;
    }>(request);
    if (!groupId) throw new ValidationError("groupId is required");
    return listGroupEvents(ctx, {
      groupId,
      viewer: actor,
      limit: limitOf(limit, 50),
      cursor,
    });
  });
}
