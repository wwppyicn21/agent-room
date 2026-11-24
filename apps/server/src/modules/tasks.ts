import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  approvals,
  groupMembers,
  taskRuns,
  type TaskRunRow,
  tasks,
  type TaskRow,
  threads,
  type ThreadRow,
  messages,
  type WorkspaceRow,
  workspaces,
} from "@room/database";
import { newId } from "@room/protocol";
import { messageContentSchema } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { recordAudit } from "./audit.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { appendEvent, enqueueDelivery, enqueueGroupAgentDeliveries } from "./events.js";
import { getGroupMessageRow } from "./messages.js";
import { workspaceForTask } from "./workspaces.js";
import {
  agentActor,
  isGroupMember,
  requireActiveGroup,
  requireAgent,
  requireGroupManager,
  requireGroupMember,
  requireWriteUser,
  validateTitle,
} from "./permissions.js";

export type TaskOutcome = "succeeded" | "failed";

/** Server-owned task state machine (plan §4.2). Clients and plugins never set status directly. */
export const TASK_TRANSITIONS: Record<TaskRow["status"], readonly TaskRow["status"][]> = {
  queued: ["assigned", "cancelled"],
  assigned: ["running", "assigned", "cancelled"],
  running: ["waiting_approval", "paused", "succeeded", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function assertTaskTransition(from: TaskRow["status"], to: TaskRow["status"]): void {
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new ConflictError(`task cannot transition from ${from} to ${to}`);
  }
}

export function createTaskFromMessage(
  ctx: RoomContext,
  input: {
    groupId: string;
    sourceMessageId: string;
    title: string;
    description?: string | null;
    assignedAgentId?: string | null;
    workspaceId?: string | null;
    createdByUserId: string;
    idempotencyKey?: string | null;
  },
): { task: TaskRow; threadId: string } {
  requireWriteUser(ctx.db, input.createdByUserId);
  requireGroupMember(ctx.db, input.groupId, { type: "user", id: input.createdByUserId });
  requireActiveGroup(ctx.db, input.groupId);
  const title = validateTitle(input.title, "title");
  const description = input.description?.trim() || null;
  const assignedAgentId = input.assignedAgentId ?? null;
  const workspaceId = input.workspaceId?.trim() || null;
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey) {
    const existing = ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.groupId, input.groupId), eq(tasks.idempotencyKey, idempotencyKey)))
      .get();
    if (existing) {
      const samePayload =
        existing.sourceMessageId === input.sourceMessageId &&
        existing.title === title &&
        (existing.description ?? null) === description &&
        (existing.assignedAgentId ?? null) === assignedAgentId &&
        (existing.workspaceId ?? null) === workspaceId;
      if (!samePayload) {
        throw new ConflictError(
          `idempotency key ${idempotencyKey} was already used with a different payload`,
        );
      }
      if (!existing.threadId) throw new ConflictError(`task ${existing.id} has no thread`);
      return { task: existing, threadId: existing.threadId };
    }
  }
  getGroupMessageRow(ctx, input.groupId, input.sourceMessageId);
  if (workspaceId) workspaceForTask(ctx, { workspaceId, groupId: input.groupId });
  if (assignedAgentId) {
    requireAgent(ctx.db, assignedAgentId);
    if (!isGroupMember(ctx.db, input.groupId, "agent", assignedAgentId)) {
      throw new ValidationError(`agent ${assignedAgentId} is not a member of the group`);
    }
  }
  const now = ctx.now();
  const threadId = newId("thr");
  const taskId = newId("tsk");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.insert(threads)
      .values({
        id: threadId,
        groupId: input.groupId,
        sourceMessageId: input.sourceMessageId,
        title,
        status: "open",
        createdByUserId: input.createdByUserId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(tasks)
      .values({
        id: taskId,
        groupId: input.groupId,
        threadId,
        idempotencyKey,
        sourceMessageId: input.sourceMessageId,
        title,
        description,
        status: assignedAgentId ? "assigned" : "queued",
        priority: 0,
        assignedAgentId,
        workspaceId,
        createdByUserId: input.createdByUserId,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      })
      .run();
    appendEvent(db, {
      type: "thread.created",
      actor: { type: "user", id: input.createdByUserId },
      groupId: input.groupId,
      threadId,
      payload: { threadId, sourceMessageId: input.sourceMessageId, title },
      createdAt: now,
    });
    const created = appendEvent(db, {
      type: "task.created",
      actor: { type: "user", id: input.createdByUserId },
      groupId: input.groupId,
      threadId,
      taskId,
      payload: { taskId, title, assignedAgentId, workspaceId },
      createdAt: now,
    });
    enqueueGroupAgentDeliveries(db, {
      groupId: input.groupId,
      eventId: created.id,
      createdAt: now,
    });
    if (assignedAgentId) {
      const assigned = appendEvent(db, {
        type: "task.assigned",
        actor: { type: "user", id: input.createdByUserId },
        groupId: input.groupId,
        threadId,
        taskId,
        payload: { taskId, agentId: assignedAgentId },
        createdAt: now,
      });
      enqueueDelivery(db, {
        agentId: assignedAgentId,
        eventId: assigned.id,
        createdAt: now,
      });
    }
    recordAudit(db, {
      actorType: "user",
      actorId: input.createdByUserId,
      action: "task.create",
      targetType: "task",
      targetId: taskId,
      metadata: {
        groupId: input.groupId,
        threadId,
        assignedAgentId,
        workspaceId,
      },
      createdAt: now,
    });
    return {
      task: db.select().from(tasks).where(eq(tasks.id, taskId)).get()!,
      threadId,
    };
  });
}

