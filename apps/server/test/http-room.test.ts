import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import {
  agentDeliveries,
  agentKeys,
  agentSessions,
  type DatabaseHandle,
  events,
  migrationsFolder,
  openDatabase,
} from "@room/database";
import { eq } from "drizzle-orm";
import { newId } from "@room/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { registerAgent } from "../src/modules/agents.js";
import { createRoomContext, type RoomContext } from "../src/modules/context.js";
import { addMember, createGroup } from "../src/modules/groups.js";
import { createUser } from "../src/modules/users.js";

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  ctx: RoomContext;
  directory: string;
  owner: string;
}

const open: Harness[] = [];

async function setup(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "room-http-"));
  const database = openDatabase({ path: join(directory, "room.db"), migrationsFolder });
  const ctx = createRoomContext(database);
  const owner = createUser(ctx, { displayName: "owner", role: "owner" }).id;
  const app = await buildApp({
    config: loadConfig({ LOG_LEVEL: "silent", AUTH_MODE: "dev" }),
    database,
  });
  const harness = { app, database, ctx, directory, owner };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.app.close();
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

function agentToken(ctx: RoomContext, agentId: string): string {
  const token = `agt_${newId("tkt")}`;
  const keyId = newId("key");
  const now = ctx.now();
  ctx.db
    .insert(agentKeys)
    .values({
      id: keyId,
      agentId,
      publicKey: `pem-${keyId}`,
      fingerprint: `fp-${keyId}`,
      createdAt: now,
    })
    .run();
  ctx.db
    .insert(agentSessions)
    .values({
      id: newId("ses"),
      agentId,
      keyId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      createdAt: now,
      expiresAt: now + 3_600_000,
      lastSeenAt: now,
    })
    .run();
  return token;
}

