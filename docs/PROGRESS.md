# 实施记录

## 当前进度总览（2026-11-27）

| 里程碑 | 状态 |
|---|---|
| M0–M5 | 完成；M5 于 2026-11-25 验收（215 tests） |
| M6 DSH Plugin | 实现与实机协议验证完成；bundle 已安装/启用，真实 Room 消息 → DSH Session → 回复链路通过；**卸载/更新实机验收未关闭** |
| M7 Codex Plugin | 未开始（用户交由 ChatGPT 开发）；服务端 Agent Room Tools HTTP 已就绪 |
| M8 React Web Client | 实现完成（2026-11-26）：登录、群组/群聊、实时消息与 presence、Thread、Task/Approval、成员/角色、Agent/Key、用户、设置、Delivery 诊断、事件历史；浏览器 E2E 9 例通过 |
| DSH 后续整改 | 完成（2026-11-27）：SQLite/配置权限、Realtime 发送失败清理、PendingTurn 超时持久化、DeliveryStore prune 提交；GitHub Actions Run `46047104203` 全绿 |
| M9 Deployment | 未开始 |

验证基线：**45 files / 307 tests**；`pnpm e2e` 9 passed；`lint` / `typecheck` / `format:check` / `build` 全部通过。

服务端前置提交：`9dae94e`（浏览器实时 WebSocket）、`783ead7`（Agent HTTP Room Tools）、
`1432b42`（Delivery 诊断 + Agent Presence）、`8b30fed`（用户管理端点）。

已知缺口：M6 卸载/更新实机项；M7 未开始；
M9 未开始；M4 skip 诊断事件；`request_task` 属 M7 Room Tools；审批过期扫描为单进程定时器；
realtime ticket/presence 与连接限制为单进程实现。

## 后续计划（2026-11-27）

1. **完成 DSH 整改 CI 验收**：获得 push 授权后在最新 HEAD 上跑 GitHub Actions；通过后再把复核项标为 PASS。
2. **M6 收尾（可选）**：补 uninstall/update 实机流程与状态记录，再决定是否把 M6 标为 Completed。
3. **M7 Codex Plugin**：由 ChatGPT 继续；可直接使用 Agent WSS + HTTP Room Tools。
4. **M8 体验补强**：附件、无限滚动、移动端布局；不改变现有权限模型。
5. **M9 Deployment**：systemd 单实例、备份/恢复、Cloudflare Tunnel、观察与多实例边界评估。

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

### M4：AI 自主群聊（2026-11-23）

按 `docs/PLAN.md` M4 实现服务端参与引擎、Agent 回复预算与 SDK 决策；REST/Web UI 与 Plugin 侧 Session 映射按里程碑归属记录为偏差。

实现：

- **参与模式**：新增 `apps/server/src/modules/participation.ts`。`decideParticipation` 依次检查 thread 消息、system 发送者、`participationMode=disabled`、Agent 发送时 `allowAgentMessages`、`hop > maxHops`、每 root 的 Agent 回复数 `>= maxRepliesPerRoot`，再取「群成员 ∩ Agent 未 disabled ∩ 有 presence TTL 内的存活 session」并排除发送者；`mention` 模式只保留内容里出现 `@displayName`（大小写不敏感、非字母数字边界）的 Agent。
- **投递**：`postMessage` 在同一事务内先写 message、event，再按上述结果逐 Agent 写 delivery；离线 Agent 不建 delivery（plan §9.1 的“在线”约束），发送者自己永远不接收。
- **Agent 发送约束**：Agent 必须指定同群的 `rootMessageId` 或 `replyToMessageId`；服务端用父消息计算 `hop = parent.hop + 1`（不信任客户端），并校验 root 与 reply 一致。超 `maxHops`、超每 root 回复预算抛 `ConflictError`；每分钟超过 `maxAgentMessagesPerMinute` 抛 `RateLimitError`（429）。所有检查都在插入之前，失败不产生 message/event/delivery。
- **限流索引**：`messages_root_idx (root_message_id, created_at)`、`messages_sender_created_idx (sender_type, sender_id, created_at)`，迁移 `0006_faithful_chat.sql`；显式索引 40 → 42。
- **WSS**：删除 M3 的 `AGENT_MESSAGES_ENABLED` 全局开关；`message.send` 直接走 `postMessage`，`DomainError` 映射为 `error` 帧（`conflict` / `rate_limited` / `forbidden` / `validation_error`）。
- **SDK**：`ParticipationResult = {action:"reply", text} | {action:"skip", reason?}`；`onEvent` 返回 reply 时 SDK 自动发送 `message.send`（带事件里的 `messageId`/`rootMessageId`），返回 skip 或空文本时只 ack；`sendMessage` 增加 `replyToMessageId`。
- **测试**：`apps/server/test/participation.test.ts` 12 例；`agent-auth.test.ts` 新增两 Agent WSS 端到端（用户消息两人都收到、A 回复只到 B、hop=1、DB 投递只有 B）；`agent-sdk/test/delivery.test.ts` 新增 reply/skip 决策 2 例。总计 15 文件 / 97 tests。
- **配置**：移除 `AGENT_MESSAGES_ENABLED`（config schema/tests、README、env example、AUTH、DATABASE 同步）。

验收对照：

| 验收项 | 结果 | 证据 |
|---|---|---|
| 两个 Mock Agent 加入同一群组 | PASS | `participation.test.ts` setup；`agent-auth.test.ts` 双 WS |
| 用户消息两个 Agent 都收到 | PASS | `fans a user message out to two connected agents and chains one reply` |
| 一个 Agent 可以 skip，不产生公开回复 | PASS | `does not send a message when the handler decides to skip` |
| 两个 Agent 在限制内交流 | PASS | `chains agent replies with an incremented hop and never notifies the sender` |
| 自己的消息不会触发自己 | PASS | 同上（A 的回复只投递给 B） |
| 超 hop / reply / rate 后停止 | PASS | `stops the chain once the hop limit is reached` / `... per-root reply budget is spent` / `rate limits an agent across groups` |
| 群组 A 消息不进群组 B | PASS | `keeps groups isolated: a message in A never reaches a member of B` |

```text
$ pnpm lint        # exit 0
$ pnpm typecheck   # exit 0
$ pnpm format:check# All matched files use Prettier code style!
$ pnpm test        # Test Files 15 passed (15) / Tests 97 passed (97)
$ pnpm build       # packages/protocol, packages/database, packages/agent-sdk, apps/server Done
```

偏差与后续：

- 群组/消息 REST API 与 React Web UI 属 M8（仓库目前只有 `apps/server`），因此“前端显示 Agent 发言和在线状态”未在本轮实现。
- 每个群组独立的 DSH Session 映射属 M6 DSH Plugin；服务端已保证事件带 `groupId` 且群组隔离有测试。
- `request_task` 决策属 M5；当前 SDK 只实现 reply/skip。
- skip 只 ack、不写诊断事件（plan 允许写脱敏内部事件，暂未实现）。
- 离线 Agent 在消息发生时不会收到 delivery（plan §9.1 只对在线 Agent 建立 delivery）；历史补拉依赖 M8 的 REST API。
- 结论：M4 服务端验收全部通过，建议进入 M5；Web UI 与 REST API 在 M8 补齐。
- 提交：`e059403`（实现 + 测试 + 文档），记录提交见下方；未重启 dsh-web。

### M4 Review Fix（2026-11-23）

按审查报告修复 SDK 自动回复的确认/幂等语义、服务端幂等查询顺序、mention 边界，并同步阶段归属。

- **SDK 自动回复幂等**（`packages/agent-sdk/src/index.ts`）：自动回复使用稳定 `clientMessageId = sdk-reply-<deliveryId>`；同一 delivery 无论重放多少次，服务端 `(group_id, client_message_id)` 唯一约束最多创建一条消息。等待确认期间同一 delivery 重投不会再次发送（新增测试 `does not send a second reply while the first awaits confirmation`）。
- **ack 语义**：自动回复只在收到 `message.sent` 且 `clientMessageId` 匹配后 ack（`armReplyAck` / `confirmReply`）。`conflict` / `forbidden` / `validation_error` / `not_found` 视为终止并 ack（`acks the delivery after a terminal reply error so the chain stops`）；`rate_limited` / `internal_error` 等可重试错误保持未 ack 并记录 5s 退避（`keeps the delivery unacked and backs off after a retryable reply error`）；10s（`replyAckTimeoutMs`）未确认也会保持未 ack，由服务端重投后重试。SDK 关闭时清理所有定时器。
- **服务端幂等顺序**（`apps/server/src/modules/messages.ts`）：在身份 / 群组 / 成员 / thread / root / reply 目标校验之后、Agent 预算与速率检查之前查询 `clientMessageId`。因此预算或每 root 回复数已耗尽时，用原 `clientMessageId` 重试仍返回原消息，不新增 message/event/delivery（新增 `returns the original agent message when a retry arrives after the reply budget is spent` 与 `... after the rate limit is reached`）。
- **错误帧关联**：`agentServerMessage` 的 `error` 帧增加可选 `clientMessageId`；WSS `message.send` 失败时回传该字段，SDK 用它确认终止或退避（`packages/protocol/src/agent.ts`、`apps/server/src/routes/agent.ts`）。
- **mention 边界**（`apps/server/src/modules/participation.ts`）：正则改为两侧边界 `(?<![\p{L}\p{N}_])@name(?![\p{L}\p{N}_])`；新增 `does not treat an email-like string as a mention`（`user@agentA` 不触发）。
- **计划同步**（`docs/PLAN.md`）：M4 工作项移除“每群组独立 Agent Session 映射”（注为 M6）与“前端显示”（注为 M8），M4 验收仍全部为服务端行为。