export function assignTask(
  ctx: RoomContext,
  input: { taskId: string; agentId: string; actorUserId: string },
): TaskRow {
  const task = getTaskRow(ctx, input.taskId);
  requireGroupManager(ctx.db, task.groupId, { type: "user", id: input.actorUserId });
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, task.groupId);
  requireAgent(ctx.db, input.agentId);
  if (!isGroupMember(ctx.db, task.groupId, "agent", input.agentId)) {
    throw new ValidationError(`agent ${input.agentId} is not a member of the group`);
  }
  if (task.status !== "queued" && task.status !== "assigned") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot be reassigned`);
  }
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(tasks)
      .set({ status: "assigned", assignedAgentId: input.agentId, updatedAt: now })
      .where(eq(tasks.id, task.id))
      .run();
    const event = appendEvent(db, {
      type: "task.assigned",
      actor: { type: "user", id: input.actorUserId },
      groupId: task.groupId,
      threadId: task.threadId,
      taskId: task.id,
      payload: { taskId: task.id, agentId: input.agentId },
      createdAt: now,
    });
    enqueueDelivery(db, { agentId: input.agentId, eventId: event.id, createdAt: now });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "task.assign",
      targetType: "task",
      targetId: task.id,
      metadata: { agentId: input.agentId },
      createdAt: now,
    });
    return db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
  });
}

export function startTask(
  ctx: RoomContext,
  input: { taskId: string; agentId: string },
): { task: TaskRow; run: TaskRunRow } {
  const task = getTaskRow(ctx, input.taskId);
  requireAgent(ctx.db, input.agentId);
  requireGroupMember(ctx.db, task.groupId, agentActor(input.agentId));
  requireActiveGroup(ctx.db, task.groupId);
  if (task.assignedAgentId !== input.agentId) {
    throw new ConflictError(`task ${task.id} is not assigned to agent ${input.agentId}`);
  }
  if (task.status !== "assigned") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot start`);
  }
  assertTaskTransition(task.status, "running");
  const now = ctx.now();
  const runId = newId("run");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(tasks)
      .set({ status: "running", startedAt: now, updatedAt: now })
      .where(eq(tasks.id, task.id))
      .run();
    db.insert(taskRuns)
      .values({
        id: runId,
        taskId: task.id,
        agentId: input.agentId,
        status: "running",
        startedAt: now,
        finishedAt: null,
        summary: null,
        error: null,
      })
      .run();
    appendEvent(db, {
      type: "task.started",
      actor: { type: "agent", id: input.agentId },
      groupId: task.groupId,
      threadId: task.threadId,
      taskId: task.id,
      payload: { taskId: task.id, runId },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "agent",
      actorId: input.agentId,
      action: "task.start",
      targetType: "task",
      targetId: task.id,
      metadata: { runId },
      createdAt: now,
    });
    return {
      task: db.select().from(tasks).where(eq(tasks.id, task.id)).get()!,
      run: db.select().from(taskRuns).where(eq(taskRuns.id, runId)).get()!,
    };
  });
}

