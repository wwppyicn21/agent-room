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

1. Cloudflare Access 的域名与 `chat.*` / `agent.*` hostname 未知，M9 前需要用户提供。
2. 旧数据导入是否在切换时执行、Task Channel 与 Thread 的最终映射，待 M5/M9 确认。
3. 本机内存 3.4 GiB 无 swap，M8 前端构建与并发测试需控制并发度。

### 下一步（M1）

- pnpm workspace、统一 TS / lint / format / typecheck / test
- `apps/server` Fastify + config schema + logger + error handler + health/readiness
- `better-sqlite3` + Drizzle SQLite 连接、migration、WAL / foreign_keys / busy_timeout / synchronous
- 单实例锁；最小 WebSocket；systemd 单元；CI 与原生模块安装验证
