# 实施记录

## M0：仓库调查与基线冻结

- 状态：**完成**
- 日期：2026-11-22
- 执行：DSH agent（lead）

### 做了什么

1. 完整检查旧仓库 `/data/work/dsh-room-bridge`：9 个提交、5 个补丁（0001–0005）、插件 6 个 JS 文件、4 个 Go 源文件、全部文档。
2. 在上游基线 `3cac309` 上应用全部补丁并编译，确认补丁可干净 `git am`、产物与仓库 `server/src` 逐字节一致。
3. 对插件做 `node --check`，核对 DSH 0.2.2-rc.5 的 Cordis 服务与事件依赖。
4. 确认目标 Mini PC：Ubuntu 26.04.1、x86_64、4 核 J3710、3.4 GiB 内存无 swap、ext4 SSD、Node v26.13.1、pnpm 10.34.9、systemd、cloudflared 2026.11.1。
5. 实测 `better-sqlite3` 13.2.0 在 Node 26（ABI 147）上使用预编译二进制安装并开启 WAL，SQLite 3.54.1。
6. 盘点旧 API（27 条路由）、protocol 类型、事件类型（35 种）、Agent/Daemon/Task/Thread 生命周期。
7. 统计旧 `state.json`：1 user、2 channels、2 agents、17 daemons、61 messages、3 tasks、6 lanes、120 events、283,512 B。
8. 整理文档不一致：补丁数量（“两个” vs 5）、端口（8791 vs 代码默认 8787）、已放弃的 TODO。
9. 建立迁移映射表与切换/回滚方案。

### 证据

```text
$ git -C /data/work/dsh-room-bridge log --oneline | head -1
93f3cdc docs: record the two agreed follow-ups (not implemented)

$ cd /tmp/oar-m0 && git checkout 3cac309 && git am server/patches/*.patch
AM OK

$ go build ./... && go build ./cmd/server ./cmd/daemon
BUILD OK
open-agent-room 11.0 MB / agent-room-daemon 6.6 MB

$ cmp server/src/{...} 与打补丁后的上游文件
SAME  cmd/server/main.go
SAME  cmd/daemon/main.go
SAME  internal/protocol/protocol.go
SAME  internal/store/store.go

$ for f in plugin/lib/*.js plugin/scripts/*.mjs; do node --check "$f"; done
6 个文件全部 OK

$ better-sqlite3 安装与运行
version 13.2.0 / engines node >=22
added 2 packages in 3s
OK {"c":1} sqlite 3.54.1
```

### 交付物

- `docs/PLAN.md` — 新版计划（77,443 B，sha256 `490adce5…`）入仓
- `docs/INVENTORY.md` — 模块 / 接口 / 数据结构 / 环境 / 风险
- `docs/MIGRATION.md` — 旧 → 新映射、导入器、切换与回滚
- `README.md`、`AGENTS.md`、`.gitignore`

### 决策记录

| 决策 | 说明 |
|---|---|
| Dev Auth Provider / Access JWT | M3 先 Dev Auth，再接 Cloudflare Access；M1/M2 无 HTTP API，尚未接入 |
| DSH 插件作为“DSH 连接服务端”的方案 | 用户确认；现有插件库中的 `@local/dsh-room-bridge` 作为移植基础 |
| Codex 暂不处理 | 用户确认；M7 延后，后续单独开发 Codex 插件 |
| 第一版 SQLite + 原生部署 | 新版计划冻结；本机实测可用，无需 Docker/PG |
| 仓库改名 `agent-room.git` | 用户确认；HEAD 仍为初始提交 `50fa012` |

### 遗留问题

1. ~~Cloudflare Access 的域名与 hostname~~ → 已定：`chat.*`（2026-11-22）。
2. ~~旧数据是否导入~~ → 已定：**不导入**，空库启动。
3. 本机内存 3.4 GiB 无 swap，M8 前端构建与并发测试需控制并发度。

## M1：工程骨架与 SQLite 基础

- 状态：**完成**
- 日期：2026-11-22
- 执行：DSH agent（lead）

### 做了什么