export function completeTask(
  ctx: RoomContext,
  input: {
    taskId: string;
    agentId: string;
    outcome: TaskOutcome;
    summary: string;
    result?: string | null;
    runId?: string | null;
    error?: string | null;
  },
): { task: TaskRow; run: TaskRunRow; summaryMessageId: string } {
  const task = getTaskRow(ctx, input.taskId);
  requireAgent(ctx.db, input.agentId);
  requireGroupMember(ctx.db, task.groupId, agentActor(input.agentId));
  requireActiveGroup(ctx.db, task.groupId);
  if (task.assignedAgentId !== input.agentId) {
    throw new ConflictError(`task ${task.id} is not assigned to agent ${input.agentId}`);
  }
  if (task.status !== "running") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot complete`);
  }
  assertTaskTransition(task.status, input.outcome);
  const summary = messageContentSchema.parse(input.summary);
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    const run = input.runId
      ? db.select().from(taskRuns).where(eq(taskRuns.id, input.runId)).get()
      : db
          .select()
          .from(taskRuns)
          .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.status, "running")))
          .orderBy(desc(taskRuns.startedAt))
          .get();
    if (!run || run.taskId !== task.id || run.agentId !== input.agentId) {
      throw new NotFoundError(`running task run for task ${task.id} not found`);
    }
    db.update(taskRuns)
      .set({
        status: input.outcome,
        finishedAt: now,
        updatedAt: now,
        summary,
        error: input.error ?? null,
      })
      .where(eq(taskRuns.id, run.id))
      .run();
    db.update(tasks)
      .set({
        status: input.outcome,
        updatedAt: now,
        completedAt: now,
        result: input.result ?? null,
        summary,
        error: input.error ?? null,
      })
      .where(eq(tasks.id, task.id))
      .run();
    db.update(threads)
      .set({
        status: input.outcome === "succeeded" ? "closed" : "failed",
        closedAt: now,
        updatedAt: now,
      })
      .where(eq(threads.id, task.threadId!))
      .run();

    const header = input.outcome === "succeeded" ? "任务完成" : "任务失败";
    const content = `${header}：${task.title}\n\n${summary}\n\nThread: ${task.threadId}`;
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
      excludeAgentId: input.agentId,
    });
    appendEvent(db, {
      type: input.outcome === "succeeded" ? "task.completed" : "task.failed",
      actor: { type: "agent", id: input.agentId },
      groupId: task.groupId,
      threadId: task.threadId,
      taskId: task.id,
      payload: { taskId: task.id, runId: run.id, summaryMessageId, threadId: task.threadId },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "agent",
      actorId: input.agentId,
      action: input.outcome === "succeeded" ? "task.complete" : "task.fail",
      targetType: "task",
      targetId: task.id,
      metadata: { runId: run.id, summaryMessageId, threadId: task.threadId },
      createdAt: now,
    });
    return {
      task: db.select().from(tasks).where(eq(tasks.id, task.id)).get()!,
      run: db.select().from(taskRuns).where(eq(taskRuns.id, run.id)).get()!,
      summaryMessageId,
    };
  });
}

export function pauseTask(
  ctx: RoomContext,
  input: { taskId: string; actorUserId: string },
): { task: TaskRow; run: TaskRunRow } {
  const task = getTaskRow(ctx, input.taskId);
  requireGroupManager(ctx.db, task.groupId, { type: "user", id: input.actorUserId });
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, task.groupId);
  if (task.status !== "running") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot be paused`);
  }
  assertTaskTransition(task.status, "paused");
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    const run = latestRun(db, task.id, "running");
    if (!run) throw new ConflictError(`task ${task.id} has no running task run`);
    db.update(taskRuns)
      .set({ status: "paused", updatedAt: now })
      .where(eq(taskRuns.id, run.id))
      .run();
    db.update(tasks).set({ status: "paused", updatedAt: now }).where(eq(tasks.id, task.id)).run();
    const event = appendEvent(db, {
      type: "task.paused",
      actor: { type: "user", id: input.actorUserId },
      groupId: task.groupId,
      threadId: task.threadId,
      taskId: task.id,
      payload: { taskId: task.id, runId: run.id },
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
      actorId: input.actorUserId,
      action: "task.pause",
      targetType: "task",
      targetId: task.id,
      metadata: { runId: run.id },
      createdAt: now,
    });
    return {
      task: db.select().from(tasks).where(eq(tasks.id, task.id)).get()!,
      run: db.select().from(taskRuns).where(eq(taskRuns.id, run.id)).get()!,
    };
  });
}

