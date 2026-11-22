# Room Core 数据库设计（M2）

本文档记录 M2「数据库与 Room Core」的 ERD、Drizzle schema、迁移、索引与关键查询计划。实现以
`packages/database/src/schema.ts` 为准，迁移在 `packages/database/drizzle/`。

## 1. 运行时约定

| 项目     | 约定                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 引擎     | SQLite（`better-sqlite3` 13.x），Drizzle SQLite dialect                                           |
| 日志模式 | `journal_mode = WAL`                                                                              |
| 约束     | `foreign_keys = ON`                                                                               |
| 写锁等待 | `busy_timeout = 5000`                                                                             |
| 持久性   | `synchronous = FULL`                                                                              |
| 写入模型 | 单进程单写者；进程级锁库 `room.db.lockdb`（`BEGIN IMMEDIATE`）                                    |
| 事务     | 业务写入 + `events` + `agent_deliveries` + `audit_logs` 同一事务；**事务内禁止 AI/网络/用户等待** |
| ID       | `前缀_UUIDv4去掉横线`，如 `usr_9f2c…`；不可猜测、URL 安全（`@room/protocol` 的 `newId`）          |
| 时间     | DB 存 UTC 毫秒整数；API 层用 ISO 8601（`toIso`）                                                  |
| 布尔     | SQLite `0/1`（Drizzle `mode: "boolean"`）                                                         |
| JSON     | `payload` / `metadata` / `capabilities` 先经 zod 校验再序列化                                     |
| 删除     | 消息软删除（`deleted_at`）；结构性删除靠外键 `ON DELETE CASCADE`                                  |

## 2. ERD

```mermaid
erDiagram
    users ||--o{ external_identities : "links"
    users ||--o{ groups : "creates"
    groups ||--o{ group_members : "has"
    users ||--o{ group_members : "joins as user"
    agents ||--o{ group_members : "joins as agent"
    agents ||--o{ agent_keys : "owns"
    groups ||--o{ threads : "contains"
    groups ||--o{ messages : "contains"
    threads ||--o{ messages : "groups"
    threads ||--o{ tasks : "backs"
    messages ||--o{ tasks : "source of"
    tasks ||--o{ task_runs : "runs"
    agents ||--o{ tasks : "assigned to"
    groups ||--o{ events : "emits"
    events ||--o{ agent_deliveries : "fans out"
    users ||--o{ tasks : "creates"
    groups ||--o{ audit_logs : "targeted by"
```

说明：

- `group_members` 是**多态成员表**（`member_type` + `member_id`），因此 `member_id` 没有单一外键；
  成员存在性由服务层 `assertKnownMember` 校验，唯一索引保证同一群体内不重复。
- `threads.source_message_id` 与 `messages.thread_id` 互相引用会形成环，SQLite 迁移无法建表，
  所以 `source_message_id` 不建外键；服务层校验消息存在且同群。
- `events` / `audit_logs` 不挂 `groups` 外键：它们是审计事实，群体删除后仍需保留。
- `tasks.source_message_id` 在删除源消息时置空（`ON DELETE SET NULL`），任务本身保留。

## 3. 表

| 表                    | 作用                             | 关键列                                                                           |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| `system_meta`         | 运行时元数据（M1 保留）          | `key` PK                                                                         |
| `users`               | 平台用户与全局角色               | `role`（owner/admin/member/readonly）、`status`                                  |
| `external_identities` | Cloudflare Access 等外部身份映射 | `(issuer, subject)` 唯一                                                         |
| `groups`              | 群组 + AI 参与策略               | `participation_mode`、`allow_agent_messages`、`max_hops`、`max_replies_per_root` |
| `group_members`       | 群体成员（用户/Agent）           | `(group_id, member_type, member_id)` 唯一、`member_role`                         |
| `agents`              | Agent 注册表                     | `runtime`、`status`、`capabilities`(JSON)                                        |
| `agent_keys`          | Agent 公钥（Ed25519）            | `fingerprint` 唯一、`status`                                                     |
| `threads`             | 由源消息派生的讨论串             | `source_message_id`、`status`                                                    |
| `messages`            | 群消息                           | `seq`（群内单调）、`client_message_id`（幂等）、`root_message_id`、`hop`         |
| `tasks`               | 任务                             | `status`、`assigned_agent_id`、`thread_id`、`source_message_id`                  |
| `task_runs`           | 任务执行轮次                     | `status`、`summary`、`started_at`/`finished_at`                                  |
| `events`              | 事务性 Outbox 事件               | `seq` 自增、`id` 唯一、`payload`(JSON)                                           |
| `agent_deliveries`    | 每个 Agent 的投递队列            | `(agent_id, event_id)` 唯一、`status`                                            |
| `audit_logs`          | 审计                             | `actor_type/actor_id`、`action`、`target_type/target_id`                         |

