import { and, desc, eq, lte, sql } from "drizzle-orm";
import {
  approvals,
  type ApprovalRow,
  messages,
  taskRuns,
  tasks,
  type TaskRow,
  threads,
} from "@room/database";
import { newId } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { recordAudit } from "./audit.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { appendEvent, enqueueDelivery, enqueueGroupAgentDeliveries } from "./events.js";
import {
  agentActor,
  requireActiveGroup,
  requireAgent,
  requireGroupManager,
  requireGroupMember,
  requireWriteUser,
  validateTitle,
} from "./permissions.js";
import { assertTaskTransition, getTaskRow } from "./tasks.js";

export function requestApproval(
  ctx: RoomContext,
  input: {
    taskId: string;
    agentId: string;
    title: string;
    details?: string | null;
    expiresAt?: number | null;
  },
): ApprovalRow {
  const task = getTaskRow(ctx, input.taskId);
  requireAgent(ctx.db, input.agentId);
  requireGroupMember(ctx.db, task.groupId, agentActor(input.agentId));
  requireActiveGroup(ctx.db, task.groupId);
  if (task.assignedAgentId !== input.agentId) {
    throw new ConflictError(`task ${task.id} is not assigned to agent ${input.agentId}`);
  }
  if (task.status !== "running") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot request approval`);
  }
  assertTaskTransition(task.status, "waiting_approval");
  const pending = ctx.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.taskId, task.id), eq(approvals.status, "pending")))
    .get();
  if (pending) throw new ConflictError(`task ${task.id} already has a pending approval`);
  const title = validateTitle(input.title, "title");
  const details = input.details?.trim() || null;
  if (details && details.length > 4000) throw new ValidationError("approval details are too long");
  const now = ctx.now();
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= now) {
    throw new ValidationError("approval expiresAt must be in the future");
  }
  const id = newId("apv");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.insert(approvals)
      .values({
        id,
        taskId: task.id,
        runId: latestRunId(db, task.id),
        threadId: task.threadId,
        requestedByAgentId: input.agentId,
        title,
        details,
        status: "pending",
        decidedByUserId: null,
        decidedAt: null,
        reason: null,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.update(tasks)
      .set({ status: "waiting_approval", updatedAt: now })
      .where(eq(tasks.id, task.id))
      .run();
    appendEvent(db, {
      type: "task.approval_requested",
      actor: { type: "agent", id: input.agentId },
      groupId: task.groupId,
      threadId: task.threadId,
      taskId: task.id,
      payload: {
        approvalId: id,
        taskId: task.id,
        title,
        expiresAt: input.expiresAt ?? null,
      },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "agent",
      actorId: input.agentId,
      action: "task.approval_request",
      targetType: "approval",
      targetId: id,
      metadata: { taskId: task.id },
      createdAt: now,
    });
    return db.select().from(approvals).where(eq(approvals.id, id)).get()!;
  });
}

export function getApproval(
  ctx: RoomContext,
  input: { approvalId: string; viewerUserId: string },
): { approval: ApprovalRow; task: TaskRow } {
  const approval = getApprovalRow(ctx, input.approvalId);
  const task = getTaskRow(ctx, approval.taskId);
  requireGroupMember(ctx.db, task.groupId, { type: "user", id: input.viewerUserId });
  return { approval, task };
}

export function listTaskApprovals(
  ctx: RoomContext,
  input: {
    taskId: string;
    viewerUserId: string;
    status?: ApprovalRow["status"];
    limit?: number;
  },
): ApprovalRow[] {
  const task = getTaskRow(ctx, input.taskId);
  requireGroupMember(ctx.db, task.groupId, { type: "user", id: input.viewerUserId });
  const conditions = [eq(approvals.taskId, task.id)];
  if (input.status) conditions.push(eq(approvals.status, input.status));
  return ctx.db
    .select()
    .from(approvals)
    .where(and(...conditions))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 100))
    .all();
}

export function approveApproval(
  ctx: RoomContext,
  input: { approvalId: string; actorUserId: string },
): { approval: ApprovalRow; task: TaskRow } {
  return decideApproval(ctx, input.approvalId, input.actorUserId, "approved", null);
}

export function rejectApproval(
  ctx: RoomContext,
  input: { approvalId: string; actorUserId: string; reason: string },
): { approval: ApprovalRow; task: TaskRow } {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("rejecting an approval requires a reason");
  return decideApproval(ctx, input.approvalId, input.actorUserId, "rejected", reason);
}

export function expireApproval(
  ctx: RoomContext,
  input: { approvalId: string },
): { approval: ApprovalRow; task: TaskRow } {
  const approval = getApprovalRow(ctx, input.approvalId);
  const task = getTaskRow(ctx, approval.taskId);
  // Expiration is idempotent: a second sweep must not duplicate the failure
  // summary, events or audit rows.
  if (approval.status === "expired") return { approval, task };
  const now = ctx.now();
  if (approval.status !== "pending") throw new ConflictError(`approval is ${approval.status}`);
  if (approval.expiresAt === null || approval.expiresAt > now) {
    throw new ConflictError("approval has not expired");
  }
  if (task.status !== "waiting_approval") {
    throw new ConflictError(`task ${task.id} is ${task.status}`);
  }
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(approvals)
      .set({ status: "expired", reason: "approval expired", updatedAt: now })
      .where(eq(approvals.id, approval.id))
      .run();
    failTask(
      db,
      task,
      approval,
      "approval expired",
      now,
      { type: "system", id: "system" },
      {
        eventType: "task.approval_expired",
        auditAction: "approval.expire",
        summaryHeader: "审批超时",
      },
    );
    return {
      approval: db.select().from(approvals).where(eq(approvals.id, approval.id)).get()!,
      task: db.select().from(tasks).where(eq(tasks.id, task.id)).get()!,
    };
  });
}

/**
 * Server-side expiration trigger: sweep pending approvals whose deadline passed.
 * Returns the number of approvals expired. Safe to call from a periodic timer.
 */
export function expireDueApprovals(ctx: RoomContext, input: { now?: number } = {}): number {
  const now = input.now ?? ctx.now();
  const due = ctx.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.status, "pending"), lte(approvals.expiresAt, now)))
    .all();
  let expired = 0;
  for (const row of due) {
    try {
      expireApproval(ctx, { approvalId: row.id });
      expired += 1;
    } catch {
      // A concurrent sweep or decision already moved this approval; the next
      // sweep only sees pending rows, so there is nothing to reconcile here.
    }
  }
  return expired;
}

function decideApproval(
  ctx: RoomContext,
  approvalId: string,
  actorUserId: string,
  decision: "approved" | "rejected",
  reason: string | null,
): { approval: ApprovalRow; task: TaskRow } {
  const approval = getApprovalRow(ctx, approvalId);
  const task = getTaskRow(ctx, approval.taskId);
  requireGroupManager(ctx.db, task.groupId, { type: "user", id: actorUserId });
  requireWriteUser(ctx.db, actorUserId);
  requireActiveGroup(ctx.db, task.groupId);
  if (approval.status === decision) {
    return { approval, task };
  }
  if (approval.status !== "pending") {
    throw new ConflictError(`approval is ${approval.status} and cannot be decided`);
  }
  if (task.status !== "waiting_approval") {
    throw new ConflictError(`task ${task.id} is ${task.status} and has no pending approval`);
  }
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(approvals)
      .set({
        status: decision,
        decidedByUserId: actorUserId,
        decidedAt: now,
        reason,
        updatedAt: now,
      })
      .where(eq(approvals.id, approval.id))
      .run();
    if (decision === "approved") {
      db.update(tasks)
        .set({ status: "running", updatedAt: now })
        .where(eq(tasks.id, task.id))
        .run();
      const event = appendEvent(db, {
        type: "task.approval_decided",
        actor: { type: "user", id: actorUserId },
        groupId: task.groupId,
        threadId: task.threadId,
        taskId: task.id,
        payload: { approvalId: approval.id, taskId: task.id, decision },
        createdAt: now,
      });
      if (task.assignedAgentId) {
        enqueueDelivery(db, {
          agentId: task.assignedAgentId,
          eventId: event.id,
          createdAt: now,
        });
      }
      recordAudit(db, {
        actorType: "user",
        actorId: actorUserId,
        action: "task.approval_approve",
        targetType: "approval",
        targetId: approval.id,
        metadata: { taskId: task.id },
        createdAt: now,
      });
    } else {
      const event = appendEvent(db, {
        type: "task.approval_decided",
        actor: { type: "user", id: actorUserId },
        groupId: task.groupId,
        threadId: task.threadId,
        taskId: task.id,
        payload: { approvalId: approval.id, taskId: task.id, decision, reason },
        createdAt: now,
      });
      if (task.assignedAgentId) {
        enqueueDelivery(db, {
          agentId: task.assignedAgentId,
          eventId: event.id,
          createdAt: now,
        });
      }
      failTask(
        db,
        task,
        approval,
        reason ?? "approval rejected",
        now,
        { type: "user", id: actorUserId },
        { eventType: "task.failed", auditAction: "task.fail", summaryHeader: "审批被拒绝" },
      );
    }
    return {
      approval: db.select().from(approvals).where(eq(approvals.id, approval.id)).get()!,
      task: db.select().from(tasks).where(eq(tasks.id, task.id)).get()!,
    };
  });
}

/** Fail the task, its run and thread, and write the failure summary back to the group. */
function failTask(
  db: RoomDb,
  task: TaskRow,
  approval: ApprovalRow,
  reason: string,
  now: number,
  actor: { type: "user" | "system"; id: string },
  options: {
    eventType: "task.failed" | "task.approval_expired";
    auditAction: "task.fail" | "approval.expire";
    summaryHeader: string;
  },
): void {
  db.update(taskRuns)
    .set({ status: "failed", finishedAt: now, updatedAt: now, error: reason })
    .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.status, "running")))
    .run();
  db.update(threads)
    .set({ status: "failed", closedAt: now, updatedAt: now })
    .where(eq(threads.id, task.threadId!))
    .run();
  db.update(tasks)
    .set({ status: "failed", completedAt: now, updatedAt: now, error: reason })
    .where(eq(tasks.id, task.id))
    .run();

  const content = `任务失败：${task.title}\n\n${options.summaryHeader}：${reason}\n\nThread: ${task.threadId}`;
  const summaryMessageId = newId("msg");
  const maxSeq = db
    .select({ value: sql<number>`coalesce(max(${messages.seq}), 0)` })
    .from(messages)
    .where(eq(messages.groupId, task.groupId))
    .get();
  const seq = Number(maxSeq?.value ?? 0) + 1;
  db.insert(messages)
    .values({
      id: summaryMessageId,
      groupId: task.groupId,
      threadId: null,
      senderType: "system",
      senderId: task.id,
      content,
      rootMessageId: task.sourceMessageId,
      replyToMessageId: null,
      hop: 0,
      clientMessageId: `task-summary:${task.id}`,
      seq,
      createdAt: now,
    })
    .run();
  const summaryEvent = appendEvent(db, {
    type: "message.created",
    actor: { type: "system", id: "system" },
    groupId: task.groupId,
    threadId: null,
    taskId: task.id,
    payload: {
      messageId: summaryMessageId,
      senderType: "system",
      senderId: task.id,
      content,
      rootMessageId: task.sourceMessageId,
      hop: 0,
    },
    createdAt: now,
  });
  enqueueGroupAgentDeliveries(db, {
    groupId: task.groupId,
    eventId: summaryEvent.id,
    createdAt: now,
    excludeAgentId: task.assignedAgentId,
  });
  appendEvent(db, {
    type: options.eventType,
    actor,
    groupId: task.groupId,
    threadId: task.threadId,
    taskId: task.id,
    payload: { taskId: task.id, approvalId: approval.id, reason, summaryMessageId },
    createdAt: now,
  });
  recordAudit(db, {
    actorType: actor.type === "system" ? "system" : "user",
    actorId: actor.id,
    action: options.auditAction,
    targetType: "task",
    targetId: task.id,
    metadata: { approvalId: approval.id, reason, summaryMessageId },
    createdAt: now,
  });
}

function latestRunId(db: RoomDb, taskId: string): string | null {
  const run = db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.status, "running")))
    .orderBy(desc(taskRuns.startedAt))
    .get();
  return run?.id ?? null;
}

function getApprovalRow(ctx: RoomContext, approvalId: string): ApprovalRow {
  const approval = ctx.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
  if (!approval) throw new NotFoundError(`approval ${approvalId} not found`);
  return approval;
}
