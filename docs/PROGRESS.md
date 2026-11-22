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
| M1/M2 使用 Dev Auth Provider | 用户确认；M3 再接 Cloudflare Access |
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

### M1 遗留

- `/ws` 目前只有 hello / ping / 错误处理，业务协议在 M2/M5 填充。
- 没有认证（Dev Auth Provider 在 M2 引入，M3 接 Cloudflare Access）。
- 生产库路径与 systemd 单元尚未在 Mini PC 上实际安装（M9 做安装/回滚演练）。

### 下一步（M2）

- Users / groups / memberships / agents / agent keys 的 schema 与 service
- Messages、Threads、Tasks / Task Runs、Events / Outbox、Audit logs
- 权限规则与 Dev Auth Provider；事务内不发起 AI/网络调用