export function resumeTask(
  ctx: RoomContext,
  input: { taskId: string; actorUserId: string },
): { task: TaskRow; run: TaskRunRow } {
  const task = getTaskRow(ctx, input.taskId);
  requireGroupManager(ctx.db, task.groupId, { type: "user", id: input.actorUserId });
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, task.groupId);
  if (task.status !== "paused") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot be resumed`);
  }
  assertTaskTransition(task.status, "running");
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    const run = latestRun(db, task.id, "paused");
    if (!run) throw new ConflictError(`task ${task.id} has no paused task run`);
    db.update(taskRuns)
      .set({ status: "running", updatedAt: now })
      .where(eq(taskRuns.id, run.id))
      .run();
    db.update(tasks).set({ status: "running", updatedAt: now }).where(eq(tasks.id, task.id)).run();
    const event = appendEvent(db, {
      type: "task.resumed",
      actor: { type: "user", id: input.actorUserId },
      groupId: task.groupId,
      threadId: task.threadId,
      taskId: task.id,
      payload: { taskId: task.id, runId: run.id },
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
      actorId: input.actorUserId,
      action: "task.resume",
      targetType: "task",
      targetId: task.id,
      metadata: { runId: run.id },
      createdAt: now,
    });
    return {
      task: db.select().from(tasks).where(eq(tasks.id, task.id)).get()!,
      run: db.select().from(taskRuns).where(eq(taskRuns.id, run.id)).get()!,
    };
  });
}

function cancelTaskInTransaction(
  db: RoomDb,
  input: {
    task: TaskRow;
    actorUserId: string;
    reason: string | null;
    now: number;
    notifyAssignee: boolean;
  },
): TaskRow {
  const { task } = input;
  const run = latestRun(db, task.id, "running") ?? latestRun(db, task.id, "paused");
  if (run) {
    db.update(taskRuns)
      .set({
        status: "cancelled",
        finishedAt: input.now,
        updatedAt: input.now,
        error: input.reason,
      })
      .where(eq(taskRuns.id, run.id))
      .run();
  }
  db.update(approvals)
    .set({ status: "cancelled", updatedAt: input.now, reason: input.reason ?? "task cancelled" })
    .where(and(eq(approvals.taskId, task.id), eq(approvals.status, "pending")))
    .run();
  if (task.threadId) {
    db.update(threads)
      .set({ status: "closed", closedAt: input.now, updatedAt: input.now })
      .where(eq(threads.id, task.threadId))
      .run();
  }
  db.update(tasks)
    .set({ status: "cancelled", cancelledAt: input.now, updatedAt: input.now, error: input.reason })
    .where(eq(tasks.id, task.id))
    .run();
  const event = appendEvent(db, {
    type: "task.cancelled",
    actor: { type: "user", id: input.actorUserId },
    groupId: task.groupId,
    threadId: task.threadId,
    taskId: task.id,
    payload: { taskId: task.id, runId: run?.id ?? null, reason: input.reason },
    createdAt: input.now,
  });
  if (input.notifyAssignee && task.assignedAgentId) {
    enqueueDelivery(db, {
      agentId: task.assignedAgentId,
      eventId: event.id,
      createdAt: input.now,
    });
  }
  recordAudit(db, {
    actorType: "user",
    actorId: input.actorUserId,
    action: "task.cancel",
    targetType: "task",
    targetId: task.id,
    metadata: { runId: run?.id ?? null, reason: input.reason },
    createdAt: input.now,
  });
  return db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
}

/**
 * Atomic cleanup used when an Agent membership is removed. It cancels every
 * non-terminal Task assigned to that Agent in the Group without notifying the
 * removed Agent (permission revocation must not enqueue fresh deliveries).
 */
export function cancelAgentTasksForGroupRemoval(
  db: RoomDb,
  input: { groupId: string; agentId: string; actorUserId: string; now: number },
): number {
  const rows = db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.groupId, input.groupId),
        eq(tasks.assignedAgentId, input.agentId),
        inArray(tasks.status, ["queued", "assigned", "running", "waiting_approval", "paused"]),
      ),
    )
    .all();
  for (const task of rows) {
    cancelTaskInTransaction(db, {
      task,
      actorUserId: input.actorUserId,
      reason: "agent removed from group",
      now: input.now,
      notifyAssignee: false,
    });
  }
  return rows.length;
}

export function cancelTask(
  ctx: RoomContext,
  input: { taskId: string; actorUserId: string; reason?: string | null },
): TaskRow {
  const task = getTaskRow(ctx, input.taskId);
  requireGroupManager(ctx.db, task.groupId, { type: "user", id: input.actorUserId });
  requireWriteUser(ctx.db, input.actorUserId);
  requireActiveGroup(ctx.db, task.groupId);
  if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot be cancelled`);
  }
  assertTaskTransition(task.status, "cancelled");
  const reason = input.reason?.trim() || null;
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    return cancelTaskInTransaction(db, {
      task,
      actorUserId: input.actorUserId,
      reason,
      now,
      notifyAssignee: true,
    });
  });
}

