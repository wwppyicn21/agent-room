import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import {
  agentDeliveries,
  type DatabaseHandle,
  migrationsFolder,
  openDatabase,
} from "@room/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { registerAgent } from "../src/modules/agents.js";
import { createRoomContext, type RoomContext } from "../src/modules/context.js";
import { appendEvent, enqueueDelivery } from "../src/modules/events.js";
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
  const directory = mkdtempSync(join(tmpdir(), "room-delivery-diag-"));
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

function seedDelivery(ctx: RoomContext, owner: string, groupId: string, agentId: string) {
  const event = appendEvent(ctx.db, {
    type: "message.created",
    actor: { type: "user", id: owner },
    groupId,
    payload: {},
    createdAt: ctx.now(),
  });
  return enqueueDelivery(ctx.db, { agentId, eventId: event.id, createdAt: ctx.now() });
}

describe("delivery diagnostics", () => {
  it("lists deliveries with agent and event type for a manager", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const agent = registerAgent(ctx, {
      displayName: "agent",
      runtime: "test",
      actorUserId: owner,
    });
    addMember(ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: agent.id });
    seedDelivery(ctx, owner, groupId, agent.id);
    seedDelivery(ctx, owner, groupId, agent.id);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/deliveries`,
      headers: { "x-dev-user-id": owner },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(2);
    expect(listed.json().items[0].agentDisplayName).toBe("agent");
    expect(listed.json().items[0].eventType).toBe("message.created");
  });

  it("paginates with a delivery cursor", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const agent = registerAgent(ctx, {
      displayName: "agent",
      runtime: "test",
      actorUserId: owner,
    });
    for (let i = 0; i < 3; i += 1) seedDelivery(ctx, owner, groupId, agent.id);

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/deliveries?limit=2`,
      headers: { "x-dev-user-id": owner },
    });
    expect(first.json().items).toHaveLength(2);
    const cursor = first.json().nextCursor;
    expect(cursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/deliveries?limit=2&cursor=${cursor}`,
      headers: { "x-dev-user-id": owner },
    });
    expect(second.json().items).toHaveLength(1);

    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/deliveries?cursor=evd_missing`,
      headers: { "x-dev-user-id": owner },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("rejects non-managers and agents", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const member = createUser(ctx, {
      displayName: "member",
      role: "member",
      actorUserId: owner,
    }).id;
    addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "user",
      memberId: member,
      memberRole: "member",
    });
    const memberResponse = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/deliveries`,
      headers: { "x-dev-user-id": member },
    });
    expect(memberResponse.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/deliveries`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("reports status counts, oldest pending and group isolation", async () => {
    const { app, ctx, owner } = await setup();
    const groupId = createGroup(ctx, { name: "g", createdByUserId: owner }).id;
    const otherGroupId = createGroup(ctx, { name: "other", createdByUserId: owner }).id;
    const agent = registerAgent(ctx, {
      displayName: "agent",
      runtime: "test",
      actorUserId: owner,
    });
    const first = seedDelivery(ctx, owner, groupId, agent.id);
    const second = seedDelivery(ctx, owner, groupId, agent.id);
    seedDelivery(ctx, owner, otherGroupId, agent.id);
    ctx.db
      .update(agentDeliveries)
      .set({ status: "delivered", deliveredAt: ctx.now() })
      .where(eq(agentDeliveries.id, first.id))
      .run();
    ctx.db
      .update(agentDeliveries)
      .set({ status: "failed", lastError: "boom" })
      .where(eq(agentDeliveries.id, second.id))
      .run();

    const stats = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/deliveries/stats`,
      headers: { "x-dev-user-id": owner },
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().statuses).toEqual({ pending: 0, delivered: 1, acked: 0, failed: 1 });
    expect(stats.json().oldestPendingAt).toBeNull();

    const pending = await app.inject({
      method: "GET",
      url: `/api/v1/groups/${groupId}/deliveries?status=pending`,
      headers: { "x-dev-user-id": owner },
    });
    expect(pending.json().items).toEqual([]);
  });
});
