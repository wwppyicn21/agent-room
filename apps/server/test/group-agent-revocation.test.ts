import { and, desc, eq } from "drizzle-orm";
import {
  agentDeliveries,
  approvals,
  auditLogs,
  events,
  groupMembers,
  tasks,
  taskRuns,
  threads,
} from "@room/database";
import { afterEach, describe, expect, it } from "vitest";
import { addMember, createGroup, removeMember } from "../src/modules/groups.js";
import {
  appendEvent,
  enqueueDelivery,
  listOutstandingDeliveries,
  markDeliveryDelivered,
} from "../src/modules/events.js";
import { listThreadMessagesForAgent, postMessage } from "../src/modules/messages.js";
import { userActor } from "../src/modules/permissions.js";
import { requestApproval } from "../src/modules/approvals.js";
import { createThread } from "../src/modules/threads.js";
import {
  completeTask,
  createTaskFromMessage,
  getAgentTask,
  listAgentTasks,
  pauseTask,
  reportTaskProgress,
  startTask,
} from "../src/modules/tasks.js";
import { createTestRoom, seedAgent, seedGroup, seedUser, type TestRoom } from "./helpers.js";

const rooms: TestRoom[] = [];

afterEach(() => {
  for (const room of rooms.splice(0)) room.close();
});

interface Fixture {
  room: TestRoom;
  owner: string;
  groupId: string;
  agentId: string;
}

function fixture(name = "group"): Fixture {
  const room = createTestRoom();
  rooms.push(room);
  const owner = seedUser(room.ctx, "owner", "owner");
  const groupId = seedGroup(room.ctx, owner, name);
  const agentId = seedAgent(room.ctx, owner, `agent-${name}`);
  addMember(room.ctx, {
    groupId,
    actorUserId: owner,
    memberType: "agent",
    memberId: agentId,
  });
  return { room, owner, groupId, agentId };
}

function source(ctx: TestRoom["ctx"], groupId: string, owner: string, content = "source") {
  return postMessage(ctx, { groupId, actor: userActor(owner), content });
}

function assignedTask(
  ctx: TestRoom["ctx"],
  input: { groupId: string; owner: string; agentId: string; title: string },
) {
  const message = source(ctx, input.groupId, input.owner, `${input.title} source`);
  return createTaskFromMessage(ctx, {
    groupId: input.groupId,
    sourceMessageId: message.id,
    title: input.title,
    assignedAgentId: input.agentId,
    createdByUserId: input.owner,
  }).task;
}

function deliveriesOf(ctx: TestRoom["ctx"], agentId: string) {
  return ctx.db.select().from(agentDeliveries).where(eq(agentDeliveries.agentId, agentId)).all();
}

function removeAgent(fixture: Fixture): void {
  removeMember(fixture.room.ctx, {
    groupId: fixture.groupId,
    actorUserId: fixture.owner,
    memberType: "agent",
    memberId: fixture.agentId,
  });
}