## 4. 索引（30 个显式索引）

| 表                    | 索引                                                                                                         | 用途                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `users`               | `users_role_idx`、`users_status_idx`                                                                         | 管理员筛选                             |
| `external_identities` | `external_identities_issuer_subject_uq`、`external_identities_user_idx`                                      | 登录映射、按用户查                     |
| `groups`              | `groups_status_idx`、`groups_created_by_idx`                                                                 | 归档筛选、创建者                       |
| `group_members`       | `group_members_member_uq`、`group_members_lookup_idx`、`group_members_group_idx`                             | 权限判定、反查用户/Agent 所在群        |
| `agents`              | `agents_status_idx`                                                                                          | 在线/离线                              |
| `agent_keys`          | `agent_keys_fingerprint_uq`、`agent_keys_agent_idx`                                                          | 公钥查找、某 Agent 的 key              |
| `threads`             | `threads_group_idx`、`threads_source_message_idx`                                                            | 群内时间线、源消息 → Thread            |
| `messages`            | `messages_group_seq_uq`、`messages_group_client_uq`、`messages_thread_seq_idx`、`messages_group_created_idx` | 分页、幂等、Thread 时间线、按时间      |
| `tasks`               | `tasks_group_idx`、`tasks_status_idx`、`tasks_thread_idx`、`tasks_assignee_idx`                              | 群内任务分页、状态、Thread、Agent 队列 |
| `task_runs`           | `task_runs_task_idx`                                                                                         | 任务执行历史                           |
| `events`              | `events_group_seq_idx`、`events_type_created_idx`、`events_id_unique`                                        | 群内增量、类型检索、按事件 id          |
| `agent_deliveries`    | `agent_deliveries_event_uq`、`agent_deliveries_pending_idx`                                                  | 去重、待投递队列                       |
| `audit_logs`          | `audit_logs_created_idx`、`audit_logs_actor_idx`                                                             | 时间线、按操作者                       |

`tasks_group_idx (group_id, created_at, id)` 与 `agent_deliveries_pending_idx
(agent_id, status, created_at)` 把排序键并入索引，避免 keyset 分页时出现临时 B-tree。

## 5. 关键查询计划

由 `node packages/database/scripts/query-plan.mjs` 在全新迁移库上生成：

```text
messages pagination: SEARCH messages USING INDEX messages_group_seq_uq (group_id=? AND seq>?)
membership lookup: SEARCH group_members USING INDEX group_members_member_uq (group_id=? AND member_type=? AND member_id=?)
group member list: SEARCH group_members USING INDEX group_members_group_idx (group_id=?)
tasks by group: SEARCH tasks USING INDEX tasks_group_idx (group_id=?)
pending deliveries: SEARCH agent_deliveries USING INDEX agent_deliveries_pending_idx (agent_id=? AND status=?)
events by group: SEARCH events USING INDEX events_group_seq_idx (group_id=? AND seq>?)
message idempotency: SEARCH messages USING INDEX messages_group_client_uq (group_id=? AND client_message_id=?)
explicit indexes: 30
```

消息分页使用 `WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT 50`，命中
`(group_id, seq)` 唯一索引，没有全表扫描；测试 `apps/server/test/room.test.ts` 对此有断言。

## 6. 事务边界（服务层）

| 操作                         | 同一事务内写入                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `postMessage`                | `messages` + `events(message.created)` + `agent_deliveries`                                                   |
| `createGroup`                | `groups` + 群主 `group_members` + `events` + `audit_logs`                                                     |
| `addMember` / `removeMember` | `group_members` + `events` + `audit_logs`                                                                     |
| `createThread`               | `threads` + `events` + `audit_logs`                                                                           |
| `createTaskFromMessage`      | `threads` + `tasks` + `events(thread.created/task.created/task.assigned)` + `agent_deliveries` + `audit_logs` |
| `completeTask`               | `task_runs` + `tasks` + 汇总 `messages` + `events` + `agent_deliveries` + `audit_logs`                        |

所有函数都在 `ctx.db.transaction(...)` 内完成上述写入；zod 校验、权限判断失败时整个事务回滚。
事务内没有 `fetch`、模型调用或等待用户输入。

## 7. 常用命令

```bash
pnpm --filter @room/database db:generate   # schema.ts -> drizzle/000N_*.sql
pnpm --filter @room/database db:init       # 打开数据库、应用迁移、打印 pragmas
node packages/database/scripts/query-plan.mjs  # 打印上面的查询计划
```