1. pnpm workspace：`apps/server`、`packages/config`、`packages/database`；根脚本 `build` / `typecheck` / `lint` / `format` / `test` / `dev` / `db:init` / `db:generate`。
2. `@room/config`：zod schema + 默认值（`127.0.0.1:8787`、`./data/room.db`），环境变量是唯一配置源；非法值抛出带字段名的 `ConfigError`。
3. `@room/database`：`better-sqlite3` + Drizzle SQLite；打开时设置 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=FULL`；Drizzle migration `0000_modern_synch`；单实例锁（`*.lock` pid 文件、死进程自动回收、0600、退出时释放）。
4. `apps/server`：Fastify 5 + `@fastify/websocket` 11；`/healthz`、`/readyz`、`/ws`（hello / ping→pong / 错误码）；结构化 404 与 500；logger 带 redact；SIGINT/SIGTERM 优雅关闭数据库与锁。
5. 原生部署：`deployment/systemd/agentroom.service`、`config/agentroom.env.example`、`scripts/start.sh`、`scripts/init-db.sh`；CI 跑 lint/typecheck/test/build 并验证原生模块。
6. SQLite 约束：同步 API 只做短事务（M2 起由 service 层保证）；`data/`、`*.db*` 不提交。

### 证据

```text
$ pnpm install --frozen-lockfile
Done in 1.4s using pnpm v10.34.9

$ pnpm typecheck  → 3 packages Done, exit 0
$ pnpm lint       → exit 0
$ pnpm test       → 5 files / 18 tests passed
$ pnpm build      → 3 packages Done, exit 0

$ DATABASE_PATH=/tmp/agent-room-e2e/room.db pnpm db:init
{
  "database": "/tmp/agent-room-e2e/room.db",
  "pragmas": { "journalMode": "wal", "foreignKeys": 1, "busyTimeout": 5000, "synchronous": 2 },
  "systemMetaTable": true
}

$ node apps/server/dist/main.js        # 未设置 HOST/PORT
{"host":"127.0.0.1","port":8787,"msg":"agent-room listening"}
$ ss -ltnp | grep 8787
LISTEN 0 511 127.0.0.1:8787 0.0.0.0:* users:(("node-MainThread",pid=52167,fd=24))
$ curl /healthz → {"status":"ok"} 200
$ curl /readyz  → {"status":"ready","database":"ok"} 200

$ 第二实例（同一 DATABASE_PATH）
exit=1
[agent-room] database is already locked by process 52167 (/tmp/agent-room-e2e/room.db.lock)

$ SIGTERM → exit=0，room.db.lock 已删除
$ 停库写入 e2e 行 → 重启 → 读回 [ { key: 'e2e', value: 'persisted' } ]，readyz 200
```

### 决策记录

| 决策 | 说明 |
|---|---|
| 工作区包 `types` 指向 `src/index.ts` | 避免 typecheck 依赖先 build；运行时仍走 `dist/` |
| `pnpm.onlyBuiltDependencies` 允许 `better-sqlite3`、`esbuild` | pnpm 10 默认拦截安装脚本；已实测原生绑定可用 |
| 单实例锁用 pid 文件而非 flock | 无原生依赖；死进程锁可自动回收；pid 复用属于已知理论风险 |
| 冷启动约 3 秒 | Node 加载原生模块 + 迁移；M2 起观察是否可接受 |

### M1 评审修复（2026-11-22）

ChatGPT 审查指出一个高优先级问题：旧 pid 锁在回收“过期锁”时先读 pid、再删除文件，两个启动进程可能同时判断锁已过期，A 删除旧锁并创建新锁后，B 又删掉 A 的新锁，双方都认为自己持有锁。已修复：

- 锁改为独立 SQLite 锁库 `room.db.lockdb`，进程用 `BEGIN IMMEDIATE` 持有至退出；获取与竞争由 SQLite / OS 文件锁保证原子性，进程死亡由内核释放，**不再存在删除过期锁的步骤**。
- 第二实例得到 `SQLITE_BUSY`，转成 `InstanceLockError` 并退出 1；pid 写在未提交事务内，供诊断。
- 锁库与 `-journal` 进入 `.gitignore`；`main.ts`、`init.ts` 的锁路径同步为 `*.lockdb`。

并发与崩溃验证：

```text
# 3 个独立子进程同时抢锁
ACQUIRED ×1，LOCKED ×2（vitest: lets exactly one of several concurrent starters win）

