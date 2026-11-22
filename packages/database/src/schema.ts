import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Small key/value table used by M1 to prove SQLite read/write, migration and
 * persistence. Business tables arrive in M2.
 */
export const systemMeta = sqliteTable("system_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SystemMetaRow = typeof systemMeta.$inferSelect;
export type NewSystemMetaRow = typeof systemMeta.$inferInsert;
