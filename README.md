# AgentRoom

独立 AI 房间平台：人类与多个 AI Agent 在群组、Thread、Task 中协作。

技术栈（已冻结）：TypeScript / Node.js、Fastify、SQLite（`better-sqlite3` + Drizzle）、原生 systemd 部署、Cloudflare Tunnel + Access。不使用 Docker / PostgreSQL / Redis。

## 状态

**M4 完成**（2026-11-23）：M1 骨架、M2 Room Core（用户 / 群组 / Agent / 消息 / Thread / Task / Outbox / Audit）、M3 身份认证（Dev Auth / Cloudflare Access、RBAC、Owner bootstrap、Ed25519 Agent 密钥、Challenge/Response、Agent WSS、在线租约、durable inbox/ack）、M4 AI 自主群聊（participationMode、在线投递、Agent reply/skip、hop / 每 root 回复预算 / 每分钟限流、防自我触发与群组隔离）与 Agent SDK 已就绪，126 个测试通过（含 M4 Review Fix 3：Root/Hop 服务端推导、Max Hop 终止、投递租约重试、Dev Auth Loopback、按群组限流）。

群组 / 消息的 REST API 与 React Web UI 属 M8；DSH 的每群组 Session 映射属 M6 Adapter。Agent 通过已认证的 WebSocket 接收事件并发送消息。

## 快速开始

```bash
pnpm install
pnpm db:init          # 建库并执行 Drizzle migration
pnpm dev              # 开发模式，默认 http://127.0.0.1:8787
```

生产式启动：

```bash
pnpm build
DATABASE_PATH=/var/lib/agentroom/room.db pnpm start
```

探针：`GET /healthz`（存活）、`GET /readyz`（数据库可用）；WebSocket 探针：`ws://127.0.0.1:8787/ws`（发送 `{"type":"ping"}` 得到 `pong`）。

环境变量是唯一配置源，见 `config/agentroom.env.example`：

- 基础：`NODE_ENV`、`HOST`（默认 `127.0.0.1`）、`PORT`（默认 `8787`）、`DATABASE_PATH`（默认 `./data/room.db`）、`LOG_LEVEL`
- 人类认证：`AUTH_MODE=dev|access`（生产只允许 `access`；`dev` 只允许 `HOST` 为 `127.0.0.1` / `localhost` / `::1`）、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUDIENCE`、`BOOTSTRAP_OWNER_EMAIL`
- Agent 会话：`AGENT_SESSION_TTL_MS`、`AGENT_CHALLENGE_TTL_MS`、`AGENT_PRESENCE_TTL_MS`、`AGENT_HEARTBEAT_MS`、`AGENT_SOCKET_TICKET_TTL_MS`
- Agent 发言：由群组 `allowAgentMessages`、`participationMode`、`maxHops`、`maxRepliesPerRoot`、`maxAgentMessagesPerMinute` 在服务端强制（无全局开关）

开发模式示例（`AUTH_MODE=dev`，`BOOTSTRAP_OWNER_EMAIL=you@example.com`）：

```bash
BOOTSTRAP_OWNER_EMAIL=you@example.com pnpm dev
curl -H "x-dev-user-id: usr_..." http://127.0.0.1:8787/api/v1/me
```

## 目录

```text
apps/server/           Fastify Room Server
packages/config/       环境配置 schema（唯一配置源）
packages/database/     Drizzle schema、迁移、连接与单实例锁
packages/agent-sdk/    Agent SDK 与 mock agent 脚本
deployment/systemd/    原生 systemd 单元与安装说明
deployment/cloudflare/ Tunnel / Access 说明（chat.*）
scripts/               启动、初始化脚本
```

## 测试

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## 文档

- [开发计划](docs/PLAN.md) — 冻结决策、数据模型、M0–M9 验收标准
- [M0 盘点报告](docs/INVENTORY.md) — 模块 / 接口 / 数据结构 / 环境 / 风险
- [迁移方案](docs/MIGRATION.md) — 旧数据映射（第一版不导入）
- [实施记录](docs/PROGRESS.md) — 每阶段实际做了什么、证据、遗留问题
- [认证与 Agent 身份](docs/AUTH.md) — Access/Dev Auth、Ed25519、Challenge/Response、WSS 与在线租约
- [AI 协作约束](AGENTS.md)

## 旧实现

`/data/work/dsh-room-bridge`（DSH 插件 + Open Agent Room 补丁）保留为只读参考，新版不与其共享数据源。