```text
$ pnpm lint        # exit 0
$ pnpm typecheck   # exit 0
$ pnpm format:check# All matched files use Prettier code style!
$ pnpm test        # Test Files 15 passed (15) / Tests 103 passed (103)
$ pnpm build       # packages/protocol, database, agent-sdk, apps/server Done
```

- 新增/更新测试：`apps/server/test/participation.test.ts`（mention 邮箱边界、预算耗尽后幂等重试、限流后幂等重试）、`packages/agent-sdk/test/delivery.test.ts`（ack 等待 message.sent、等待期间不重发、可重试错误退避、终止错误 ack）。
- 结论：审查报告中的优先项与 mention 边界已修复；M4 仍标完成，Session 映射归 M6、前端归 M8 已在计划中同步。
- 提交：`6515983`（修复 + 测试 + 文档）。

### M4 Review Fix 2（2026-11-23）

按第二轮审查补齐自动回复的本地重试、参与停止诊断与回归测试。

- **SDK 本地重试**（`packages/agent-sdk/src/index.ts`）：待确认回复保存 `groupId` / `content` / 发送选项 / `clientMessageId = sdk-reply-<deliveryId>`。收到 `rate_limited` / `internal_error` 等可重试错误后，按 `replyRetryBackoffMs`（默认 5s）重发**同一 payload**；`replyAckTimeoutMs`（默认 10s）到期同样重发，不重新生成文本。`message.sent` 匹配后清除状态并 ack；`conflict` / `forbidden` / `validation_error` / `not_found` 终止并 ack；`close()` 清理全部 pending 与定时器。同一 delivery 并发重投只保留一个待发送项和一个定时器。socket 意外关闭时保留 pending、清掉运行中的定时器；重新 `open()` 后在 hello 之后重发。
- **服务端诊断**（`packages/protocol/src/schemas.ts`、`apps/server/src/modules/participation.ts`、`apps/server/src/modules/messages.ts`）：新增事件类型 `participation.stopped`，payload 只含 `reason` / `rootMessageId` / `senderType` / `senderId` / `agentId`，不含消息正文或凭据。hop / reply budget / mode disabled 的停止在消息事务内记录；被拒绝的 Agent 发送（`rate_limit` / `hop_limit` / `reply_budget` / `agent_messages_disallowed`）在主事务回滚后记录，不创建 message、event（message.created）以外的公开内容，也不创建任何 Agent delivery。
- **测试**：`packages/agent-sdk/test/delivery.test.ts` 11 → 15（退避结束后重发同一 payload 并确认、确认超时后重发、同一 delivery 并发只保留一个重试流程、close 后不再发送、断线保留 pending 并在重连后重发）；`apps/server/test/participation.test.ts` 15 → 19（hop 拒绝诊断、reply budget 诊断、rate limit 诊断且不写消息、确认丢失重试后只有一条消息 / 一个 `message.created` / 正确投递）。
- **验证**：`pnpm lint` exit 0；`pnpm typecheck` exit 0；`pnpm format:check` 通过；`pnpm test` 15 files / 111 tests 通过；`pnpm build` 通过。
- **未完成**：skip 的内部诊断事件。SDK 的 skip 目前只 ack、不上报服务器，服务器无法区分 skip 与“没有回复”；已在 `docs/PLAN.md` M4 工作项中标注为未完成，不把该项验收写成已通过。
- 提交：`29671aa`（SDK 重试 + 服务端诊断 + 测试 + 文档）。

### M4 Review Fix 3（2026-11-23）

针对第三轮审查修复 M4 的 Root/Hop 语义、Max Hop Fan-out、Delivery 重试/租约、Dev Auth 边界与限流作用域；未提前实现 M5。

修复：

- **P1 Root / Hop 由服务端推导**（`apps/server/src/modules/messages.ts`）：顶层消息 `rootMessageId = 自身`、`hop = 0`；用户回复继承 parent 的 root 且不增加 hop；Agent 回复继承 root、`hop = parent.hop + 1`。`replyToMessageId` 是唯一附着点（必须存在、同群），客户端提交的 `rootMessageId` 只作为 Agent 无 `replyToMessageId` 时的兼容回复目标，不能决定链；`hop` 无客户端输入字段。`maxRepliesPerRoot` 的计数按 effective root，用户插话不会重置预算。
- **P2 Max Hop 终止 Fan-out**（`apps/server/src/modules/participation.ts`）：参与判定从 `hop > maxHops` 收紧为 `hop >= maxHops`，达到上限的消息不再创建 Agent Delivery；Agent 发送 `hop > maxHops` 仍被拒绝并写入 `participation.stopped`（reason `hop_limit`）。用户插话不会恢复已达上限的讨论链。
- **P2 Delivery 租约与重试**（`apps/server/src/modules/events.ts`、`apps/server/src/routes/agent.ts`、`packages/database/src/schema.ts`）：新增 `DELIVERY_LEASE_MS = 30_000` 与 `MAX_DELIVERY_ATTEMPTS = 10`；`listOutstandingDeliveries` 支持 `leaseMs` / `now` / `includeUnacked`，默认返回 `pending` + 租约已过期的 `delivered`；连接建立/重连时用 `includeUnacked` 立刻补发全部未 ack 投递，之后每 1s 按租约扫描。新增 `redeliverDelivery`（`delivered` → `delivered`、`attempts + 1`、更新 `delivered_at`），重投复用同一 `deliveryId`，不产生新 Message/Event；`attempts >= 10` 由连接循环置为 `failed` 作为诊断状态。索引新增 `agent_deliveries_lease_idx(agent_id, status, delivered_at)`（迁移 `0007_rainy_rawhide_kid.sql`，显式索引 43）。
- **P2 Dev Auth 仅限 Loopback**（`packages/config/src/index.ts`）：`AUTH_MODE=dev` 时 `HOST` 必须是 `127.0.0.1` / `localhost` / `::1`（或 `[::1]`），`0.0.0.0` 与非回环 IP 在启动前被 `ConfigError` 拒绝；`access` 模式不受此限制。
- **P2 按群组限流**（`apps/server/src/modules/participation.ts`）：`countRecentAgentMessages` 与 `assertAgentRateLimit` 增加 `groupId`，只统计同一 `(group, agent)` 最近 60 秒的 Agent 消息；用户/系统消息不计，跨群组互不影响。

测试：

- 新增 `apps/server/test/delivery-lease.test.ts` 6 例：租约到期以同一 `deliveryId` 重投、requeue、达到最大尝试后 `failed`、长期未 ack 不阻塞新投递、跨 Agent ack 拒绝、disabled Agent 拒投。
- `apps/server/test/participation.test.ts` 扩至 26 例：顶层 root/hop、用户回复不重置 root/hop、Agent 回复 hop 递增、忽略伪造 root、跨群组 reply 拒绝、budget 在用户插话后仍生效、hop 达到上限零 fan-out、按群组限流/窗口恢复/不同 Agent 独立。
- `packages/config/test/config.test.ts` 扩至 12 例：dev auth 仅 Loopback（允许/拒绝）、access 模式不受限。

```text
$ pnpm lint         # exit 0
$ pnpm typecheck    # exit 0
$ pnpm format:check # All matched files use Prettier code style!
$ pnpm test         # Test Files 16 passed (16) / Tests 126 passed (126)
$ pnpm build        # exit 0
```

未解决 / 明确推迟：

- skip 的内部诊断事件仍未实现（SDK 的 skip 只 ack，不上报原因；服务器无法区分 skip 与未回复），已在 PLAN M4 工作项标为未完成，不计入通过。
- REST 群组/消息 API、React Web UI 属 M8；每群组独立 Session 映射属 M6 DSH Plugin；`request_task` 属 M5。

结论：M4 Review Fix 3 的 Root/Hop、Max Hop、Delivery 租约、Dev Auth 与限流作用域已修复并有测试覆盖；M4 可继续作为 M5 的输入。

