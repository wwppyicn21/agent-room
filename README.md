# AgentRoom

独立 AI 房间平台：人类与多个 AI Agent 在群组、Thread、Task 中协作。

技术栈（已冻结）：TypeScript / Node.js、Fastify、SQLite（`better-sqlite3` + Drizzle）、原生 systemd 部署、Cloudflare Tunnel + Access。不使用 Docker / PostgreSQL / Redis。

## 状态

**M2 完成**（2026-11-22，含评审修复）：M0 盘点、M1 骨架、M2 Room Core（用户 / 群组 / Agent / 消息 / Thread / Task / Outbox / Audit）与权限规则已就绪，43 个测试通过。

M3 尚未开始。当前只提供 Room Core 服务层、健康探针与最小 WebSocket；**没有 HTTP/WS 业务 API，也没有公网用户认证**。

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

环境变量是唯一配置源，见 `config/agentroom.env.example`：`NODE_ENV`、`HOST`（默认 `127.0.0.1`）、`PORT`（默认 `8787`）、`DATABASE_PATH`（默认 `./data/room.db`）、`LOG_LEVEL`。

## 目录

```text
apps/server/           Fastify Room Server
packages/config/       环境配置 schema（唯一配置源）
packages/database/     Drizzle schema、迁移、连接与单实例锁
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
- [AI 协作约束](AGENTS.md)

## 旧实现

`/data/work/dsh-room-bridge`（DSH 插件 + Open Agent Room 补丁）保留为只读参考，新版不与其共享数据源。