describe("group agent membership revocation", () => {
  it("revokes Group A recovery, Thread history, deliveries and tasks while keeping Group B", () => {
    const a = fixture("a");
    const groupB = createGroup(a.room.ctx, { name: "b", createdByUserId: a.owner }).id;
    addMember(a.room.ctx, {
      groupId: groupB,
      actorUserId: a.owner,
      memberType: "agent",
      memberId: a.agentId,
    });

    const taskA = assignedTask(a.room.ctx, {
      groupId: a.groupId,
      owner: a.owner,
      agentId: a.agentId,
      title: "task-a",
    });
    startTask(a.room.ctx, { taskId: taskA.id, agentId: a.agentId });
    const approval = requestApproval(a.room.ctx, {
      taskId: taskA.id,
      agentId: a.agentId,
      title: "approve-a",
    });

    postMessage(a.room.ctx, {
      groupId: a.groupId,
      actor: userActor(a.owner),
      content: "pending thread message",
      threadId: taskA.threadId,
    });
    const pending = deliveriesOf(a.room.ctx, a.agentId).at(-1)!;
    expect(pending.status).toBe("pending");
    postMessage(a.room.ctx, {
      groupId: a.groupId,
      actor: userActor(a.owner),
      content: "delivered thread message",
      threadId: taskA.threadId,
    });
    const delivered = deliveriesOf(a.room.ctx, a.agentId).at(-1)!;
    markDeliveryDelivered(a.room.ctx, { deliveryId: delivered.id, agentId: a.agentId });

    const taskB = assignedTask(a.room.ctx, {
      groupId: groupB,
      owner: a.owner,
      agentId: a.agentId,
      title: "task-b",
    });
    startTask(a.room.ctx, { taskId: taskB.id, agentId: a.agentId });
    postMessage(a.room.ctx, {
      groupId: groupB,
      actor: userActor(a.owner),
      content: "group b message",
      threadId: taskB.threadId,
    });
    const deliveryB = deliveriesOf(a.room.ctx, a.agentId).at(-1)!;
    expect(deliveryB.status).toBe("pending");

    removeAgent(a);

    const membership = a.room.ctx.db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, a.groupId),
          eq(groupMembers.memberType, "agent"),
          eq(groupMembers.memberId, a.agentId),
        ),
      )
      .get();
    expect(membership).toBeUndefined();

    const cancelledTask = a.room.ctx.db.select().from(tasks).where(eq(tasks.id, taskA.id)).get()!;
    expect(cancelledTask.status).toBe("cancelled");
    expect(cancelledTask.error).toBe("agent removed from group");
    expect(cancelledTask.cancelledAt).not.toBeNull();

    const run = a.room.ctx.db.select().from(taskRuns).where(eq(taskRuns.taskId, taskA.id)).get()!;
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("agent removed from group");

    const cancelledApproval = a.room.ctx.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .get()!;
    expect(cancelledApproval.status).toBe("cancelled");

    const threadA = a.room.ctx.db
      .select()
      .from(threads)
      .where(eq(threads.id, taskA.threadId!))
      .get()!;
    expect(threadA.status).toBe("closed");

    for (const deliveryId of [pending.id, delivered.id]) {
      const row = a.room.ctx.db
        .select()
        .from(agentDeliveries)
        .where(eq(agentDeliveries.id, deliveryId))
        .get()!;
      expect(row.status).toBe("failed");
      expect(row.lastError).toBe("group membership revoked");
    }

    const outstanding = listOutstandingDeliveries(a.room.ctx, { agentId: a.agentId });
    expect(
      outstanding.every((delivery) => {
        const event = a.room.ctx.db
          .select()
          .from(events)
          .where(eq(events.id, delivery.eventId))
          .get();
        return event?.groupId === groupB;
      }),
    ).toBe(true);

    const taskBRow = a.room.ctx.db.select().from(tasks).where(eq(tasks.id, taskB.id)).get()!;
    expect(taskBRow.status).toBe("running");
    const deliveryBAfter = a.room.ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.id, deliveryB.id))
      .get()!;
    expect(deliveryBAfter.status).toBe("pending");

    const recovery = listAgentTasks(a.room.ctx, { agentId: a.agentId });
    expect(recovery.map((view) => view.task.id)).toEqual([taskB.id]);
    expect(getAgentTask(a.room.ctx, { agentId: a.agentId, taskId: taskB.id }).task.id).toBe(
      taskB.id,
    );
    expect(() => getAgentTask(a.room.ctx, { agentId: a.agentId, taskId: taskA.id })).toThrow(
      /not found/,
    );
    expect(() =>
      listThreadMessagesForAgent(a.room.ctx, { agentId: a.agentId, threadId: taskA.threadId! }),
    ).toThrow(/not a member/);
    expect(
      listThreadMessagesForAgent(a.room.ctx, { agentId: a.agentId, threadId: taskB.threadId! })
        .items,
    ).not.toHaveLength(0);

    // Cancelling the task closes its Thread, so normal Thread rules reject new
    // messages. A still-open plain Thread accepts the user message but has no
    // Agent subscriber and therefore creates no delivery.
    expect(() =>
      postMessage(a.room.ctx, {
        groupId: a.groupId,
        actor: userActor(a.owner),
        content: "after removal",
        threadId: taskA.threadId,
      }),
    ).toThrow(/closed/);
    const plainSource = source(a.room.ctx, a.groupId, a.owner, "plain source");
    const plain = createThread(a.room.ctx, {
      groupId: a.groupId,
      sourceMessageId: plainSource.id,
      title: "plain",
      createdByUserId: a.owner,
    });
    const afterRevocation = deliveriesOf(a.room.ctx, a.agentId).length;
    const message = postMessage(a.room.ctx, {
      groupId: a.groupId,
      actor: userActor(a.owner),
      content: "after removal",
      threadId: plain.id,
    });
    expect(message.id).toMatch(/^msg_/);
    expect(deliveriesOf(a.room.ctx, a.agentId)).toHaveLength(afterRevocation);

    // Agent write endpoints keep rejecting the removed Agent.
    expect(() => startTask(a.room.ctx, { taskId: taskA.id, agentId: a.agentId })).toThrow(
      /not a member/,
    );
    expect(() =>
      reportTaskProgress(a.room.ctx, { taskId: taskA.id, agentId: a.agentId, percent: 50 }),
    ).toThrow(/not a member/);
    expect(() =>
      completeTask(a.room.ctx, {
        taskId: taskA.id,
        agentId: a.agentId,
        outcome: "succeeded",
        summary: "done",
      }),
    ).toThrow(/not a member/);
    expect(() =>
      requestApproval(a.room.ctx, { taskId: taskA.id, agentId: a.agentId, title: "again" }),
    ).toThrow();
  });

  it("cancels every non-terminal task state and leaves terminal tasks untouched", () => {
    const f = fixture("states");
    const ctx = f.room.ctx;
    const queued = source(ctx, f.groupId, f.owner, "queued source");
    const queuedTask = createTaskFromMessage(ctx, {
      groupId: f.groupId,
      sourceMessageId: queued.id,
      title: "queued",
      createdByUserId: f.owner,
    }).task;
    ctx.db
      .update(tasks)
      .set({ assignedAgentId: f.agentId })
      .where(eq(tasks.id, queuedTask.id))
      .run();

    const assigned = assignedTask(ctx, {
      groupId: f.groupId,
      owner: f.owner,
      agentId: f.agentId,
      title: "assigned",
    });
    const running = assignedTask(ctx, {
      groupId: f.groupId,
      owner: f.owner,
      agentId: f.agentId,
      title: "running",
    });
    startTask(ctx, { taskId: running.id, agentId: f.agentId });

    const waiting = assignedTask(ctx, {
      groupId: f.groupId,
      owner: f.owner,
      agentId: f.agentId,
      title: "waiting",
    });
    startTask(ctx, { taskId: waiting.id, agentId: f.agentId });
    requestApproval(ctx, { taskId: waiting.id, agentId: f.agentId, title: "approve" });

    const paused = assignedTask(ctx, {
      groupId: f.groupId,
      owner: f.owner,
      agentId: f.agentId,
      title: "paused",
    });
    startTask(ctx, { taskId: paused.id, agentId: f.agentId });
    pauseTask(ctx, { taskId: paused.id, actorUserId: f.owner });

    const terminal = [] as { id: string; status: string; updatedAt: number }[];
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      const message = source(ctx, f.groupId, f.owner, `${status} source`);
      const task = createTaskFromMessage(ctx, {
        groupId: f.groupId,
        sourceMessageId: message.id,
        title: status,
        createdByUserId: f.owner,
      }).task;
      ctx.db
        .update(tasks)
        .set({ status, updatedAt: 1234, cancelledAt: null })
        .where(eq(tasks.id, task.id))
        .run();
      terminal.push({ id: task.id, status, updatedAt: 1234 });
    }

    removeAgent(f);

    for (const taskId of [queuedTask.id, assigned.id, running.id, waiting.id, paused.id]) {
      const row = ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
      expect(row.status).toBe("cancelled");
      expect(row.error).toBe("agent removed from group");
    }
    for (const item of terminal) {
      const row = ctx.db.select().from(tasks).where(eq(tasks.id, item.id)).get()!;
      expect(row.status).toBe(item.status);
      expect(row.updatedAt).toBe(item.updatedAt);
      expect(row.cancelledAt).toBeNull();
    }
    const runs = ctx.db.select().from(taskRuns).all();
    expect(
      runs
        .filter((run) => [running.id, paused.id].includes(run.taskId))
        .every((run) => run.status === "cancelled"),
    ).toBe(true);
  });

  it("does not cancel Agent tasks when a User member is removed", () => {
    const f = fixture("user-remove");
    const ctx = f.room.ctx;
    const member = seedUser(ctx, "member");
    addMember(ctx, {
      groupId: f.groupId,
      actorUserId: f.owner,
      memberType: "user",
      memberId: member,
    });
    const task = assignedTask(ctx, {
      groupId: f.groupId,
      owner: f.owner,
      agentId: f.agentId,
      title: "keep",
    });
    startTask(ctx, { taskId: task.id, agentId: f.agentId });

    removeMember(ctx, {
      groupId: f.groupId,
      actorUserId: f.owner,
      memberType: "user",
      memberId: member,
    });

    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe("running");
    expect(
      ctx.db
        .select()
        .from(events)
        .where(and(eq(events.groupId, f.groupId), eq(events.type, "task.cancelled")))
        .all(),
    ).toHaveLength(0);
  });

  it("rolls the whole removal back on failure and stays idempotent afterwards", () => {
    const f = fixture("rollback");
    const ctx = f.room.ctx;
    const task = assignedTask(ctx, {
      groupId: f.groupId,
      owner: f.owner,
      agentId: f.agentId,
      title: "rollback",
    });
    startTask(ctx, { taskId: task.id, agentId: f.agentId });
    const event = appendEvent(ctx.db, {
      type: "message.created",
      actor: { type: "user", id: f.owner },
      groupId: f.groupId,
      payload: { messageId: "msg_manual" },
      createdAt: ctx.now(),
    });
    const delivery = enqueueDelivery(ctx.db, {
      agentId: f.agentId,
      eventId: event.id,
      createdAt: ctx.now(),
    });

    const client = (ctx.db as unknown as { $client: { exec(sql: string): void } }).$client;
    client.exec(
      "CREATE TRIGGER fail_member_removed BEFORE INSERT ON events WHEN NEW.type = 'group.member_removed' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    expect(() => removeAgent(f)).toThrow();
    client.exec("DROP TRIGGER fail_member_removed");

    expect(
      ctx.db
        .select()
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, f.groupId),
            eq(groupMembers.memberType, "agent"),
            eq(groupMembers.memberId, f.agentId),
          ),
        )
        .get(),
    ).toBeDefined();
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe("running");
    expect(
      ctx.db.select().from(agentDeliveries).where(eq(agentDeliveries.id, delivery.id)).get()!
        .status,
    ).toBe("pending");

    removeAgent(f);
    const firstCancelEvents = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.groupId, f.groupId), eq(events.type, "task.cancelled")))
      .all();

    expect(() => removeAgent(f)).toThrow(/not found/);
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe(
      "cancelled",
    );
    expect(
      ctx.db
        .select()
        .from(events)
        .where(and(eq(events.groupId, f.groupId), eq(events.type, "task.cancelled")))
        .all(),
    ).toHaveLength(firstCancelEvents.length);
  });

  it("records the task cancellation audit and does not deliver it to the removed Agent", () => {
    const f = fixture("audit");
    const ctx = f.room.ctx;
    const task = assignedTask(ctx, {
      groupId: f.groupId,
      owner: f.owner,
      agentId: f.agentId,
      title: "audited",
    });
    startTask(ctx, { taskId: task.id, agentId: f.agentId });
    removeAgent(f);

    const cancelledEvent = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.groupId, f.groupId), eq(events.type, "task.cancelled")))
      .get()!;
    expect(cancelledEvent.threadId).toBe(task.threadId);
    expect(cancelledEvent.taskId).toBe(task.id);
    expect(JSON.parse(cancelledEvent.payload).reason).toBe("agent removed from group");
    expect(
      ctx.db
        .select()
        .from(agentDeliveries)
        .where(
          and(
            eq(agentDeliveries.eventId, cancelledEvent.id),
            eq(agentDeliveries.agentId, f.agentId),
          ),
        )
        .get(),
    ).toBeUndefined();

    const audit = ctx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "task.cancel"), eq(auditLogs.targetId, task.id)))
      .get()!;
    expect(JSON.parse(audit.metadata).reason).toBe("agent removed from group");

    const latest = ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.agentId, f.agentId))
      .orderBy(desc(agentDeliveries.createdAt))
      .all();
    expect(latest.every((row) => row.eventId !== cancelledEvent.id)).toBe(true);
  });
});
