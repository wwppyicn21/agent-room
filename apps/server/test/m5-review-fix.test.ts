import { afterEach, describe, expect, it } from "vitest";
import {
  approvals,
  auditLogs,
  events,
  messages,
  migrationsFolder,
  openDatabase,
  taskRuns,
  tasks,
  threads,
} from "@room/database";
import { and, eq } from "drizzle-orm";
import {
  approveApproval,
  cancelTask,
  closeThread,
  completeTask,
  createTaskFromMessage,
  createThread,
  expireApproval,
  expireDueApprovals,
  listMessages,
  listThreads,
  pauseTask,
  postMessage,
  rejectApproval,
  requestApproval,
  resumeTask,
  startTask,
} from "../src/modules/index.js";
import { addMember } from "../src/modules/groups.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../src/modules/errors.js";
import { createTestRoom, markAgentOnline, seedAgent, seedGroup, seedUser } from "./helpers.js";
import { createRoomContext, type RoomContext } from "../src/modules/context.js";

function setup(clock?: { value: number }) {
  const room = createTestRoom(clock ? () => clock.value : undefined);
  const ctx = room.ctx;
  const owner = seedUser(ctx, "owner", "owner");
  const groupId = seedGroup(ctx, owner, "m5-review");
  const agent = seedAgent(ctx, owner, "agent");
  addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent });
  markAgentOnline(ctx, agent);
  return { room, ctx, owner, groupId, agent };
}

function sourceMessage(ctx: RoomContext, groupId: string, owner: string, content: string): string {
  return postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content }).id;
}

function makeTask(
  ctx: RoomContext,
  input: {
    groupId: string;
    owner: string;
    agent?: string;
    key?: string;
    title?: string;
    sourceId?: string;
  },
) {
  return createTaskFromMessage(ctx, {
    groupId: input.groupId,
    sourceMessageId: input.sourceId ?? sourceMessage(ctx, input.groupId, input.owner, "source"),
    title: input.title ?? "write report",
    createdByUserId: input.owner,
    assignedAgentId: input.agent,
    idempotencyKey: input.key,
  });
}

describe("M5-FIX-01 thread cursor pagination", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function withThreads(count: number) {
    const room = createTestRoom();
    cleanup = room.close;
    const ctx = room.ctx;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const sourceId = sourceMessage(ctx, groupId, owner, `source ${index}`);
      ids.push(
        createThread(ctx, {
          groupId,
          sourceMessageId: sourceId,
          title: `thread ${index}`,
          createdByUserId: owner,
        }).id,
      );
    }
    return { ctx, owner, groupId, ids };
  }

  it("pages with a stable keyset cursor and no duplicates", () => {
    const { ctx, owner, groupId, ids } = withThreads(5);
    const viewer = { type: "user" as const, id: owner };
    const first = listThreads(ctx, { groupId, viewer, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]!.id);
    const second = listThreads(ctx, { groupId, viewer, limit: 2, cursor: first.nextCursor });
    const third = listThreads(ctx, { groupId, viewer, limit: 2, cursor: second.nextCursor });
    const seen = [...first.items, ...second.items, ...third.items].map((thread) => thread.id);
    expect(new Set(seen).size).toBe(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });

  it("returns an empty page after the last cursor", () => {
    const { ctx, owner, groupId } = withThreads(2);
    const viewer = { type: "user" as const, id: owner };
    const first = listThreads(ctx, { groupId, viewer, limit: 2 });
    const empty = listThreads(ctx, { groupId, viewer, limit: 2, cursor: first.nextCursor });
    expect(empty.items).toHaveLength(0);
    expect(empty.nextCursor).toBeNull();
  });

  it("keeps the cursor valid when a newer thread is created", () => {
    const { ctx, owner, groupId } = withThreads(4);
    const viewer = { type: "user" as const, id: owner };
    const first = listThreads(ctx, { groupId, viewer, limit: 2 });
    const sourceId = sourceMessage(ctx, groupId, owner, "late source");
    createThread(ctx, {
      groupId,
      sourceMessageId: sourceId,
      title: "late",
      createdByUserId: owner,
    });
    const second = listThreads(ctx, { groupId, viewer, limit: 2, cursor: first.nextCursor });
    expect(second.items.map((thread) => thread.id)).not.toContain(
      listThreads(ctx, { groupId, viewer, limit: 1 }).items[0]!.id,
    );
    expect(second.items).toHaveLength(2);
  });

  it("validates cursors, limits, filters and membership", () => {
    const { ctx, owner, groupId } = withThreads(3);
    const viewer = { type: "user" as const, id: owner };
    expect(() => listThreads(ctx, { groupId, viewer, cursor: "thr_missing" })).toThrow(
      ValidationError,
    );
    expect(listThreads(ctx, { groupId, viewer, limit: 0 }).items).toHaveLength(1);
    expect(listThreads(ctx, { groupId, viewer, limit: 500 }).items).toHaveLength(3);
    const otherGroup = seedGroup(ctx, owner, "other");
    const otherSource = sourceMessage(ctx, otherGroup, owner, "other source");
    const otherThread = createThread(ctx, {
      groupId: otherGroup,
      sourceMessageId: otherSource,
      title: "other",
      createdByUserId: owner,
    });
    expect(() => listThreads(ctx, { groupId, viewer, cursor: otherThread.id })).toThrow(
      ValidationError,
    );
    expect(listThreads(ctx, { groupId, viewer, status: "closed" }).items).toHaveLength(0);
    const stranger = seedUser(ctx, "stranger");
    expect(() => listThreads(ctx, { groupId, viewer: { type: "user", id: stranger } })).toThrow(
      ForbiddenError,
    );
  });
});

