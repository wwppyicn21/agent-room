import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock, InstanceLockError } from "../src/index.js";

const fixture = fileURLToPath(new URL("./fixtures/lock-child.ts", import.meta.url));
const directories: string[] = [];
const children: ChildProcess[] = [];

function lockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "room-lock-"));
  directories.push(directory);
  return join(directory, "room.db.lockdb");
}

interface Child {
  process: ChildProcess;
  firstLine: Promise<string>;
  exited: Promise<number | null>;
}

function runChild(path: string, holdMs: number): Child {
  const child = spawn(process.execPath, ["--import", "tsx", fixture, path, String(holdMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const firstLine = new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.includes("\n")) resolve(buffer.split("\n")[0] ?? "");
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      buffer += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!buffer.includes("\n")) reject(new Error(`child exited (${code}) without output`));
    });
  });

  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { process: child, firstLine, exited };
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
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

  it("releases the lock when the holding process is killed", async () => {
    const path = lockPath();
    const holder = runChild(path, 60_000);
    await expect(holder.firstLine).resolves.toBe("ACQUIRED");

    holder.process.kill("SIGKILL");
    await holder.exited;

    const lock = acquireInstanceLock(path);
    expect(lock.pid).toBe(process.pid);
    lock.release();
  });

  it("lets exactly one of several concurrent starters win", async () => {
    const path = lockPath();
    const contenders = [runChild(path, 3_000), runChild(path, 3_000), runChild(path, 3_000)];

    const lines = await Promise.all(contenders.map((child) => child.firstLine));
    expect(lines.filter((line) => line === "ACQUIRED")).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("LOCKED"))).toHaveLength(2);

    await Promise.all(contenders.map((child) => child.exited));
  });
});
