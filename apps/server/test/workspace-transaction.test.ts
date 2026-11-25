import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { auditLogs, workspaces } from "@room/database";
import { createWorkspace } from "../src/modules/index.js";
import { ConflictError } from "../src/modules/errors.js";
import { createTestRoom, seedGroup, seedUser } from "./helpers.js";

describe("M5 Review Fix 3C — workspace and audit atomicity", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("commits the workspace and its audit row together", () => {
    const room = createTestRoom();
    cleanup = room.close;
    const ctx = room.ctx;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner, "workspace-atomic");

    const workspace = createWorkspace(ctx, { groupId, actorUserId: owner, name: "repo" });

    expect(workspace.groupId).toBe(groupId);
    const audits = ctx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "workspace.create"), eq(auditLogs.targetId, workspace.id)))
      .all();
    expect(audits).toHaveLength(1);
  });

  it("rolls the workspace INSERT back when the audit write fails", () => {
    const room = createTestRoom();
    cleanup = room.close;
    const ctx = room.ctx;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner, "workspace-rollback");

    ctx.db.run(
      sql`CREATE TRIGGER fail_audit_insert BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit failure'); END;`,
    );
    try {
      expect(() => createWorkspace(ctx, { groupId, actorUserId: owner, name: "repo" })).toThrow(
        /audit failure/,
      );
    } finally {
      ctx.db.run(sql`DROP TRIGGER fail_audit_insert;`);
    }

    expect(ctx.db.select().from(workspaces).all()).toHaveLength(0);
    expect(
      ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "workspace.create")).all(),
    ).toHaveLength(0);
  });

  it("keeps names unique per group and allows the same name in another group", () => {
    const room = createTestRoom();
    cleanup = room.close;
    const ctx = room.ctx;
    const owner = seedUser(ctx, "owner", "owner");
    const groupId = seedGroup(ctx, owner, "workspace-a");
    const otherGroup = seedGroup(ctx, owner, "workspace-b");

    createWorkspace(ctx, { groupId, actorUserId: owner, name: "repo" });
    expect(() => createWorkspace(ctx, { groupId, actorUserId: owner, name: "repo" })).toThrow(
      ConflictError,
    );

    const other = createWorkspace(ctx, { groupId: otherGroup, actorUserId: owner, name: "repo" });
    expect(other.groupId).toBe(otherGroup);
    expect(ctx.db.select().from(workspaces).all()).toHaveLength(2);
  });
});