# 真实 server 双实例同时启动
alive: A=no B=yes
[agent-room] another agent-room instance is already running (lock database /tmp/room-lock-e2e/room.db.lockdb)

# SIGKILL 持有者后立即重启
kill -9 <winner> → 端口释放
node apps/server/dist/main.js → agent-room listening
curl /readyz → {"status":"ready","database":"ok"} 200
SIGTERM → exit 0
```

第二个问题（低）：`docs/PLAN.md` 执行表已同步，M0 记为 `4d12d79`、M1 记为 `1ab5092`。

### M1 遗留

- `/ws` 目前只有 hello / ping / 错误处理，业务协议在 M2/M5 填充。
- 没有认证（M1/M2 无 HTTP API；Dev Auth Provider 在 M3 引入，随后接 Cloudflare Access）。
- 生产库路径与 systemd 单元尚未在 Mini PC 上实际安装（M9 做安装/回滚演练）。

### 下一步（M2）

- Users / groups / memberships / agents / agent keys 的 schema 与 service
- Messages、Threads、Tasks / Task Runs、Events / Outbox、Audit logs
- 权限规则（Dev Auth Provider 原计划在 M2，按 M0 决策调整到 M3 先实现）；事务内不发起 AI/网络调用

### M2：数据库与 Room Core（2026-11-22）

按 `docs/PLAN.md` M2 实现服务层；数据库设计、ERD、索引与查询计划见 `docs/DATABASE.md`。

实现范围：

- `packages/protocol`：统一 ID（`前缀_UUIDv4`）、UTC 时间工具、RBAC / 群组 AI 策略 / 消息 / 事件 zod schema、事件类型枚举。
- `packages/database`：13 张业务表 + `system_meta`，迁移 `0001_lowly_speedball.sql`、`0002_glossy_vulcan.sql`；共 30 个显式索引。
- `apps/server/src/modules`：`users` / `groups` / `agents` / `messages` / `threads` / `tasks` / `events` / `audit` 服务，以及权限层（成员校验、群管理员、最后 owner 保护）。
- 事务性 Outbox：消息、事件、Agent 投递同事务提交；`events.seq` 自增作为增量游标；`agent_deliveries(agent_id, event_id)` 唯一。
- 任务链路：`queued → assigned → running → succeeded/failed`；`createTaskFromMessage` 同事务建 Thread + Task；完成时把 `task_summary` 系统消息写回父 Group。

验证证据：

```text
Test Files  6 passed (6)
Tests       27 passed (27)   # 新增 9 个 Room Core 用例

