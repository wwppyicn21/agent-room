import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceLockError";
  }
}

export interface InstanceLock {
  readonly path: string;
  readonly pid: number;
  release(): void;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Enforces a single writer per database file.
 *
 * The lock is a separate SQLite database held under `BEGIN IMMEDIATE` for the
 * lifetime of the process. SQLite's OS-level file locks make acquisition
 * atomic, and the OS releases them when the process dies, so there is no stale
 * lock file to reclaim (and therefore no reclaim race). The pid is recorded in
 * the open transaction for diagnostics.
 */
const IS_POSIX = process.platform !== "win32";

function ensurePrivateDirectory(directory: string): void {
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (IS_POSIX && !existed) chmodSync(directory, 0o700);
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

export function acquireInstanceLock(lockPath: string): InstanceLock {
  ensurePrivateDirectory(dirname(lockPath));
  if (IS_POSIX) {
    closeSync(openSync(lockPath, "a", 0o600));
    chmodSync(lockPath, 0o600);
  }

  let sqlite: Database.Database;
  try {
    // timeout: 0 -> a contending writer fails with SQLITE_BUSY immediately.
    sqlite = withRestrictedUmask(() => new Database(lockPath, { timeout: 0 }));
  } catch (error) {
    throw new InstanceLockError(`cannot open lock database ${lockPath}: ${describe(error)}`);
  }

  try {
    sqlite.pragma("busy_timeout = 0");
    sqlite.pragma("journal_mode = delete");
    sqlite.exec("begin immediate");
    sqlite.exec(
      "create table if not exists instance_lock (" +
        "id integer primary key check (id = 1), " +
        "pid integer not null, " +
        "started_at text not null)",
    );
    sqlite
      .prepare("insert or replace into instance_lock (id, pid, started_at) values (1, ?, ?)")
      .run(process.pid, new Date().toISOString());
  } catch (error) {
    try {
      sqlite.exec("rollback");
    } catch {
      // Nothing to roll back.
    }
    sqlite.close();
    if (isBusy(error)) {
      throw new InstanceLockError(
        `another agent-room instance is already running (lock database ${lockPath})`,
      );
    }
    throw new InstanceLockError(`cannot acquire ${lockPath}: ${describe(error)}`);
  }

  let released = false;
  return {
    path: lockPath,
    pid: process.pid,
    release() {
      if (released) return;
      released = true;
      try {
        sqlite.exec("rollback");
      } catch {
        // The connection may already be closed.
      }
      try {
        sqlite.close();
      } catch {
        // Closing an already closed connection is harmless.
      }
    },
  };
}
