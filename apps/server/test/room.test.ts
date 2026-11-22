import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentDeliveries, events, groupMembers, messages, taskRuns, threads } from "@room/database";
import { DomainError, ForbiddenError } from "../src/modules/errors.js";
import { addMember } from "../src/modules/groups.js";
import { listMessages, postMessage } from "../src/modules/messages.js";
import { createThread } from "../src/modules/threads.js";
import {
  assignTask,
  completeTask,
  createTaskFromMessage,
  startTask,
} from "../src/modules/tasks.js";
import { createTestRoom, type TestRoom, seedAgent, seedGroup, seedUser } from "./helpers.js";
import { openDatabase } from "@room/database";
import { createRoomContext } from "../src/modules/context.js";

let room: TestRoom;

beforeEach(() => {
  room = createTestRoom();
});

afterEach(() => {
  room.close();
});

function count(rows: unknown[]): number {
  return rows.length;
}

describe("Room Core: membership and isolation", () => {
  it("keeps groups isolated: non-members cannot read or write messages", () => {
    const { ctx } = room;
    const alice = seedUser(ctx, "alice");
    const bob = seedUser(ctx, "bob");
    const groupA = seedGroup(ctx, alice, "A");
    const groupB = seedGroup(ctx, bob, "B");

    const message = postMessage(ctx, {
      groupId: groupA,
      actor: { type: "user", id: alice },
      content: "hello A",
    });
    expect(message.groupId).toBe(groupA);

    expect(() => listMessages(ctx, { groupId: groupA, viewer: { type: "user", id: bob } })).toThrow(
      ForbiddenError,
    );
    expect(() =>
      postMessage(ctx, { groupId: groupA, actor: { type: "user", id: bob }, content: "nope" }),
    ).toThrow(ForbiddenError);
    expect(() =>
      listMessages(ctx, { groupId: groupB, viewer: { type: "user", id: alice } }),
    ).toThrow(ForbiddenError);
  });

  it("rejects agents that are not members of the group", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const agentId = seedAgent(ctx, owner, "outsider");

    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "agent", id: agentId },
        content: "let me in",
      }),
    ).toThrow(ForbiddenError);
  });
});

describe("Room Core: messages, threads and tasks", () => {
  it("creates a thread and a task from one message, with consistent foreign keys", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const agentId = seedAgent(ctx, owner, "worker");
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
      memberRole: "member",
    });

    const source = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "please fix the login bug",
    });
    const thread = createThread(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "Login bug",
      createdByUserId: owner,
    });
    const { task, threadId } = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "Fix login",
      description: "reproduce and fix",
      assignedAgentId: agentId,
      createdByUserId: owner,
    });

    expect(task.threadId).toBe(threadId);
    expect(task.sourceMessageId).toBe(source.id);
    expect(task.status).toBe("assigned");
    expect(thread.id).not.toBe(threadId);
    const storedThread = ctx.db.select().from(threads).where(eq(threads.id, threadId)).get();
    expect(storedThread?.groupId).toBe(groupId);

    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: "wrong thread",
        threadId: threadId + "x",
      }),
    ).toThrow(DomainError);
  });

  it("writes the task completion summary back into the parent group in one transaction", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const agentId = seedAgent(ctx, owner, "worker");
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
      memberRole: "member",
    });
    const source = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "run the migration",
    });
    const { task } = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "Migration",
      assignedAgentId: agentId,
      createdByUserId: owner,
    });

    const started = startTask(ctx, { taskId: task.id, agentId });
    expect(started.task.status).toBe("running");
    const completed = completeTask(ctx, {
      taskId: task.id,
      agentId,
      outcome: "succeeded",
      summary: "Migration applied in 42ms.",
    });

    expect(completed.task.status).toBe("succeeded");
    expect(completed.run.status).toBe("succeeded");
    const summary = ctx.db
      .select()
      .from(messages)
      .where(eq(messages.id, completed.summaryMessageId))
      .get();
    expect(summary?.groupId).toBe(groupId);
    expect(summary?.senderType).toBe("system");
    expect(summary?.rootMessageId).toBe(source.id);
    expect(summary?.content).toContain("Migration applied in 42ms.");

    const storedRun = ctx.db.select().from(taskRuns).where(eq(taskRuns.id, started.run.id)).get();
    expect(storedRun?.summary).toBe("Migration applied in 42ms.");
    const completedEvent = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.taskId, task.id), eq(events.type, "task.completed")))
      .get();
    expect(completedEvent).toBeDefined();
  });

  it("enforces the assignment chain: queued -> assigned -> running -> succeeded", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const agentId = seedAgent(ctx, owner, "worker");
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
    });
    const source = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "task",
    });
    const { task } = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "queued task",
      createdByUserId: owner,
    });
    expect(task.status).toBe("queued");

    const assigned = assignTask(ctx, { taskId: task.id, agentId, actorUserId: owner });
    expect(assigned.status).toBe("assigned");
    expect(assigned.assignedAgentId).toBe(agentId);

    expect(() => startTask(ctx, { taskId: task.id, agentId: "agt_unknown" })).toThrow(DomainError);
    const started = startTask(ctx, { taskId: task.id, agentId });
    expect(started.task.status).toBe("running");
    expect(() => startTask(ctx, { taskId: task.id, agentId })).toThrow(DomainError);
  });
});

