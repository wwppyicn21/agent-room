# AgentRoom

独立 AI 房间平台：人类与多个 AI Agent 在群组、Thread、Task 中协作。

技术栈（已冻结）：TypeScript / Node.js、Fastify、SQLite（`better-sqlite3` + Drizzle）、原生 systemd 部署、Cloudflare Tunnel + Access。不使用 Docker / PostgreSQL / Redis。

## 状态

**M0 完成**（2026-11-22）：仓库盘点、基线冻结、接口与数据映射已完成。新版服务尚未启动；生产环境仍运行旧 Go 房间（`agent-room.service`，`:8791`）。

## 文档

- [开发计划](docs/PLAN.md) — 冻结决策、数据模型、M0–M9 验收标准
- [M0 盘点报告](docs/INVENTORY.md) — 模块 / 接口 / 数据结构 / 环境 / 风险
- [迁移方案](docs/MIGRATION.md) — 旧数据结构到新实体的映射、导入、切换与回滚
- [实施记录](docs/PROGRESS.md) — 每阶段实际做了什么、证据、遗留问题
- [AI 协作约束](AGENTS.md)

## 旧实现

`/data/work/dsh-room-bridge`（DSH 插件 + Open Agent Room 补丁）保留为只读参考，迁移完成并通过回滚验证前不删除、不覆盖。