提交：`e52a355`（修复 + 测试 + 文档）。

### 路线图同步（2026-11-23）

按用户提供的 Development Roadmap 执行文档同步任务；仅修改文档，未改代码，未开始 M5。

- 新增 `docs/ROADMAP.md`：保存用户提供的完整路线图（M0–M9、Plugin 架构、依赖顺序、执行规则、验收标准）。
- `docs/PLAN.md`：M6 由“DSH Adapter”改为“DSH Plugin”，M7 由“Codex Adapter 与独立 Host Agent”改为“Codex Plugin”；§11 改为 Plugin 设计（`RoomAgentPlugin` 接口、DSH Plugin、Codex Plugin、第三方 Plugin）；架构、目录说明、执行顺序摘要与 DoD 中相关表述同步；明确不新增独立 Adapter 产品或默认 Host Agent。
- `README.md`：状态区 M6 Session 映射引用改为“M6 DSH Plugin”，文档区新增 ROADMAP 链接。
- `docs/PROGRESS.md`：M4 偏差中的 M6 Adapter 引用改为 M6 DSH Plugin，新增本同步记录。
- `docs/AUTH.md`：M6 Session 映射引用改为 M6 DSH Plugin。

```text
$ pnpm lint          # exit 0（本次文档变更后复跑）
$ pnpm typecheck     # exit 0
$ pnpm format:check  # All matched files use Prettier code style!
$ pnpm test          # 16 files / 126 tests passed
$ pnpm build         # 全部 Done
```

说明：本次任务只同步文档，测试数量与代码行为均未变化；上述结果为本轮实际复跑，不是引用历史记录。

### M5：Thread / Task Engine（2026-11-24）

按 `docs/ROADMAP.md` §4 与 `docs/PLAN.md` M5 实现，范围是服务层 + REST API；Web UI 仍属 M8，DSH/Codex 的 Session 映射属 M6/M7。

实现：

- **Thread**：`threads.ts` 新增 `getThreadDetail`（源消息、消息数、最后消息时间、关联 Task）、`listThreads` 支持 status 过滤；`messages.ts` 新增 `listThreadMessages`，并让群消息流排除 Thread 消息；`events.ts` 新增 `listThreadEvents`（keyset）。Thread 关闭 / 失败后不能写入。
- **Task 状态机**：`tasks.ts` 的 `TASK_TRANSITIONS` 覆盖 queued → assigned → running → waiting_approval / paused / succeeded / failed / cancelled；所有转换由 Server 校验，非法转换 409。Task 新增 `started_at`、`result`、`summary`、`error`、`cancelled_at`、`workspace_id`；Task Run 新增 `paused`、progress 字段与 `updated_at`。
- **Progress**：仅 assignee 在 running 时上报（percent 0–100、stage ≤ 200、message ≤ 2000），写 Task Run + `task.progress` 事件，不进入群聊。
- **Approval**：新表 `approvals`（迁移 `0008`）与 `approvals.ts`：assignee 在 running 请求，Task → `waiting_approval`；审批人 = 群 owner/admin 或系统 owner/admin；approve → running，reject（必须 reason）/ expire → Task+Run+Thread failed 并在父群写失败摘要；决策幂等、反向决策 409、待审批唯一、审计 `task.approval_*`。
- **Pause / Resume / Cancel**：群管理员操作，写 `task.paused` / `task.resumed` / `task.cancelled` 事件并给 assignee durable delivery；cancel 同时把 pending approval 置 cancelled、关闭 Thread；重复 cancel 409。
- **摘要回流**：completeTask 仅在 running 时成功；成功摘要与失败摘要都写入父群（`client_message_id = task-summary:<taskId>`、`thread_id = null`、正文含 `Thread: <threadId>`），Thread 消息不进入 Group stream。
- **REST API**：`apps/server/src/routes/room.ts` 覆盖 ROADMAP §4.9 的 groups / members / messages / threads / tasks / approvals / events；用户请求用现有 Dev/Access Principal，Task 执行端点（start / progress / complete / approvals）用 Agent Bearer 会话 token；`docs/openapi.yaml` 描述全部端点。
- **权限**：所有写操作走既有 `requireWriteUser` / `requireGroupManager` / `requireActiveGroup`；Agent 执行端点额外校验 assignee 与成员关系。

验收（ROADMAP §4.11，25 项）对照：

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 从 Group Message 创建 Thread | PASS | `task-engine.test.ts` 生命周期、`http-room.test.ts` |
| Thread 消息不进入 Group Message Stream | PASS | `isolates thread messages from the group stream` |
| Thread Detail / Logs | PASS | `getThreadDetail` / `GET /threads/:id` / `/events` |
| 创建并分配 Task | PASS | `createTaskFromMessage` / `assignTask` / REST |
| Agent 在独立 Thread 中执行 | PASS | Thread + Task 关联；执行事件带 `threadId` |
| Task Progress | PASS | `reportTaskProgress` + `task.progress` 测试 |
| Approval 请求 / 批准 / 拒绝 / 超时 | PASS | approvals 测试（含 expiry、权限、幂等、反向 409） |
| Pause / Resume / Cancel | PASS | 生命周期 + 非法转换 + cancel 清理 pending approval |
| 完成 / 失败摘要回流 | PASS | 摘要进入父群、`thread_id=null`、失败含拒绝原因 |
| 服务器重启后状态保留 | PASS | 关闭并重新打开同一 SQLite 文件后 Task 仍为 paused |
| REST API + OpenAPI | PASS | `apps/server/src/routes/room.ts`、`docs/openapi.yaml`、4 个 HTTP 契约测试 |

验证（本轮实际执行）：

```text
$ pnpm lint          # exit 0
$ pnpm typecheck     # exit 0
$ pnpm format:check  # All matched files use Prettier code style!
$ pnpm test          # 18 files / 143 tests passed
$ pnpm build         # 全部 Done
```

已知偏差与后续：

- Approval 超时已由 M5 Review Fix 接入 Server 启动 + 每 30 秒扫描（见下节）。
- Agent 自主 `request_task` 不在 M5 范围，留给 M6/M7 Plugin。
- M4 的 skip 诊断事件仍未实现（PLAN 中保持未完成状态）。
- REST 暂无附件与 OpenAPI 请求级 schema 校验；Web UI 属 M8。
- 提交：`bd25675`（实现 + 测试 + 文档，18 files / 143 tests）。


### M5 Review Fix（2026-11-24）

审查确认的 5 项问题全部修复；未改变 M5 架构与 API 风格，未开始 M6/M7/M8。

| Fix | 状态 | 实现 | 主要文件 | 回归测试 |
| --- | --- | --- | --- | --- |
| FIX-01 Thread Cursor Pagination | PASS | `listThreads` keyset `(createdAt DESC, id DESC)` + `{ items, nextCursor }`；cursor 校验同 Group；limit 1–200 | `apps/server/src/modules/threads.ts`、`apps/server/src/routes/room.ts` | `m5-review-fix.test.ts` 分页 4 例；`http-room.test.ts` 分页契约 |
| FIX-02 Thread Reply Isolation | PASS | Thread 内只允许回复同 Thread 或源群消息；群聊不可回复 Thread 消息 | `apps/server/src/modules/messages.ts` | `m5-review-fix.test.ts` 隔离 3 例 |
| FIX-03 Active Task Thread Close Guard | PASS | 非终态 Task 关联 Thread 关闭 → 409，不写事件/审计 | `apps/server/src/modules/threads.ts` | `m5-review-fix.test.ts` 关闭保护 2 例；HTTP 409 契约 |
| FIX-04 Approval Expiration Consistency | PASS | `task.approval_expired` + `approval.expire`；Task/Run/Thread failed + 摘要；启动/30s 扫描；重复幂等；已决策拒绝 | `apps/server/src/modules/approvals.ts`、`apps/server/src/main.ts`、`packages/protocol/src/schemas.ts` | `m5-review-fix.test.ts` 过期 4 例（含重启恢复） |
| FIX-05 Idempotency Payload Conflict | PASS | 同 key 比较 source/title/description/assignee；不一致 409 且不写行 | `apps/server/src/modules/tasks.ts` | `m5-review-fix.test.ts` 幂等 3 例 |

其他修改：`docs/openapi.yaml`（Thread 分页参数/响应、Task 创建 409）；`apps/server/test/http-room.test.ts`（分页 + Active Task Thread 关闭 409）。

验证（实际执行）：

```text
$ pnpm lint          # exit 0
$ pnpm typecheck     # exit 0
$ pnpm format:check  # exit 0
$ pnpm test          # 19 files / 160 tests passed
$ pnpm build         # 全部 Done
```

未完成 / 后续：