messages pagination: SEARCH messages USING INDEX messages_group_seq_uq (group_id=? AND seq>?)
membership lookup: SEARCH group_members USING INDEX group_members_member_uq (...)
tasks by group: SEARCH tasks USING INDEX tasks_group_idx (group_id=?)
pending deliveries: SEARCH agent_deliveries USING INDEX agent_deliveries_pending_idx (agent_id=? AND status=?)
```

覆盖的验收点：

| 验收点 | 测试 |
|---|---|
| 多用户、多独立群组 | `keeps groups isolated` |
| 非成员不能读群消息 | `keeps groups isolated` |
| Agent 不能访问未加入群组 | `rejects agents that are not members` |
| Message/Thread/Task 外键一致 | `creates a thread and a task from one message` |
| 一条消息创建 Thread/Task | 同上 |
| 完成任务摘要写回父 Group | `writes the task completion summary back` |
| 业务 + 事件 + 投递同事务 | `commits message, event and agent deliveries together` |
| 事务内无 AI/网络/等待 | 代码检查 + 事务边界表（docs/DATABASE.md §6） |
| 重启后消息与 Task 恢复 | `keeps data across a close/reopen cycle` |
| 分页 + 索引、无全表扫描 | `paginates large message sets`（含 EXPLAIN QUERY PLAN 断言） |

已知取舍：

- `group_members.member_id` 是多态列，没有单一外键；成员存在性由服务层强校验，唯一索引防重复。
- `threads.source_message_id` 因与 `messages.thread_id` 成环，不建硬外键；服务层校验同群。
- Agent 投递当前是 `pending → delivered → acked` 的状态机，真正的长连接推送在 M5。

提交：`cba3ce5`；`docs/PLAN.md` 执行表已同步。

### M2 遗留

- 尚未有 HTTP/WS API 层（M2 只做服务层与权限规则）；Dev Auth Provider 在 M3 接 Access 前补齐。
- 消息风控（`maxRepliesPerRoot`、`maxAgentMessagesPerMinute`）已存配置，尚未在发送路径强制执行。
- `listTasks` 的 keyset 游标按 `(created_at, id)`；任务量极大时再接 `EXPLAIN` 回归。

### M2 Review Fix（2026-11-22）

按评审（ChatGPT 静态审查）补齐 M2 的权限边界、状态一致性与测试覆盖；未提前实现 M3/M4/M5。

修复：

- **P1 全局 readonly**：新增 `requireWriteUser` / `requireWritableActor`；`postMessage`、`createThread`、`createTaskFromMessage`、`createGroup`、`closeThread`、`addMember`、`removeMember`、`updateGroupAISettings`、`assignTask` 全部拒绝 readonly 用户。readonly 的群管理员也不能管理群组。
- **P1 disabled 身份**：`requireGroupMember` 先 `requireActor`，读接口（`listMessages` / `getMessage` / `getThread` / `listThreads` / `listGroupMembers` / `getTask` / `listTasks`）统一拒绝 disabled 用户 / Agent。
- **P1 Owner/Admin 分级**：`createUser` 增加 `actorUserId`（首个用户是 bootstrap owner）；只有 owner 能创建 / 提升 owner 与 admin、能禁用 owner/admin；last-owner 保护保留。
- **P1 `requireGroupManager` 顺序**：系统 owner/admin 直接放行（可管理非成员群组），普通用户才校验群内 owner/admin。
- **P2 Agent 群角色**：Agent 只能以 `member` 加入群组，`admin`/`owner` 抛 `ValidationError`。
- **P2 External Identity 事务**：`external_identities` + `events(identity.linked)` + `audit_logs` 同事务。
- **P2 Task 幂等**：`tasks.idempotency_key` + `unique(group_id, idempotency_key)`（迁移 `0003_closed_newton_destine.sql`）；重复请求返回原 Task / Thread。
- **P2 Delivery 状态机**：`pending → delivered → acked`、`pending|delivered → failed`、`delivered → pending`（requeue）；非法转换抛 `ConflictError`，ack/fail 幂等；新增 `listOutstandingDeliveries` 覆盖“已送达未 ack”。
- **P3 文档**：README 更新到 M2；`docs/DATABASE.md` 增投递状态机与已知偏差。

测试从 27 增至 43（新增 `apps/server/test/permissions.test.ts` 16 例）：

```text
Test Files  7 passed (7)
Tests       43 passed (43)
```

| 评审项 | 结果 | 测试 |
|---|---|---|
| Readonly 全局生效 | PASS | `rejects message, thread, task and group writes from readonly users` / `rejects group management by a readonly group admin` |
| Disabled 用户/Agent | PASS | `rejects reads from a disabled user` / `rejects reads and writes from a disabled agent` / `rejects group management by a disabled group admin` |
| System Admin 管非成员群组 | PASS | `lets a system admin manage a group they are not a member of` |
| Owner / Admin 分级 | PASS | `only the owner can grant admin or owner roles` / `only the owner can disable an admin` |
| Last owner 保护 | PASS | `protects the last active owner from demotion and disabling` |
| Agent 群角色 | PASS | `refuses to grant agents owner or admin roles` |
| External Identity 事务 | PASS | `commits the external identity, event and audit row atomically` |
| Task 请求幂等 | PASS | `returns the original task for a repeated idempotency key` |
| Delivery 状态机 | PASS | `enforces the pending -> delivered -> acked transition and requeue` |
| 归档群组只读 | PASS | `blocks writes to an archived group` |
| 成员生命周期 | PASS | `rejects duplicate memberships and removing the last group owner` |

全量校验：`lint` / `typecheck` / `format:check` / `test`（43）/ `build` 全过。提交：`b79a580`。

### M2 Review Fix 2（2026-11-23）

按第二轮静态审查（`m02580` 执行计划）封堵 Thread/Task 创建、归档群组写入与关闭 Thread 的边界；未提前实现 M3/M4。

修复：

- **阶段一：Thread/Task 创建权限**：`createThread` 与 `createTaskFromMessage` 统一按 `requireWriteUser → requireGroupMember → requireActiveGroup` 顺序校验；两者此前缺成员校验。Task 的幂等键查询移到权限校验之后，非成员用已存在的幂等键只会得到 `ForbiddenError`，拿不到 Task/Thread 信息。
- **阶段二：归档群组统一只读**：`postMessage`、`addMember`、`removeMember`、`updateGroupAISettings`、`createThread`、`closeThread`、`createTaskFromMessage`、`assignTask`、`startTask`、`completeTask` 全部走 `requireActiveGroup`。没有例外：归档后已完成/运行中的 Task 也不能再 start/complete，只能读取。
- **阶段三：关闭 Thread**：`postMessage` 指定 `threadId` 时校验 `thread.groupId` 与 `thread.status === "open"`；已关闭返回 `ConflictError`。普通群消息与开放 Thread 不受影响。
- **阶段四：回归测试**：`apps/server/test/permissions.test.ts` 新增 4 例——非成员建 Thread/Task、非成员用幂等键、归档群组全部写入入口且事件/投递/审计计数不变、关闭 Thread 拒消息。总数 43 → 47。

```text
$ pnpm lint        # exit 0
$ pnpm typecheck   # exit 0
$ pnpm format:check# All matched files use Prettier code style!
$ pnpm test        # Test Files 7 passed (7) / Tests 47 passed (47)
$ pnpm build       # packages/protocol, packages/database, apps/server build Done
```

遗留（不阻塞 M2，已按计划阶段记录）：

- `allowAgentMessages`、`maxRepliesPerRoot`、`maxAgentMessagesPerMinute` 目前只存储、发送路径未执行；属于 M4 群聊能力的风控，计划在 M4 实现并补测试。
- Dev Auth Provider 尚未实现：M1/M2 只有服务层，没有 HTTP/WS API，因此没有可接入的认证入口；M3 先实现 Dev Auth Provider，再接 Cloudflare Access JWT。`AGENTS.md` 与本记录已按此对齐，不把未实现项记为完成。
- 已知 P3 偏差（事件 payload 通用 schema、状态枚举无 DB CHECK、`group_members` 多态无单 FK、`threads.source_message_id` 无硬 FK）保持不变，已在 `docs/DATABASE.md` §7 记录。

结论：建议将 M2 Review Fix 标记为完成（47 tests，五项检查全过）；M4 风控与 M3 认证按计划后续实现。

提交：`7ce6437`（代码 + 测试 + 文档），已推 `agent-room.git` main。

### M3：身份认证与 Agent SDK（2026-11-23）

按 `docs/PLAN.md` M3 实现人类认证、Agent 密钥与 Challenge/Response、WSS 会话、在线租约与 durable inbox/ack；
群组/消息的 HTTP API 仍留给 M4。

实现范围：

- `packages/protocol/src/agent.ts`：协议版本、Challenge 规范签名串（`buildAgentChallengeString`）、challenge/connect 与
  WSS 帧的 zod schema；`fingerprint.ts` 统一 `sha256(SPKI DER)`；ID 前缀增 `chl` / `ses`；事件类型增 `agent.status.changed`。
- `packages/config`：`AUTH_MODE=dev|access`（生产强制 access）、`ACCESS_TEAM_DOMAIN`/`ACCESS_AUDIENCE`、
  `BOOTSTRAP_OWNER_EMAIL`、Agent 会话/Challenge/Lease/Heartbeat TTL。
- `packages/database`：`agent_challenges`（nonce 唯一、`used_at`、过期索引）与 `agent_sessions`
  （`token_hash` 唯一、`last_seen_at`、`closed_at`、按 Agent 与过期索引）；迁移 `0004_fat_nicolaos.sql`。
- `apps/server/src/auth`：`dev`（`x-dev-user-id` / `x-dev-user-email`，只认已登记用户）、`access`（jose 校验 JWT，
  未映射邮箱按用户邮箱自动 link）、`bootstrap`（用户表为空时按 `BOOTSTRAP_OWNER_EMAIL` 建一次 Owner）、
  `onRequest` Principal 解析（仅保护 `/api/v1/*`，健康探针与旧 `/ws` 保持公开）。
- `apps/server/src/modules/agentAuth.ts`：一次性 challenge（`UPDATE ... WHERE used_at IS NULL` 原子消费）、
  Ed25519 验签、session token（只存 SHA-256）、在线租约与静默 session 清扫、按 key 吊销并返回受影响 Agent。
- `apps/server/src/routes`：`/api/v1/me`、`/api/v1/users`、`/api/v1/agents`（注册时同事务写 agent + key + 事件 + 审计）、
  key 追加/吊销；`/api/v1/agent/challenge`、`/api/v1/agent/connect` 与已认证 WSS；WSS 每秒扫描投递，
  `pending → delivered → acked`，重连后未 ack 的事件再投递，Agent 按 `deliveryId` 去重。
- `apps/server/src/modules/agentHub.ts`：在线 socket 注册表；吊销 key / 租约超时先发 `error session_closed` 再断开。
- `packages/agent-sdk`：`AgentClient`（Challenge → 签名 → connect → WSS → 自动 ack / 心跳）与 `scripts/mock-agent.ts`
  手工联调脚本；SDK 单测覆盖指纹与签名串。
- `main.ts`：启动时 bootstrap Owner、每 10s 清扫过期在线租约；进程退出关闭定时器。

验收对照（`pnpm test`，10 个测试文件 / 67 tests）：

| 验收项 | 覆盖 |
| --- | --- |
| 未登录不能访问 | `requires a provisioned, active user for admin routes`（401） |
| Member 不能执行 Admin 操作 | `only owners and admins can register agents`（403） |
| 未登记公钥不能连接 | `never derives identity from an unregistered fingerprint or a forged agentId` |
| 不能伪造 Agent ID | 同上（challenge 的 `agentId` 只作提示，不一致即 401） |
| Challenge 重放失败 | `connects with a valid signature and refuses to reuse the challenge` |
| 吊销后连接失效 | `revokes a key, disconnects the live socket and refuses new connects` |
| 重连补齐未 ack 事件 | `delivers, acks, and redelivers an unacked event after reconnect` |
| 重复事件不重复执行 | ack 后 `deliveries` 为 `acked`，重连时不再投递（同一测试断言） |

手动端到端（临时库 `/tmp/agentroom-m3`，`AUTH_MODE=dev` + `BOOTSTRAP_OWNER_EMAIL`）：

```text
healthz=200 readyz=200 me_noauth=401
GET /api/v1/me (x-dev-user-email) → role=owner, serverId=srv_8facf294…
POST /api/v1/agents → 201 fingerprint=1167588bbee70e92…
POST /api/v1/agent/challenge → 200; 签名 connect → 200 agt_6965879991d54d56846e1e9f388a1d1c
WS connect → hello（outstanding=0）
SIGTERM → 正常退出
```

全量检查：`lint` / `typecheck` / `format:check` / `test`（67）/ `build` 全过。

已知偏差：

- WSS 采用“HTTP challenge → HTTP connect → 带 token 升级”的握手；签名串与一次性消费语义不变，后续可在 WSS 内完成握手。
- 群组/消息 HTTP API 在 M4；mock Agent 目前只能验证连接与事件接收，不能主动拉取群消息。
- Agent 连接本身不逐条审计（状态变化写 `agent.status.changed` 事件）；会话 token 暂不轮换。

提交：`d34d271`（实现 + 测试 + 文档），已推 `agent-room.git` main。

### M3 Review Fix（2026-11-23）

按 `m02941` 的六阶段计划处理 M3 的身份、WSS 与 SDK 缺口；没有把未实现项写成完成。

| 阶段 | 修复 | 涉及文件 | 测试 |
| --- | --- | --- | --- |
| 1. Agent 发言 | `message.send` 默认拒绝（`AGENT_MESSAGES_ENABLED=false`，生产禁止开启），返回 `agent_messages_disabled`，不写 message/event/delivery；不依赖客户端隐藏 `sendMessage` | `packages/config`、`apps/server/src/routes/agent.ts` | `refuses agent group messages while the M4 participation limits are missing`（计数不变） |
| 2. SDK ack | `onEvent(event,{deliveryId,attempt})`；无 handler 不 ack、handler 抛错不 ack；`attempt` 随 socket 生命周期递增；收到 `ack.ok` 后删除对应计数，Map 不随已确认事件增长；文档写明至少一次，不承诺去重 | `packages/agent-sdk/src/index.ts` | `delivery.test.ts` 6 例 |
| 3. 升级凭据 | 新增 `agent_socket_tickets` + `POST /api/v1/agent/socket-ticket`；WS 只接受 Bearer session token 或一次性 `?ticket=`，`?token=` 直接 401；票据原子消费；日志 serializer 去掉 query string | `packages/database`（迁移 `0005_rapid_riptide.sql`）、`apps/server/src/routes/agent.ts`、`apps/server/src/app.ts` | `refuses the session token in the websocket URL and reuse of a ticket`、`logging.test.ts` |
| 4. Session TTL | 活跃连接到期由定时器 + 每帧校验关闭（`session_expired`、close 1008、关闭数据库 session、无其他活跃 socket 置 offline） | `apps/server/src/routes/agent.ts`、`modules/agentAuth.ts` | `closes a live socket when the session TTL elapses and refuses reconnection` |
| 5. Challenge | 每个 key 最多 5 个活跃 challenge（超出 429 `rate_limited`）；每 10 分钟清理已消费/过期 challenge 与 ticket | `modules/agentAuth.ts`、`apps/server/src/main.ts`、`errors.ts` | `auth-limits.test.ts` 3 例 |
| 6. 邮箱唯一 | `normalizeEmail`（trim+lower）；`users_email_lower_uq` 唯一索引（`lower(email)`）；迁移前 `assertNoDuplicateUserEmails` 明确报错；Access 映射无歧义 | `modules/users.ts`、`packages/database`（迁移 0005、`db.ts`） | `users-email.test.ts` 2 例 |

附带修复：迁移失败时关闭 SQLite 句柄（此前会导致测试进程 segfault）；`createTestRoom` 支持注入时钟。

验证（2026-11-23 实际执行，全部 exit 0）：

```text
pnpm lint        # exit 0
pnpm typecheck   # exit 0
pnpm format:check# All matched files use Prettier code style!
pnpm test        # Test Files 14 passed (14) / Tests 83 passed (83)
pnpm build       # packages/protocol, packages/database, apps/server build Done
```

文档同步：`docs/AUTH.md` §4（ticket/TTL）、§6（新端点）、§8（本轮修复与重新开放条件）；
`docs/DATABASE.md` §3/§4（新表、40 个索引）、§6.1（TTL/ticket/邮箱）、§7；
`README.md` 与 `config/agentroom.env.example` 增加 `AGENT_MESSAGES_ENABLED`、`AGENT_SOCKET_TICKET_TTL_MS`。

状态与剩余风险：

- **Agent 发言在 M3 不开放**。重新开放的前提：M4 在服务端原子执行 `allowAgentMessages`、`maxHops`、`maxRepliesPerRoot`、`maxAgentMessagesPerMinute` 并递增 `hop`，补超限与循环停止测试；`AGENT_MESSAGES_ENABLED` 只作为受控开关，生产禁止开启。
- Session token 固定 TTL、无主动轮换；ticket 默认 60s、单次消费。
- 握手仍是 HTTP challenge/connect → 带 ticket 升级，未在 WSS 内完成 challenge。
- 邮箱唯一性依赖迁移前检查：含重复邮箱的旧库会启动失败并给出重复地址，需要人工去重后重跑。
- 应用日志已剥离 query string；部署侧（Cloudflare/代理）仍需保证不记录升级 URL。

评审补充（2026-11-23）：`ack.ok` 到达后删除 `deliveryAttempts` 中对应 `deliveryId`，避免长时间运行的无界增长；新增 `clears attempt tracking once the server confirms the ack`。

提交：`de8ef4d`（实现 + 测试 + 文档）、`f54de8b`（`ack.ok` 清理计数），已推 `agent-room.git` main。
