import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export interface DatabaseHandle {
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly sqlite: Database.Database;
  readonly path: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Absolute or relative path to the SQLite file. */
  path: string;
  /** Folder with Drizzle migrations; when omitted the schema is not applied. */
  migrationsFolder?: string;
}

export interface PragmaSnapshot {
  journalMode: string;
  foreignKeys: number;
  busyTimeout: number;
  synchronous: number;
}

/**
 * Opens the database and applies the runtime pragmas required by the plan:
 * WAL, foreign keys, a write lock timeout and full synchronous writes.
 */
export function openDatabase({ path, migrationsFolder }: OpenDatabaseOptions): DatabaseHandle {
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = FULL");

  const db = drizzle(sqlite, { schema });
  if (migrationsFolder) {
    try {
      assertNoDuplicateUserEmails(sqlite);
      migrate(db, { migrationsFolder });
    } catch (error) {
      // Never leak an open handle when a pre-migration check or migration fails.
      if (sqlite.open) sqlite.close();
      throw error;
    }
  }

  return {
    db,
    sqlite,
    path,
    close() {
      if (sqlite.open) sqlite.close();
    },
  };
}

/**
 * The unique index on `lower(email)` is created by a migration; pre-existing
 * duplicates would make that migration fail with an opaque SQLite error, so we
 * check first and tell the operator exactly which address conflicts.
 */
function assertNoDuplicateUserEmails(sqlite: Database.Database): void {
  const table = sqlite
    .prepare("select name from sqlite_master where type = 'table' and name = 'users'")
    .get();
  if (!table) return;
  const duplicate = sqlite
    .prepare(
      `select lower(email) as email, count(*) as count
         from users
        where email is not null
        group by lower(email)
       having count(*) > 1
        limit 1`,
    )
    .get() as { email: string; count: number } | undefined;
  if (duplicate) {
    throw new Error(
      `duplicate user email ${duplicate.email} (${duplicate.count} users); ` +
        "deduplicate the users table before starting the server so the unique email index can be created",
    );
  }
}

export function readPragmas(sqlite: Database.Database): PragmaSnapshot {
  return {
    journalMode: String(sqlite.pragma("journal_mode", { simple: true })),
    foreignKeys: Number(sqlite.pragma("foreign_keys", { simple: true })),
    busyTimeout: Number(sqlite.pragma("busy_timeout", { simple: true })),
    synchronous: Number(sqlite.pragma("synchronous", { simple: true })),
  };
}
