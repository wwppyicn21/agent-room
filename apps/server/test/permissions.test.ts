import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentDeliveries, agents, auditLogs, events, groups, tasks, threads } from "@room/database";
import { ConflictError, ForbiddenError, ValidationError } from "../src/modules/errors.js";
import {
  addMember,
  createGroup,
  removeMember,
  updateGroupAISettings,
} from "../src/modules/groups.js";
import { listMessages, postMessage } from "../src/modules/messages.js";
import { closeThread, createThread } from "../src/modules/threads.js";
import {
  assignTask,
  completeTask,
  createTaskFromMessage,
  startTask,
} from "../src/modules/tasks.js";
import { disableUser, linkExternalIdentity, setUserRole } from "../src/modules/users.js";
import {
  ackDelivery,
  failDelivery,
  listOutstandingDeliveries,
  listPendingDeliveries,
  markDeliveryDelivered,
  requeueDelivery,
} from "../src/modules/events.js";
import { createTestRoom, type TestRoom, seedAgent, seedGroup, seedUser } from "./helpers.js";

let room: TestRoom;

beforeEach(() => {
  room = createTestRoom();
});

afterEach(() => {
  room.close();
});

function seedMember(
  ctx: TestRoom["ctx"],
  owner: string,
  groupId: string,
  role: "member" | "admin" = "member",
) {
  const userId = seedUser(ctx, `member-${Math.random().toString(36).slice(2, 8)}`);
  addMember(ctx, {
    groupId,
    actorUserId: owner,
    memberType: "user",
    memberId: userId,
    memberRole: role,
  });
  return userId;
}

describe("RBAC: readonly is enforced globally", () => {
  it("rejects message, thread, task and group writes from readonly users", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const readonly = seedUser(ctx, "readonly", "readonly");
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "user",
      memberId: readonly,
      memberRole: "member",
    });
    const source = postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "hi" });

    expect(() =>
      postMessage(ctx, { groupId, actor: { type: "user", id: readonly }, content: "nope" }),
    ).toThrow(ForbiddenError);
    expect(() =>
      createThread(ctx, {
        groupId,
        sourceMessageId: source.id,
        title: "t",
        createdByUserId: readonly,
      }),
    ).toThrow(ForbiddenError);
    expect(() =>
      createTaskFromMessage(ctx, {
        groupId,
        sourceMessageId: source.id,
        title: "t",
        createdByUserId: readonly,
      }),
    ).toThrow(ForbiddenError);
    expect(() => createGroup(ctx, { name: "g", createdByUserId: readonly })).toThrow(
      ForbiddenError,
    );

    // Reading stays allowed.
    expect(
      listMessages(ctx, { groupId, viewer: { type: "user", id: readonly } }).items,
    ).toHaveLength(1);
  });

  it("rejects group management by a readonly group admin", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const readonlyAdmin = seedUser(ctx, "ro-admin", "readonly");
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "user",
      memberId: readonlyAdmin,
      memberRole: "admin",
    });
    const victim = seedUser(ctx, "victim");

    expect(() =>
      addMember(ctx, {
        groupId,
        actorUserId: readonlyAdmin,
        memberType: "user",
        memberId: victim,
      }),
    ).toThrow(ForbiddenError);
  });
});

describe("RBAC: disabled identities lose access", () => {
  it("rejects reads from a disabled user", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const user = seedMember(ctx, owner, groupId);
    postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "hi" });
    disableUser(ctx, { userId: user, actorUserId: owner });

    expect(() => listMessages(ctx, { groupId, viewer: { type: "user", id: user } })).toThrow(
      ForbiddenError,
    );
  });

  it("rejects reads and writes from a disabled agent", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const agentId = seedAgent(ctx, owner, "agent");
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
      memberRole: "member",
    });
    ctx.db.update(agents).set({ status: "disabled" }).where(eq(agents.id, agentId)).run();

    expect(() => listMessages(ctx, { groupId, viewer: { type: "agent", id: agentId } })).toThrow(
      ForbiddenError,
    );
    expect(() =>
      postMessage(ctx, { groupId, actor: { type: "agent", id: agentId }, content: "nope" }),
    ).toThrow(ForbiddenError);
  });

  it("rejects group management by a disabled group admin", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const admin = seedMember(ctx, owner, groupId, "admin");
    const victim = seedUser(ctx, "victim");
    disableUser(ctx, { userId: admin, actorUserId: owner });

    expect(() =>
      addMember(ctx, { groupId, actorUserId: admin, memberType: "user", memberId: victim }),
    ).toThrow(ForbiddenError);
  });
});

