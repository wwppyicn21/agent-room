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
} from "@room/database";
import { eq } from "drizzle-orm";
import {
  approveApproval,
  cancelTask,
  completeTask,
  createTaskFromMessage,
  expireApproval,
  getThreadDetail,
  listMessages,
  listTaskApprovals,
  listThreadEvents,
  listThreadMessages,
  pauseTask,
  postMessage,
  rejectApproval,
  reportTaskProgress,
  requestApproval,
  resumeTask,
  startTask,
} from "../src/modules/index.js";
import { addMember } from "../src/modules/groups.js";
import { ConflictError, ForbiddenError, ValidationError } from "../src/modules/errors.js";
import { createTestRoom, markAgentOnline, seedAgent, seedGroup, seedUser } from "./helpers.js";
import { createRoomContext, type RoomContext } from "../src/modules/context.js";

function setup(now?: { value: number }) {
  const room = createTestRoom(now ? () => now.value : undefined);
  const ctx = room.ctx;
  const owner = seedUser(ctx, "owner", "owner");
  const groupId = seedGroup(ctx, owner, "m5");
  const agentA = seedAgent(ctx, owner, "agent-a");
  const agentB = seedAgent(ctx, owner, "agent-b");
  addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentA });
  addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentB });
  markAgentOnline(ctx, agentA);
  markAgentOnline(ctx, agentB);
  const source = postMessage(ctx, {
    groupId,
    actor: { type: "user", id: owner },
    content: "build the report",
  });
  return { room, ctx, owner, groupId, agentA, agentB, source };
}

function newTask(
  ctx: RoomContext,
  input: { owner: string; groupId: string; sourceId: string; agentId: string },
) {
  return createTaskFromMessage(ctx, {
    groupId: input.groupId,
    sourceMessageId: input.sourceId,
    title: "write report",
    createdByUserId: input.owner,
    assignedAgentId: input.agentId,
  });
}

