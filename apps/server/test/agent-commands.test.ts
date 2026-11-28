import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { agentCommands, agentDeliveries, approvals, events, taskRuns, tasks } from "@room/database";
import {
  ackCommand,
  countUnackedCommands,
  createTaskCancelCommand,
  listAgentCommands,
  markCommandDelivered,
} from "../src/modules/agentCommands.js";
import {
  cancelTask,
  completeTask,
  createTaskFromMessage,
  postMessage,
  reportTaskProgress,
  requestApproval,
  startTask,
} from "../src/modules/index.js";
import { addMember, removeMember } from "../src/modules/groups.js";
import { NotFoundError } from "../src/modules/errors.js";
import { createTestRoom, seedAgent, seedGroup, seedUser } from "./helpers.js";

function setup() {
  const room = createTestRoom();
  const ctx = room.ctx;
  const owner = seedUser(ctx, "owner", "owner");
  const groupId = seedGroup(ctx, owner, "commands");
  const agent = seedAgent(ctx, owner, "agent");
  addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent });
  const source = postMessage(ctx, {
    groupId,
    actor: { type: "user", id: owner },
    content: "build it",
  });
  const { task, threadId } = createTaskFromMessage(ctx, {
    groupId,
    sourceMessageId: source.id,
    title: "write report",
    createdByUserId: owner,
    assignedAgentId: agent,
  });
  startTask(ctx, { taskId: task.id, agentId: agent });
  return { room, ctx, owner, groupId, agent, task, threadId };
}

