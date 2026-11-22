import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { migrationsFolder, openDatabase, readPragmas, systemMeta } from "../src/index.js";

const directories: string[] = [];

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "room-db-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  it("opens with WAL, foreign keys, busy timeout and FULL sync", () => {
    const database = openDatabase({ path: join(freshDirectory(), "room.db"), migrationsFolder });
    try {
      expect(readPragmas(database.sqlite)).toEqual({
        journalMode: "wal",
        foreignKeys: 1,
        busyTimeout: 5000,
        synchronous: 2,
      });
    } finally {
      database.close();
    }
  });

  it("applies the Drizzle migration and creates system_meta", () => {
    const database = openDatabase({ path: join(freshDirectory(), "room.db"), migrationsFolder });
    try {
      const table = database.sqlite
        .prepare("select count(*) as n from sqlite_master where type = 'table' and name = ?")
        .get("system_meta") as { n: number };
      expect(table.n).toBe(1);
    } finally {
      database.close();
    }
  });

  it("persists rows across close and reopen", () => {
    const path = join(freshDirectory(), "room.db");

    const first = openDatabase({ path, migrationsFolder });
    first.db
      .insert(systemMeta)
      .values({ key: "probe", value: "42", updatedAt: new Date("2026-11-22T18:00:00Z") })
      .run();
    first.close();

    const second = openDatabase({ path, migrationsFolder });
    try {
      const row = second.db.select().from(systemMeta).where(eq(systemMeta.key, "probe")).get();
      expect(row?.value).toBe("42");
      expect(row?.updatedAt.toISOString()).toBe("2026-11-22T18:00:00.000Z");
    } finally {
      second.close();
    }
  });
});
