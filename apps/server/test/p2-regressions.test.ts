import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import {
  auditLogs,
  type DatabaseHandle,
  events,
  migrationsFolder,
  openDatabase,
} from "@room/database";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createRoomContext, type RoomContext } from "../src/modules/context.js";
import { createGroup, updateGroup } from "../src/modules/groups.js";
import { createTaskFromMessage } from "../src/modules/tasks.js";
import { postMessage } from "../src/modules/messages.js";
import { RealtimeHub } from "../src/modules/realtime.js";
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
  const directory = mkdtempSync(join(tmpdir(), "room-p2-"));
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

function seedTask(room: Harness) {
  const group = createGroup(room.ctx, { name: "g", createdByUserId: room.owner });
  const source = postMessage(room.ctx, {
    groupId: group.id,
    actor: { type: "user", id: room.owner },
    content: "please do the thing",
  });
  const input = {
    groupId: group.id,
    createdByUserId: room.owner,
    sourceMessageId: source.id,
    title: "do the thing",
    idempotencyKey: "p2-idem",
  };
  return { group, source, input };
}

describe("P2 regressions", () => {
  it("rejects a task idempotency replay with a different payload", async () => {
    const room = await setup();
    const { input } = seedTask(room);
    const first = createTaskFromMessage(room.ctx, input);
    const second = createTaskFromMessage(room.ctx, input);
    expect(second.task.id).toBe(first.task.id);
    expect(second.threadId).toBe(first.threadId);
    expect(() => createTaskFromMessage(room.ctx, { ...input, title: "different" })).toThrowError(
      /idempotency key/,
    );
  });

  it("updates group name and settings in one transaction", async () => {
    const room = await setup();
    const group = createGroup(room.ctx, { name: "before", createdByUserId: room.owner });
    const updated = updateGroup(room.ctx, {
      groupId: group.id,
      actorUserId: room.owner,
      name: "after",
      settings: {
        participationMode: "mention",
        allowAgentMessages: false,
        maxHops: 2,
        maxRepliesPerRoot: 5,
        maxAgentMessagesPerMinute: 3,
      },
    });
    expect(updated.name).toBe("after");
    expect(updated.participationMode).toBe("mention");
    expect(updated.allowAgentMessages).toBe(false);
    const auditRows = room.ctx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, "group"), eq(auditLogs.targetId, group.id)))
      .all();
    expect(
      auditRows
        .map((row) => row.action)
        .filter((action) => action !== "group.create")
        .sort(),
    ).toEqual(["group.settings_update", "group.updated"]);
    const updateEvents = room.ctx.db
      .select()
      .from(events)
      .where(and(eq(events.groupId, group.id), eq(events.type, "group.updated")))
      .all();
    expect(updateEvents).toHaveLength(1);
  });

  it("does not write when the settings payload is invalid", async () => {
    const room = await setup();
    const group = createGroup(room.ctx, { name: "keep", createdByUserId: room.owner });
    expect(() =>
      updateGroup(room.ctx, {
        groupId: group.id,
        actorUserId: room.owner,
        name: "changed",
        settings: {
          participationMode: "mention",
          allowAgentMessages: true,
          maxHops: 999,
          maxRepliesPerRoot: 5,
          maxAgentMessagesPerMinute: 3,
        },
      }),
    ).toThrow();
    const row = room.ctx.db.select().from(events).where(eq(events.groupId, group.id)).all();
    expect(row.some((event) => event.type === "group.updated")).toBe(false);
  });

  it("rejects invalid message cursors with 400", async () => {
    const room = await setup();
    const group = createGroup(room.ctx, { name: "cursors", createdByUserId: room.owner });
    const headers = { "x-dev-user-id": room.owner };
    for (const cursor of ["abc", "-1", "1.5"]) {
      const response = await room.app.inject({
        method: "GET",
        url: `/api/v1/groups/${group.id}/messages?cursor=${encodeURIComponent(cursor)}`,
        headers,
      });
      expect(response.statusCode).toBe(400);
    }
    const ok = await room.app.inject({
      method: "GET",
      url: `/api/v1/groups/${group.id}/messages?cursor=0`,
      headers,
    });
    expect(ok.statusCode).toBe(200);
  });

  it("keeps realtime ticket state inside each hub instance", async () => {
    const room = await setup();
    const first = new RealtimeHub();
    const second = new RealtimeHub();
    const issued = first.issueTicket(room.ctx, room.owner, 60_000, 10);
    expect(second.consumeTicket(room.ctx, issued.ticket)).toBeNull();
    expect(first.consumeTicket(room.ctx, issued.ticket)).toBe(room.owner);
  });
});