describe("M5-FIX-02 thread reply isolation", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function setupThreads() {
    const { room, ctx, owner, groupId } = setup();
    cleanup = room.close;
    const sourceA = sourceMessage(ctx, groupId, owner, "source A");
    const sourceB = sourceMessage(ctx, groupId, owner, "source B");
    const threadA = createThread(ctx, {
      groupId,
      sourceMessageId: sourceA,
      title: "A",
      createdByUserId: owner,
    });
    const threadB = createThread(ctx, {
      groupId,
      sourceMessageId: sourceB,
      title: "B",
      createdByUserId: owner,
    });
    return { ctx, owner, groupId, threadA, threadB, sourceA, sourceB };
  }

  it("allows replies inside the same thread and to the thread source", () => {
    const { ctx, owner, groupId, threadA, sourceA } = setupThreads();
    const first = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "inside A",
      threadId: threadA.id,
    });
    const reply = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "reply in A",
      threadId: threadA.id,
      replyToMessageId: first.id,
    });
    expect(reply.replyToMessageId).toBe(first.id);
    const toSource = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "reply to source",
      threadId: threadA.id,
      replyToMessageId: sourceA,
    });
    expect(toSource.replyToMessageId).toBe(sourceA);
  });

  it("rejects replies that cross threads, groups or the group stream", () => {
    const { ctx, owner, groupId, threadA, threadB, sourceB } = setupThreads();
    const inA = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "inside A",
      threadId: threadA.id,
    });
    const inB = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "inside B",
      threadId: threadB.id,
    });
    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: "cross",
        threadId: threadA.id,
        replyToMessageId: inB.id,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: "cross source",
        threadId: threadA.id,
        replyToMessageId: sourceB,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: "stream reply",
        replyToMessageId: inA.id,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: "missing",
        threadId: threadA.id,
        replyToMessageId: "msg_missing",
      }),
    ).toThrow(NotFoundError);
  });

  it("rejects replies into a closed thread", () => {
    const { ctx, owner, groupId, threadA } = setupThreads();
    closeThread(ctx, { threadId: threadA.id, actorUserId: owner });
    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: "late",
        threadId: threadA.id,
      }),
    ).toThrow(ConflictError);
  });
});

describe("M5-FIX-03 active task thread close guard", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("refuses to close a thread with an active task and emits nothing", () => {
    const { room, ctx, owner, groupId, agent } = setup();
    cleanup = room.close;
    const { task, threadId } = makeTask(ctx, { groupId, owner, agent });
    startTask(ctx, { taskId: task.id, agentId: agent });
    const before = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.groupId, groupId), eq(events.type, "thread.closed")))
      .all().length;
    expect(() => closeThread(ctx, { threadId, actorUserId: owner })).toThrow(ConflictError);
    const thread = ctx.db.select().from(threads).where(eq(threads.id, threadId)).get()!;
    expect(thread.status).toBe("open");
    const after = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.groupId, groupId), eq(events.type, "thread.closed")))
      .all().length;
    expect(after).toBe(before);

    pauseTask(ctx, { taskId: task.id, actorUserId: owner });
    expect(() => closeThread(ctx, { threadId, actorUserId: owner })).toThrow(ConflictError);
    resumeTask(ctx, { taskId: task.id, actorUserId: owner });
    completeTask(ctx, { taskId: task.id, agentId: agent, outcome: "succeeded", summary: "done" });
    expect(closeThread(ctx, { threadId, actorUserId: owner }).status).toBe("closed");
  });

  it("allows closing plain and terminal-failure threads", () => {
    const { room, ctx, owner, groupId, agent } = setup();
    cleanup = room.close;
    const plainSource = sourceMessage(ctx, groupId, owner, "plain");
    const plain = createThread(ctx, {
      groupId,
      sourceMessageId: plainSource,
      title: "plain",
      createdByUserId: owner,
    });
    expect(closeThread(ctx, { threadId: plain.id, actorUserId: owner }).status).toBe("closed");

    const { task, threadId } = makeTask(ctx, { groupId, owner, agent });
    startTask(ctx, { taskId: task.id, agentId: agent });
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agent,
      title: "need approval",
    });
    rejectApproval(ctx, { approvalId: approval.id, actorUserId: owner, reason: "no" });
    expect(closeThread(ctx, { threadId, actorUserId: owner }).status).toBe("closed");
  });
});

