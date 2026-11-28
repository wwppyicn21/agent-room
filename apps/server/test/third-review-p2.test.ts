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
import { liveSessionAgentIds } from "../src/modules/agentAuth.js";
import { createRoomContext, type RoomContext } from "../src/modules/context.js";
import { addMember, createGroup } from "../src/modules/groups.js";
import { createUser } from "../src/modules/users.js";

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  ctx: RoomContext;
  directory: string;
  owner: string;
  groupId: string;
}

const open: Harness[] = [];

async function setup(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "room-p2-"));
  const database = openDatabase({ path: join(directory, "room.db"), migrationsFolder });
  const ctx = createRoomContext(database);
  const owner = createUser(ctx, { displayName: "owner", role: "owner" }).id;
  const groupId = createGroup(ctx, { name: "group", createdByUserId: owner }).id;
  const app = await buildApp({
    config: loadConfig({ LOG_LEVEL: "silent", AUTH_MODE: "dev" }),
    database,
  });
  const harness = { app, database, ctx, directory, owner, groupId };
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

describe("third review P2 regressions", () => {
  it("returns 201 when creating a user", async () => {
    const { app, owner } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: { "x-dev-user-id": owner },
      payload: { displayName: "new user" },
    });
    expect(response.statusCode).toBe(201);
  });

  it("rejects a key revoke whose key belongs to another agent", async () => {
    const { app, ctx, owner } = await setup();
    const a = registerAgent(ctx, { displayName: "a", runtime: "test", actorUserId: owner }).id;
    const b = registerAgent(ctx, { displayName: "b", runtime: "test", actorUserId: owner }).id;
    const keyId = newId("key");
    ctx.db
      .insert(agentKeys)
      .values({
        id: keyId,
        agentId: b,
        publicKey: `pem-${keyId}`,
        fingerprint: `fp-${keyId}`,
        createdAt: ctx.now(),
      })
      .run();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${a}/keys/${keyId}/revoke`,
      headers: { "x-dev-user-id": owner },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 400 for an invalid delivery status instead of silently ignoring it", async () => {
    const { app, owner, groupId } = await setup();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/deliveries?status=bogus`,
      headers: { "x-dev-user-id": owner },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("does not count expired sessions as online", async () => {
    const { ctx, owner, groupId } = await setup();
    const agentId = registerAgent(ctx, {
      displayName: "a",
      runtime: "test",
      actorUserId: owner,
    }).id;
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
      memberRole: "member",
    });
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
        expiresAt: ctx.now() - 1,
      })
      .run();
    expect(liveSessionAgentIds(ctx, 60_000).has(agentId)).toBe(false);
  });

  it("limits and scopes member candidates without exposing emails", async () => {
    const { app, ctx, owner, groupId } = await setup();
    createUser(ctx, {
      displayName: "Alice",
      email: "alice@example.com",
      role: "member",
      actorUserId: owner,
    });
    createUser(ctx, { displayName: "Bob", role: "member", actorUserId: owner });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/member-candidates?memberType=user&q=ali&limit=1`,
      headers: { "x-dev-user-id": owner },
    });
    expect(response.statusCode).toBe(200);
    const candidates = response.json().candidates as { displayName: string }[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0].displayName).toBe("Alice");
  });
});
