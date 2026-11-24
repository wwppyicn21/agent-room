import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentDeliveries,
  events,
  groups,
  migrationsFolder,
  openDatabase,
  taskRuns,
  tasks,
  approvals,
} from "@room/database";
import { TASK_RUN_STATUSES, newId, taskRunStatusSchema } from "@room/protocol";
import {
  approveApproval,
  createTaskFromMessage,
  createThread,
  createWorkspace,
  getAgentTask,
  getTask,
  listAgentTasks,
  listGroupEvents,
  listTasks,
  listThreadEvents,
  listThreadMessagesForAgent,
  listWorkspaces,
  getWorkspace,
  postMessage,
  rejectApproval,
  requestApproval,
  startTask,
} from "../src/modules/index.js";
import { addMember } from "../src/modules/groups.js";
import { createRoomContext } from "../src/modules/context.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../src/modules/errors.js";
import { createTestRoom, markAgentOnline, seedAgent, seedGroup, seedUser } from "./helpers.js";

function setup(clock?: { value: number }) {
  const room = createTestRoom(clock ? () => clock.value : undefined);
  const ctx = room.ctx;
  const owner = seedUser(ctx, "owner", "owner");
  const groupId = seedGroup(ctx, owner, "m5r2");
  const agentA = seedAgent(ctx, owner, "agent-a");
  const agentB = seedAgent(ctx, owner, "agent-b");
  addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentA });
  addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentB });
  markAgentOnline(ctx, agentA);
  markAgentOnline(ctx, agentB);
  const source = postMessage(ctx, {
    groupId,
    actor: { type: "user", id: owner },
    content: "prepare the report",
  });
  return { room, ctx, owner, groupId, agentA, agentB, source };
}

function setupRunningTask(clock?: { value: number }) {
  const base = setup(clock);
  const created = createTaskFromMessage(base.ctx, {
    groupId: base.groupId,
    sourceMessageId: base.source.id,
    title: "report",
    createdByUserId: base.owner,
    assignedAgentId: base.agentA,
  });
  startTask(base.ctx, { taskId: created.task.id, agentId: base.agentA });
  return { ...base, task: created.task, threadId: created.threadId };
}

function deliveriesForEvent(ctx: Parameters<typeof listGroupEvents>[0], eventId: string) {
  return ctx.db.select().from(agentDeliveries).where(eq(agentDeliveries.eventId, eventId)).all();
}

function threadMessageEvent(ctx: Parameters<typeof listGroupEvents>[0], threadId: string) {
  return ctx.db
    .select()
    .from(events)
    .where(eq(events.threadId, threadId))
    .all()
    .filter((event) => event.type === "message.created")
    .at(-1)!;
}