- Approval 过期扫描是进程内定时器；多实例部署需在 M9 评估单实例执行或数据库级调度。
- `request_task` 仍属 M6/M7；M4 skip 诊断事件仍未实现；Web UI 属 M8。
- 代码提交：`3ac5f64`（fix + tests + OpenAPI）；文档随本次 docs 提交更新。

### M5 Review Fix 2（2026-11-24）

第二轮审查（`m04154`）判定 M5 不通过，阻断项是 Thread 消息未通过 durable delivery 到达 Agent。逐项修复并补集成测试；未开始 M6。

| 问题 | 状态 | 修复 | 测试 |
| --- | --- | --- | --- |
| P0 Thread 消息不投递 | PASS | `postMessage` 对 Thread 内消息只投递给该 Thread 非终态 Task 的 assignee；事件 payload 带 `threadId` / `taskId`；plain Thread / sender 本人不投递 | `m5-review-round2.test.ts` 3 例；`http-room.test.ts` REST 投递 |
| P1 审批过期后仍可批准 | PASS | 决策事务内校验 `expiresAt`；过期先落 `expired` + fail Task/Run/Thread + 摘要；条件 update 防竞态 | `m5-review-round2.test.ts` 审批竞态 1 例 |
| P1 Agent 重启恢复不完整 | PASS | Agent Bearer 恢复端点（active tasks / task detail / thread history）；SDK `onRecover` + `listTasks/getTask/listThreadMessages`；只允许 assignee | `m5-review-round2.test.ts` 重启恢复 1 例；SDK delivery 测试 |
| P1 Workspace Policy 未实现 | PASS | `workspaces` 表 + Group 边界 + 创建权限/审计 + Task `workspaceId` 校验 + 成员读/Agent 读自己 Task 的元数据 | `m5-review-round2.test.ts` workspace 1 例；`http-room.test.ts` REST 权限/跨群 |
| P2 来源消息校验 | PASS | 创建 Thread/Task 的 source 必须是群主消息流中未删除消息 | `m5-review-round2.test.ts` 1 例 |
| P2 OpenAPI close 路由 | PASS | 移除 `/threads/{id}` POST，新增 `/threads/{id}/close`；补 workspaces / agent tasks 路径 | `openapi-contract.test.ts` 2 例 |
| P2 TaskRun paused 协议 | PASS | `TASK_RUN_STATUSES` 增加 `paused` | `m5-review-round2.test.ts` 1 例 |
| P2 Cursor 错误处理 | PASS | 无效/跨 Group 或 Thread 的 cursor 统一 `400` | `m5-review-round2.test.ts` 1 例 |

验证（实际执行）：

```text
$ pnpm lint          # exit 0
$ pnpm typecheck     # exit 0
$ pnpm format:check  # exit 0
$ pnpm test          # 21 files / 174 tests passed
$ pnpm build         # 全部 Done
```

剩余：

- Thread 投递只覆盖「用户 → 当前 assignee」；多个 Agent 在 Thread 内协作不在 M5 范围。
- `running` Task 的恢复需要 Agent 主动拉取；Server 不会自动重启执行，也不会把 `running` 自动判失败。
- 审批过期扫描仍是进程内定时器（单实例）；多实例部署在 M9 评估。
- `request_task` 属 M6/M7；M4 skip 诊断未实现；Web UI 属 M8。
- 代码提交：`6f8092a`（实现 + 测试 + 文档 + 迁移 0009）。

### M5 Review Fix 3（Group membership 撤销，2026-11-24）

第三轮审查针对 Agent 被移出 Group 后的权限撤销完整性；保留 Review Fix 2 已有实现，未改变架构，未开始 M6/M7/M8。

| 问题 | 状态 | 修复 | 测试 |
| --- | --- | --- | --- |
| FIX3-01 Recovery 仍可读原 Group | PASS | `listAgentTasks` join `group_members`；`getAgentTask` 非本人/非成员统一 `404`；`listThreadMessagesForAgent` 校验 membership（`403`）；写端点保留 `requireGroupMember` | `group-agent-revocation.test.ts`（T2/T3/T4/T16）；`http-room.test.ts` REST 用例 |
| FIX3-02 Thread 仍投递给旧 assignee | PASS | 事务内校验 assignee 仍为该 Group 成员后才建 delivery；不广播；已移除 assignee 不阻塞用户消息 | `group-agent-revocation.test.ts` T5 |
| FIX3-03 pending/unacked Delivery 可重放 | PASS | `listOutstandingDeliveries` 过滤/终止无权记录为 `failed`（`lastError = group membership revoked`）；`markDeliveryDelivered` / `redeliverDelivery` / WebSocket 发送前二次校验；`removeMember` 同事务批量撤销；`hello.outstanding` 不再计数 | `group-agent-revocation.test.ts` T6/T7；`agent-auth.test.ts` live socket 与重连用例 |
| FIX3-04 非终态 Task 留下无效 assignment | PASS | `removeMember` 事务内抽取的取消 helper 取消该 Group 中该 Agent 的全部非终态 Task；Run / pending Approval / Thread / `task.cancelled` / audit 一致；reason `agent removed from group`；不向被移除 Agent 新建 delivery；User removal 不受影响 | `group-agent-revocation.test.ts` T1/T11/T12/T13/T14；事务回滚 T15 |
| FIX3-05 回归覆盖 | PASS | Service、REST、WebSocket/Delivery、多 Group、事务回滚；未 mock membership | `group-agent-revocation.test.ts` 5 例；`http-room.test.ts` +1；`agent-auth.test.ts` +1 |
| FIX3-06 Workspace 阶段边界 | PASS | ROADMAP §4.9 明确 M5 仅为 Task / Workspace 元数据映射，Runtime 与 Filesystem Allowlist 属 M6/M7；THREAD_TASK_ENGINE §11、PLAN、AUTH、README 同步 | 文档检查 |

测试覆盖 T1–T16 的说明：T5 的“原 Thread”在 Task 取消后已关闭，因此用户消息按正常 Thread 规则被拒绝；仍然开放的 plain Thread 消息可正常保存且不创建 delivery（测试中显式区分）。T8 使用真实 WSS 连接，移除后 polling 不再发送该 Group 事件；T9/T10 用 Group A + Group B 验证只撤销 A。

验证（实际执行）：

```text
$ pnpm lint          # exit 0
$ pnpm typecheck     # exit 0
$ pnpm format:check  # exit 0
$ pnpm test          # 22 files / 181 tests passed
$ pnpm build         # 全部 Done
```

剩余：

- Runtime binding / Local filesystem allowlist 属 M6/M7；M5 不提供路径字段或文件访问代码。
- Thread 投递仍只覆盖「用户 → 当前 assignee」；多 Agent Thread 协作不在 M5。
- `running` Task 恢复依赖 Agent 主动拉取；Server 不自动重启执行。
- 审批过期扫描仍是进程内 30s 定时器（单实例）；M9 评估多实例调度。
- `request_task` 属 M6/M7；M4 skip 诊断未实现；Web UI 属 M8。
- 代码提交：`eadb4a4`（实现 + 测试）。M5 状态：Completed（M5 Review Fix 3 / 3A 验收通过，2026-11-24）。

### M5 Review Fix 3A — Approval Expiration Assignee Durable Delivery（2026-11-24）

Status: Completed / Verified

- **Issue**：审批过期后 Approval/Task/Run/Thread 状态、失败摘要、`task.approval_expired` 事件和审计都已完成，但原 Task assignee 没有收到 durable delivery；Agent 可能一直停留在“等待审批结果”。
- **Root Cause**：共享的 `failTask()` 只写生命周期事件并丢弃返回值；摘要广播 `enqueueGroupAgentDeliveries` 明确排除 assignee，因此唯一能通知 assignee 的路径缺失。
- **Fix**：`failTask` 保存 `task.approval_expired` 事件引用，payload 增加 `threadId` / `status`；当事件类型为审批过期、task 有 `assignedAgentId`、assignee 未 disabled 且仍是该 Group 成员时，在同一事务内 `enqueueDelivery` 给 assignee。复用现有 delivery 状态机、租约与重试；无新事件、无新表、无迁移、无新依赖。无有效 assignee 时不创建 delivery。
- **Changed files**：`apps/server/src/modules/approvals.ts`、新增 `apps/server/test/approval-expiration-delivery.test.ts`、`docs/ROADMAP.md`、`docs/PLAN.md`、`docs/PROGRESS.md`、`docs/THREAD_TASK_ENGINE.md`。
- **Tests**：7 例——assignee delivery 与 event payload、引用既有事件且不重复创建、非 assignee 不收到到期 delivery 且摘要仍广播给其他在线 Agent、assignee 离线时 pending + 恢复 ack、重复过期幂等、事务回滚（Approval/Task/Run/Thread/Event/Delivery/Summary/Audit）、无 assignee 场景。
- **Validation**：`lint` / `typecheck` / `format:check` / `test` / `build` 全部实际执行（结果见下）。
- **Test summary**：Test Files 23，Tests Passed 188，Tests Failed 0。
- **Remaining**：审批过期扫描仍是单实例 30 秒定时器；Server 不会自动重启 Agent 执行；Runtime/Filesystem Allowlist 属 M6/M7；Thread 多 Agent 协作、`request_task`、skip 诊断、Web UI 等边界不变。
- **代码提交**：`a9021ea`。

