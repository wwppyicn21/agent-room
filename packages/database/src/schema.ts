import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * M1 key/value table kept for smoke tests and runtime metadata.
 */
export const systemMeta = sqliteTable("system_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// ---------------------------------------------------------------------------
// Identity: users, external identities, roles
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    role: text("role", { enum: ["owner", "admin", "member", "readonly"] })
      .notNull()
      .default("member"),
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("users_role_idx").on(table.role), index("users_status_idx").on(table.status)],
);

export const externalIdentities = sqliteTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    email: text("email"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("external_identities_issuer_subject_uq").on(table.issuer, table.subject),
    index("external_identities_user_idx").on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// Groups and members
// ---------------------------------------------------------------------------

export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    participationMode: text("participation_mode", { enum: ["all", "mention", "disabled"] })
      .notNull()
      .default("all"),
    allowAgentMessages: integer("allow_agent_messages", { mode: "boolean" })
      .notNull()
      .default(true),
    maxHops: integer("max_hops").notNull().default(4),
    maxRepliesPerRoot: integer("max_replies_per_root").notNull().default(20),
    maxAgentMessagesPerMinute: integer("max_agent_messages_per_minute").notNull().default(10),
    maxTokensPerRoot: integer("max_tokens_per_root"),
    systemPrompt: text("system_prompt"),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("groups_status_idx").on(table.status),
    index("groups_created_by_idx").on(table.createdByUserId),
  ],
);

export const groupMembers = sqliteTable(
  "group_members",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    memberType: text("member_type", { enum: ["user", "agent"] }).notNull(),
    memberId: text("member_id").notNull(),
    memberRole: text("member_role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
    joinedAt: integer("joined_at").notNull(),
  },
  (table) => [
    uniqueIndex("group_members_member_uq").on(table.groupId, table.memberType, table.memberId),
    index("group_members_lookup_idx").on(table.memberType, table.memberId),
    index("group_members_group_idx").on(table.groupId, table.joinedAt),
  ],
);

// ---------------------------------------------------------------------------
// Agents and keys
// ---------------------------------------------------------------------------

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    hostId: text("host_id"),
    runtime: text("runtime").notNull(),
    model: text("model"),
    capabilities: text("capabilities").notNull().default("[]"),
    status: text("status", { enum: ["online", "offline", "disabled"] })
      .notNull()
      .default("offline"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("agents_status_idx").on(table.status)],
);

export const agentKeys = sqliteTable(
  "agent_keys",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    algorithm: text("algorithm").notNull().default("ed25519"),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("agent_keys_fingerprint_uq").on(table.fingerprint),
    index("agent_keys_agent_idx").on(table.agentId),
  ],
);

// ---------------------------------------------------------------------------
// Threads, messages
// ---------------------------------------------------------------------------

/**
 * `source_message_id` cannot be a hard FK: threads.source_message_id and
 * messages.thread_id would form a cycle. The service layer verifies that the
 * source message exists and belongs to the same group; the UNIQUE group/seq
 * indexes keep the relation consistent.
 */
export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    sourceMessageId: text("source_message_id").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (table) => [
    index("threads_group_idx").on(table.groupId, table.createdAt),
    index("threads_source_message_idx").on(table.sourceMessageId),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, { onDelete: "set null" }),
    senderType: text("sender_type", { enum: ["user", "agent", "system"] }).notNull(),
    senderId: text("sender_id").notNull(),
    content: text("content").notNull(),
    rootMessageId: text("root_message_id").references((): AnySQLiteColumn => messages.id, {
      onDelete: "set null",
    }),
    replyToMessageId: text("reply_to_message_id").references((): AnySQLiteColumn => messages.id, {
      onDelete: "set null",
    }),
    hop: integer("hop").notNull().default(0),
    clientMessageId: text("client_message_id"),
    seq: integer("seq").notNull(),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("messages_group_seq_uq").on(table.groupId, table.seq),
    uniqueIndex("messages_group_client_uq").on(table.groupId, table.clientMessageId),
    index("messages_thread_seq_idx").on(table.threadId, table.seq),
    index("messages_group_created_idx").on(table.groupId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Tasks and runs
// ---------------------------------------------------------------------------

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, { onDelete: "set null" }),
    sourceMessageId: text("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", {
      enum: [
        "queued",
        "assigned",
        "running",
        "waiting_approval",
        "paused",
        "succeeded",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("queued"),
    priority: integer("priority").notNull().default(0),
    assignedAgentId: text("assigned_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    index("tasks_group_idx").on(table.groupId, table.createdAt, table.id),
    index("tasks_status_idx").on(table.status),
    index("tasks_thread_idx").on(table.threadId),
    index("tasks_assignee_idx").on(table.assignedAgentId),
  ],
);

export const taskRuns = sqliteTable(
  "task_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "succeeded", "failed", "cancelled"] })
      .notNull()
      .default("running"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    summary: text("summary"),
    error: text("error"),
  },
  (table) => [index("task_runs_task_idx").on(table.taskId, table.startedAt)],
);

// ---------------------------------------------------------------------------
// Events, deliveries, audit
// ---------------------------------------------------------------------------

export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    type: text("type").notNull(),
    groupId: text("group_id"),
    threadId: text("thread_id"),
    taskId: text("task_id"),
    actorType: text("actor_type", { enum: ["user", "agent", "system"] }).notNull(),
    actorId: text("actor_id").notNull(),
    payload: text("payload").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("events_group_seq_idx").on(table.groupId, table.seq),
    index("events_type_created_idx").on(table.type, table.createdAt),
  ],
);

export const agentDeliveries = sqliteTable(
  "agent_deliveries",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "delivered", "acked", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
    ackedAt: integer("acked_at"),
  },
  (table) => [
    uniqueIndex("agent_deliveries_event_uq").on(table.agentId, table.eventId),
    index("agent_deliveries_pending_idx").on(table.agentId, table.status, table.createdAt),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type", { enum: ["user", "agent", "system"] }).notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("audit_logs_created_idx").on(table.createdAt),
    index("audit_logs_actor_idx").on(table.actorType, table.actorId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type ExternalIdentityRow = typeof externalIdentities.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type GroupMemberRow = typeof groupMembers.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type AgentKeyRow = typeof agentKeys.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskRunRow = typeof taskRuns.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type AgentDeliveryRow = typeof agentDeliveries.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
