import { fileURLToPath } from "node:url";
import { loadConfig } from "@room/config";
import { acquireInstanceLock, InstanceLockError, openDatabase } from "@room/database";
import { ensureBootstrapOwner } from "./auth/bootstrap.js";
import {
  cleanupExpiredChallenges,
  cleanupExpiredSocketTickets,
  sweepStaleSessions,
} from "./modules/agentAuth.js";
import { expireDueApprovals } from "./modules/approvals.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const lockPath = `${config.databasePath}.lockdb`;

let lock: ReturnType<typeof acquireInstanceLock>;
try {
  lock = acquireInstanceLock(lockPath);
} catch (error) {
  if (error instanceof InstanceLockError) {
    console.error(`[agent-room] ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const database = openDatabase({
  path: config.databasePath,
  migrationsFolder: fileURLToPath(new URL("../../../packages/database/drizzle/", import.meta.url)),
});

const app = await buildApp({ config, database });
const { roomContext } = app;

const bootstrapOwner = ensureBootstrapOwner(
  roomContext,
  { email: config.bootstrapOwnerEmail },
  {
    warn: (obj, msg) => app.log.warn(obj, msg),
    info: (obj, msg) => app.log.info(obj, msg),
  },
);
if (bootstrapOwner) {
  app.log.info({ userId: bootstrapOwner.id }, "bootstrap owner ready");
}

// Task approvals have deadlines in the database; sweep them on the server so a
// restart or an agent disconnect cannot leave a task waiting forever.
const expireApprovals = (): number => {
  try {
    const expired = expireDueApprovals(roomContext);
    if (expired > 0) app.log.info({ expired }, "approvals expired");
    return expired;
  } catch (error) {
    app.log.warn({ err: error }, "approval expiration failed");
    return 0;
  }
};
expireApprovals();
const approvalTimer = setInterval(expireApprovals, 30_000);
approvalTimer.unref();

const presenceTimer = setInterval(() => {
  try {
    const offline = sweepStaleSessions(roomContext, {
      presenceTtlMs: config.agentPresenceTtlMs,
    });
    for (const agentId of offline) {
      app.agentHub.closeAgent(agentId, "presence timeout");
    }
  } catch (error) {
    app.log.warn({ err: error }, "presence sweep failed");
  }
}, 10_000);
presenceTimer.unref();

// Public challenge/connect endpoints write rows; bound both tables without
// touching challenges that are still valid and unconsumed.
const authCleanupTimer = setInterval(() => {
  try {
    const now = roomContext.now();
    const challenges = cleanupExpiredChallenges(roomContext, now);
    const tickets = cleanupExpiredSocketTickets(roomContext, now);
    if (challenges > 0 || tickets > 0) {
      app.log.info({ challenges, tickets }, "expired auth artifacts removed");
    }
  } catch (error) {
    app.log.warn({ err: error }, "auth artifact cleanup failed");
  }
}, 600_000);
authCleanupTimer.unref();

app.addHook("onClose", async () => {
  clearInterval(presenceTimer);
  clearInterval(authCleanupTimer);
  clearInterval(approvalTimer);
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, "failed to start server");
  database.close();
  lock.release();
  process.exit(1);
}

app.log.info(
  { host: config.host, port: config.port, database: database.path },
  "agent-room listening",
);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
  } finally {
    database.close();
    lock.release();
  }
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