describe("RBAC: system owner vs admin", () => {
  it("lets a system admin manage a group they are not a member of", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const admin = seedUser(ctx, "admin", "admin");
    const groupId = seedGroup(ctx, owner);
    const user = seedUser(ctx, "user");

    addMember(ctx, { groupId, actorUserId: admin, memberType: "user", memberId: user });
  });

  it("rejects group management by an ordinary member", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const member = seedMember(ctx, owner, groupId);
    const victim = seedUser(ctx, "victim");

    expect(() =>
      addMember(ctx, { groupId, actorUserId: member, memberType: "user", memberId: victim }),
    ).toThrow(ForbiddenError);
    expect(() =>
      updateGroupAISettings(ctx, {
        groupId,
        actorUserId: member,
        settings: {
          participationMode: "all",
          allowAgentMessages: true,
          maxHops: 4,
          maxRepliesPerRoot: 20,
          maxAgentMessagesPerMinute: 10,
        },
      }),
    ).toThrow(ForbiddenError);
  });

  it("only the owner can grant admin or owner roles", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const admin = seedUser(ctx, "admin", "admin");
    const member = seedUser(ctx, "member");

    expect(() => setUserRole(ctx, { userId: member, role: "admin", actorUserId: admin })).toThrow(
      ForbiddenError,
    );
    expect(setUserRole(ctx, { userId: member, role: "admin", actorUserId: owner }).role).toBe(
      "admin",
    );
  });

  it("only the owner can disable an admin", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const adminA = seedUser(ctx, "admin-a", "admin");
    const adminB = seedUser(ctx, "admin-b", "admin");

    expect(() => disableUser(ctx, { userId: adminB, actorUserId: adminA })).toThrow(ForbiddenError);
    expect(disableUser(ctx, { userId: adminB, actorUserId: owner }).status).toBe("disabled");
  });

  it("protects the last active owner from demotion and disabling", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");

    expect(() => setUserRole(ctx, { userId: owner, role: "member", actorUserId: owner })).toThrow(
      ConflictError,
    );
    expect(() => disableUser(ctx, { userId: owner, actorUserId: owner })).toThrow(ConflictError);
  });
});

describe("groups: membership lifecycle", () => {
  it("rejects duplicate memberships and removing the last group owner", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const user = seedUser(ctx, "user");

    addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: user });
    expect(() =>
      addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: user }),
    ).toThrow(ConflictError);
    expect(() =>
      removeMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: owner }),
    ).toThrow(ConflictError);
  });

  it("refuses to grant agents owner or admin roles", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const agentId = seedAgent(ctx, owner, "agent");

    expect(() =>
      addMember(ctx, {
        groupId,
        actorUserId: owner,
        memberType: "agent",
        memberId: agentId,
        memberRole: "admin",
      }),
    ).toThrow(ValidationError);
  });

  it("blocks writes to an archived group", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    ctx.db
      .update(groups)
      .set({ status: "archived", updatedAt: ctx.now() })
      .where(eq(groups.id, groupId))
      .run();

    expect(() =>
      postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "archived" }),
    ).toThrow(ForbiddenError);
  });
});