describe("M5 Review Fix 4 — durable Agent control commands", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("creates one pending task.cancel command when the agent is removed", () => {
    const { room, ctx, owner, groupId, agent, task, threadId } = setup();
    cleanup = room.close;
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agent,
      title: "Deploy?",
    });
    const run = ctx.db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id)).get()!;

    removeMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent });

    const cancelled = ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBe("agent removed from group");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(ctx.db.select().from(taskRuns).where(eq(taskRuns.id, run.id)).get()?.status).toBe(
      "cancelled",
    );
    expect(ctx.db.select().from(approvals).where(eq(approvals.id, approval.id)).get()?.status).toBe(
      "cancelled",
    );
    expect(threadId).not.toBeNull();
    expect(ctx.db.select().from(tasks).get()!);

    const commands = listAgentCommands(ctx, { agentId: agent });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      commandType: "task.cancel",
      taskId: task.id,
      runId: run.id,
      reason: "agent removed from group",
      status: "pending",
    });

    const cancelledEvent = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.type, "task.cancelled"), eq(events.taskId, task.id)))
      .get()!;
    expect(
      ctx.db
        .select()
        .from(agentDeliveries)
        .where(eq(agentDeliveries.eventId, cancelledEvent.id))
        .all(),
    ).toHaveLength(0);
  });

  it("delivers and acknowledges a command idempotently, and rejects foreign ack", () => {
    const { room, ctx, owner, groupId, agent, task } = setup();
    cleanup = room.close;
    const other = seedAgent(ctx, owner, "other");
    removeMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent });
    const command = listAgentCommands(ctx, { agentId: agent })[0];
    expect(command).toBeDefined();

    markCommandDelivered(ctx, { commandId: command.id, agentId: agent });
    expect(listAgentCommands(ctx, { agentId: agent })).toHaveLength(0);
    expect(listAgentCommands(ctx, { agentId: agent, includeDelivered: true })).toHaveLength(1);

    const acked = ackCommand(ctx, { commandId: command.id, agentId: agent });
    expect(acked.status).toBe("acked");
    expect(countUnackedCommands(ctx, agent)).toBe(0);
    // Repeated ack is idempotent.
    expect(ackCommand(ctx, { commandId: command.id, agentId: agent }).status).toBe("acked");
    // Another Agent cannot ack (or probe) the command.
    expect(() => ackCommand(ctx, { commandId: command.id, agentId: other })).toThrow(NotFoundError);
    expect(() => ackCommand(ctx, { commandId: "cmd_unknown", agentId: agent })).toThrow(
      NotFoundError,
    );
    expect(
      ctx.db.select().from(agentCommands).where(eq(agentCommands.taskId, task.id)).all(),
    ).toHaveLength(1);
  });

  it("only revokes the removed group and leaves terminal tasks and other groups alone", () => {
    const { room, ctx, owner, groupId, agent, task } = setup();
    cleanup = room.close;
    const otherGroup = seedGroup(ctx, owner, "kept");
    addMember(ctx, {
      groupId: otherGroup,
      actorUserId: owner,
      memberType: "agent",
      memberId: agent,
    });
    const otherSource = postMessage(ctx, {
      groupId: otherGroup,
      actor: { type: "user", id: owner },
      content: "other task",
    });
    const otherTask = createTaskFromMessage(ctx, {
      groupId: otherGroup,
      sourceMessageId: otherSource.id,
      title: "other",
      createdByUserId: owner,
      assignedAgentId: agent,
    });
    startTask(ctx, { taskId: otherTask.task.id, agentId: agent });

    // A task cancelled manually before removal is terminal: no command for it.
    const finishedSource = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "finished source",
    });
    const finished = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: finishedSource.id,
      title: "finished",
      createdByUserId: owner,
      assignedAgentId: agent,
    });
    startTask(ctx, { taskId: finished.task.id, agentId: agent });
    cancelTask(ctx, { taskId: finished.task.id, actorUserId: owner, reason: "no longer needed" });

    removeMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent });

    expect(ctx.db.select().from(tasks).where(eq(tasks.id, otherTask.task.id)).get()?.status).toBe(
      "running",
    );
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, finished.task.id)).get()?.status).toBe(
      "cancelled",
    );
    const commands = ctx.db.select().from(agentCommands).all();
    expect(commands).toHaveLength(1);
    expect(commands[0].taskId).toBe(task.id);
    expect(commands[0].commandType).toBe("task.cancel");
  });

  it("does not create commands when a user member is removed", () => {
    const { room, ctx, owner, groupId, agent, task } = setup();
    cleanup = room.close;
    const member = seedUser(ctx, "member");
    addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member });
    removeMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member });
    expect(ctx.db.select().from(agentCommands).all()).toHaveLength(0);
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe("running");
    expect(listAgentCommands(ctx, { agentId: agent })).toHaveLength(0);
  });

  it("deduplicates command creation for the same task", () => {
    const { room, ctx, agent, task } = setup();
    cleanup = room.close;
    const first = createTaskCancelCommand(ctx.db, {
      agentId: agent,
      taskId: task.id,
      runId: null,
      reason: "agent removed from group",
      now: ctx.now(),
    });
    const second = createTaskCancelCommand(ctx.db, {
      agentId: agent,
      taskId: task.id,
      runId: null,
      reason: "agent removed from group",
      now: ctx.now(),
    });
    expect(second.id).toBe(first.id);
    expect(ctx.db.select().from(agentCommands).all()).toHaveLength(1);
  });

  it("rejects further execution calls from the removed agent", () => {
    const { room, ctx, owner, groupId, agent, task } = setup();
    cleanup = room.close;
    removeMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent });
    expect(() =>
      reportTaskProgress(ctx, { taskId: task.id, agentId: agent, percent: 50 }),
    ).toThrow();
    expect(() =>
      completeTask(ctx, {
        taskId: task.id,
        agentId: agent,
        outcome: "succeeded",
        summary: "done",
        result: "done",
      }),
    ).toThrow();
    expect(() => startTask(ctx, { taskId: task.id, agentId: agent })).toThrow();
    expect(() =>
      requestApproval(ctx, { taskId: task.id, agentId: agent, title: "again" }),
    ).toThrow();
  });
});

describe("command redelivery lease", () => {
  it("re-lists a delivered command only after its lease expires", () => {
    const { room, ctx, agent, task } = setup();
    try {
      const command = createTaskCancelCommand(ctx.db, {
        agentId: agent,
        taskId: task.id,
        runId: null,
        reason: "test",
        now: ctx.now(),
      });
      expect(listAgentCommands(ctx, { agentId: agent })).toHaveLength(1);
      markCommandDelivered(ctx, { commandId: command.id, agentId: agent });
      expect(listAgentCommands(ctx, { agentId: agent })).toHaveLength(0);
      expect(
        listAgentCommands(ctx, {
          agentId: agent,
          includeDelivered: true,
          staleDeliveredBefore: ctx.now() + 1_000,
        }),
      ).toHaveLength(1);
      expect(
        listAgentCommands(ctx, {
          agentId: agent,
          includeDelivered: true,
          staleDeliveredBefore: ctx.now() - 1_000,
        }),
      ).toHaveLength(0);
    } finally {
      room.close();
    }
  });
});
