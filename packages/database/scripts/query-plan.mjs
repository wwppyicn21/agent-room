// Prints EXPLAIN QUERY PLAN for the hot Room Core queries (see docs/DATABASE.md).
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-room-qp-"));
const db = new Database(join(dir, "qp.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
const drizzleDir = new URL("../drizzle/", import.meta.url);
for (const file of readdirSync(drizzleDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  const full = new URL(file, drizzleDir);
  for (const chunk of readFileSync(full, "utf8").split("--> statement-breakpoint")) {
    const statement = chunk.trim();
    if (statement) db.exec(statement);
  }
}

const queries = [
  [
    "messages pagination",
    "SELECT * FROM messages WHERE group_id = ? AND seq > ? AND deleted_at IS NULL ORDER BY seq LIMIT 50",
    ["x", 0],
  ],
  [
    "membership lookup",
    "SELECT * FROM group_members WHERE group_id = ? AND member_type = ? AND member_id = ?",
    ["x", "user", "y"],
  ],
  ["group member list", "SELECT * FROM group_members WHERE group_id = ?", ["x"]],
  [
    "tasks by group",
    "SELECT * FROM tasks WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
    ["x"],
  ],
  [
    "pending deliveries",
    "SELECT * FROM agent_deliveries WHERE agent_id = ? AND status = 'pending' ORDER BY created_at LIMIT 50",
    ["x"],
  ],
  [
    "events by group",
    "SELECT * FROM events WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT 50",
    ["x", 0],
  ],
  [
    "message idempotency",
    "SELECT * FROM messages WHERE group_id = ? AND client_message_id = ?",
    ["x", "y"],
  ],
];

for (const [name, query, params] of queries) {
  const rows = db.prepare("EXPLAIN QUERY PLAN " + query).all(...params);
  console.log(`${name}: ${rows.map((row) => row.detail).join(" | ")}`);
}
const indexes = db
  .prepare(
    "SELECT count(*) AS c FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
  )
  .get().c;
console.log(`explicit indexes: ${indexes}`);