export function reportTaskProgress(
  ctx: RoomContext,
  input: {
    taskId: string;
    agentId: string;
    percent?: number | null;
    stage?: string | null;
    message?: string | null;
  },
): TaskRunRow {
  const task = getTaskRow(ctx, input.taskId);
  requireAgent(ctx.db, input.agentId);
  requireGroupMember(ctx.db, task.groupId, agentActor(input.agentId));
  requireActiveGroup(ctx.db, task.groupId);
  if (task.assignedAgentId !== input.agentId) {
    throw new ConflictError(`task ${task.id} is not assigned to agent ${input.agentId}`);
  }
  if (task.status !== "running") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot report progress`);
  }
  let percent: number | null = null;
  if (input.percent !== undefined && input.percent !== null) {
    if (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100) {
      throw new ValidationError("progress percent must be an integer between 0 and 100");
    }
    percent = input.percent;
  }
  const stage = input.stage?.trim() || null;
  const progressMessage = input.message?.trim() || null;
  if (stage && stage.length > 200) throw new ValidationError("progress stage is too long");
  if (progressMessage && progressMessage.length > 2000) {
    throw new ValidationError("progress message is too long");
  }
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    const run = latestRun(db, task.id, "running");
    if (!run) throw new ConflictError(`task ${task.id} has no running task run`);
    db.update(taskRuns)
      .set({
        progressPercent: percent,
        progressStage: stage,
        progressMessage,
        updatedAt: now,
      })
      .where(eq(taskRuns.id, run.id))
      .run();
    appendEvent(db, {
      type: "task.progress",
      actor: { type: "agent", id: input.agentId },
      groupId: task.groupId,
      threadId: task.threadId,
      taskId: task.id,
      payload: {
        taskId: task.id,
        runId: run.id,
        percent,
        stage,
        message: progressMessage,
      },
      createdAt: now,
    });
    return db.select().from(taskRuns).where(eq(taskRuns.id, run.id)).get()!;
  });
}

function latestRun(
  db: RoomDb,
  taskId: string,
  status: TaskRunRow["status"],
): TaskRunRow | undefined {
  return db
    .select()
    .from(taskRuns)
    .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.status, status)))
    .orderBy(desc(taskRuns.startedAt))
    .get();
}

export function getTask(
  ctx: RoomContext,
  input: { taskId: string; viewerUserId: string },
): TaskRow {
  const task = getTaskRow(ctx, input.taskId);
  requireGroupMember(ctx.db, task.groupId, { type: "user", id: input.viewerUserId });
  return task;
}

export function listTasks(
  ctx: RoomContext,
  input: {
    groupId: string;
    viewerUserId: string;
    status?: TaskRow["status"];
    limit?: number;
    cursor?: string | null;
  },
): { items: TaskRow[]; nextCursor: string | null } {
  requireGroupMember(ctx.db, input.groupId, { type: "user", id: input.viewerUserId });
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const conditions = [eq(tasks.groupId, input.groupId)];
  if (input.status) conditions.push(eq(tasks.status, input.status));
  if (input.cursor) {
    const cursor = ctx.db.select().from(tasks).where(eq(tasks.id, input.cursor)).get();
    if (!cursor || cursor.groupId !== input.groupId) {
      throw new ValidationError("cursor does not belong to this group");
    }
    conditions.push(
      or(
        lt(tasks.createdAt, cursor.createdAt),
        and(eq(tasks.createdAt, cursor.createdAt), lt(tasks.id, cursor.id)),
      )!,
    );
  }
  const items = ctx.db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit)
    .all();
  const last = items.at(-1);
  return { items, nextCursor: items.length === limit && last ? last.id : null };
}

export function getTaskRow(ctx: RoomContext, taskId: string): TaskRow {
  const task = ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFoundError(`task ${taskId} not found`);
  return task;
}

export interface AgentTaskView {
  task: TaskRow;
  run: TaskRunRow | null;
  thread: ThreadRow | null;
  workspace: WorkspaceRow | null;
}

function mostRecentRun(db: RoomDb, taskId: string): TaskRunRow | null {
  return (
    db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.taskId, taskId))
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
      .get() ?? null
  );
}

function agentTaskView(db: RoomDb, task: TaskRow): AgentTaskView {
  const thread = task.threadId
    ? (db.select().from(threads).where(eq(threads.id, task.threadId)).get() ?? null)
    : null;
  const workspace = task.workspaceId
    ? (db.select().from(workspaces).where(eq(workspaces.id, task.workspaceId)).get() ?? null)
    : null;
  return { task, run: mostRecentRun(db, task.id), thread, workspace };
}

/**
 * Agent-authenticated recovery surface: the Agent can re-discover the tasks it
 * still owns after a reconnect or a server restart, including the latest run
 * and Thread so it can reload context (ROADMAP §4 task recovery).
 */
export function listAgentTasks(
  ctx: RoomContext,
  input: { agentId: string; includeTerminal?: boolean },
): AgentTaskView[] {
  const active: TaskRow["status"][] = [
    "queued",
    "assigned",
    "running",
    "waiting_approval",
    "paused",
  ];
  const rows = ctx.db
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(
      groupMembers,
      and(
        eq(groupMembers.groupId, tasks.groupId),
        eq(groupMembers.memberType, "agent"),
        eq(groupMembers.memberId, input.agentId),
      ),
    )
    .where(eq(tasks.assignedAgentId, input.agentId))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .all();
  return rows
    .filter(({ task }) => input.includeTerminal || active.includes(task.status))
    .map(({ task }) => agentTaskView(ctx.db, task));
}

export function getAgentTask(
  ctx: RoomContext,
  input: { agentId: string; taskId: string },
): AgentTaskView {
  const task = getTaskRow(ctx, input.taskId);
  if (
    task.assignedAgentId !== input.agentId ||
    !isGroupMember(ctx.db, task.groupId, "agent", input.agentId)
  ) {
    // Assignment alone is not authorization, and we do not leak task existence.
    throw new NotFoundError(`task ${input.taskId} not found`);
  }
  return agentTaskView(ctx.db, task);
}