describe("M5-FIX-04 approval expiration", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("expires atomically with its own event and audit, idempotently", () => {
    const clock = { value: 1_700_000_000_000 };
    const { room, ctx, owner, groupId, agent } = setup(clock);
    cleanup = room.close;
    const { task, threadId } = makeTask(ctx, { groupId, owner, agent });
    startTask(ctx, { taskId: task.id, agentId: agent });
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agent,
      title: "ship it",
      expiresAt: clock.value + 60_000,
    });
    expect(() => expireApproval(ctx, { approvalId: approval.id })).toThrow(ConflictError);

    clock.value += 120_000;
    const expired = expireApproval(ctx, { approvalId: approval.id });
    expect(expired.approval.status).toBe("expired");
    expect(expired.task.status).toBe("failed");
    const run = ctx.db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id)).get()!;
    expect(run.status).toBe("failed");
    const thread = ctx.db.select().from(threads).where(eq(threads.id, threadId)).get()!;
    expect(thread.status).toBe("failed");
    const summary = ctx.db
      .select()
      .from(messages)
      .where(
        and(eq(messages.groupId, groupId), eq(messages.clientMessageId, `task-summary:${task.id}`)),
      )
      .get()!;
    expect(summary.content).toContain("审批超时");
    const expiryEvents = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.taskId, task.id), eq(events.type, "task.approval_expired")))
      .all();
    expect(expiryEvents).toHaveLength(1);
    const audits = ctx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "approval.expire"))
      .all();
    expect(audits).toHaveLength(1);

    const repeat = expireApproval(ctx, { approvalId: approval.id });
    expect(repeat.approval.status).toBe("expired");
    expect(
      ctx.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.groupId, groupId),
            eq(messages.clientMessageId, `task-summary:${task.id}`),
          ),
        )
        .all(),
    ).toHaveLength(1);
    expect(
      ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "approval.expire")).all(),
    ).toHaveLength(1);
  });

  it("rejects expiration for decided approvals and only sweeps pending due rows", () => {
    const clock = { value: 1_700_000_000_000 };
    const { room, ctx, owner, groupId, agent } = setup(clock);
    cleanup = room.close;
    const first = makeTask(ctx, { groupId, owner, agent });
    startTask(ctx, { taskId: first.task.id, agentId: agent });
    const approved = requestApproval(ctx, {
      taskId: first.task.id,
      agentId: agent,
      title: "approved",
      expiresAt: clock.value + 10_000,
    });
    approveApproval(ctx, { approvalId: approved.id, actorUserId: owner });

    const second = makeTask(ctx, { groupId, owner, agent });
    startTask(ctx, { taskId: second.task.id, agentId: agent });
    const due = requestApproval(ctx, {
      taskId: second.task.id,
      agentId: agent,
      title: "due",
      expiresAt: clock.value + 10_000,
    });
    clock.value += 60_000;
    expect(() => expireApproval(ctx, { approvalId: approved.id })).toThrow(ConflictError);
    expect(expireDueApprovals(ctx)).toBe(1);
    expect(ctx.db.select().from(approvals).where(eq(approvals.id, due.id)).get()!.status).toBe(
      "expired",
    );
    expect(ctx.db.select().from(approvals).where(eq(approvals.id, approved.id)).get()!.status).toBe(
      "approved",
    );
  });

  it("recovers pending expired approvals after a restart", () => {
    const clock = { value: 1_700_000_000_000 };
    const { room, ctx, owner, groupId, agent } = setup(clock);
    const { task } = makeTask(ctx, { groupId, owner, agent });
    startTask(ctx, { taskId: task.id, agentId: agent });
    requestApproval(ctx, {
      taskId: task.id,
      agentId: agent,
      title: "pending",
      expiresAt: clock.value + 10_000,
    });
    clock.value += 60_000;
    room.handle.close();

    const reopened = openDatabase({ path: room.path, migrationsFolder });
    const reopenedCtx = createRoomContext(reopened, () => clock.value);
    try {
      expect(expireDueApprovals(reopenedCtx)).toBe(1);
      expect(reopenedCtx.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!.status).toBe(
        "failed",
      );
    } finally {
      reopened.close();
    }
  });

  it("rejects expiration after rejection and cancellation", () => {
    const clock = { value: 1_700_000_000_000 };
    const { room, ctx, owner, groupId, agent } = setup(clock);
    cleanup = room.close;
    const rejected = makeTask(ctx, { groupId, owner, agent });
    startTask(ctx, { taskId: rejected.task.id, agentId: agent });
    const rejectedApproval = requestApproval(ctx, {
      taskId: rejected.task.id,
      agentId: agent,
      title: "reject me",
      expiresAt: clock.value + 10_000,
    });
    rejectApproval(ctx, { approvalId: rejectedApproval.id, actorUserId: owner, reason: "no" });
    const cancelled = makeTask(ctx, { groupId, owner, agent });
    startTask(ctx, { taskId: cancelled.task.id, agentId: agent });
    const cancelledApproval = requestApproval(ctx, {
      taskId: cancelled.task.id,
      agentId: agent,
      title: "cancel me",
      expiresAt: clock.value + 10_000,
    });
    cancelTask(ctx, { taskId: cancelled.task.id, actorUserId: owner });
    clock.value += 60_000;
    expect(() => expireApproval(ctx, { approvalId: rejectedApproval.id })).toThrow(ConflictError);
    expect(
      ctx.db.select().from(approvals).where(eq(approvals.id, cancelledApproval.id)).get()!.status,
    ).toBe("cancelled");
    expect(() => expireApproval(ctx, { approvalId: cancelledApproval.id })).toThrow(ConflictError);
  });
});

