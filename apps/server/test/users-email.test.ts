import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { migrationsFolder, openDatabase } from "@room/database";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "../src/modules/errors.js";
import { createUser, findUserByEmail } from "../src/modules/users.js";
import { createTestRoom, type TestRoom } from "./helpers.js";

const rooms: TestRoom[] = [];

afterEach(() => {
  for (const room of rooms.splice(0)) room.close();
});

function room(): TestRoom {
  const created = createTestRoom();
  rooms.push(created);
  return created;
}

describe("user email identity", () => {
  it("normalizes emails, rejects case-insensitive duplicates and allows multiple NULLs", () => {
    const created = room();
    const owner = createUser(created.ctx, {
      displayName: "Owner",
      email: "Owner@Example.com",
    }).id;
    expect(findUserByEmail(created.ctx, "OWNER@EXAMPLE.COM")?.email).toBe("owner@example.com");

    const alice = createUser(created.ctx, {
      displayName: "Alice",
      email: "Alice@Example.com",
      actorUserId: owner,
    });
    expect(alice.email).toBe("alice@example.com");
    expect(findUserByEmail(created.ctx, "aLiCe@example.COM")?.id).toBe(alice.id);

    expect(() =>
      createUser(created.ctx, {
        displayName: "Duplicate",
        email: "ALICE@example.com",
        actorUserId: owner,
      }),
    ).toThrow(ConflictError);

    expect(() =>
      createUser(created.ctx, { displayName: "No mail 1", actorUserId: owner }),
    ).not.toThrow();
    expect(() =>
      createUser(created.ctx, { displayName: "No mail 2", actorUserId: owner }),
    ).not.toThrow();
  });

  it("creates the lower(email) unique index and reports pre-existing duplicates", () => {
    const created = room();
    const path = created.handle.path;
    expect(
      created.handle.sqlite
        .prepare(
          "select name from sqlite_master where type = 'index' and name = 'users_email_lower_uq'",
        )
        .get(),
    ).toBeDefined();

    // Simulate an old database that predates the unique email migration.
    created.handle.sqlite.prepare("drop index users_email_lower_uq").run();
    created.handle.sqlite
      .prepare(
        `insert into users (id, display_name, email, role, status, created_at, updated_at)
         values ('usr_a', 'A', 'dup@example.com', 'member', 'active', 0, 0),
                ('usr_b', 'B', 'DUP@example.com', 'member', 'active', 0, 0)`,
      )
      .run();
    created.handle.close();

    try {
      expect(() => openDatabase({ path, migrationsFolder })).toThrow(
        /duplicate user email dup@example\.com/,
      );
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});
