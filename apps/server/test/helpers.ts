import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  agentKeys,
  agentSessions,
  type DatabaseHandle,
  migrationsFolder,
  openDatabase,
  users,
} from "@room/database";
import { type RbacRole, newId } from "@room/protocol";
import { type RoomContext, createRoomContext } from "../src/modules/context.js";
import { registerAgent } from "../src/modules/agents.js";
import { createGroup } from "../src/modules/groups.js";
import { createUser } from "../src/modules/users.js";

export interface TestRoom {
  ctx: RoomContext;
  handle: DatabaseHandle;
  close(): void;
}

export function createTestRoom(now?: () => number): TestRoom {
  const dir = mkdtempSync(join(tmpdir(), "agent-room-test-"));
  const handle = openDatabase({ path: join(dir, "room.db"), migrationsFolder });
  const ctx = createRoomContext(handle, now);
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
  // The first user bootstraps as owner; later users are created by that owner.
  const owner = ctx.db.select({ id: users.id }).from(users).where(eq(users.role, "owner")).get();
  if (!owner) return createUser(ctx, { displayName, role: "owner" }).id;
  return createUser(ctx, { displayName, role, actorUserId: owner.id }).id;
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

/**
 * Gives the agent an active key and a live session so the participation engine
 * treats it as online. M4 delivers group messages only to online agents.
 */
export function markAgentOnline(ctx: RoomContext, agentId: string): void {
  const now = ctx.now();
  const keyId = newId("key");
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
      tokenHash: `hash-${keyId}`,
      createdAt: now,
      expiresAt: now + 3_600_000,
      lastSeenAt: now,
    })
    .run();
}