describe("M5-FIX-05 idempotency payload conflict", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  function counts(ctx: RoomContext, groupId: string) {
    return {
      tasks: ctx.db.select().from(tasks).where(eq(tasks.groupId, groupId)).all().length,
      threads: ctx.db.select().from(threads).where(eq(threads.groupId, groupId)).all().length,
      events: ctx.db.select().from(events).where(eq(events.groupId, groupId)).all().length,
      messages: ctx.db.select().from(messages).where(eq(messages.groupId, groupId)).all().length,
    };
  }

  it("returns the same task for the same payload", () => {
    const { room, ctx, owner, groupId, agent } = setup();
    cleanup = room.close;
    const sourceId = sourceMessage(ctx, groupId, owner, "source");
    const first = makeTask(ctx, { groupId, owner, agent, key: "k-1", sourceId });
    const before = counts(ctx, groupId);
    const second = makeTask(ctx, { groupId, owner, agent, key: "k-1", sourceId });
    expect(second.task.id).toBe(first.task.id);
    expect(second.threadId).toBe(first.threadId);
    expect(counts(ctx, groupId)).toEqual(before);
  });

  it("rejects the same key with a different payload and writes nothing", () => {
    const { room, ctx, owner, groupId, agent } = setup();
    cleanup = room.close;
    const otherAgent = seedAgent(ctx, owner, "other-agent");
    addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: otherAgent });
    const sourceA = sourceMessage(ctx, groupId, owner, "source A");
    const sourceB = sourceMessage(ctx, groupId, owner, "source B");
    const first = makeTask(ctx, { groupId, owner, agent, key: "k-2", sourceId: sourceA });
    const before = counts(ctx, groupId);
    expect(() => makeTask(ctx, { groupId, owner, agent, key: "k-2", sourceId: sourceB })).toThrow(
      ConflictError,
    );
    expect(() =>
      makeTask(ctx, { groupId, owner, agent, key: "k-2", sourceId: sourceA, title: "other title" }),
    ).toThrow(ConflictError);
    expect(() =>
      makeTask(ctx, { groupId, owner, agent: otherAgent, key: "k-2", sourceId: sourceA }),
    ).toThrow(ConflictError);
    expect(counts(ctx, groupId)).toEqual(before);
    expect(first.task.status).toBe("assigned");
  });

  it("keeps the key scoped per group", () => {
    const { room, ctx, owner, groupId, agent } = setup();
    cleanup = room.close;
    const otherGroup = seedGroup(ctx, owner, "other");
    addMember(ctx, {
      groupId: otherGroup,
      actorUserId: owner,
      memberType: "agent",
      memberId: agent,
    });
    const inFirst = makeTask(ctx, {
      groupId,
      owner,
      agent,
      key: "shared",
      sourceId: sourceMessage(ctx, groupId, owner, "a"),
    });
    const inSecond = makeTask(ctx, {
      groupId: otherGroup,
      owner,
      agent,
      key: "shared",
      sourceId: sourceMessage(ctx, otherGroup, owner, "b"),
    });
    expect(inSecond.task.id).not.toBe(inFirst.task.id);
    expect(
      listMessages(ctx, { groupId: otherGroup, viewer: { type: "user", id: owner } }).items.length,
    ).toBeGreaterThan(0);
  });
});