describe("M5 REST surface", () => {
  it("requires a user session and creates a group", async () => {
    const { app, owner } = await setup();
    const unauth = await app.inject({ method: "GET", url: "/api/v1/groups" });
    expect(unauth.statusCode).toBe(401);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { "x-dev-user-id": owner },
      payload: { name: "m5-http" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().group.name).toBe("m5-http");

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/groups",
      headers: { "x-dev-user-id": owner },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().groups).toHaveLength(1);
  });

  it("isolates thread messages from the group stream", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const headers = { "x-dev-user-id": owner };

    const source = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/messages`,
      headers,
      payload: { content: "source message" },
    });
    expect(source.statusCode).toBe(201);
    const messageId = source.json().message.id;

    const thread = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/threads`,
      headers,
      payload: { sourceMessageId: messageId, title: "thread" },
    });
    expect(thread.statusCode).toBe(201);
    const threadId = thread.json().thread.id;

    const inThread = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${threadId}/messages`,
      headers,
      payload: { content: "inside thread" },
    });
    expect(inThread.statusCode).toBe(201);

    const groupStream = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/messages`,
      headers,
    });
    expect(groupStream.json().items.map((m: { content: string }) => m.content)).toEqual([
      "source message",
    ]);

    const threadStream = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${threadId}/messages`,
      headers,
    });
    expect(threadStream.json().items.map((m: { content: string }) => m.content)).toEqual([
      "inside thread",
    ]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${threadId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messageCount).toBe(1);
    expect(detail.json().sourceMessage.id).toBe(messageId);

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${threadId}/events`,
      headers,
    });
    expect(events.json().items.length).toBeGreaterThan(0);
  });

  it("drives the task lifecycle through REST with an agent bearer token", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const agentId = registerAgent(ctx, {
      displayName: "agent",
      runtime: "test",
      actorUserId: owner,
    }).id;
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
    });
    const token = agentToken(ctx, agentId);
    const headers = { "x-dev-user-id": owner };

    const source = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/messages`,
      headers,
      payload: { content: "do it" },
    });
    const messageId = source.json().message.id;

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/tasks`,
      headers,
      payload: { sourceMessageId: messageId, title: "task", assignedAgentId: agentId },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id;
    expect(created.json().threadId).toMatch(/^thr_/);

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/start`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().task.status).toBe("running");

    const closeActive = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${created.json().threadId}/close`,
      headers,
    });
    expect(closeActive.statusCode).toBe(409);

    const progress = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/progress`,
      headers: { authorization: `Bearer ${token}` },
      payload: { percent: 50, stage: "half" },
    });
    expect(progress.statusCode).toBe(200);

    const approval = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/approvals`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "ship it?" },
    });
    expect(approval.statusCode).toBe(201);
    const approvalId = approval.json().approval.id;

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/approve`,
      headers,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().task.status).toBe("running");

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { outcome: "succeeded", summary: "done", result: "artifact" },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().task.status).toBe("succeeded");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}`,
      headers,
    });
    expect(detail.json().task.result).toBe("artifact");
  });

  it("pages threads with an opaque cursor and rejects invalid cursors", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const headers = { "x-dev-user-id": owner };
    for (let index = 0; index < 3; index += 1) {
      const source = await app.inject({
        method: "POST",
        url: `/api/v1/groups/${groupId}/messages`,
        headers,
        payload: { content: `source ${index}` },
      });
      const thread = await app.inject({
        method: "POST",
        url: `/api/v1/groups/${groupId}/threads`,
        headers,
        payload: { sourceMessageId: source.json().message.id, title: `thread ${index}` },
      });
      expect(thread.statusCode).toBe(201);
    }
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/threads?limit=2`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(2);
    expect(first.json().nextCursor).toBe(first.json().items[1].id);
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/threads?limit=2&cursor=${first.json().nextCursor}`,
      headers,
    });
    expect(second.json().items).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();
    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/threads?cursor=thr_missing`,
      headers,
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("rejects approval decisions from ordinary members and bad transitions", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const member = createUser(ctx, {
      displayName: "member",
      role: "member",
      actorUserId: owner,
    }).id;
    addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member });
    const agentId = registerAgent(ctx, {
      displayName: "agent",
      runtime: "test",
      actorUserId: owner,
    }).id;
    addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentId });
    const token = agentToken(ctx, agentId);
    const headers = { "x-dev-user-id": owner };

    const source = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/messages`,
      headers,
      payload: { content: "go" },
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/tasks`,
      headers,
      payload: { sourceMessageId: source.json().message.id, title: "t", assignedAgentId: agentId },
    });
    const taskId = created.json().task.id;

    const illegalPause = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/pause`,
      headers,
    });
    expect(illegalPause.statusCode).toBe(409);

    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/start`,
      headers: { authorization: `Bearer ${token}` },
    });
    const approval = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/approvals`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "ok?" },
    });
    const approvalId = approval.json().approval.id;

    const memberDecision = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/approve`,
      headers: { "x-dev-user-id": member },
    });
    expect(memberDecision.statusCode).toBe(403);
  });
});

describe("M5 review round 2 REST surface", () => {
  it("delivers Thread messages to the assigned Agent and exposes recovery endpoints", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const agentA = registerAgent(ctx, { displayName: "a", runtime: "test", actorUserId: owner }).id;
    const agentB = registerAgent(ctx, { displayName: "b", runtime: "test", actorUserId: owner }).id;
    for (const agentId of [agentA, agentB]) {
      addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentId });
    }
    const tokenA = agentToken(ctx, agentA);
    const tokenB = agentToken(ctx, agentB);
    const headers = { "x-dev-user-id": owner };

    const source = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/messages`,
      headers,
      payload: { content: "source" },
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/tasks`,
      headers,
      payload: {
        sourceMessageId: source.json().message.id,
        title: "task",
        assignedAgentId: agentA,
      },
    });
    expect(created.statusCode).toBe(201);
    const { task, threadId } = created.json();
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/start`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(started.statusCode).toBe(200);

    const inThread = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${threadId}/messages`,
      headers,
      payload: { content: "status?" },
    });
    expect(inThread.statusCode).toBe(201);
    const event = ctx.db
      .select()
      .from(events)
      .where(eq(events.threadId, threadId))
      .all()
      .filter((row) => row.type === "message.created")
      .at(-1)!;
    const deliveries = ctx.db
      .select()
      .from(agentDeliveries)
      .where(eq(agentDeliveries.eventId, event.id))
      .all();
    expect(deliveries.map((delivery) => delivery.agentId)).toEqual([agentA]);

    const recovery = await app.inject({
      method: "GET",
      url: "/api/v1/agent/tasks",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json().tasks.map((view: { task: { id: string } }) => view.task.id)).toEqual([
      task.id,
    ]);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/agent/tasks/${task.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(detail.json().run.status).toBe("running");
    expect(detail.json().thread.id).toBe(threadId);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/agent/threads/${threadId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().items.map((message: { content: string }) => message.content)).toContain(
      "status?",
    );

    const otherAgentHistory = await app.inject({
      method: "GET",
      url: `/api/v1/agent/threads/${threadId}/messages`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(otherAgentHistory.statusCode).toBe(403);
    const otherAgentTask = await app.inject({
      method: "GET",
      url: `/api/v1/agent/tasks/${task.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(otherAgentTask.statusCode).toBe(404);
  });

  it("enforces workspace permissions and the group boundary through REST", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const member = createUser(ctx, {
      displayName: "member",
      role: "member",
      actorUserId: owner,
    }).id;
    addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member });
    const headers = { "x-dev-user-id": owner };

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/workspaces`,
      headers,
      payload: { name: "repo" },
    });
    expect(created.statusCode).toBe(201);
    const workspaceId = created.json().workspace.id;
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/workspaces`,
      headers,
      payload: { name: "repo" },
    });
    expect(duplicate.statusCode).toBe(409);
    const memberCreate = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/workspaces`,
      headers: { "x-dev-user-id": member },
      payload: { name: "member-repo" },
    });
    expect(memberCreate.statusCode).toBe(403);
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/workspaces`,
      headers,
    });
    expect(listed.json().workspaces).toHaveLength(1);

    const otherGroup = createGroup(ctx, { name: "other", createdByUserId: owner }).id;
    const otherWorkspace = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${otherGroup}/workspaces`,
      headers,
      payload: { name: "other-repo" },
    });
    const source = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/messages`,
      headers,
      payload: { content: "source" },
    });
    const crossGroup = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/tasks`,
      headers,
      payload: {
        sourceMessageId: source.json().message.id,
        title: "cross",
        workspaceId: otherWorkspace.json().workspace.id,
      },
    });
    expect(crossGroup.statusCode).toBe(400);
    const own = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}`,
      headers,
    });
    expect(own.statusCode).toBe(200);
  });
});
