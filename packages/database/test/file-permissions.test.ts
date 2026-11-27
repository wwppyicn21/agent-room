import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../src/lock.js";
import { openDatabase } from "../src/db.js";

const POSIX = process.platform !== "win32";
const mode = (path: string): number => statSync(path).mode & 0o777;

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "room-permissions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!POSIX)("SQLite file permissions", () => {
  it("creates the database and WAL sidecars private to the owner", () => {
    const dir = tempDir();
    const path = join(dir, "room.db");
    const handle = openDatabase({ path });
    try {
      handle.sqlite.exec("create table t (id integer)");
      handle.sqlite.exec("insert into t (id) values (1)");
      expect(mode(path)).toBe(0o600);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(mode(`${path}-wal`)).toBe(0o600);
      if (existsSync(`${path}-shm`)) expect(mode(`${path}-shm`)).toBe(0o600);
    } finally {
      handle.close();
    }
  });

  it("tightens an existing database file that was created with wider permissions", () => {
    const dir = tempDir();
    const path = join(dir, "room.db");
    writeFileSync(path, "");
    chmodSync(path, 0o644);
    const handle = openDatabase({ path });
    try {
      expect(mode(path)).toBe(0o600);
    } finally {
      handle.close();
    }
  });

  it("creates the instance lock database private to the owner", () => {
    const dir = tempDir();
    const path = join(dir, "room.db.lockdb");
    const lock = acquireInstanceLock(path);
    try {
      expect(mode(path)).toBe(0o600);
    } finally {
      lock.release();
    }
  });
});