describe("identity, idempotency and delivery state machine", () => {
  it("commits the external identity, event and audit row atomically", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    linkExternalIdentity(ctx, { userId: owner, issuer: "test", subject: "sub-1" });

    expect(
      ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "identity.link")).all(),
    ).toHaveLength(1);
    expect(
      ctx.db.select().from(events).where(eq(events.type, "identity.linked")).all(),
    ).toHaveLength(1);
    expect(() =>
      linkExternalIdentity(ctx, { userId: owner, issuer: "test", subject: "sub-1" }),
    ).toThrow(ConflictError);
    expect(
      ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "identity.link")).all(),
    ).toHaveLength(1);
  });

  it("returns the original task for a repeated idempotency key", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const source = postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "hi" });

    const first = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "Fix",
      createdByUserId: owner,
      idempotencyKey: "req-1",
    });
    const second = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "Fix",
      createdByUserId: owner,
      idempotencyKey: "req-1",
    });
    const third = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "Fix",
      createdByUserId: owner,
      idempotencyKey: "req-2",
    });

    expect(second.task.id).toBe(first.task.id);
    expect(second.threadId).toBe(first.threadId);
    expect(third.task.id).not.toBe(first.task.id);
    expect(ctx.db.select().from(tasks).where(eq(tasks.groupId, groupId)).all()).toHaveLength(2);
  });

  it("enforces the pending -> delivered -> acked transition and requeue", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const agentId = seedAgent(ctx, owner, "agent");
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
      memberRole: "member",
    });
    postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "hi" });

    const [pending] = listPendingDeliveries(ctx, { agentId });
    expect(pending?.status).toBe("pending");
    expect(() => ackDelivery(ctx, { deliveryId: pending!.id, agentId })).toThrow(ConflictError);

    const delivered = markDeliveryDelivered(ctx, { deliveryId: pending!.id, agentId });
    expect(delivered.status).toBe("delivered");
    expect(delivered.attempts).toBe(1);
    expect(() => markDeliveryDelivered(ctx, { deliveryId: pending!.id, agentId })).toThrow(
      ConflictError,
    );
    expect(listOutstandingDeliveries(ctx, { agentId })).toHaveLength(1);

    const acked = ackDelivery(ctx, { deliveryId: pending!.id, agentId });
    expect(acked.status).toBe("acked");
    expect(ackDelivery(ctx, { deliveryId: pending!.id, agentId }).status).toBe("acked");
    expect(() => failDelivery(ctx, { deliveryId: pending!.id, agentId })).toThrow(ConflictError);

    postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "again" });
    const [second] = listPendingDeliveries(ctx, { agentId });
    markDeliveryDelivered(ctx, { deliveryId: second!.id, agentId });
    expect(requeueDelivery(ctx, { deliveryId: second!.id, agentId }).status).toBe("pending");

    const failed = failDelivery(ctx, { deliveryId: second!.id, agentId, error: "timeout" });
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe("timeout");
    expect(listPendingDeliveries(ctx, { agentId })).toHaveLength(0);
    expect(listOutstandingDeliveries(ctx, { agentId })).toHaveLength(0);

    const deliveredRow = ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.id, pending!.id))
      .get();
    expect(deliveredRow?.status).toBe("acked");
  });
});