describe("M5 task engine", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("runs the full lifecycle and writes the summary to the parent group", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const { task, threadId } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    expect(task.status).toBe("assigned");

    startTask(ctx, { taskId: task.id, agentId: agentA });
    const run = reportTaskProgress(ctx, {
      taskId: task.id,
      agentId: agentA,
      percent: 40,
      stage: "drafting",
      message: "outline done",
    });
    expect(run.progressPercent).toBe(40);

    pauseTask(ctx, { taskId: task.id, actorUserId: owner });
    resumeTask(ctx, { taskId: task.id, actorUserId: owner });
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agentA,
      title: "publish?",
      details: "release the draft",
    });
    expect(approval.status).toBe("pending");
    approveApproval(ctx, { approvalId: approval.id, actorUserId: owner });

    const done = completeTask(ctx, {
      taskId: task.id,
      agentId: agentA,
      outcome: "succeeded",
      summary: "report published",
      result: "artifact-1",
    });
    expect(done.task.status).toBe("succeeded");
    expect(done.task.result).toBe("artifact-1");
    expect(done.task.summary).toBe("report published");
    const detail = getThreadDetail(ctx, { threadId, viewer: { type: "user", id: owner } });
    expect(detail.thread.status).toBe("closed");
    expect(detail.task?.id).toBe(task.id);

    const groupMessages = listMessages(ctx, {
      groupId,
      viewer: { type: "user", id: owner },
    }).items;
    const summary = groupMessages.find((message) => message.id === done.summaryMessageId)!;
    expect(summary.threadId).toBeNull();
    expect(summary.content).toContain(`Thread: ${threadId}`);
    const threadMessages = listThreadMessages(ctx, {
      threadId,
      viewer: { type: "user", id: owner },
    }).items;
    expect(threadMessages.map((message) => message.id)).not.toContain(done.summaryMessageId);
    const runRows = ctx.db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id)).all();
    expect(runRows[0]?.status).toBe("succeeded");
  });

  it("keeps thread messages out of the group stream and exposes thread detail and logs", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const { threadId } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    const threadMessage = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "thread only",
      threadId,
    });
    postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "group only" });
    const groupMessages = listMessages(ctx, {
      groupId,
      viewer: { type: "user", id: owner },
    }).items;
    expect(groupMessages.map((message) => message.id)).not.toContain(threadMessage.id);
    expect(groupMessages.some((message) => message.content === "group only")).toBe(true);
    const threadMessages = listThreadMessages(ctx, {
      threadId,
      viewer: { type: "user", id: owner },
    }).items;
    expect(threadMessages.map((message) => message.id)).toEqual([threadMessage.id]);
    const logs = listThreadEvents(ctx, {
      threadId,
      viewer: { type: "user", id: owner },
    }).items;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((event) => event.threadId === threadId)).toBe(true);
    const detail = getThreadDetail(ctx, { threadId, viewer: { type: "user", id: owner } });
    expect(detail.messageCount).toBe(1);
    expect(detail.sourceMessage?.id).toBe(source.id);
    expect(detail.lastMessageAt).not.toBeNull();
  });

  it("rejects invalid task transitions and illegal completion", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const { task } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    expect(() => pauseTask(ctx, { taskId: task.id, actorUserId: owner })).toThrow(ConflictError);
    expect(() =>
      completeTask(ctx, {
        taskId: task.id,
        agentId: agentA,
        outcome: "succeeded",
        summary: "too early",
      }),
    ).toThrow(ConflictError);
    startTask(ctx, { taskId: task.id, agentId: agentA });
    expect(() => resumeTask(ctx, { taskId: task.id, actorUserId: owner })).toThrow(ConflictError);
    pauseTask(ctx, { taskId: task.id, actorUserId: owner });
    expect(() => pauseTask(ctx, { taskId: task.id, actorUserId: owner })).toThrow(ConflictError);
    expect(() =>
      completeTask(ctx, {
        taskId: task.id,
        agentId: agentA,
        outcome: "succeeded",
        summary: "still paused",
      }),
    ).toThrow(ConflictError);
  });

  it("guards progress reporting to the assignee and a running task", () => {
    const { room, ctx, owner, groupId, agentA, agentB, source } = setup();
    cleanup = room.close;
    const { task } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    expect(() =>
      reportTaskProgress(ctx, { taskId: task.id, agentId: agentB, percent: 10 }),
    ).toThrow(ConflictError);
    expect(() =>
      reportTaskProgress(ctx, { taskId: task.id, agentId: agentA, percent: 101 }),
    ).toThrow(ValidationError);
    pauseTask(ctx, { taskId: task.id, actorUserId: owner });
    expect(() =>
      reportTaskProgress(ctx, { taskId: task.id, agentId: agentA, percent: 10 }),
    ).toThrow(ConflictError);
    const progressEvents = ctx.db
      .select()
      .from(events)
      .where(eq(events.type, "task.progress"))
      .all();
    expect(progressEvents).toHaveLength(0);
  });

  it("notifies the assignee about pause and resume through durable deliveries", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const { task } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    pauseTask(ctx, { taskId: task.id, actorUserId: owner });
    resumeTask(ctx, { taskId: task.id, actorUserId: owner });
    const types = ctx.db
      .select()
      .from(events)
      .all()
      .filter((event) => event.type === "task.paused" || event.type === "task.resumed")
      .map((event) => event.type);
    expect(types).toEqual(["task.paused", "task.resumed"]);
  });

  it("cancels a running task, closes its thread and cancels pending approvals", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const { task, threadId } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agentA,
      title: "need review",
    });
    const cancelled = cancelTask(ctx, {
      taskId: task.id,
      actorUserId: owner,
      reason: "changed plan",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    const approvalRow = listTaskApprovals(ctx, {
      taskId: task.id,
      viewerUserId: owner,
    }).find((row) => row.id === approval.id)!;
    expect(approvalRow.status).toBe("cancelled");
    const thread = getThreadDetail(ctx, { threadId, viewer: { type: "user", id: owner } }).thread;
    expect(thread.status).toBe("closed");
    expect(
      ctx.db
        .select()
        .from(taskRuns)
        .all()
        .every((run) => run.status === "cancelled"),
    ).toBe(true);
    expect(() => cancelTask(ctx, { taskId: task.id, actorUserId: owner })).toThrow(ConflictError);
  });

  it("rejects an approval, fails the task and writes a failure summary", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const { task, threadId } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agentA,
      title: "deploy?",
    });
    const decided = rejectApproval(ctx, {
      approvalId: approval.id,
      actorUserId: owner,
      reason: "not now",
    });
    expect(decided.approval.status).toBe("rejected");
    expect(decided.approval.decidedByUserId).toBe(owner);
    expect(decided.task.status).toBe("failed");
    expect(decided.task.error).toBe("not now");
    expect(
      getThreadDetail(ctx, { threadId, viewer: { type: "user", id: owner } }).thread.status,
    ).toBe("failed");
    const summary = ctx.db
      .select()
      .from(messages)
      .all()
      .find((message) => message.clientMessageId === `task-summary:${task.id}`)!;
    expect(summary.threadId).toBeNull();
    expect(summary.content).toContain("审批被拒绝：not now");
    const audits = ctx.db
      .select()
      .from(auditLogs)
      .all()
      .filter((audit) => audit.action === "task.fail");
    expect(audits).toHaveLength(1);
    expect(() =>
      rejectApproval(ctx, { approvalId: approval.id, actorUserId: owner, reason: "again" }),
    ).not.toThrow();
    expect(
      ctx.db
        .select()
        .from(messages)
        .all()
        .filter((message) => message.clientMessageId === `task-summary:${task.id}`),
    ).toHaveLength(1);
  });

  it("makes approval decisions idempotent and prevents flip-flopping", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const { task } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agentA,
      title: "approve me",
    });
    const first = approveApproval(ctx, { approvalId: approval.id, actorUserId: owner });
    const second = approveApproval(ctx, { approvalId: approval.id, actorUserId: owner });
    expect(second.approval.status).toBe("approved");
    expect(second.task.status).toBe("running");
    expect(first.approval.updatedAt).toBe(second.approval.updatedAt);
    expect(() =>
      rejectApproval(ctx, { approvalId: approval.id, actorUserId: owner, reason: "no" }),
    ).toThrow(ConflictError);
  });

  it("only group managers may decide approvals", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const member = seedUser(ctx, "member");
    addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member });
    const { task } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agentA,
      title: "approve?",
    });
    expect(() => approveApproval(ctx, { approvalId: approval.id, actorUserId: member })).toThrow(
      ForbiddenError,
    );
  });

  it("enforces approval request rules", () => {
    const { room, ctx, owner, groupId, agentA, agentB, source } = setup();
    cleanup = room.close;
    const { task } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    expect(() =>
      requestApproval(ctx, { taskId: task.id, agentId: agentB, title: "not mine" }),
    ).toThrow(ConflictError);
    requestApproval(ctx, { taskId: task.id, agentId: agentA, title: "first" });
    expect(() =>
      requestApproval(ctx, { taskId: task.id, agentId: agentA, title: "second" }),
    ).toThrow(ConflictError);
    expect(() =>
      requestApproval(ctx, {
        taskId: task.id,
        agentId: agentA,
        title: "third",
        expiresAt: Date.now() - 1,
      }),
    ).toThrow(ConflictError);
  });

  it("expires approvals and fails the waiting task", () => {
    const clock = { value: 1_800_000_000_000 };
    const { room, ctx, owner, groupId, agentA, source } = setup(clock);
    cleanup = room.close;
    const { task } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    const approval = requestApproval(ctx, {
      taskId: task.id,
      agentId: agentA,
      title: "slow review",
      expiresAt: clock.value + 1_000,
    });
    clock.value += 2_000;
    const expired = expireApproval(ctx, { approvalId: approval.id });
    expect(expired.approval.status).toBe("expired");
    expect(expired.task.status).toBe("failed");
    expect(expired.task.error).toBe("approval expired");
  });

  it("refuses approvals for approvals that were never requested", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    cleanup = room.close;
    const { task } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    expect(() => approveApproval(ctx, { approvalId: "apv_missing", actorUserId: owner })).toThrow();
    expect(() =>
      rejectApproval(ctx, {
        approvalId: "apv_missing",
        actorUserId: owner,
        reason: "no",
      }),
    ).toThrow();
  });

  it("keeps task state across a database close and reopen", () => {
    const { room, ctx, owner, groupId, agentA, source } = setup();
    const { task } = newTask(ctx, {
      owner,
      groupId,
      sourceId: source.id,
      agentId: agentA,
    });
    startTask(ctx, { taskId: task.id, agentId: agentA });
    pauseTask(ctx, { taskId: task.id, actorUserId: owner });
    const path = room.path;
    room.closeHandle();
    cleanup = null;

    const handle = openDatabase({ path, migrationsFolder });
    const reopened = createRoomContext(handle);
    cleanup = () => handle.close();
    const row = reopened.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
    expect(row?.status).toBe("paused");
    expect(reopened.db.select().from(approvals).all()).toHaveLength(0);
  });
});
