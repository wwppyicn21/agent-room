import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { taskRuns, type TaskRunRow, tasks, type TaskRow, threads, messages } from "@room/database";
import { newId } from "@room/protocol";
import { messageContentSchema } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { recordAudit } from "./audit.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { appendEvent, enqueueDelivery, enqueueGroupAgentDeliveries } from "./events.js";
import { getGroupMessageRow } from "./messages.js";
import {
  agentActor,
  isGroupMember,
  requireActiveGroup,
  requireAgent,
  requireGroupManager,
  requireGroupMember,
  validateTitle,
} from "./permissions.js";

export type TaskOutcome = "succeeded" | "failed";

export function createTaskFromMessage(
  ctx: RoomContext,
  input: {
    groupId: string;
    sourceMessageId: string;
    title: string;
    description?: string | null;
    assignedAgentId?: string | null;
    createdByUserId: string;
  },
): { task: TaskRow; threadId: string } {
  requireActiveGroup(ctx.db, input.groupId);
  requireGroupMember(ctx.db, input.groupId, { type: "user", id: input.createdByUserId });
  getGroupMessageRow(ctx, input.groupId, input.sourceMessageId);
  const title = validateTitle(input.title, "title");
  if (input.assignedAgentId) {
    requireAgent(ctx.db, input.assignedAgentId);
    if (!isGroupMember(ctx.db, input.groupId, "agent", input.assignedAgentId)) {
      throw new ValidationError(`agent ${input.assignedAgentId} is not a member of the group`);
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
        sourceMessageId: input.sourceMessageId,
        title,
        description: input.description ?? null,
        status: input.assignedAgentId ? "assigned" : "queued",
        priority: 0,
        assignedAgentId: input.assignedAgentId ?? null,
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
      payload: { taskId, title, assignedAgentId: input.assignedAgentId ?? null },
      createdAt: now,
    });
    enqueueGroupAgentDeliveries(db, {
      groupId: input.groupId,
      eventId: created.id,
      createdAt: now,
    });
    if (input.assignedAgentId) {
      const assigned = appendEvent(db, {
        type: "task.assigned",
        actor: { type: "user", id: input.createdByUserId },
        groupId: input.groupId,
        threadId,
        taskId,
        payload: { taskId, agentId: input.assignedAgentId },
        createdAt: now,
      });
      enqueueDelivery(db, {
        agentId: input.assignedAgentId,
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
        assignedAgentId: input.assignedAgentId ?? null,
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
  if (task.assignedAgentId !== input.agentId) {
    throw new ConflictError(`task ${task.id} is not assigned to agent ${input.agentId}`);
  }
  if (task.status !== "assigned") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot start`);
  }
  const now = ctx.now();
  const runId = newId("run");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(tasks).set({ status: "running", updatedAt: now }).where(eq(tasks.id, task.id)).run();
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
    runId?: string | null;
    error?: string | null;
  },
): { task: TaskRow; run: TaskRunRow; summaryMessageId: string } {
  const task = getTaskRow(ctx, input.taskId);
  requireAgent(ctx.db, input.agentId);
  requireGroupMember(ctx.db, task.groupId, agentActor(input.agentId));
  if (task.assignedAgentId !== input.agentId) {
    throw new ConflictError(`task ${task.id} is not assigned to agent ${input.agentId}`);
  }
  if (task.status !== "running" && task.status !== "assigned") {
    throw new ConflictError(`task ${task.id} is ${task.status} and cannot complete`);
  }
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
        summary,
        error: input.error ?? null,
      })
      .where(eq(taskRuns.id, run.id))
      .run();
    db.update(tasks)
      .set({ status: input.outcome, updatedAt: now, completedAt: now })
      .where(eq(tasks.id, task.id))
      .run();

    const header = input.outcome === "succeeded" ? "任务完成" : "任务失败";
    const content = `${header}：${task.title}\n\n${summary}`;
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
        threadId: task.threadId,
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
      threadId: task.threadId,
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
      payload: { taskId: task.id, runId: run.id, summaryMessageId },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "agent",
      actorId: input.agentId,
      action: input.outcome === "succeeded" ? "task.complete" : "task.fail",
      targetType: "task",
      targetId: task.id,
      metadata: { runId: run.id, summaryMessageId },
      createdAt: now,
    });
    return {
      task: db.select().from(tasks).where(eq(tasks.id, task.id)).get()!,
      run: db.select().from(taskRuns).where(eq(taskRuns.id, run.id)).get()!,
      summaryMessageId,
    };
  });
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
    if (cursor && cursor.groupId === input.groupId) {
      conditions.push(
        or(
          lt(tasks.createdAt, cursor.createdAt),
          and(eq(tasks.createdAt, cursor.createdAt), lt(tasks.id, cursor.id)),
        )!,
      );
    }
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

function getTaskRow(ctx: RoomContext, taskId: string): TaskRow {
  const task = ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) throw new NotFoundError(`task ${taskId} not found`);
  return task;
}
