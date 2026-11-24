import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { events, messages, taskRuns, tasks } from "@room/database";
import {
  completeTask,
  createTaskFromMessage,
  pauseTask,
  postMessage,
  resumeTask,
  startTask,
} from "../src/modules/index.js";
import { addMember } from "../src/modules/groups.js";
import { ConflictError } from "../src/modules/errors.js";
import { createTestRoom, seedAgent, seedGroup, seedUser } from "./helpers.js";

function setup() {
  const room = createTestRoom();
  const ctx = room.ctx;
  const owner = seedUser(ctx, "owner", "owner");
  const groupId = seedGroup(ctx, owner, "transitions");
  const agent = seedAgent(ctx, owner, "agent-a");
  addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent });
  const source = postMessage(ctx, {
    groupId,
    actor: { type: "user", id: owner },
    content: "do the work",
  });
  const created = createTaskFromMessage(ctx, {
    groupId,
    sourceMessageId: source.id,
    title: "work",
    createdByUserId: owner,
    assignedAgentId: agent,
  });
  return { room, ctx, owner, groupId, agent, task: created.task };
}

describe("M5 Review Fix 3B — task transition guards", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("rejects a repeated start and keeps exactly one running TaskRun", () => {
    const { room, ctx, agent, task } = setup();
    cleanup = room.close;
    startTask(ctx, { taskId: task.id, agentId: agent });
    expect(() => startTask(ctx, { taskId: task.id, agentId: agent })).toThrow(ConflictError);
    expect(
      ctx.db
        .select()
        .from(taskRuns)
        .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.status, "running")))
        .all(),
    ).toHaveLength(1);
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe("running");
  });

  it("rejects a repeated completion and does not duplicate the summary or event", () => {
    const { room, ctx, agent, task } = setup();
    cleanup = room.close;
    startTask(ctx, { taskId: task.id, agentId: agent });
    completeTask(ctx, {
      taskId: task.id,
      agentId: agent,
      outcome: "succeeded",
      summary: "done",
    });
    expect(() =>
      completeTask(ctx, {
        taskId: task.id,
        agentId: agent,
        outcome: "succeeded",
        summary: "done",
      }),
    ).toThrow(ConflictError);
    expect(
      ctx.db
        .select()
        .from(messages)
        .where(eq(messages.clientMessageId, `task-summary:${task.id}`))
        .all(),
    ).toHaveLength(1);
    expect(
      ctx.db
        .select()
        .from(events)
        .where(and(eq(events.taskId, task.id), eq(events.type, "task.completed")))
        .all(),
    ).toHaveLength(1);
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe(
      "succeeded",
    );
    expect(
      ctx.db
        .select()
        .from(taskRuns)
        .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.status, "succeeded")))
        .all(),
    ).toHaveLength(1);
  });

  it("rejects a repeated pause and keeps Task and Run paused", () => {
    const { room, ctx, owner, agent, task } = setup();
    cleanup = room.close;
    startTask(ctx, { taskId: task.id, agentId: agent });
    pauseTask(ctx, { taskId: task.id, actorUserId: owner });
    expect(() => pauseTask(ctx, { taskId: task.id, actorUserId: owner })).toThrow(ConflictError);
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe("paused");
    expect(ctx.db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id)).get()!.status).toBe(
      "paused",
    );
  });

  it("rejects resume while the Task is still running", () => {
    const { room, ctx, owner, agent, task } = setup();
    cleanup = room.close;
    startTask(ctx, { taskId: task.id, agentId: agent });
    expect(() => resumeTask(ctx, { taskId: task.id, actorUserId: owner })).toThrow(ConflictError);
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe("running");
    expect(ctx.db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id)).get()!.status).toBe(
      "running",
    );
  });

  it("allows only one of two concurrent starts", async () => {
    const { room, ctx, agent, task } = setup();
    cleanup = room.close;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => startTask(ctx, { taskId: task.id, agentId: agent })),
      Promise.resolve().then(() => startTask(ctx, { taskId: task.id, agentId: agent })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      ctx.db
        .select()
        .from(taskRuns)
        .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.status, "running")))
        .all(),
    ).toHaveLength(1);
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe("running");
  });
});
