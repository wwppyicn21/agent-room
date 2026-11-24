import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentDeliveries,
  approvals,
  auditLogs,
  events,
  messages,
  taskRuns,
  tasks,
  threads,
} from "@room/database";
import {
  ackDelivery,
  createTaskFromMessage,
  expireApproval,
  listOutstandingDeliveries,
  markDeliveryDelivered,
  postMessage,
  requestApproval,
  startTask,
} from "../src/modules/index.js";
import { addMember } from "../src/modules/groups.js";
import { createTestRoom, markAgentOnline, seedAgent, seedGroup, seedUser } from "./helpers.js";

function setup(options: { onlineAssignee: boolean; clock: { value: number } }) {
  const room = createTestRoom(() => options.clock.value);
  const ctx = room.ctx;
  const owner = seedUser(ctx, "owner", "owner");
  const groupId = seedGroup(ctx, owner, "expiry");
  const agentA = seedAgent(ctx, owner, "agent-a");
  const agentB = seedAgent(ctx, owner, "agent-b");
  const agentC = seedAgent(ctx, owner, "agent-c");
  for (const agentId of [agentA, agentB, agentC]) {
    addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentId });
  }
  for (const agentId of [agentB, agentC]) markAgentOnline(ctx, agentId);
  if (options.onlineAssignee) markAgentOnline(ctx, agentA);

  const source = postMessage(ctx, {
    groupId,
    actor: { type: "user", id: owner },
    content: "prepare the report",
  });
  const created = createTaskFromMessage(ctx, {
    groupId,
    sourceMessageId: source.id,
    title: "report",
    createdByUserId: owner,
    assignedAgentId: agentA,
  });
  startTask(ctx, { taskId: created.task.id, agentId: agentA });
  const approval = requestApproval(ctx, {
    taskId: created.task.id,
    agentId: agentA,
    title: "deploy",
    expiresAt: options.clock.value + 1_000,
  });
  return { room, ctx, owner, groupId, agentA, agentB, agentC, task: created.task, approval };
}

function expirationEvent(ctx: ReturnType<typeof setup>["ctx"], taskId: string) {
  return ctx.db
    .select()
    .from(events)
    .where(and(eq(events.type, "task.approval_expired"), eq(events.taskId, taskId)))
    .all();
}

function summaryMessages(ctx: ReturnType<typeof setup>["ctx"], taskId: string) {
  return ctx.db
    .select()
    .from(messages)
    .where(eq(messages.clientMessageId, `task-summary:${taskId}`))
    .all();
}

