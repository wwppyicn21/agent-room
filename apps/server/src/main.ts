import { fileURLToPath } from "node:url";
import { loadConfig } from "@room/config";
import { acquireInstanceLock, InstanceLockError, openDatabase } from "@room/database";
import { buildApp } from "./app.js";

const config = loadConfig();
const lockPath = `${config.databasePath}.lock`;

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