describe("M5 review round 2 — Thread delivery, approvals, recovery", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("delivers a user Thread message only to the assigned Agent", () => {
    const { room, ctx, owner, groupId, agentA, agentB, threadId } = setupRunningTask();
    cleanup = room.close;
    const message = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "any update?",
      threadId,
    });
    const event = threadMessageEvent(ctx, threadId);
    const deliveries = deliveriesForEvent(ctx, event.id);
    expect(deliveries.map((delivery) => delivery.agentId)).toEqual([agentA]);
    expect(deliveries.some((delivery) => delivery.agentId === agentB)).toBe(false);
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    expect(payload.threadId).toBe(threadId);
    expect(payload.taskId).toBeDefined();
    expect(payload.messageId).toBe(message.id);
  });

  it("does not deliver plain Thread messages and does not let an Agent self-deliver", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const plain = createThread(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "discussion",
      createdByUserId: owner,
    });
    postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "no task here",
      threadId: plain.id,
    });
    expect(deliveriesForEvent(ctx, threadMessageEvent(ctx, plain.id).id)).toHaveLength(0);

    const created = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "self delivery",
      createdByUserId: owner,
      assignedAgentId: agentA,
    });
    startTask(ctx, { taskId: created.task.id, agentId: agentA });
    postMessage(ctx, {
      groupId,
      actor: { type: "agent", id: agentA },
      content: "I am working on it",
      threadId: created.threadId,
    });
    expect(deliveriesForEvent(ctx, threadMessageEvent(ctx, created.threadId).id)).toHaveLength(0);
  });

  it("allows an assigned Agent to reply in the Thread even when group discussion is disabled", () => {
    const { room, ctx, groupId, agentA, threadId } = setupRunningTask();
    cleanup = room.close;
    ctx.db.update(groups).set({ allowAgentMessages: false }).where(eq(groups.id, groupId)).run();
    const reply = postMessage(ctx, {
      groupId,
      actor: { type: "agent", id: agentA },
      content: "working",
      threadId,
    });
    expect(reply.threadId).toBe(threadId);
  });

  it("rejects approving or rejecting an approval whose deadline passed before the sweeper ran", () => {
    const clock = { value: 1_800_000_000_000 };
    const { room, ctx, owner, agentA, task } = setupRunningTask(clock);
    cleanup = room.close;
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agentA,
      title: "deploy",
      expiresAt: clock.value + 1_000,
    });
    clock.value += 2_000;
    expect(() => approveApproval(ctx, { approvalId: approval.id, actorUserId: owner })).toThrow(
      ConflictError,
    );
    expect(ctx.db.select().from(approvals).where(eq(approvals.id, approval.id)).get()!.status).toBe(
      "expired",
    );
    expect(ctx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe("failed");
    expect(ctx.db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id)).get()!.status).toBe(
      "failed",
    );
    // A repeated decision cannot resurrect the expired approval.
    expect(() =>
      rejectApproval(ctx, { approvalId: approval.id, actorUserId: owner, reason: "x" }),
    ).toThrow(ConflictError);
  });

  it("rejects Thread messages as a Thread or Task source", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const thread = createThread(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "source rules",
      createdByUserId: owner,
    });
    const inThread = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "thread-only",
      threadId: thread.id,
    });
    expect(() =>
      createThread(ctx, {
        groupId,
        sourceMessageId: inThread.id,
        title: "nested",
        createdByUserId: owner,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createTaskFromMessage(ctx, {
        groupId,
        sourceMessageId: inThread.id,
        title: "nested",
        createdByUserId: owner,
        assignedAgentId: agentA,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects cursors from another group or thread", () => {
    const { room, ctx, owner, groupId, source } = setup();
    cleanup = room.close;
    const otherGroup = seedGroup(ctx, owner, "other");
    const otherSource = postMessage(ctx, {
      groupId: otherGroup,
      actor: { type: "user", id: owner },
      content: "other",
    });
    const event = ctx.db.select().from(events).where(eq(events.groupId, otherGroup)).get()!;
    expect(() =>
      listGroupEvents(ctx, { groupId, viewer: { type: "user", id: owner }, cursor: event.id }),
    ).toThrow(ValidationError);
    expect(() =>
      listThreadEvents(ctx, {
        threadId: createThread(ctx, {
          groupId: otherGroup,
          sourceMessageId: otherSource.id,
          title: "t",
          createdByUserId: owner,
        }).id,
        viewer: { type: "user", id: owner },
        cursor: event.id,
      }),
    ).toThrow(ValidationError);
    expect(() => listTasks(ctx, { groupId, viewerUserId: owner, cursor: source.id })).toThrow(
      ValidationError,
    );
  });

  it("enforces the workspace group boundary and permissions", () => {
    const { room, ctx, owner, groupId, agentA, agentB, source } = setup();
    cleanup = room.close;
    const member = seedUser(ctx, "member", "member");
    addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member });
    const workspace = createWorkspace(ctx, { groupId, actorUserId: owner, name: "repo" });
    expect(() => createWorkspace(ctx, { groupId, actorUserId: owner, name: "repo" })).toThrow(
      ConflictError,
    );
    expect(() => createWorkspace(ctx, { groupId, actorUserId: member, name: "nope" })).toThrow(
      ForbiddenError,
    );
    expect(listWorkspaces(ctx, { groupId, viewerUserId: member }).map((w) => w.id)).toEqual([
      workspace.id,
    ]);

    const otherGroup = seedGroup(ctx, owner, "other");
    const otherWorkspace = createWorkspace(ctx, {
      groupId: otherGroup,
      actorUserId: owner,
      name: "other-repo",
    });
    expect(() =>
      createTaskFromMessage(ctx, {
        groupId,
        sourceMessageId: source.id,
        title: "cross",
        createdByUserId: owner,
        assignedAgentId: agentA,
        workspaceId: otherWorkspace.id,
      }),
    ).toThrow(ValidationError);

    const created = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "scoped",
      createdByUserId: owner,
      assignedAgentId: agentA,
      workspaceId: workspace.id,
      idempotencyKey: "scoped-key",
    });
    expect(getTask(ctx, { taskId: created.task.id, viewerUserId: owner }).workspaceId).toBe(
      workspace.id,
    );
    expect(listAgentTasks(ctx, { agentId: agentA })[0]?.workspace?.id).toBe(workspace.id);
    // Workspace metadata is group-scoped: outsiders cannot read it, and a
    // non-assignee Agent cannot recover it through the task endpoint.
    const outsider = seedUser(ctx, "outsider", "member");
    expect(() => getWorkspace(ctx, { workspaceId: workspace.id, viewerUserId: outsider })).toThrow(
      ForbiddenError,
    );
    expect(() => getAgentTask(ctx, { agentId: agentB, taskId: created.task.id })).toThrow(
      NotFoundError,
    );
    // Reusing the key with a different workspace is a payload conflict.
    expect(() =>
      createTaskFromMessage(ctx, {
        groupId,
        sourceMessageId: source.id,
        title: "scoped",
        createdByUserId: owner,
        assignedAgentId: agentA,
        workspaceId: otherWorkspace.id,
        idempotencyKey: "scoped-key",
      }),
    ).toThrow(ConflictError);
  });

  it("recovers running tasks and Thread history for the assigned Agent after a restart", () => {
    const { room, ctx, owner, groupId, agentA, agentB, task, threadId } = setupRunningTask();
    postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "context before restart",
      threadId,
    });
    room.closeHandle();
    const handle = openDatabase({ path: room.path, migrationsFolder });
    const reopened = createRoomContext(handle);
    try {
      const active = listAgentTasks(reopened, { agentId: agentA });
      expect(active.map((view) => view.task.id)).toEqual([task.id]);
      expect(active[0]!.task.status).toBe("running");
      expect(active[0]!.thread?.id).toBe(threadId);
      expect(getAgentTask(reopened, { agentId: agentA, taskId: task.id }).run?.status).toBe(
        "running",
      );
      const history = listThreadMessagesForAgent(reopened, {
        agentId: agentA,
        threadId,
        limit: 50,
      });
      expect(history.items.map((message) => message.content)).toContain("context before restart");
      expect(() => listThreadMessagesForAgent(reopened, { agentId: agentB, threadId })).toThrow(
        ForbiddenError,
      );
      expect(() => getAgentTask(reopened, { agentId: agentB, taskId: task.id })).toThrow();
      // Thread works after restart and still reaches only the assignee.
      postMessage(reopened, {
        groupId,
        actor: { type: "user", id: owner },
        content: "after restart",
        threadId,
      });
      expect(
        deliveriesForEvent(reopened, threadMessageEvent(reopened, threadId).id).map(
          (delivery) => delivery.agentId,
        ),
      ).toEqual([agentA]);
    } finally {
      handle.close();
      // The original room handle is already closed; remove its directory.
      cleanup = () => room.close();
    }
  });

  it("keeps the paused TaskRun status in the shared protocol", () => {
    expect(TASK_RUN_STATUSES).toContain("paused");
    expect(taskRunStatusSchema.parse("paused")).toBe("paused");
    expect(newId("wks")).toMatch(/^wks_[0-9a-f]{32}$/);
  });
});
