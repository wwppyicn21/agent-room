import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import {
  agentSessions,
  type DatabaseHandle,
  events,
  migrationsFolder,
  openDatabase,
} from "@room/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disableAgent, enableAgent, registerAgent } from "../src/modules/agents.js";
import { liveSessionAgentIds } from "../src/modules/agentAuth.js";
import { createRoomContext } from "../src/modules/context.js";
import { ConflictError, ForbiddenError, ValidationError } from "../src/modules/errors.js";
import { addMember, createGroup, updateMemberRole } from "../src/modules/groups.js";
import { deleteMessage, listMessages, postMessage } from "../src/modules/messages.js";
import { createUser } from "../src/modules/users.js";
import { createTestRoom, markAgentOnline, type TestRoom } from "./helpers.js";

const rooms: TestRoom[] = [];

function room(now?: () => number): TestRoom {
  const created = createTestRoom(now);
  rooms.push(created);
  return created;
}

afterEach(() => {
  for (const created of rooms.splice(0)) created.close();
});

function bootstrap() {
  const { ctx } = room();
  const owner = createUser(ctx, { displayName: "owner", role: "owner" }).id;
  const groupId = createGroup(ctx, { name: "group", createdByUserId: owner }).id;
  const agentId = registerAgent(ctx, {
    displayName: "agent",
    runtime: "test",
    actorUserId: owner,
  }).id;
  const member = createUser(ctx, { displayName: "member", actorUserId: owner }).id;
  addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member });
  return { ctx, owner, member, groupId, agentId };
}

describe("agent administration", () => {
  it("disables an agent, closes sessions and re-enables it as offline", () => {
    const { ctx, owner, member, agentId } = bootstrap();
    markAgentOnline(ctx, agentId);
    expect(liveSessionAgentIds(ctx, 60_000).has(agentId)).toBe(true);

    expect(() => disableAgent(ctx, { agentId, actorUserId: member })).toThrow(ForbiddenError);

    const disabled = disableAgent(ctx, { agentId, actorUserId: owner, reason: "rotation" });
    expect(disabled.status).toBe("disabled");
    expect(liveSessionAgentIds(ctx, 60_000).has(agentId)).toBe(false);
    const openSessions = ctx.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.agentId, agentId))
      .all();
    expect(openSessions.every((session) => session.closedAt !== null)).toBe(true);
    const statusEvents = ctx.db
      .select()
      .from(events)
      .where(eq(events.type, "agent.status.changed"))
      .all();
    expect(statusEvents.at(-1)?.payload).toContain("disabled");

    // Disabling again is idempotent and does not append another event.
    disableAgent(ctx, { agentId, actorUserId: owner });
    expect(
      ctx.db.select().from(events).where(eq(events.type, "agent.status.changed")).all(),
    ).toHaveLength(statusEvents.length);

    const enabled = enableAgent(ctx, { agentId, actorUserId: owner });
    expect(enabled.status).toBe("offline");
    expect(enableAgent(ctx, { agentId, actorUserId: owner }).status).toBe("offline");
  });
});

describe("group member roles", () => {
  it("updates roles while protecting the last owner and owner-only escalation", () => {
    const { ctx, owner, member, groupId, agentId } = bootstrap();
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
    });
    const other = createUser(ctx, { displayName: "other", actorUserId: owner }).id;
    addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: other });

    const promoted = updateMemberRole(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "user",
      memberId: member,
      memberRole: "admin",
    });
    expect(promoted.memberRole).toBe("admin");

    expect(() =>
      updateMemberRole(ctx, {
        groupId,
        actorUserId: member,
        memberType: "user",
        memberId: other,
        memberRole: "owner",
      }),
    ).toThrow(ForbiddenError);

    expect(() =>
      updateMemberRole(ctx, {
        groupId,
        actorUserId: owner,
        memberType: "user",
        memberId: owner,
        memberRole: "admin",
      }),
    ).toThrow(ConflictError);

    expect(() =>
      updateMemberRole(ctx, {
        groupId,
        actorUserId: owner,
        memberType: "agent",
        memberId: agentId,
        memberRole: "admin",
      }),
    ).toThrow(ValidationError);

    const updatedEvents = ctx.db
      .select()
      .from(events)
      .where(eq(events.type, "group.member_updated"))
      .all();
    expect(updatedEvents).toHaveLength(1);
  });
});

describe("message soft delete", () => {
  it("lets senders and managers delete, hides messages and is idempotent", () => {
    const { ctx, owner, member, groupId } = bootstrap();
    const other = createUser(ctx, { displayName: "other", actorUserId: owner }).id;
    addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: other });

    const message = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: member },
      content: "hello",
    });
    expect(() =>
      deleteMessage(ctx, { messageId: message.id, actor: { type: "user", id: other } }),
    ).toThrow(ForbiddenError);

    const deleted = deleteMessage(ctx, {
      messageId: message.id,
      actor: { type: "user", id: owner },
    });
    expect(deleted.deletedAt).not.toBeNull();
    expect(listMessages(ctx, { groupId, viewer: { type: "user", id: member } }).items).toHaveLength(
      0,
    );
    const deleteEvents = ctx.db
      .select()
      .from(events)
      .where(eq(events.type, "message.deleted"))
      .all();
    expect(deleteEvents).toHaveLength(1);

    deleteMessage(ctx, { messageId: message.id, actor: { type: "user", id: owner } });
    expect(
      ctx.db.select().from(events).where(eq(events.type, "message.deleted")).all(),
    ).toHaveLength(1);

    const own = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: member },
      content: "mine",
    });
    expect(
      deleteMessage(ctx, { messageId: own.id, actor: { type: "user", id: member } }).deletedAt,
    ).not.toBeNull();
  });
});

describe("administration HTTP routes", () => {
  const open: { app: FastifyInstance; database: DatabaseHandle; dir: string }[] = [];
  afterEach(async () => {
    for (const harness of open.splice(0)) {
      await harness.app.close();
      harness.database.close();
      rmSync(harness.dir, { recursive: true, force: true });
    }
  });

  it("exposes agent disable, member role and message delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "room-admin-http-"));
    const database = openDatabase({ path: join(dir, "room.db"), migrationsFolder });
    const ctx = createRoomContext(database);
    const owner = createUser(ctx, { displayName: "owner", role: "owner" }).id;
    const groupId = createGroup(ctx, { name: "group", createdByUserId: owner }).id;
    const member = createUser(ctx, { displayName: "member", actorUserId: owner }).id;
    addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member });
    const agentId = registerAgent(ctx, {
      displayName: "agent",
      runtime: "test",
      actorUserId: owner,
    }).id;
    markAgentOnline(ctx, agentId);
    const message = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: member },
      content: "hello",
    });
    const app = await buildApp({
      config: loadConfig({ LOG_LEVEL: "silent", AUTH_MODE: "dev" }),
      database,
    });
    open.push({ app, database, dir });
    const headers = { "x-dev-user-id": owner };

    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/disable`,
      headers,
      payload: { reason: "test" },
    });
    expect(disabled.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/v1/agents", headers });
    expect(list.json().agents.find((agent: { id: string }) => agent.id === agentId).online).toBe(
      false,
    );

    const role = await app.inject({
      method: "PATCH",
      url: `/api/v1/groups/${groupId}/members/user/${member}`,
      headers,
      payload: { memberRole: "admin" },
    });
    expect(role.statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${message.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/messages`,
      headers,
    });
    expect(hidden.json().items).toHaveLength(0);

    const anonymous = await app.inject({
      method: "DELETE",
      url: `/api/v1/messages/${message.id}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
