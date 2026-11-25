import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import { type DatabaseHandle, events, migrationsFolder, openDatabase } from "@room/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createRoomContext, type RoomContext } from "../src/modules/context.js";
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
  const directory = mkdtempSync(join(tmpdir(), "room-users-admin-"));
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

describe("user administration", () => {
  it("lets only the owner grant admin and rejects member listing", async () => {
    const { app, ctx, owner } = await setup();
    const member = createUser(ctx, {
      displayName: "member",
      role: "member",
      actorUserId: owner,
    }).id;
    const viewer = createUser(ctx, {
      displayName: "viewer",
      role: "member",
      actorUserId: owner,
    }).id;
    const admin = createUser(ctx, { displayName: "admin", role: "admin", actorUserId: owner }).id;

    const adminAttempt = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${member}`,
      headers: { "x-dev-user-id": admin },
      payload: { role: "admin" },
    });
    expect(adminAttempt.statusCode).toBe(403);

    const ownerAttempt = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${member}`,
      headers: { "x-dev-user-id": owner },
      payload: { role: "admin" },
    });
    expect(ownerAttempt.statusCode).toBe(200);
    expect(ownerAttempt.json().user.role).toBe("admin");

    const memberList = await app.inject({
      method: "GET",
      url: "/api/v1/users",
      headers: { "x-dev-user-id": viewer },
    });
    expect(memberList.statusCode).toBe(403);
  });

  it("disables and re-enables a user with events", async () => {
    const { app, ctx, owner } = await setup();
    const member = createUser(ctx, {
      displayName: "member",
      role: "member",
      actorUserId: owner,
    }).id;

    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/users/${member}/disable`,
      headers: { "x-dev-user-id": owner },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().user.status).toBe("disabled");

    const blocked = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { "x-dev-user-id": member },
    });
    expect(blocked.statusCode).toBe(403);

    const enabled = await app.inject({
      method: "POST",
      url: `/api/v1/users/${member}/enable`,
      headers: { "x-dev-user-id": owner },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().user.status).toBe("active");

    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { "x-dev-user-id": member },
    });
    expect(allowed.statusCode).toBe(200);

    const disabledEvents = ctx.db
      .select()
      .from(events)
      .where(eq(events.type, "user.disabled"))
      .all();
    expect(disabledEvents).toHaveLength(1);
  });

  it("keeps the last active owner", async () => {
    const { app, owner } = await setup();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/users/${owner}/disable`,
      headers: { "x-dev-user-id": owner },
    });
    expect(response.statusCode).toBe(409);
  });
});