### M5 Review Fix 3B — Message Idempotency, Transition Guards and Workspace Boundary Audit（2026-11-24）

Status: Completed / Verified

- **FIX-01 Message 幂等一致性**：`postMessage` 现在把 `groupId + clientMessageId` 视为一次具体请求。相同 sender / thread / content 的重试返回原消息；不同内容、不同 Thread、不同 Sender 复用 ID 统一 `409`，unique-violation 并发路径做同样比较；重试不会新增 Message / Event / Delivery。幂等查询前移到 Thread 校验之前，因此已关闭 Thread 上的原样重试仍能拿到原消息。新增 `assertIdempotentReplay()`。
- **FIX-02 Task 转换保护**：`assignTask`（queued/assigned）、`startTask`（assigned + assignee 匹配）、`completeTask`（running）、`pauseTask`（running）、`resumeTask`（paused）全部改为 `UPDATE ... WHERE id = ? AND status = ?` 条件更新并检查 `changes`；Task 先 claim，再条件更新对应 Run，任何影响行数不为 1 均抛 `ConflictError`，事务回滚保证 Task / Run / Event 一致。合法状态集合与既有 `TASK_TRANSITIONS` 不变。
- **FIX-03 Workspace 边界核查**：确认 `workspaceForTask()` 拒绝跨 Group Task 引用、`getWorkspace()` 仅 Group 成员、`listAgentTasks()` / `getAgentTask()` 仅返回当前 Agent 仍为成员的 Group 内 assignment；补充非成员读取 Workspace 与非 assignee 通过 Task 端点读取 Workspace 的断言。路径穿越、符号链接、本地路径访问控制属于 M6 安全验收事项，本轮不提前实现。
- **Cursor 契约**：`messages` / `thread messages` / `agent thread messages` 的 `cursor` 为数字 seq；`events` / `tasks` 的 `cursor` 为字符串 ID。`docs/openapi.yaml` 新增 `messageCursor`（integer）并替换误用的字符串 `cursorId`；REST / OpenAPI / SDK 三处一致。
- **Changed files**：`apps/server/src/modules/messages.ts`、`apps/server/src/modules/tasks.ts`、新增 `apps/server/test/message-idempotency.test.ts`、新增 `apps/server/test/task-transition-guards.test.ts`、`apps/server/test/m5-review-round2.test.ts`、`apps/server/test/room.test.ts`（原幂等测试改为原样重试）、`docs/openapi.yaml`。
- **Tests**：新增 10 例（相同重试、内容冲突、跨 Thread、不同 Sender、并发重复；重复 start、重复 complete、重复 pause、running 时 resume、并发 start），Workspace 边界测试补 2 个断言。
- **Validation**（本轮实际执行）：`lint` exit 0；`typecheck` exit 0；`format:check` exit 0；`test` 25 files / 198 tests passed；`build` exit 0。
- **Remaining / M6 前置安全事项**：Runtime binding 与 Local filesystem allowlist（含路径穿越、符号链接、本地路径访问控制、Plugin 不得扩大权限）属 M6/M7；审批过期扫描仍是单实例 30 秒定时器；Thread 投递仍只覆盖用户 → 当前 assignee；Server 不自动重启 Agent 执行。
- **代码提交**：`aec3434`（实现 + 测试 + OpenAPI）。M5 状态保持 Completed；未开始 M6。

### M5 Review Fix 3C — Workspace 创建与 Audit 原子提交（2026-11-25）

Status: Completed / Verified

- **Issue**：`createWorkspace()` 先 INSERT Workspace，再单独调用 `recordAudit()`；如果审计写入失败，Workspace 已经留下，违反 `recordAudit()` 注释要求的“与业务变更同事务”。
- **Fix**：`createWorkspace()` 改为 `ctx.db.transaction()` 内完成 Workspace INSERT 与 `workspace.create` Audit；唯一键冲突仍转换为 `ConflictError`；审计失败时整个事务回滚；返回事务内创建的 Workspace。
- **Changed files**：`apps/server/src/modules/workspaces.ts`、新增 `apps/server/test/workspace-transaction.test.ts`、`docs/PROGRESS.md`、`docs/PLAN.md`、`docs/THREAD_TASK_ENGINE.md`、`README.md`。
- **Tests**：3 例——Workspace 与 Audit 正常一起提交；用 SQLite `BEFORE INSERT ON audit_logs` trigger 模拟审计写入失败，断言 Workspace 与 Audit 均回滚；同 Group 重名 `ConflictError`、其他 Group 同名允许。
- **Validation**（本轮实际执行）：`lint` exit 0；`typecheck` exit 0；`format:check` exit 0；`test` 26 files / 201 tests passed；`build` exit 0。
- **Remaining**：Runtime / Filesystem Allowlist 仍属 M6/M7；审批过期扫描单实例 30 秒定时器；Thread 投递仅用户 → assignee；M5 最终验收仍以审查确认和远端代码为准。
- **代码提交**：`6498911`（实现 + 测试）。

### M5 Review Fix 4 — Durable Agent Control Command（2026-11-25）

Status: Completed / Verified

- **Issue**：`removeMember` 已取消被移除 Agent 的非终态 Task、撤销其 pending / unacked Delivery，但 Agent 运行中的执行循环不会收到“停止”指令；仅靠事件流不可行，因为同一事务会撤销该 Agent 的 Delivery。Message 幂等重试也未比较有效回复目标（`replyToMessageId` / Agent legacy `rootMessageId`）。
- **FIX-01 持久化控制指令**：新增 `agent_commands` 表（`command_type = task.cancel`，状态 `pending → delivered → acked`，唯一 `(agent_id, command_type, task_id)`），迁移 `0010_dark_silver_samurai.sql`。`cancelAgentTasksForGroupRemoval` 在 `removeMember` 事务内为每个被取消的非终态 Task 创建指令（含 `run_id`、`reason = "agent removed from group"`），与 Task / Run / Approval / Thread / Event / Audit 同事务；同一任务重复创建幂等。
- **WSS 投递与 ACK**：`hello` 增加 `outstandingCommands`；连接后立即补发未 ACK 指令（含 `delivered`），1s poll 只发 `pending` 并标记 `delivered`；`command` 帧携带 `commandId/type/taskId/runId/reason/createdAt`；`command.ack` 仅目标 Agent 可确认，未知/他人 ID 返回 `not_found`，重复 ACK 幂等。ACK 只更新指令状态，不重放事件。
- **SDK**：`AgentClientOptions.onTaskCancel`；handler resolve 后自动 ACK，抛错或无 handler 不 ACK；`ackedCommands` 去重。未改变既有 `onEvent` / `onRecover` / `autoAck` 语义。
- **FIX-02 Message 幂等**：`assertIdempotentReplay` 增加有效回复目标比较；用户为 `replyToMessageId ?? null`，Agent 为 `replyToMessageId ?? rootMessageId ?? null`；相同 ID 但回复目标不同返回 `409`；并发 unique-violation 分支同样比较。原样重试仍返回原消息，不新增 Message / Event / Delivery。
- **Changed files**：`packages/database/src/schema.ts` + 迁移 `0010_dark_silver_samurai.sql`、`packages/protocol/src/agent.ts`、`packages/protocol/src/ids.ts`、`packages/agent-sdk/src/index.ts`、`apps/server/src/modules/agentCommands.ts`（新增）、`apps/server/src/modules/tasks.ts`、`apps/server/src/routes/agent.ts`、`apps/server/src/modules/messages.ts`；测试新增 `apps/server/test/agent-commands.test.ts`，扩展 `apps/server/test/agent-auth.test.ts`、`apps/server/test/message-idempotency.test.ts`、`packages/agent-sdk/test/delivery.test.ts`。
- **Tests**：`agent-commands.test.ts` 6 例（移除创建指令与 Run/Approval/Thread 一致性且不建 `task.cancelled` delivery、delivered/ack/幂等/他人 ACK 拒绝、多 Group 与终态隔离、移除 User 不触发、指令去重、移除后执行端点仍被拒绝）；`agent-auth.test.ts` +2（live socket 收指令并 ACK、离线重连补发 + 他人 ACK 拒绝 + 已 ACK 不再重发）；`message-idempotency.test.ts` +3（相同回复目标重试、不同回复目标 409、Agent legacy root 比较）；SDK +3（handler 后 ACK、handler 抛错不 ACK、无 handler 不 ACK）。
- **Validation**（本轮实际执行）：`lint` exit 0；`typecheck` exit 0；`format:check` exit 0；`test` 27 files / 215 tests passed；`build` exit 0。
- **Remaining**：控制指令目前只有 `task.cancel`；手动 Cancel 仍使用 `task.cancelled` durable delivery；审批过期扫描仍是单实例 30 秒定时器；Runtime / Filesystem Allowlist 属 M6/M7；Thread 多 Agent 协作、`request_task`、skip 诊断、Web UI 边界不变。
- **代码提交**：`8df761a`（实现 + 测试）。

