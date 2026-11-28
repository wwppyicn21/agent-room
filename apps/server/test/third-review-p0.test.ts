import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import {
  agentKeys,
  agentSessions,
  type DatabaseHandle,
  agents,
  auditLogs,
  events,
  groups,
  messages,
  migrationsFolder,
  openDatabase,
} from "@room/database";
import { eq } from "drizzle-orm";
import { newId } from "@room/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { disableAgent, registerAgent } from "../src/modules/agents.js";
import { createRoomContext, type RoomContext } from "../src/modules/context.js";
import { addMember, createGroup } from "../src/modules/groups.js";
import { deleteMessage, postMessage } from "../src/modules/messages.js";
import { setAgentStatus } from "../src/modules/agentAuth.js";
import { createUser } from "../src/modules/users.js";

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  ctx: RoomContext;
  directory: string;
  owner: string;
  groupId: string;
  member: string;
}

const open: Harness[] = [];

async function setup(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "room-p0-"));
  const database = openDatabase({ path: join(directory, "room.db"), migrationsFolder });
  const ctx = createRoomContext(database);
  const owner = createUser(ctx, { displayName: "owner", role: "owner" }).id;
  const member = createUser(ctx, { displayName: "member", role: "member", actorUserId: owner }).id;
  const groupId = createGroup(ctx, { name: "group", createdByUserId: owner }).id;
  addMember(ctx, {
    groupId,
    actorUserId: owner,
    memberType: "user",
    memberId: member,
    memberRole: "member",
  });
  const app = await buildApp({
    config: loadConfig({ LOG_LEVEL: "silent", AUTH_MODE: "dev" }),
    database,
  });
  const harness = { app, database, ctx, directory, owner, groupId, member };
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

describe("third review P0 regressions", () => {
  it("maps blank group messages to 400 validation_error", async () => {
    const { app, groupId, owner } = await setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/messages`,
      headers: { "x-dev-user-id": owner },
      payload: { content: "   " },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("maps an invalid memberType path parameter to 400", async () => {
    const { app, groupId, owner, member } = await setup();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/groups/${groupId}/members/robot/${member}`,
      headers: { "x-dev-user-id": owner },
      payload: { memberRole: "member" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("keeps valid writes working", async () => {
    const { app, groupId, owner } = await setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/groups/${groupId}/messages`,
      headers: { "x-dev-user-id": owner },
      payload: { content: "hello" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().message.content).toBe("hello");
  });

  it("rejects deleting a message in an archived group without side effects", async () => {
    const { ctx, groupId, owner, member } = await setup();
    const message = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "before",
    });
    ctx.db
      .update(groups)
      .set({ status: "archived", updatedAt: ctx.now() })
      .where(eq(groups.id, groupId))
      .run();
    expect(() =>
      deleteMessage(ctx, { messageId: message.id, actor: { type: "user", id: owner } }),
    ).toThrow(/archived/);
    const deleted = ctx.db.select().from(events).where(eq(events.type, "message.deleted")).all();
    expect(deleted).toHaveLength(0);
    const audits = ctx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "message.delete"))
      .all();
    expect(audits).toHaveLength(0);
    const stored = ctx.db.select().from(messages).where(eq(messages.id, message.id)).get()!;
    expect(stored.deletedAt).toBeNull();
    // A normal member remains unable to delete someone else's message.
    expect(() =>
      deleteMessage(ctx, { messageId: message.id, actor: { type: "user", id: member } }),
    ).toThrow();
  });

  it("never lets a disabled Agent return to offline/online", async () => {
    const { ctx, owner } = await setup();
    const agentId = registerAgent(ctx, {
      displayName: "agent",
      runtime: "test",
      actorUserId: owner,
    }).id;
    const keyId = newId("key");
    ctx.db
      .insert(agentKeys)
      .values({
        id: keyId,
        agentId,
        publicKey: `pem-${keyId}`,
        fingerprint: `fp-${keyId}`,
        createdAt: ctx.now(),
      })
      .run();
    ctx.db
      .insert(agentSessions)
      .values({
        id: newId("ses"),
        agentId,
        keyId,
        tokenHash: `hash-${keyId}`,
        createdAt: ctx.now(),
        lastSeenAt: ctx.now(),
        expiresAt: ctx.now() + 60_000,
      })
      .run();
    expect(setAgentStatus(ctx, agentId, "online", "test")).toBe(true);
    disableAgent(ctx, { agentId, actorUserId: owner, reason: "test" });
    expect(setAgentStatus(ctx, agentId, "offline", "socket-closed")).toBe(false);
    expect(setAgentStatus(ctx, agentId, "online", "heartbeat")).toBe(false);
    expect(ctx.db.select().from(agents).where(eq(agents.id, agentId)).get()!.status).toBe(
      "disabled",
    );
  });
});
