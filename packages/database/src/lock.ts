import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

interface LockRecord {
  pid: number;
  startedAt: string;
}

function readRecord(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt ?? "" };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Enforces a single writer per database file. Uses an exclusive-create pid file
 * next to the database; a lock left by a dead process is reclaimed.
 */
export function acquireInstanceLock(lockPath: string): InstanceLock {
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };
      writeFileSync(fd, JSON.stringify(record));
      closeSync(fd);

      let released = false;
      return {
        path: lockPath,
        pid: process.pid,
        release() {
          if (released) return;
          released = true;
          try {
            if (readRecord(lockPath)?.pid === process.pid) unlinkSync(lockPath);
          } catch {
            // The lock file is already gone; nothing to release.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const holder = readRecord(lockPath);
      if (holder && isProcessAlive(holder.pid)) {
        throw new InstanceLockError(
          `database is already locked by process ${holder.pid} (${lockPath})`,
        );
      }
      // Stale lock from a crashed process: remove it and retry.
      try {
        unlinkSync(lockPath);
      } catch {
        // Another starter removed it first; the next iteration will retry.
      }
    }
  }

  const holder = readRecord(lockPath);
  throw new InstanceLockError(
    `could not acquire ${lockPath}${holder ? ` (held by pid ${holder.pid})` : ""}`,
  );
}
