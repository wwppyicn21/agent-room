import { fileURLToPath } from "node:url";
import { loadConfig } from "@room/config";
import { openDatabase, readPragmas } from "./db.js";
import { acquireInstanceLock } from "./lock.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));

const config = loadConfig();
const lockPath = `${config.databasePath}.lockdb`;
const lock = acquireInstanceLock(lockPath);

try {
  const database = openDatabase({ path: config.databasePath, migrationsFolder });
  try {
    const table = database.sqlite
      .prepare("select count(*) as n from sqlite_master where type = 'table' and name = ?")
      .get("system_meta") as { n: number };

    console.log(
      JSON.stringify(
        {
          database: database.path,
          pragmas: readPragmas(database.sqlite),
          systemMetaTable: table.n === 1,
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
  }
} finally {
  lock.release();
}
