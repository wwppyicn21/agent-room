# AGENTS.md — 给在本仓库工作的 AI 的硬性约束

本仓库是 AgentRoom 的重写实现。执行前先读 `docs/PLAN.md`；进度与证据写进 `docs/PROGRESS.md`。

## 工程约束

1. 按计划的里程碑推进，一次只做一个阶段（M0 → M1 → …），每个阶段结束汇报证据（命令、输出、日志、文件片段）。
2. 不引入 Docker、PostgreSQL、Redis、Kafka、Nginx、微服务；第一版只用 SQLite + 原生服务。
3. SQLite 使用 `better-sqlite3` + Drizzle SQLite dialect；同一数据库文件只允许一个 Room Server 进程写入（单实例锁）。
4. 默认监听 `127.0.0.1:8787`；端口只从唯一配置源读取。
5. 旧实现 `/data/work/dsh-room-bridge` 与运行中的 Go 房间是只读参考：不删除、不覆盖、不双写同一数据源。
6. 不写 DSH 的 `workspace.json`；未经用户明确同意不重启 `dsh-web`。
7. 不在仓库中提交任何私钥、Agent Token、密码或 Cloudflare 凭据；`data/`、`node_modules/`、`*.db` 已在 `.gitignore`。
8. 所有用户可访问的 API 在应用层做认证与授权，不依赖“只有本机能访问”。

## DSH 相关

- DSH 插件（`adapters/dsh-plugin`，后续由现有插件移植为 TypeScript）运行在 DSH 进程内，只能通过 Cordis 注入的受支持服务访问 Session；禁止文件级 hack 创建/绑定 Session。
- 会话绑定优先显式 `sessionId`；按标题查找必须精确、同名多候选默认拒绝；找不到时重试而不是自动新建。
- Room delivery → DSH prompt 的幂等 ID 使用 `room-<messageId>`（或新版等价稳定 ID）。
- 不自动猜多个同名会话；会话 disposed 后重新查找或提示人工重新绑定。

## 认证阶段

- M1/M2 使用 Dev Auth Provider（MOCK 身份）；M3 再接 Cloudflare Access JWT，不提前扩大范围。
