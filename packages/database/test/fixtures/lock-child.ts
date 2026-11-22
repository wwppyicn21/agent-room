import { acquireInstanceLock } from "../../src/index.js";

const lockPath = process.argv[2] ?? "";
const holdMs = Number(process.argv[3] ?? "5000");

if (!lockPath) {
  process.stderr.write("usage: lock-child.ts <lock-path> [hold-ms]\n");
  process.exit(64);
}

try {
  const lock = acquireInstanceLock(lockPath);
  process.stdout.write("ACQUIRED\n");
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, holdMs);
} catch (error) {
  process.stdout.write(`LOCKED ${(error as Error).message}\n`);
  process.exit(2);
}
