import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock, InstanceLockError } from "../src/index.js";

const directories: string[] = [];

function lockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "room-lock-"));
  directories.push(directory);
  return join(directory, "room.db.lock");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("acquireInstanceLock", () => {
  it("allows only one live holder", () => {
    const path = lockPath();
    const lock = acquireInstanceLock(path);
    try {
      expect(() => acquireInstanceLock(path)).toThrow(InstanceLockError);
    } finally {
      lock.release();
    }
  });

  it("can be reacquired after release", () => {
    const path = lockPath();
    const first = acquireInstanceLock(path);
    first.release();
    const second = acquireInstanceLock(path);
    expect(second.pid).toBe(process.pid);
    second.release();
  });

  it("reclaims a lock left by a dead process", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 999_999_999, startedAt: "2026-01-01T00:00:00Z" }));

    const lock = acquireInstanceLock(path);
    expect(lock.pid).toBe(process.pid);
    lock.release();
  });

  it("does not remove a lock held by a live foreign process", () => {
    const path = lockPath();
    // pid 1 always exists while this test runs.
    writeFileSync(path, JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00Z" }));

    expect(() => acquireInstanceLock(path)).toThrow(/already locked by process 1/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ pid: 1 });
  });
});
