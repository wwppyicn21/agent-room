import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DatabaseHandle, migrationsFolder, openDatabase } from "@room/database";
import type { RbacRole } from "@room/protocol";
import { type RoomContext, createRoomContext } from "../src/modules/context.js";
import { registerAgent } from "../src/modules/agents.js";
import { createGroup } from "../src/modules/groups.js";
import { createUser } from "../src/modules/users.js";

export interface TestRoom {
  ctx: RoomContext;
  handle: DatabaseHandle;
  close(): void;
}

export function createTestRoom(): TestRoom {
  const dir = mkdtempSync(join(tmpdir(), "agent-room-test-"));
  const handle = openDatabase({ path: join(dir, "room.db"), migrationsFolder });
  const ctx = createRoomContext(handle);
  return {
    ctx,
    handle,
    close() {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function seedUser(ctx: RoomContext, displayName: string, role: RbacRole = "member"): string {
  return createUser(ctx, { displayName, role }).id;
}

export function seedGroup(ctx: RoomContext, ownerUserId: string, name = "group"): string {
  return createGroup(ctx, { name, createdByUserId: ownerUserId }).id;
}

export function seedAgent(ctx: RoomContext, adminUserId: string, displayName: string): string {
  return registerAgent(ctx, {
    displayName,
    runtime: "test",
    actorUserId: adminUserId,
  }).id;
}
