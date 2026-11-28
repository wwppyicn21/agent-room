import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationsFolder, openDatabase } from "@room/database";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function run(script: string, args: string[]): string {
  return execFileSync("bash", [join(root, "deployment/scripts", script), ...args], {
    encoding: "utf8",
  });
}

function sqlite(path: string, statement: string): string {
  return execFileSync("sqlite3", [path, statement], { encoding: "utf8" }).trim();
}

describe("deployment backup scripts", () => {
  it("backs up a live WAL database, verifies integrity and restores a copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-room-backup-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "room.db");
    const handle = openDatabase({ path: dbPath, migrationsFolder });
    handle.sqlite.exec(
      "create table if not exists probe(value text); insert into probe values ('kept');",
    );
    cleanups.push(() => handle.close());

    const backupDir = join(dir, "backups");
    const output = run("backup.sh", [dbPath, backupDir, "2"]);
    expect(output).toContain("backup:");
    const files = execFileSync("bash", ["-c", `ls -1 ${backupDir}/room-*.db`], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(files).toHaveLength(1);
    const checksum = readFileSync(`${files[0]}.sha256`, "utf8").trim();
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);

    const restored = join(dir, "restore", "room.db");
    run("restore.sh", [files[0], restored]);
    expect(sqlite(restored, "select value from probe")).toBe("kept");
    expect(sqlite(restored, "pragma integrity_check")).toBe("ok");
    expect(existsSync(restored)).toBe(true);
  });

  it("refuses to overwrite a target without --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-room-restore-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "room.db");
    const handle = openDatabase({ path: dbPath, migrationsFolder });
    handle.sqlite.exec("create table probe(value text); insert into probe values ('kept');");
    handle.close();
    const backupDir = join(dir, "backups");
    run("backup.sh", [dbPath, backupDir]);
    const backup = execFileSync("bash", ["-c", `ls -1 ${backupDir}/room-*.db`], {
      encoding: "utf8",
    }).trim();
    const target = join(dir, "existing.db");
    handle.close();
    openDatabase({ path: target, migrationsFolder }).close();
    expect(() => run("restore.sh", [backup, target])).toThrow();
    run("restore.sh", [backup, target, "--force"]);
    expect(sqlite(target, "pragma integrity_check")).toBe("ok");
  });
});

describe("deployment release switching", () => {
  it("switches releases atomically and keeps the previous one for rollback", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-room-release-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const releases = join(dir, "releases");
    const link = join(dir, "current");
    for (const id of ["r1", "r2"]) {
      const release = join(releases, id, "apps/server/dist");
      execFileSync("mkdir", ["-p", release]);
      execFileSync("touch", [join(release, "main.js")]);
    }
    run("switch-release.sh", [releases, "r1", link]);
    expect(execFileSync("readlink", ["-f", link], { encoding: "utf8" }).trim()).toBe(
      join(releases, "r1"),
    );
    run("switch-release.sh", [releases, "r2", link]);
    expect(execFileSync("readlink", ["-f", link], { encoding: "utf8" }).trim()).toBe(
      join(releases, "r2"),
    );
    run("switch-release.sh", [releases, "r1", link]);
    expect(execFileSync("readlink", ["-f", link], { encoding: "utf8" }).trim()).toBe(
      join(releases, "r1"),
    );
  });
});