describe("M5 Review Fix 3A — approval expiration assignee delivery", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("creates one durable delivery to the assignee for the approval expiry event", () => {
    const clock = { value: 1_800_000_000_000 };
    const { room, ctx, owner, agentA, task, approval } = setup({
      onlineAssignee: true,
      clock,
    });
    cleanup = room.close;
    clock.value += 2_000;
    expireApproval(ctx, { approvalId: approval.id });

    expect(ctx.db.select().from(approvals).where(eq(approvals.id, approval.id)).get()!.status).toBe(
      "expired",
    );
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe("failed");
    expect(ctx.db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id)).get()!.status).toBe(
      "failed",
    );
    expect(ctx.db.select().from(threads).where(eq(threads.id, task.threadId!)).get()!.status).toBe(
      "failed",
    );

    const lifecycleEvents = expirationEvent(ctx, task.id);
    expect(lifecycleEvents).toHaveLength(1);
    const event = lifecycleEvents[0];
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    expect(payload.taskId).toBe(task.id);
    expect(payload.approvalId).toBe(approval.id);
    expect(payload.threadId).toBe(task.threadId);
    expect(payload.reason).toBe("approval expired");
    expect(payload.status).toBe("failed");
    expect(event.actorType).toBe("system");
    expect(event.groupId).toBe(task.groupId);

    const deliveries = ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.eventId, event.id))
      .all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].agentId).toBe(agentA);
    expect(deliveries[0].status).toBe("pending");
    expect(deliveries[0].attempts).toBe(0);
    void owner;
  });

  it("references the existing approval expiry event instead of creating a second one", () => {
    const clock = { value: 1_800_000_000_000 };
    const { room, ctx, task, approval } = setup({ onlineAssignee: true, clock });
    cleanup = room.close;
    clock.value += 2_000;
    expireApproval(ctx, { approvalId: approval.id });

    const lifecycleEvents = expirationEvent(ctx, task.id);
    expect(lifecycleEvents).toHaveLength(1);
    const deliveries = ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.eventId, lifecycleEvents[0].id))
      .all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].eventId).toBe(lifecycleEvents[0].id);
    expect(lifecycleEvents[0].type).toBe("task.approval_expired");
    const payload = JSON.parse(lifecycleEvents[0].payload) as Record<string, unknown>;
    expect(payload.approvalId).toBe(approval.id);
    expect(payload.status).toBe("failed");
  });

  it("delivers the expiry only to the assignee while keeping the group summary broadcast", () => {
    const clock = { value: 1_800_000_000_000 };
    const { room, ctx, agentA, agentB, agentC, task, approval } = setup({
      onlineAssignee: true,
      clock,
    });
    cleanup = room.close;
    clock.value += 2_000;
    expireApproval(ctx, { approvalId: approval.id });

    const event = expirationEvent(ctx, task.id)[0];
    const expiryDeliveries = ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.eventId, event.id))
      .all();
    expect(expiryDeliveries.map((delivery) => delivery.agentId)).toEqual([agentA]);

    const summary = summaryMessages(ctx, task.id)[0];
    expect(summary).toBeDefined();
    const summaryEvent = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.taskId, task.id), eq(events.type, "message.created")))
      .all()
      .at(-1)!;
    const summaryDeliveries = ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.eventId, summaryEvent.id))
      .all();
    expect(summaryDeliveries.map((delivery) => delivery.agentId).sort()).toEqual(
      [agentB, agentC].sort(),
    );
  });

  it("keeps the delivery pending while the assignee is offline and allows ack after delivery", () => {
    const clock = { value: 1_800_000_000_000 };
    const { room, ctx, agentA, task, approval } = setup({ onlineAssignee: false, clock });
    cleanup = room.close;
    clock.value += 2_000;
    expireApproval(ctx, { approvalId: approval.id });

    const event = expirationEvent(ctx, task.id)[0];
    const delivery = ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.eventId, event.id))
      .get()!;
    expect(delivery.agentId).toBe(agentA);
    expect(delivery.status).toBe("pending");

    const outstanding = listOutstandingDeliveries(ctx, {
      agentId: agentA,
      now: clock.value,
      includeUnacked: true,
    });
    expect(outstanding.map((row) => row.id)).toContain(delivery.id);

    markDeliveryDelivered(ctx, { deliveryId: delivery.id, agentId: agentA, now: clock.value });
    ackDelivery(ctx, { deliveryId: delivery.id, agentId: agentA, now: clock.value });
    expect(
      ctx.db.select().from(agentDeliveries).where(eq(agentDeliveries.id, delivery.id)).get()!
        .status,
    ).toBe("acked");
  });

  it("does not duplicate events, deliveries, summaries or audits when expiry runs twice", () => {
    const clock = { value: 1_800_000_000_000 };
    const { room, ctx, task, approval } = setup({ onlineAssignee: true, clock });
    cleanup = room.close;
    clock.value += 2_000;
    expireApproval(ctx, { approvalId: approval.id });
    expireApproval(ctx, { approvalId: approval.id });

    expect(expirationEvent(ctx, task.id)).toHaveLength(1);
    expect(summaryMessages(ctx, task.id)).toHaveLength(1);
    const event = expirationEvent(ctx, task.id)[0];
    expect(
      ctx.db.select().from(agentDeliveries).where(eq(agentDeliveries.eventId, event.id)).all(),
    ).toHaveLength(1);
    expect(
      ctx.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "approval.expire"), eq(auditLogs.targetId, task.id)))
        .all(),
    ).toHaveLength(1);
  });

  it("rolls back approval, task, run, thread, event, delivery, summary and audit together", () => {
    const clock = { value: 1_800_000_000_000 };
    const { room, ctx, task, approval } = setup({ onlineAssignee: true, clock });
    cleanup = room.close;
    clock.value += 2_000;
    const deliveriesBefore = ctx.db.select().from(agentDeliveries).all().length;
    const client = (ctx.db as unknown as { $client: { exec(sql: string): void } }).$client;
    client.exec(
      "CREATE TRIGGER fail_approval_expire_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'approval.expire' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    expect(() => expireApproval(ctx, { approvalId: approval.id })).toThrow();
    client.exec("DROP TRIGGER fail_approval_expire_audit");

    expect(ctx.db.select().from(approvals).where(eq(approvals.id, approval.id)).get()!.status).toBe(
      "pending",
    );
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe(
      "waiting_approval",
    );
    expect(ctx.db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id)).get()!.status).toBe(
      "running",
    );
    expect(ctx.db.select().from(threads).where(eq(threads.id, task.threadId!)).get()!.status).toBe(
      "open",
    );
    expect(expirationEvent(ctx, task.id)).toHaveLength(0);
    expect(summaryMessages(ctx, task.id)).toHaveLength(0);
    expect(ctx.db.select().from(agentDeliveries).all()).toHaveLength(deliveriesBefore);
    expect(
      ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "approval.expire")).all(),
    ).toHaveLength(0);
  });

  it("fails the task without an assignee delivery when no assignee is valid", () => {
    const clock = { value: 1_800_000_000_000 };
    const { room, ctx, task, approval } = setup({ onlineAssignee: true, clock });
    cleanup = room.close;
    ctx.db.update(tasks).set({ assignedAgentId: null }).where(eq(tasks.id, task.id)).run();
    clock.value += 2_000;
    expireApproval(ctx, { approvalId: approval.id });

    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe("failed");
    const event = expirationEvent(ctx, task.id)[0];
    expect(event).toBeDefined();
    expect(
      ctx.db.select().from(agentDeliveries).where(eq(agentDeliveries.eventId, event.id)).all(),
    ).toHaveLength(0);
    expect(summaryMessages(ctx, task.id)).toHaveLength(1);
    expect(
      ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "approval.expire")).all(),
    ).toHaveLength(1);
  });
});
