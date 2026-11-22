import { fileURLToPath } from "node:url";

export * from "./schema.js";
export * from "./db.js";
export * from "./lock.js";

/** Absolute path to the Drizzle migrations shipped with this package. */
export const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));