describe("M2 review fix 2: thread/task creation, archives, closed threads", () => {
  it("rejects thread and task creation by a non-member", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const outsider = seedUser(ctx, "outsider");
    const groupId = seedGroup(ctx, owner);
    const source = postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "hi" });

    expect(() =>
      createThread(ctx, {
        groupId,
        sourceMessageId: source.id,
        title: "t",
        createdByUserId: outsider,
      }),
    ).toThrow(ForbiddenError);
    expect(() =>
      createTaskFromMessage(ctx, {
        groupId,
        sourceMessageId: source.id,
        title: "t",
        createdByUserId: outsider,
      }),
    ).toThrow(ForbiddenError);
    expect(ctx.db.select().from(threads).all()).toHaveLength(0);
    expect(ctx.db.select().from(tasks).all()).toHaveLength(0);
  });

  it("does not reveal an existing task through an idempotency key to a non-member", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const outsider = seedUser(ctx, "outsider");
    const groupId = seedGroup(ctx, owner);
    const source = postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "hi" });
    const created = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "Fix",
      createdByUserId: owner,
      idempotencyKey: "shared-key",
    });

    expect(() =>
      createTaskFromMessage(ctx, {
        groupId,
        sourceMessageId: source.id,
        title: "Fix",
        createdByUserId: outsider,
        idempotencyKey: "shared-key",
      }),
    ).toThrow(ForbiddenError);
    const rows = ctx.db.select().from(tasks).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created.task.id);
  });

  it("rejects every write path against an archived group without partial rows", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const member = seedMember(ctx, owner, groupId);
    const agentId = seedAgent(ctx, owner, "agent");
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
      memberRole: "member",
    });
    const source = postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "hi" });
    const thread = createThread(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "t",
      createdByUserId: owner,
    });
    const assigned = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "queued",
      createdByUserId: owner,
      assignedAgentId: agentId,
    });
    const running = createTaskFromMessage(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "running",
      createdByUserId: owner,
      assignedAgentId: agentId,
    });
    startTask(ctx, { taskId: running.task.id, agentId });
    const extra = seedUser(ctx, "extra");

    ctx.db
      .update(groups)
      .set({ status: "archived", updatedAt: ctx.now() })
      .where(eq(groups.id, groupId))
      .run();
    const before = snapshotCounts(ctx);

    expect(() =>
      addMember(ctx, {
        groupId,
        actorUserId: owner,
        memberType: "user",
        memberId: extra,
      }),
    ).toThrow(ForbiddenError);
    expect(() =>
      removeMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member }),
    ).toThrow(ForbiddenError);
    expect(() =>
      updateGroupAISettings(ctx, {
        groupId,
        actorUserId: owner,
        settings: {
          participationMode: "all",
          allowAgentMessages: true,
          maxHops: 4,
          maxRepliesPerRoot: 20,
          maxAgentMessagesPerMinute: 10,
        },
      }),
    ).toThrow(ForbiddenError);
    expect(() =>
      createThread(ctx, {
        groupId,
        sourceMessageId: source.id,
        title: "t2",
        createdByUserId: owner,
      }),
    ).toThrow(ForbiddenError);
    expect(() => closeThread(ctx, { threadId: thread.id, actorUserId: owner })).toThrow(
      ForbiddenError,
    );
    expect(() =>
      assignTask(ctx, { taskId: assigned.task.id, agentId, actorUserId: owner }),
    ).toThrow(ForbiddenError);
    expect(() => startTask(ctx, { taskId: assigned.task.id, agentId })).toThrow(ForbiddenError);
    expect(() =>
      completeTask(ctx, {
        taskId: running.task.id,
        agentId,
        outcome: "succeeded",
        summary: "done",
      }),
    ).toThrow(ForbiddenError);
    expect(() =>
      postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "nope" }),
    ).toThrow(ForbiddenError);

    expect(snapshotCounts(ctx)).toEqual(before);
    expect(ctx.db.select().from(tasks).all()).toHaveLength(2);
  });

  it("rejects messages in a closed thread but keeps open threads and group messages working", () => {
    const { ctx } = room;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner);
    const source = postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "hi" });
    const thread = createThread(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "t",
      createdByUserId: owner,
    });

    const inThread = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "inside",
      threadId: thread.id,
    });
    expect(inThread.threadId).toBe(thread.id);

    closeThread(ctx, { threadId: thread.id, actorUserId: owner });
    const before = snapshotCounts(ctx);
    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: "after close",
        threadId: thread.id,
      }),
    ).toThrow(ConflictError);
    expect(snapshotCounts(ctx)).toEqual(before);
    expect(
      postMessage(ctx, { groupId, actor: { type: "user", id: owner }, content: "group msg" })
        .threadId,
    ).toBeNull();
  });
});

function snapshotCounts(ctx: TestRoom["ctx"]) {
  return {
    events: ctx.db.select().from(events).all().length,
    deliveries: ctx.db.select().from(agentDeliveries).all().length,
    audits: ctx.db.select().from(auditLogs).all().length,
  };
}
