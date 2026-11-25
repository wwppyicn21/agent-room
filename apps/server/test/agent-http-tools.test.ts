import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import {
  agentKeys,
  agentSessions,
  type DatabaseHandle,
  migrationsFolder,
  openDatabase,
} from "@room/database";
import { newId } from "@room/protocol";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { registerAgent } from "../src/modules/agents.js";
import { createRoomContext, type RoomContext } from "../src/modules/context.js";
import { addMember, createGroup } from "../src/modules/groups.js";
import { postMessage } from "../src/modules/messages.js";
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
  const directory = mkdtempSync(join(tmpdir(), "room-agent-tools-"));
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

function seedAgent(ctx: RoomContext, owner: string, groupId: string) {
  const agentId = registerAgent(ctx, {
    displayName: "agent",
    runtime: "test",
    actorUserId: owner,
  }).id;
  addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agentId });
  return { agentId, token: agentToken(ctx, agentId) };
}

describe("Agent HTTP room tools", () => {
  it("lists only the groups the agent belongs to", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    createGroup(ctx, { name: "other", createdByUserId: owner });
    const { agentId, token } = seedAgent(ctx, owner, groupId);

    const groups = await app.inject({
      method: "GET",
      url: "/api/v1/agent/groups",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(groups.statusCode).toBe(200);
    expect(groups.json().groups.map((g: { id: string }) => g.id)).toEqual([groupId]);

    const outsider = registerAgent(ctx, {
      displayName: "outsider",
      runtime: "test",
      actorUserId: owner,
    });
    const outsiderGroups = await app.inject({
      method: "GET",
      url: "/api/v1/agent/groups",
      headers: { authorization: `Bearer ${agentToken(ctx, outsider.id)}` },
    });
    expect(outsiderGroups.json().groups).toEqual([]);
    expect(agentId).toBeTruthy();
  });

  it("reads the group stream and replies with a bearer token", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const source = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "ping the agent",
    });
    const { token } = seedAgent(ctx, owner, groupId);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/agent/groups/${groupId}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((m: { content: string }) => m.content)).toEqual([
      "ping the agent",
    ]);

    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/agent/groups/${groupId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: "pong", replyToMessageId: source.id },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().message.senderType).toBe("agent");
    expect(reply.json().message.hop).toBe(1);

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/agent/groups/${groupId}/events`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().items.some((e: { type: string }) => e.type === "message.created")).toBe(
      true,
    );
  });

  it("rejects a non-member agent and a top-level agent message", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const outsider = registerAgent(ctx, {
      displayName: "outsider",
      runtime: "test",
      actorUserId: owner,
    });
    const outsiderToken = agentToken(ctx, outsider.id);
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/agent/groups/${groupId}/messages`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const { token } = seedAgent(ctx, owner, groupId);
    const topLevel = await app.inject({
      method: "POST",
      url: `/api/v1/agent/groups/${groupId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: "top-level agent message" },
    });
    expect(topLevel.statusCode).toBe(400);
  });

  it("requires an agent bearer token", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/v1/agent/groups" });
    expect(response.statusCode).toBe(401);
  });
});
