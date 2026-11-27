import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
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

const IS_POSIX = process.platform !== "win32";

/**
 * Creates the data directory with private permissions. An existing directory is
 * left untouched: it may be a shared parent such as /tmp chosen by the caller,
 * and the deployment guide tightens /var/lib/agentroom explicitly.
 */
function ensurePrivateDirectory(directory: string): void {
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (IS_POSIX && !existed) chmodSync(directory, 0o700);
}

/** Tightens an existing file we own; a missing file is not an error. */
function ensurePrivateFile(file: string): void {
  if (!IS_POSIX) return;
  try {
    chmodSync(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * SQLite creates `-wal`/`-shm` sidecars with the process umask, so files
 * created during open/migration are made private here. The systemd unit also
 * sets UMask=0077 so later sidecars stay private in production.
 */
function secureSqliteFiles(path: string): void {
  ensurePrivateFile(path);
  ensurePrivateFile(`${path}-wal`);
  ensurePrivateFile(`${path}-shm`);
}

function withRestrictedUmask<T>(operation: () => T): T {
  if (!IS_POSIX) return operation();
  const previous = process.umask(0o077);
  try {
    return operation();
  } finally {
    process.umask(previous);
  }
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
  ensurePrivateDirectory(dirname(path));
  if (IS_POSIX) {
    // Pre-create the database with 0600 so better-sqlite3 never creates it with
    // the ambient umask; WAL/SHM inherit the restricted umask below.
    closeSync(openSync(path, "a", 0o600));
  }

  const sqlite = withRestrictedUmask(() => {
    const database = new Database(path);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("synchronous = FULL");
    return database;
  });

  const db = drizzle(sqlite, { schema });
  if (migrationsFolder) {
    try {
      withRestrictedUmask(() => {
        assertNoDuplicateUserEmails(sqlite);
        migrate(db, { migrationsFolder });
      });
    } catch (error) {
      // Never leak an open handle when a pre-migration check or migration fails.
      if (sqlite.open) sqlite.close();
      throw error;
    }
  }
  secureSqliteFiles(path);

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