### M6：DSH Plugin（2026-11-25）

范围：DSH 原生 Host Plugin（`adapters/dsh-plugin`），不修改 DSH Core，不引入独立 Adapter 进程。

已实现：

- **Bundle 结构**：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`，Host 行
  `id=agent-room`；`lib/index.js` 由 esbuild 自包含打包；locale / icon / README 齐备；
  安装/启停/卸载/更新沿用 DSH Plugin Manager 与 Settings 配置，不在 profile 中手写 manifest。
- **配置**（schemastery `Config`）：`roomBaseUrl`、`agentKeyPath`、`dataDir`、
  `groups[{groupId,sessionId,label}]`、`maxReplyChars`、`turnTimeoutMs`、`replyPrefix`；
  `assertMappings` 拒绝重复/一拖多映射；Session 缺失只告警，绝不自动创建。
- **身份**：本地生成/加载 Ed25519 PKCS#8 key（目录 0700、文件 0600），读取时拒绝
  group/other 可读；只记录公钥指纹，不记录私钥；不使用配置明文存私钥。
- **连接**：直接复用 `@room/agent-sdk` 的 challenge/response、socket ticket、WSS、
  heartbeat、delivery/ack、lease recovery；插件不重写认证协议。Socket 断开后指数退避
  重连（0.5s–30s），`hello` 后 SDK 自动重投未 ack 的 Delivery 与 active tasks。
- **Session 映射**：每个 Group 显式映射一个独立 Session；两个 Group 使用两个 Session
  的测试验证上下文隔离；映射状态通过 `RoomBridge.status()` 暴露。
- **Message Bridge**：`message.created` → 显式映射 Session 的 `sessionController.prompt`
  （`requestId=room-<eventId>`，`mode=queue`）；Prompt 带 Group/Thread/Task/消息上下文；
  只抽取 assistant text blocks，`[skip]`/空不回；回复带 `threadId`/`replyToMessageId`，
  `clientMessageId=plugin-reply-<eventId>`。
- **Delivery 幂等**：`deliveries.json` 原子持久化 `pending/processing/completed/failed`、
  attempts、error；completed 重复投递不重复 Prompt；processing 由 Room 重投 + DSH requestId
  去重；failed 记录原因并 ack；不依赖内存 Set。
- **Task 取消与恢复**：SDK `command` → `sessionController.cancel({sessionId})`；`onRecover`
  记录 task→session；插件禁用/重启后由 DSH 生命周期与 SDK 重连恢复。
- **状态/日志**：`status()` 暴露 connected/agentId/fingerprint/groups/deliveries/lastError；
  连接、映射缺失、Session 不可用、Prompt 失败、skip、取消均写 Cordis logger。

提交：`baedbe4`（插件代码、bundle 配置、workspace/vitest/eslint 接线）。

测试：新增 `adapters/dsh-plugin/test/bridge.test.ts` 12 例、`integration.test.ts` 1 例
（真实 Room Server + 真实 AgentClient + 假 DSH ctx）；全量 29 files / 228 tests 通过，
lint / typecheck / format:check / build 通过。

未完成 / 偏差（如实记录）：

### 实机验证（2026-11-25）

- 通过 DSH `plugin_manager` 卸载旧 `@local/dsh-room-bridge`，清理 profile 中旧 patch 行；
- 以 `file:/data/work/agent-room/adapters/dsh-plugin` 安装 `@room/dsh-plugin`，写入显式
  Group→Session 映射并启用；
- 真实 Room Server（dev auth、临时 SQLite）→ 用户消息 → 插件 Prompt 映射 Session →
  assistant 回复 → Room `sendMessage` 回复成功（`seq 5` 用户消息，`seq 6` Agent 回复，
  `replyToMessageId` 指向原消息）；
- 实机发现并修复：`sessionController.prompt` 必须传 `AbortSignal`；冷 Session 需先
  `resolveAgent`；映射到**归档 Session** 时 `agent/pre-step` 拒绝（`turn/end=blocked`）；
  `/api/v1/agent/*` 需绕过 dev auth 的用户 Principal（由路由校验 Agent Bearer）；
- 测试结束后清空映射、停止临时 Room Server；插件保持安装/启用。

未完成 / 偏差（如实记录）：

- Bundle 已实机安装/启用；替换旧 bundle 的**卸载**与 **update** 实机流程仍待操作者确认。
- 结构化 Task Progress / Approval / Result / Error 工具尚未提供；M6 只桥接 Thread/Task
  消息上下文与 cancel 指令，完整 Room Tools 属 M7。
- Workspace 运行时/文件系统隔离属 M7 allowlist；M6 只使用 M5 的 Task→Workspace 元数据。

### 浏览器实时层（M8 服务端前置，2026-11-25）

范围：为 M8 Web Client 提供已认证的浏览器 WebSocket；不涉及 UI。

已实现：

- `POST /api/v1/realtime/ticket`：User Principal 换取一次性、60 秒有效的 ticket；ticket 只
  以 SHA-256 哈希保存在进程内，使用后即删除；浏览器不能把 JWT / dev 身份放进 URL。
- `GET /api/v1/realtime/ws?ticket=...`：消费 ticket 后建立 WebSocket；无效、过期、重复
  使用以 `1008` 关闭；`/api/v1/realtime/ws` 加入公开路径，由 ticket 自行认证。
- 订阅协议：`subscribe {groupId, afterSeq?}`、`subscribed`、`event`、`unsubscribe`、
  `unsubscribed`、`ping`/`pong`、`error {code}`；同一连接同一时间只订阅一个 Group。
- 投递：从持久化 `events` 表按 `seq` 游标读取，每 300ms 最多 100 条，只推进已发送游标；
  订阅时校验 Group 成员身份；省略 `afterSeq` 时只接收订阅后的新事件，带 `afterSeq` 时
  从该 seq 之后重放；单帧上限 64 KiB（超出 `1009`）。
- 文档：`docs/REALTIME.md`、`docs/openapi.yaml`（`/api/v1/realtime/ticket`）、README。

测试：新增 `apps/server/test/realtime.test.ts` 7 例（未认证 ticket、无效/重复 ticket、
成员收到 `message.created`、`afterSeq` 重放、非成员拒绝、ping/pong、unsubscribe）。
全量 30 files / 237 tests 通过；lint / typecheck / format:check / build 通过。
代码提交：`9dae94e`。

已知边界：

- Agent 在线状态不是 Group 级事件，暂不进入该通道；M8 Agent 列表先用 REST；
- ticket 存储为单进程内存，多实例需迁移（M9 评估）；
- Origin 校验、每用户连接数/速率限制、Thread 级订阅、Delivery 诊断尚未实现；
- 被移出 Group 的已订阅连接不会立即断开，重新订阅时才拒绝。

### Agent HTTP Room Tools（M7 服务端支持，2026-11-25）

范围：为 Codex / 第三方 Plugin 的 Room Tools 提供服务端 HTTP 入口；Plugin 工具封装属 M7。

已实现：

- `GET /api/v1/agent/groups`：Agent 所属 Group（含 AI settings），按创建时间倒序；
- `GET /api/v1/agent/groups/:groupId/messages`：Group 主消息流，排除 Thread 消息，`seq` keyset；
- `POST /api/v1/agent/groups/:groupId/messages`：Agent 群聊回复 / Thread 回复，复用
  `postMessage` 的 membership、root/hop、预算、限流、Thread 归属与 `clientMessageId` 幂等；
- `GET /api/v1/agent/groups/:groupId/events`：Group 事件 keyset（事件 id 游标）；
- 全部使用 Agent Bearer session token；非成员 `403`；裸顶层 Agent 消息 `400`；冲突 `409`。

测试：新增 `apps/server/test/agent-http-tools.test.ts` 4 例（仅列出所属 Group、读取主消息流并
回复 + 事件可见、非成员 403 / 裸顶层 400、无 token 401）。全量 31 files / 241 tests。
OpenAPI 与 AUTH §13 已同步；代码提交：`783ead7`。

已知边界：

- 不提供 Agent 创建 Group / Thread、成员管理、审批决策；
- Thread 消息读取仍走 `/api/v1/agent/threads/:threadId/messages`（按 Task assignee 授权）；
- 这组 REST 端点与 WSS 的投递语义独立：读取历史不会自动 ACK delivery。

### Delivery 诊断 + Agent Presence（M8 服务端前置，2026-11-25）

已实现：

- `GET /api/v1/groups/:groupId/deliveries`：Group owner/admin 查看投递诊断；支持
  `status`（pending / delivered / acked / failed）、`agentId`、`limit`、`cursor`
  （上一页最后一条 delivery id）；返回 delivery 字段 + Agent displayName + event type；
  cursor 必须属于该 Group，否则 `400`；非 manager `403`。
- `GET /api/v1/groups/:groupId/deliveries/stats`：按状态计数与最老 pending 的
  `createdAt`；同样仅 owner/admin。
- 浏览器实时通道新增 `presence` 帧：订阅成功后立即推送该 Group 的 Agent 快照
  （agentId / displayName / status / online），之后每 300ms 检查，变化时才推送；
  `online` 依据 `agentPresenceTtlMs` 的活跃 Session lease。
- 不新增表/迁移；投递查询走 `agent_deliveries` + `events(group_id)` 索引。

测试：`apps/server/test/delivery-diagnostics.test.ts` 4 例（manager 列表、delivery cursor
分页 / 非法 cursor、非 manager 与未认证、状态统计 + 最老 pending + Group 隔离）；
`realtime.test.ts` 增 presence 快照与上线更新 1 例。全量 32 files / 246 tests。
代码提交：`1432b42`。

已知边界：

- 只读诊断，不提供重试/终止操作；Agent 侧 ACK 语义仍以 WSS 为准；
- presence 依赖会话 lease 轮询，单进程 SQLite 下可接受；多实例需改为事件驱动（M9）；
- 每连接每 300ms 一次 presence 查询，连接数增长时需评估去重/共享快照。

### 用户管理端点（M8 服务端前置，2026-11-25）

已实现：

- `PATCH /api/v1/users/:userId`：修改角色；owner/admin 授予/撤销与 owner/admin 目标仅 owner 可操作；
- `POST /api/v1/users/:userId/disable` 与 `/enable`：禁用/恢复；禁用后认证 403；最后一个 active
  owner 受保护（409）；启用对 disabled 用户幂等；
- 状态变更与 `user.disabled` / `user.enabled` 事件、`user.disable` / `user.enable` 审计同事务；
- `/api/v1/users` 列表仍仅系统 owner/admin。

测试：新增 `apps/server/test/users-admin.test.ts` 3 例（admin 不能授予 admin / 成员不能列表、
禁用后 403 且启用恢复 + 事件、最后 owner 保护）。全量 33 files / 249 tests。
代码提交：`8b30fed`。

已知边界：

- 不支持删除用户（保留审计与消息归属）；
- 角色变更不影响已有 Group membership 的 owner/admin 角色；
- 被禁用用户的 Agent Session / Delivery 不在本端点级联处理。

### Agent / 成员 / 消息管理端点（M8 服务端前置，2026-11-26）

已实现：

- `POST /api/v1/agents/:agentId/disable` / `enable`：系统 owner/admin 禁用/恢复 Agent；
  禁用时同事务关闭全部 Session、写 `agent.status.changed` 与审计，路由层关闭在线 WebSocket；
  `enable` 恢复为 `offline`；两者幂等。
- `GET /api/v1/agents` 与 `GET /api/v1/agents/:agentId` 返回 `online`（Session lease）。
- `PATCH /api/v1/groups/:groupId/members/:memberType/:memberId`：调整成员角色；Agent 仅
  `member`；owner 角色变更仅系统 owner/admin 或 Group owner；最后一个 Group owner 不可降级
  （409）；写 `group.member_updated` 事件与审计。
- `DELETE /api/v1/messages/:messageId`：软删除；发送者或 Group manager 可删；重复删除幂等；
  写 `message.deleted` 事件与审计；列表已过滤。
- 新增事件类型 `group.member_updated`、`message.deleted`。

测试：新增 `apps/server/test/admin-endpoints.test.ts` 4 例（Agent 禁用/会话关闭/恢复/幂等、
成员角色提升与 owner 保护、消息软删除权限/幂等/列表隐藏、HTTP 路由）。全量 34 files / 253 tests。
代码提交：`ff20d5e`。

已知边界：

- Agent 禁用不撤销其 Key，也不清理已 ack 的 Delivery；恢复后需重新连接。
- 消息删除不追溯已投递 Delivery，也不删除引用它的 Thread/Task；客户端需按事件刷新。
- 成员角色变更不转移 Group 所有权语义，也不影响系统角色。


## M8：React Web Client（2026-11-26）

状态：**实现完成**（无浏览器 E2E；生产静态托管属 M9）。

### 做了什么

- `apps/web`：React 19 + Vite 8；Vite `/api` 代理到 `127.0.0.1:8787`（含 WebSocket upgrade）。
- 登录：`GET /api/v1/auth-info` 区分 dev / access；dev 使用 `x-dev-user-email`，access 依赖 Cloudflare Access。
- 群组：列表/创建/切换（localStorage 记忆）、群聊历史（seq 分页）、发送、回复、软删除。
- 实时：`RealtimeClient` 一次性 ticket → `/api/v1/realtime/ws`，Group 订阅、`events.seq` 续传、
  `presence` 在线 Agent、指数退避重连、20s ping；消息按 id 去重合并。
- Thread：列表/状态过滤、详情（来源消息、消息数、Task）、Thread 消息、事件日志、从群消息创建、关闭。
- Task：列表/状态过滤、从群消息创建、分配、暂停/恢复/取消、审批列表与批准/拒绝。
- 管理：成员添加/角色/移除；Agent 注册、禁用/启用、Key 列表/添加/吊销；用户创建/角色/禁用/启用；
  群组设置（participationMode、allowAgentMessages、hop/回复预算/限流）；Workspace 创建。
- 诊断：Delivery 状态统计与分页列表、事件历史（字符串 cursor）。
- 服务端增强：`GET /api/v1/auth-info`；成员列表返回 `displayName/status/online`；OpenAPI 0.7.0。

### 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| Login | PASS | dev 邮箱登录 / auth-info；`api.test.ts` |
| Group List / Chat | PASS | App 群组侧栏 + ChatView；手工 smoke |
| Real-time Message | PASS | `realtime.test.ts`；Vite 代理 smoke 200 |
| Message History | PASS | `listMessages` seq 分页；刷新重新拉取 |
| Thread / Task / Approval | PASS | ThreadsView / TasksView；REST 端点已由服务端测试覆盖 |
| Agent Status | PASS | presence 帧 + members online；`realtime.test.ts` |
| Agent / User / Role Management | PASS | AgentsView / UsersView / MembersView |
| Group Isolation | PASS | 所有请求带 groupId，服务端成员校验；server 测试覆盖 |
| WebSocket Reconnect / Recovery | PASS | 退避重连；刷新后历史重拉；无浏览器 E2E |
| API Contract Tests | PASS | `apps/server/test/openapi-contract.test.ts`；web `api.test.ts` |
| 所有测试通过 | PASS | 37 files / 260 tests |
| 文档更新 | PASS | 本文、README、PLAN、ROADMAP、WEB_CLIENT |

### 验证

- `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm test`（37 files / 260 tests）、`pnpm build` 全过。
- 手工 smoke：dev server + `vite dev`，`GET /` 200、`/api/v1/auth-info` 返回 `{"authMode":"dev"}`、
  `/api/v1/me` 200（经 Vite 代理）。
- Web 单测：`apps/web/test/api.test.ts` 4、`state.test.ts` 2、`realtime.test.ts` 1。
- 代码提交：`d42ca42`（Web + Server 增强）。
- 同时修复 DSH Plugin 回复竞态（`fa573e9`）：pending turn 现在在持久化 `completed` 之前注册，
  避免 `assistant/message` / `turn/end` 在 store 写入期间到达而被丢弃；integration 测试在 emit
  前等待 delivery completed。

### 已知边界

- 无 react-router / 深链；浏览器 E2E 仅覆盖 `e2e/room.spec.ts` 的 9 个核心场景。
- Task 细粒度 run progress 无独立 REST 端点，UI 展示 Task 状态与摘要。
- 附件上传/下载未实现；生产静态托管、同源部署属 M9。
- realtime ticket / presence 为单进程内存实现。
- M6 卸载/更新实机验收、M7、M9 仍未完成。

## 质量整改（2026-11-26）

针对 M8 后代码审查的专项整改（未开始 M9）：

| 项目 | 结果 | 证据 |
|---|---|---|
| WebSocket 权限撤销 | PASS | `RealtimeHub` 连接登记；`users.disableUser` 关闭全部连接、`groups.removeMember` 撤销订阅；每轮推送前复核用户/成员；`realtime-revocation.test.ts` 9 例 |
| Ticket 二次验证 | PASS | 兑换时重查 `users.status`；禁用后旧 ticket 1008；测试覆盖 |
| PendingTurn 持久化 | PASS | `deliveries.json` v2 保存 turn；`store.test.ts` 5 例（并发/残留 tmp/保留期/v1 迁移） |
| 插件重启恢复 | PARTIAL | `bridge.test.ts` 17 例含等待中重启、已结束未写回、completed 不重放；at-least-once + 幂等，不承诺 exactly-once |
| DeliveryStore 并发安全 | PASS | 写串行化、唯一临时文件、原子替换；并发测试通过 |
| 历史记录清理 | PASS | `deliveryRetentionDays`（默认 30）仅清终态；未完成记录保留 |
| GitHub Actions | PASS | Install 历史失败根因为 lockfile/依赖不一致，`0948c7c` 修复；整改 run `45844424920` 全步骤 success（含 Browser E2E） |
| WebSocket Origin | PASS | `REALTIME_ALLOWED_ORIGINS`；无 Origin 的 CLI 允许但仍需 ticket；测试覆盖 |
| Playwright E2E | PASS | 6 例：登录、授权 Group、群聊、重连补偿、重复消息、Thread/Task、移除成员后不可读；`--repeat-each 2` 12 通过 |
| 文档同步 | PASS | 本节、README、REALTIME、DSH_PLUGIN、env 示例、`QUALITY_REVIEW_REMEDIATION.md` |

实际执行：

- `pnpm test` → 39 files / 277 tests 全过；
- `pnpm exec playwright test` → 6 passed（`--repeat-each 2` → 12 passed）；
- `pnpm lint` / `pnpm typecheck` / `pnpm format:check` / `pnpm build` → exit 0。

数据库：本次整改未修改 SQLite schema；插件 `deliveries.json` v1→v2 兼容读取。

剩余：插件恢复的 exactly-once 语义、周期清理、多实例共享限流、Cloudflare Origin 实测、
M6 卸载/更新验收、M7、M9。

## M8 整改（2026-11-27）

针对 M8 Web / Server / Realtime 复审的三项缺陷，按 FIX-01 → FIX-02 → FIX-03 独立修改与提交：

| 项目 | 修复 | 提交 |
|---|---|---|
| FIX-01 普通成员任务页 | `TasksView` 将任务与 Agent 加载解耦；Agent 403/失败不再清空任务列表，仅禁用指派选择器并提示 | `0569aa0` |
| FIX-02 群组范围 Agent | 新增 `listGroupAgents(ctx,{groupId,viewerUserId})` 与 `GET /api/v1/groups/:groupId/agents`（成员校验、仅本群、排除 disabled）；任务页改用该接口；服务端指派仍独立校验 | `85adb82` |
| FIX-03 Realtime 断点 | `listMessages` 在单一 SQLite 事务内返回消息页与 `eventCursor=max(events.seq) where groupId`；ChatView 用 `eventCursor` 建立订阅，不再使用 `messages.seq` | `8bdc257` |

测试与验证：

- `apps/server/test/group-agents.test.ts` 3 例：群内隔离、非成员 403、跨群指派拒绝。
- `apps/server/test/message-event-cursor.test.ts` 2 例：群内 cursor 与全局隔离、分页一致。
- `apps/server/test/realtime.test.ts` +1 例：`subscribe afterSeq=eventCursor` 只回放其后的新事件。
- `pnpm test` → 41 files / 283 tests 全过（本轮实际执行，后台任务 exit 0）。
- `CI=true pnpm e2e` → 9 passed（成员任务页在 Agent 500 时仍显示、群组 Agent 隔离与跨群 400、eventCursor 断线重连无重复）。
- `pnpm lint` / `pnpm typecheck` / `pnpm format:check` / `pnpm build` → exit 0。

安全回归：未放宽系统级 Agent API（仍仅 owner/admin）；群组 Agent 查询要求当前用户为群组成员；创建/重新指派继续由服务端校验 Agent 群成员关系；Realtime 仍按群组与成员权限过滤；history 与 cursor 来自同一事务快照。

剩余：任务页缺少 Agent 时的交互仅通过 Playwright 路由模拟验证；历史消息分页时 cursor 语义已覆盖，但前端未实现无限滚动自动翻页。

## DSH 整改（2026-11-27）

针对 DSH 插件与服务器复核（`agent-room-dsh-remediation.md`）的 6 项意见：

| 项目 | 结果 | 证据 |
|---|---|---|
| SQLite / 配置权限 | PASS（本地） | 数据库/锁库/sidecar `0600`、新建目录 `0700`、systemd `UMask=0077`；`file-permissions.test.ts` 3 例 |
| Realtime send 异常清理 | PASS | `closed`/`cleaned` 分离、幂等 `cleanup()`、`1011`/`1008` 关闭；`realtime-cleanup.test.ts` 2 例 |
| PendingTurn 超时 | PASS | 超时异步落盘 `failed/turn_timeout`，迟到事件忽略，stop 保留 awaiting；`bridge.test.ts` 19 例 |
| DeliveryStore prune 提交 | PASS | 删除任一记录即提交；未终态 turn 永不删；store 6 例 |
| 文档一致 | PASS | README、本文件、部署手册、`QUALITY_REVIEW_FOLLOWUP_2026-11-27.md` |
| 最新 HEAD CI | PASS | push `fb005d2` 后 Run `46047104203` 全绿（lint/typecheck/test/build/E2E） |

本轮实际执行：`pnpm test` 43 files / 291 tests；`CI=true pnpm e2e` 9 passed；`lint` / `typecheck` / `format:check` / `build` 全过。
未修改 SQLite schema；`deliveries.json` 保持 v1 读取、v2 写入；API/帧格式未变。

## 代码审查修复（2026-11-27）

针对 13 项审查清单逐项复核并修复（P0 → P1 → P2 → P3），每阶段先补测试再改代码：

- **P0-01** Agent Token 前缀与认证：`openSession()` 签发 `agt_` 前缀 token；`auth/plugin.ts` 对 `Bearer agt_` 先调用 `requireAgentSession` 验证再放行；新增真实 `challenge → connect → sessionToken → /agent/tasks|groups` 集成测试，伪造/非法 token 401。
- **P0-02** Diagnostics Delivery DTO：服务端 `{delivery, agentDisplayName, eventType}` 与 Web `DeliveryItem` 对齐，`DiagnosticsView` 按嵌套结构渲染并分页。
- **P0-03** DSH Plugin 回合状态：按 `rpcId/requestId` 关联 turn；取消状态持久化 `cancelled`；新增 `reply_pending` 持久化与重连幂等补发；`connectOnce`/`stop` 竞态修复。
- **P1-01** Origin 默认值：dev 仅注入本地 5173 白名单，access 默认空且不继承 localhost；URL 规范化后比较 `.origin`。
- **P1-02** MembersView：`onError` 用 `useCallback` 固定；成员列表与系统 Users/Agents 目录拆分；群管理权限改用群内 `memberRole`。
- **P1-03** 消息历史分页：默认最新 50 条，`before` 向前加载，`eventCursor` 与实时订阅衔接；ChatView/ThreadsView 支持「加载更早消息」。
- **P1-04** readonly 删除：`deleteMessage` 统一 `requireWritableActor`。
- **P2-01** Task 幂等：查询、thread/task 插入、事件/审计合并事务；唯一冲突回查并校验 payload，不返回 500。
- **P2-02** Group PATCH：基本信息与 AI Settings 单事务一次更新，仅 Settings 不写多余 base 审计，校验失败无部分提交。
- **P2-03** cursor 校验：四个消息列表接口统一非负整数校验，非法值 400。
- **P2-04** Realtime 安全：ticket 状态迁入 `RealtimeHub` 实例；Agent 帧上限 256 KiB（1009）；单个 Session offline 不再误断其他 Session；300ms 轮询评估后保留（单实例、SQLite、当前规模可接受）。
- **P3-01/02/03/04** 补齐缺失 CSS 类；ChatView 对被回复消息不可见时显示「较早的消息」；修正 `pauseTask`/`resumeTask` 返回 `{task, run}` 与 `removeMember` 的 204 类型；`sweepStaleSessions` 删除重复分支。

验证：`pnpm test` 45 files / 307 tests；`CI=true pnpm e2e` 9 passed；`lint` / `typecheck` / `format:check` / `build` 全部通过。提交：`e9c705f`（P0）、`5c3b354`（P1）、`020e49d`（P2）、`33be0bb`（P2/P3 测试与收尾）。未解决：P3 的 UI 样式与回复引用没有独立组件测试（由构建与 E2E 覆盖）；Realtime 仍为轮询，事件驱动推送留待后续。