describe("Room Core: transactional outbox and idempotency", () => {
  it("commits message, event and agent deliveries together", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const agentId = seedAgent(ctx, owner, "worker");
    addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentId });

    const message = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "ping",
    });
    const event = ctx.db
      .select()
      .from(events)
      .where(and(eq(events.groupId, groupId), eq(events.type, "message.created")))
      .get();
    expect(event?.payload).toContain(message.id);
    const deliveries = ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.agentId, agentId))
      .all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("pending");

    // A rejected post leaves no message, event or delivery behind.
    expect(() =>
      postMessage(ctx, { groupId, actor: { type: "user", id: "usr_missing" }, content: "x" }),
    ).toThrow(DomainError);
    const messageCount = count(ctx.db.select().from(messages).all());
    expect(messageCount).toBe(1);
  });

  it("is idempotent per group/clientMessageId and does not fan out twice", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const agentId = seedAgent(ctx, owner, "worker");
    addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentId });

    const first = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "only once",
      clientMessageId: "client-1",
    });
    const second = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "only once (retry)",
      clientMessageId: "client-1",
    });
    expect(second.id).toBe(first.id);
    expect(count(ctx.db.select().from(messages).all())).toBe(1);
    expect(
      count(
        ctx.db
          .select()
          .from(events)
          .where(and(eq(events.groupId, groupId), eq(events.type, "message.created")))
          .all(),
      ),
    ).toBe(1);
    expect(count(ctx.db.select().from(agentDeliveries).all())).toBe(1);
  });
});

describe("Room Core: pagination and indexes", () => {
  it("paginates large message sets with a keyset and uses the seq index", () => {
    const { ctx, handle } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    for (let index = 0; index < 120; index += 1) {
      postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: `m${index}` });
    }
    const page1 = listMessages(ctx, { groupId, viewer: { type: "user", id: owner }, limit: 50 });
    expect(page1.items).toHaveLength(50);
    expect(page1.items[0]?.seq).toBe(1);
    expect(page1.nextCursor).toBe(50);

    const page2 = listMessages(ctx, {
      groupId,
      viewer: { type: "user", id: owner },
      limit: 50,
      cursor: page1.nextCursor ?? 0,
    });
    expect(page2.items[0]?.seq).toBe(51);
    const page3 = listMessages(ctx, {
      groupId,
      viewer: { type: "user", id: owner },
      limit: 50,
      cursor: page2.nextCursor ?? 0,
    });
    expect(page3.items).toHaveLength(20);
    expect(page3.nextCursor).toBeNull();

    const plan = handle.sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM messages WHERE group_id = ? AND seq > ? AND deleted_at IS NULL ORDER BY seq LIMIT 50",
      )
      .all(groupId, 0) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("messages_group_seq_uq"))).toBe(true);
  });

  it("keeps data across a close/reopen cycle", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const message = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "persist me",
    });
    const path = room.handle.path;
    room.handle.close();
    const reopened = createTestRoomFromPath(path);
    try {
      const stored = reopened.ctx.db
        .select()
        .from(messages)
        .where(eq(messages.id, message.id))
        .get();
      expect(stored?.content).toBe("persist me");
      const members = reopened.ctx.db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.groupId, groupId))
        .all();
      expect(members).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});

function createTestRoomFromPath(path: string): TestRoom {
  const handle = openDatabase({ path });
  return {
    ctx: createRoomContext(handle),
    handle,
    close() {
      handle.close();
    },
  };
}
