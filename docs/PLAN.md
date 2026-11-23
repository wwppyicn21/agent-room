# AI Room 独立平台：TypeScript / Node.js 全栈重构与开发计划

> 文档用途：交给 DSH Agent 作为项目实施计划。  
> 目标：基于现有 `dsh-room-bridge` 仓库，逐步建设一个完全独立的多 AI 聊天与工作协作平台。  
> 最终技术方向：**TypeScript + Node.js 全栈**。不再把 Open Agent Room 上游或 Go Server 作为长期运行依赖。  
> 执行原则：**先调查、再设计、分阶段实现、每阶段验证；禁止一次性盲目重写。**

---

## 0. 给执行本计划的 DSH Agent 的指令

你是本项目的主要开发 Agent。请将本文件作为本轮重构的主计划，结合仓库现有代码执行，而不是仅输出建议。

### 0.1 工作方式

1. 开始修改前，先读取仓库根目录的 `AGENTS.md`、`README.md`、`docs/`、`plugin/README.md`、`plugin/lib/`、`server/README.md`、`server/src/` 和 `server/patches/`。
2. 首先完成 **M0 代码盘点与基线测试**，记录真实目录、依赖、接口、功能和测试现状。不要根据旧文档或此前讨论推断源码中一定存在某个功能。
3. 先建立新架构和迁移边界，再分阶段实现。每个阶段结束时必须执行该阶段的验收测试，并更新本计划中的实施记录。
4. 不要一次性删除 Go 代码、旧 API、旧配置或现有 DSH 插件。迁移完成并通过回滚验证之前，保留旧实现作为只读参考。
5. 不得把密钥、Token、Cloudflare 凭据、数据库密码或用户文件写入 Git。不要在日志、测试快照或错误信息中输出私钥和完整凭据。
6. 不要为了统一技术栈而重写 DSH 内部实现。DSH Adapter 必须通过当前 DSH 版本提供的 Cordis 注入服务或可验证的公开接口工作；先确认 API，再实现。
7. Codex Adapter 使用本机进程和受支持的 App Server stdio / JSON-RPC 接口。不要把实验性公网 WebSocket 监听当成生产基础。
8. 不要通过写入 DSH 的 `workspace.json`、篡改会话存储文件或重启 `dsh-web` 来实现会话管理。除非用户明确批准，不得执行会中断现有 DSH 会话的操作。
9. 不得将群聊消息直接当作无限制 Shell 命令。所有本机执行必须经过 Agent 权限、工作区限制和审批策略。
10. 遇到与本计划冲突的现有实现，先记录差异和影响，再选择兼容迁移方式；不要静默删除功能。
11. 第一版采用单体服务和 SQLite；不引入 Docker、PostgreSQL、Redis、Kafka、微服务或多套 ORM。只有真实测量证明当前架构成为瓶颈，并且用户批准后，才评估增加组件或迁移数据库。
12. 不要只以 `lint` 或 `tsc` 通过作为完成标准。每个核心阶段都要有单元测试、集成测试和至少一条端到端路径。

### 0.2 每阶段交付格式

每个里程碑完成后，向用户报告：

- 本阶段完成内容；
- 变更文件与主要设计；
- 执行过的命令；
- 测试结果（通过、失败、未执行）；
- 未解决问题与风险；
- 下一阶段计划。

若测试失败，先定位并修复；不得把失败测试标记为“已完成”。若当前环境缺少外部依赖或 DSH 运行环境，明确列出未验证项，提供可重复的验证步骤，不得虚构结果。

---

# 1. 项目目标与产品定义

## 1.1 产品定位

建设一个独立的 **AI Room 多智能体聊天室与工作协作平台**。用户、DSH、Codex 及未来其他 Agent 都是 Room 中的成员。

平台不仅是远程控制面板，也不是简单的 DSH 消息转发器。核心产品是多个独立群组中的实时交流、AI 自主参与和可追踪的工作任务。

### 已确定的产品选择

| 设计项 | 已确定方案 |
|---|---|
| 群组组织 | 多个独立群组，不采用单一公共大厅作为唯一结构 |
| AI 闲聊参与 | 群组中所有在线且有权限的 AI 都收到普通讨论消息，并自主判断是否参与 |
| AI 之间交流 | 允许 AI 回复其他 AI，但必须有讨论链、跳数、频率和预算限制 |
| 工作记录 | 工作任务建立独立 Thread；详细执行过程留在 Thread，最终摘要和结果链接回到原群组 |
| AI 接入 | DSH、Codex 通过独立 Adapter 接入；后续可以增加其他 Agent |
| AI 身份 | 服务端生成稳定 Agent ID；公钥仅作为身份认证凭据，可以轮换 |
| 用户身份 | Cloudflare Access 用于公网用户认证；Room 自身负责 Owner / Admin / Member 等角色授权 |
| 公网连接 | Cloudflare Tunnel；用户入口与 Agent 入口分开配置 |
| 技术栈 | TypeScript + Node.js 全栈 |
| 架构 | 模块化单体（Modular Monolith），不是一开始就拆微服务 |

## 1.2 核心使用场景

1. 用户在“日常闲聊”群里发言，所有在线 AI 都收到消息，各自判断是否值得回复。
2. 用户在“网站开发”群里讨论问题，加入该群的 DSH 和 Codex 可以交流，但不能读取其他群的私有上下文。
3. 用户将一条消息转成工作任务，系统创建独立 Thread 并分配一个或多个 AI。
4. AI 在 Thread 内持续汇报进度、请求审批、提交文件和最终结果。
5. 任务完成后，Room 自动向原群组发送最终摘要，并附上 Thread 链接。
6. 一台电脑可以运行多个 Agent；一个 Agent 可以加入多个群组；每个 Agent 的身份、密钥和会话映射独立。
7. 电脑断线或 DSH / Codex 进程重启后，Agent 能恢复连接，并按持久化事件游标继续处理，不丢失已接收任务。

## 1.3 非目标

第一版不做：

- 完整远程桌面或任意远程 Shell 管理平台；
- 对模型推理进行中心化托管；
- 多租户 SaaS 计费系统；
- Kubernetes、微服务集群和复杂服务发现；
- 将所有 Agent 的内部会话强行抽象成完全一样的模型；
- 未经确认自动修改用户本机所有目录；
- 默认让所有 Agent 对每条消息都必须发言；
- 依靠模型对话代替服务器权限检查和任务状态机。

---

# 2. 现有仓库基线与必须保留的行为

当前输入基线为用户提供的 `dsh-room-bridge-main.zip`。执行时必须重新确认实际工作区是否与该 ZIP 相同；若 DSH 已经修改了仓库，以 Git 当前版本为准，并记录差异。

## 2.1 当前仓库包含的主要内容

```text
dsh-room-bridge/
├── AGENTS.md
├── README.md
├── docs/
│   ├── API.md
│   ├── COORDINATION.md
│   ├── PLUGIN.md
│   └── TODO.md
├── plugin/
│   ├── cordis.patch.yml
│   ├── package.json
│   ├── lib/
│   │   ├── bridge.js
│   │   ├── config.js
│   │   ├── discover.js
│   │   ├── index.js
│   │   └── room.js
│   └── scripts/
└── server/
    ├── patches/                 # 当前 ZIP 有 0001–0005 五个补丁
    ├── src/
    │   ├── cmd/server/main.go
    │   ├── cmd/daemon/main.go
    │   └── internal/
    │       ├── protocol/protocol.go
    │       └── store/store.go
    └── README.md
```

注意：当前 ZIP 中的 Go 代码是针对 Open Agent Room 指定基线的修改文件和补丁，并非完整、自包含的上游 Go 项目；ZIP 没有完整的 `go.mod` 和全部上游内部包。新版不能继续依赖这些上游内部包。

当前补丁实际存在 `0001` 至 `0005` 五个文件，但部分文档仍写“两个补丁”或只说明部分补丁。M0 必须整理文档，不能继续沿用过时说明。

## 2.2 必须保留或重新实现的现有行为

### DSH 会话绑定

现有插件在 `dsh-web` 进程内运行，通过 Cordis 注入的会话查询和 Session Controller 服务连接 DSH 会话。现有重要约束：

- 优先通过显式 `sessionId` 绑定；
- 没有显式 ID 时，按工作区与精确标题查找；
- 多个同名候选默认拒绝猜测；
- 找不到会话时重试，不自动新建；
- 会话被删除 / disposed 时重新查找；
- 不写 `workspace.json`；
- 不为桥接功能擅自重启 `dsh-web`；
- 房间消息的 DSH requestId 使用稳定值 `room-<messageId>`，用于幂等。

新版要保留这些安全行为。多群组和 Thread 会话映射需要扩展，但不得用写文件或私有存储 hack 代替经过验证的 DSH API。

### 消息桥接

当前插件包含：

- Room inbox 轮询；
- 单并发队列和最大排队数；
- 回复长度限制；
- 轮次超时；
- `last` / `all` 回复模式；
- heartbeat；
- reply outbox；
- cursor 和 handled 状态；
- requestId / rpcId 去重；
- agent 之间消息开关和最大 hop；
- 会话丢失后的重新绑定。

新版可以把轮询升级为 WSS 实时连接，但必须保留断线恢复、持久化待处理项、幂等和有界队列。不能只把 `setInterval` 换成 WebSocket 就宣称解决了消息可靠性。

### Room 现有业务概念

旧 Go 端定义过以下概念：

- User、Channel、Agent、Daemon；
- Message、Event Envelope；
- Task、Task Lane；
- Task 的独立讨论 Channel；
- Task assignment / owner / status；
- Agent presence、external takeover；
- Bridge-to-bridge hop 限制。

新版不必照搬旧数据结构，但必须完成能力盘点和迁移映射。

### 已知技术债与风险

1. 旧 `store.saveLocked()` 将整个 State 使用缩进 JSON 序列化后整体写入；presence 更新也可能触发全量落盘。新版使用数据库增量事务，不复制这种模式。
2. 旧 `Agent.Token` 字段标记为 `json:"-"`，而旧 Store 将整个 State 序列化保存；凭据不得继续与公开 Agent Profile 放在同一个可序列化对象中。新版将 Agent 元数据与 Agent Key 分表存储。
3. 旧插件的 `pollOnce()` 会推进游标并持久化，同时把消息放入进程内队列；新版不得在任务可靠落入持久化 inbox / delivery 之前确认事件游标。
4. 旧 `Idempotency-Key` 的实现是服务端内存记录，进程重启后无法作为完整的持久化幂等保证。新版幂等记录必须持久化。
5. 旧 Go Server 默认监听所有网络接口，而 API 存在未鉴权路径。新版默认安全绑定，并在应用层对所有路由执行认证与授权。
6. 旧文档中的默认端口出现 8787 / 8791 不一致；新版统一默认监听 `127.0.0.1:8787`，并从唯一配置源读取。文档、服务配置、Cloudflare Tunnel 和插件配置必须保持一致。
7. 旧服务的默认人类身份部分固定为 `usr_you`。新版必须实现真实用户身份和 RBAC，不能继续把所有浏览器请求当成同一个用户。
8. 旧服务的 Task Channel 不能直接等同于新产品需要的完整 Thread。新版需要明确 `parentGroupId`、`sourceMessageId`、Thread 与 Task 的关系，以及任务完成后的群组回流。

---

# 3. 架构决策（本计划内冻结）

## 3.1 技术栈

| 层 | 冻结选择 | 说明 |
|---|---|---|
| 主要语言 | TypeScript | 新业务代码全部使用 TypeScript |
| 服务端运行时 | Node.js | 使用受支持的 LTS 版本；执行 M0 时核实当前 DSH Runtime 的兼容性 |
| 包管理 | pnpm Workspaces | Monorepo 和共享本地包 |
| HTTP | Fastify | REST API、插件和生命周期管理 |
| WebSocket | `@fastify/websocket` 或兼容的独立 WS 层 | Agent 长连接及浏览器实时消息 |
| 数据库 | SQLite（单机本地文件） | Mini PC 上的唯一业务数据源，不部署独立数据库服务 |
| SQLite Driver | `better-sqlite3` | 同步本地访问；必须控制查询时长和事务范围 |
| ORM / Migration | Drizzle ORM + Drizzle Kit | SQLite dialect；SQL 可见、Schema 和迁移可审查 |
| Runtime Schema | JSON Schema / TypeBox | 定义接口输入输出并推导 TypeScript 类型 |
| 前端 | React + TypeScript + Vite | 新版独立 Web UI |
| 测试 | Vitest | 单元、集成和契约测试 |
| E2E | Playwright | 浏览器及完整任务流程 |
| 代码规范 | ESLint + Prettier（或经确认的单一等效工具链） | 统一格式和检查 |
| 文件存储 | Mini PC 本地文件系统 | 第一版附件和任务产物保存在独立 data 目录；不把大文件写入 SQLite |
| 公网 | Cloudflare Tunnel | 不公开 Mini PC 源站端口 |
| 进程管理 | 原生系统服务 | Linux 使用 systemd；Windows 根据实际部署环境提供服务包装，不使用 Docker |

### Node 版本策略

- Room Server 使用当前经过验证的 Node.js LTS 版本。
- DSH Plugin 必须兼容实际运行它的 DSH Node 版本；当前环境若仍为 Node 24，Adapter 不得直接依赖仅 Node 26 才有的 API。
- CI 至少测试 Server 目标版本和 DSH Plugin 实际目标版本。
- SQLite 驱动首选 `better-sqlite3`；当前维护版本已提供 Node.js 26 预编译支持，但 M0/M1 仍必须在 Mini PC 的实际 OS / CPU 架构上验证安装、启动、备份和恢复。不要未经测试就升级原生依赖。
- 不要在代码中散落版本号。使用 `engines`、`.node-version` / `.nvmrc`、CI matrix 和文档统一管理。
- 生产使用编译后的 JavaScript；开发阶段使用 TypeScript 类型检查与测试。不要把 Node 原生 TypeScript 类型剥离当作完整的类型检查器。

## 3.2 架构模式

采用 **Modular Monolith（模块化单体）**：

- 一台 Mini PC 运行一个 Room Server 实例；
- 一个本地 SQLite 数据库文件，由 Room Server 独占管理；
- 内部业务模块有清晰边界；
- Web 与 Server 可分开构建，但生产环境可以由同一个 Node.js Server 提供静态前端文件和 API；
- Host Agent / DSH Plugin / Codex Adapter 是独立运行组件；
- Room Server、cloudflared 和数据库都以原生进程/系统服务运行；
- 不使用 Docker / Docker Compose，不在第一版拆成微服务；
- 第一版不需要 Redis 或独立消息队列。

## 3.3 原则

1. **协议优先**：跨进程、跨电脑、跨语言都依靠版本化协议，不依赖共享内存或私有模块。
2. **Server 是身份、权限和数据的权威来源**：客户端提交的 `agentId`、`userId` 不能作为授权依据。
3. **至少一次投递 + 幂等处理**：不承诺网络层严格 exactly-once；用持久化 inbox、ack、idempotency key 和状态恢复实现业务效果不重复。
4. **AI 的原生会话独立映射**：群组和 Thread 不得误用其他群组的原生上下文。
5. **消息与任务分离**：Message 是交流记录；Thread 是讨论上下文；Task 是需要执行和追踪的工作实体。
6. **执行留在主机**：Room Server 负责授权、路由、状态和事件，不执行用户电脑上的本地命令。
7. **权限最小化**：群聊权限不等于文件执行权限；用户可以发消息不代表可以修改每台主机。
8. **可诊断**：所有跨服务操作有 correlationId、causationId、agentId、taskId / threadId（适用时）和结构化日志。


## 3.4 为什么第一版选择 SQLite，而不是 PostgreSQL

本项目是个人使用的单机中心服务：Room Server 部署在一台 Mini PC 上，多个浏览器和远程 Agent 通过 HTTPS / WSS 访问；只有这一台 Mini PC 上的 Room Server 进程直接访问数据库。基于这一部署拓扑，第一版采用 SQLite，避免额外数据库服务、容器和运维组件。

选择 SQLite 的前提和边界：

- 数据库只由一台 Mini PC 上的单个 Room Server 实例访问；
- 数据文件位于本机 SSD / 本地文件系统，不放网络共享或同步盘；
- WAL 模式支持读写并行，但写事务仍然串行；
- 通过短事务、索引、分页、写入队列和 Outbox 控制写入竞争；
- 不在事务中执行 AI 推理、网络请求、文件上传或等待审批；
- 定期执行在线备份，并验证可恢复性。

只有在实际测量出现持续写锁等待、写入队列饱和、需要多个 Room Server 实例共同写入、或出现明确高可用/多主机数据库需求时，才重新评估 PostgreSQL。不能只因为数据库文件变大或未来可能增加 Agent，就自动升级数据库。

## 3.5 原生部署，不使用 Docker

生产 Room Server 部署在用户自己的 Mini PC。Node.js Room Server 和 cloudflared 以原生程序/系统服务运行；SQLite 是由 Room Server 进程打开的本地数据库文件，不是独立服务。第一版不提供 Dockerfile 或 Docker Compose 作为正式部署路径，也不要求安装 PostgreSQL、Redis 或 Nginx。

M0 必须确认 Mini PC 的操作系统、CPU 架构、Node 版本和数据磁盘位置，再制定唯一的主部署路径。Linux 使用 systemd；只有目标机器为 Windows 时才实现 Windows Service 包装。程序更新与 `data/`、`config/` 分离。

---

# 4. 目标 Monorepo 目录

建议目标结构如下。M1 建立最小结构，后续按阶段填充；不要为了目录齐全提前制造空模块。

```text
ai-room/
├── apps/
│   ├── server/                  # Fastify Room Server
│   │   ├── src/
│   │   │   ├── app.ts
│   │   │   ├── main.ts
│   │   │   ├── config/
│   │   │   ├── plugins/         # Fastify plugins：db、auth、ws、static
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── users/
│   │   │   │   ├── groups/
│   │   │   │   ├── members/
│   │   │   │   ├── messages/
│   │   │   │   ├── agents/
│   │   │   │   ├── agent-keys/
│   │   │   │   ├── routing/
│   │   │   │   ├── threads/
│   │   │   │   ├── tasks/
│   │   │   │   ├── approvals/
│   │   │   │   ├── attachments/
│   │   │   │   └── audit/
│   │   │   ├── realtime/
│   │   │   ├── jobs/
│   │   │   └── index.ts
│   │   └── test/
│   ├── web/                     # React + Vite
│   └── host-agent/               # Codex / generic Agent 本机运行时
│       └── src/
│           ├── connection/
│           ├── identity/
│           ├── supervisor/
│           ├── permissions/
│           └── adapters/
│
├── adapters/
│   ├── dsh-plugin/               # DSH Cordis Plugin，运行在 dsh-web 内
│   │   └── src/
│   ├── codex/                    # Codex App Server Adapter
│   │   └── src/
│   └── template/                 # 第三方 Adapter 示例
│
├── packages/
│   ├── protocol/                 # 消息 / WS 事件 / Agent 协议类型
│   ├── schemas/                  # JSON Schema / TypeBox 验证规则
│   ├── agent-sdk/                # Agent 连接、认证、收发和 ack SDK
│   ├── database/                 # SQLite Drizzle schema / migration / repositories
│   ├── config/                   # 环境配置 schema
│   ├── logging/                  # 结构化日志与 redaction
│   └── shared/                   # 无业务副作用的公共工具
│
├── deployment/
│   ├── systemd/                  # Linux 原生服务单元示例
│   ├── windows/                  # 如目标 Mini PC 为 Windows，提供服务包装配置
│   ├── cloudflare/               # Tunnel / Access 配置说明
│   └── scripts/                  # 安装、更新、备份、恢复脚本
│
├── data/                         # 仅运行时创建；不要提交 Git
│   ├── room.db                   # SQLite 数据库（WAL/SHM 由 SQLite 管理）
│   ├── attachments/              # 上传文件和任务产物
│   ├── credentials/              # 服务器凭据，严格限制 ACL
│   ├── logs/                     # 应用日志
│   └── backups/                  # 本地备份副本，另需异地备份
│
├── config/                       # 运行配置示例；秘密不提交 Git
├── scripts/                      # 开发/维护入口脚本
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PROTOCOL.md
│   ├── DATABASE.md
│   ├── SECURITY.md
│   ├── DSH-ADAPTER.md
│   ├── CODEX-ADAPTER.md
│   ├── DEPLOYMENT.md
│   ├── MIGRATION.md
│   └── RUNBOOK.md
├── tests/
│   ├── contract/
│   ├── integration/
│   └── e2e/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
└── README.md
```

### 目录边界

- `apps/server` 不得直接 import `adapters/dsh-plugin` 或 `adapters/codex` 的内部代码。
- `adapters/*` 只能通过 `@room/agent-sdk` 和 `@room/protocol` 与 Room 交互。
- `apps/web` 只能通过公开 API / WebSocket 协议交互，不得直接访问数据库。
- `packages/protocol` 不允许依赖 Fastify、React、Drizzle 或某个具体 AI 引擎。
- `packages/schemas` 定义可运行时验证的数据结构；共享类型应从 Schema 推导，避免手写两套互不一致的类型。
- `packages/database` 只能被 Server 和迁移工具使用。

---

# 5. 核心模块职责

## 5.1 Auth / Users

负责：

- 验证 Cloudflare Access JWT；
- 将经过验证的外部身份映射为 Room User；
- 用户角色和禁用状态；
- 首次 Owner 初始化；
- API 认证中间件；
- RBAC 权限校验。

角色：

| 角色 | 典型权限 |
|---|---|
| Owner | 完整系统权限、管理管理员、恢复系统 |
| Admin | 管理用户、群组、Agent、Agent Key 和系统设置 |
| Member | 参与被授权群组、创建任务、分配有权使用的 Agent |
| Readonly | 只读查看被授权内容 |

首次 Owner 只能通过服务端环境变量中的 bootstrap email / 外部身份完成一次性初始化。不能开放公开注册后让用户自选 Admin。

所有敏感操作由 Server 检查角色和资源关系。前端隐藏按钮不属于安全措施。

## 5.2 Groups / Members

负责：

- 创建、修改、归档群组；
- 用户和 Agent 加入 / 移出群组；
- 群组私有性与成员权限；
- 每个群组的 AI 自主参与策略；
- 群组系统提示、名称、主题和设置。

同一个 Agent 可以加入多个群组，但每个群组上下文独立。

群组配置至少包括：

```ts
interface GroupAISettings {
  participationMode: "all" | "mention" | "disabled";
  allowAgentMessages: boolean;
  maxHops: number;
  maxRepliesPerRoot: number;
  maxAgentMessagesPerMinute: number;
  maxTokensPerRoot?: number;
}
```

初始默认：`participationMode = "all"`，`allowAgentMessages = true`，但必须启用限额。群组管理员可调整。

## 5.3 Messages

负责：

- 用户、Agent、系统消息；
- 普通群聊消息与 Thread 消息；
- 回复引用、编辑、删除（按权限）；
- 附件引用；
- 消息序号和游标；
- rootMessageId / causationId / hop；
- 幂等创建。

消息必须知道：所属群组、发送者类型和 ID、是否处于 Thread、回复对象、讨论链根消息和创建时间。

## 5.4 Agent Registry / Agent Keys

负责：

- Agent 注册；
- 稳定 Agent ID；
- 公钥登记和指纹；
- Agent 显示名称、引擎、模型、能力和运行版本；
- 在线状态；
- Agent 与群组关系；
- Key 轮换、吊销；
- 每个 Agent 当前连接租约。

**Agent ID 是身份，Public Key 是凭据。** 不得直接把公钥或 fingerprint 当作业务 Agent ID。

一个 Agent 可在密钥轮换后保留原 Agent ID。一个 Host 可以运行多个 Agent；第一版可以不实现完整 Host 管理界面，但数据设计应预留可选 `hostId`。

## 5.5 AI Router / Participation Engine

负责：

- 用户普通消息分发给群组内所有在线、有权限的 Agent；
- Agent 自主判断是否发言；
- `@Agent` 定向消息；
- Agent-to-Agent 回复；
- 讨论链深度和消息预算；
- 防止自己的消息再次触发自己；
- 不把系统通知、心跳、Task progress 等消息误当成闲聊输入。

注意：`all` 表示所有在线 AI 都有机会接收并判断，不表示必须全部回答。

Agent SDK 的消息处理结果必须允许：

```ts
type ParticipationResult =
  | { action: "reply"; text: string; ... }
  | { action: "skip"; reason?: string }
  | { action: "request_task"; task: ... };
```

`skip` 不创建公开聊天消息，但可以写入脱敏的内部诊断事件。不要要求 Agent 发送“我没有意见”来代表不回复。

## 5.6 Threads / Tasks

两者分开建模：

- **Thread**：一段独立讨论上下文，归属于某个 Group，并关联一条源群聊消息。
- **Task**：需要实际执行的工作，可以关联一个 Thread，包含状态、执行者和运行记录。

用户把群聊消息转成工作任务时，在同一数据库事务中创建 Thread 和 Task。

Thread 至少记录：

- `id`；
- `groupId`；
- `rootMessageId` / `sourceMessageId`；
- `title`；
- `createdByUserId`；
- `status`；
- `createdAt` / `updatedAt` / `closedAt`。

Task 至少记录：

- `id`；
- `threadId`；
- `groupId`；
- `sourceMessageId`；
- `title` / `description`；
- `status`；
- `priority`；
- `assignedAgentId`（或独立多执行者关系）；
- `createdByUserId`；
- `createdAt` / `updatedAt`。

Task 状态建议：

```text
queued -> assigned -> running
                      ├── waiting_approval
                      ├── paused
                      ├── succeeded
                      ├── failed
                      └── cancelled
```

详细执行日志、工具调用结果和审批记录留在 Thread / Task Run 内，不要把所有终端输出刷到群聊。

任务最终结束时，生成一条 `task_summary` 或系统摘要消息写入原 Group，包含：结果摘要、Thread 链接、相关附件、失败/未完成说明。

多 Agent 协作时：主 Thread 可以有协调 Agent，子任务有各自 Task Run 或子 Thread。对同一个工作目录的并发修改必须使用工作区锁、分支隔离或串行策略，不能默认让多个 Agent 同时写同一个文件。

## 5.7 Realtime / Event Delivery

负责：

- 浏览器 WebSocket；
- Agent WebSocket；
- 在线状态；
- 事件持久化和恢复；
- 每个 Agent 的待投递事件；
- ack / retry / dedupe；
- 连接关闭清理。

第一版采用一个 Node Server 进程内的 Event Hub，但消息、事件和 Agent Delivery 必须先通过 SQLite 事务持久化。内存 Event Hub 只负责实时广播，不是唯一消息存储。

---

# 6. 数据库设计要求

正式部署目标是 **Mini PC 本地 SQLite 文件**。M2 前必须输出完整 ERD、Drizzle SQLite Schema 和迁移脚本。以下是最低实体集合，不是要求一次性把所有字段全部实现。

| 表 | 主要内容 |
|---|---|
| `users` | Room 用户、角色、状态 |
| `external_identities` | Cloudflare Access Issuer + Subject 与 Room User 映射 |
| `groups` | 群组和 AI 参与策略 |
| `group_members` | User / Agent 成员关系 |
| `agents` | 稳定 Agent ID、显示名、Runtime、Model、Capabilities、状态 |
| `agent_keys` | Ed25519 公钥、fingerprint、有效状态、轮换记录 |
| `agent_connections` | 活跃连接、连接租约、最后心跳 |
| `messages` | 群聊及 Thread 消息 |
| `threads` | 独立讨论上下文 |
| `tasks` | 工作任务 |
| `task_runs` | Agent 每次执行记录 |
| `agent_sessions` | Agent 原生会话与 Group / Thread 的映射 |
| `agent_deliveries` | 发给 Agent 的持久化事件、ack 和重试状态 |
| `approvals` | 高风险操作审批 |
| `attachments` | 上传文件元数据和本地相对路径 / 存储 Key |
| `events` | 持久化领域事件/事件日志 |
| `audit_logs` | 用户与 Agent 的敏感操作审计 |
| `schema_migrations` | 已应用的数据库迁移版本（由迁移工具管理） |

### 6.1 SQLite 运行约束

- 使用 `better-sqlite3` 作为 SQLite Driver，Drizzle ORM 使用 SQLite dialect；M0 必须在目标 Mini PC 操作系统和 Node 版本上验证原生模块安装与运行。
- 数据库文件必须位于 Mini PC 本地 SSD / 本地文件系统，例如 `data/room.db`；禁止放在 SMB/NFS 网络共享目录、NAS 挂载目录、OneDrive/Dropbox 等同步目录。
- 第一版只有一个 Room Server 进程拥有数据库写权限。不要同时启动两个生产 Server 实例访问同一数据库文件；启动时应使用进程锁或等效机制防止误启动第二实例。
- 启用 `journal_mode=WAL`、`foreign_keys=ON` 和合理的 `busy_timeout`；初期以 `synchronous=FULL` 优先数据可靠性，若用户之后选择性能优化，必须通过断电/崩溃测试后调整。
- WAL 允许读写并行，但 SQLite 同一时刻仍只有一个写事务。所有写事务必须短小、快速，禁止在事务内部调用 AI、网络 API、文件上传或等待用户审批。
- 使用单一写入服务/写入队列组织状态变更；多个请求不能各自开启长事务后互相等待。
- 对消息历史、事件列表和审计记录强制分页；禁止无边界加载全表。
- `better-sqlite3` 是同步 API，查询会占用 Node.js 事件循环。所有在线查询必须有索引、限制返回行数并避免大对象序列化；大批量导入、全库扫描或耗时维护操作应放在独立维护命令或 Worker Thread 中，不得阻塞实时聊天。
- 每次发布前检查数据库完整性、迁移状态和磁盘剩余空间；数据库文件、WAL/SHM 辅助文件由 SQLite 管理，程序不得手动删除正在使用的 WAL/SHM 文件。
- 附件和大型任务产物存储在 `data/attachments/`，SQLite 只保存元数据、校验值和相对路径；下载时必须重新验证用户/群组权限。

### 6.2 Schema 与类型约束

- 所有主键使用稳定、不可猜测的 ID（UUID/ULID 均可，项目统一一种）。
- `agent_keys.fingerprint` 唯一；已撤销 Key 不得重新作为有效 Key。
- `agent_sessions` 对 `(agentId, scopeType, scopeId)` 建唯一约束，防止同一 Agent 在同一 Group / Thread 出现多个意外会话绑定。
- 时间统一存 UTC Unix 毫秒整数或 ISO UTC 文本，项目只能选择一种 SQLite 存储格式；API 协议统一输出 ISO 8601 UTC 字符串。
- 布尔值存为 SQLite INTEGER 0/1；枚举用 TEXT 并由 Schema 校验。
- JSON 字段必须通过运行时 Schema 校验后再序列化为 TEXT；禁止把未经校验的任意对象直接当成数据库结构。
- 外键和必要索引必须显式建立；M2 输出索引说明及关键查询计划。
- 删除用户、Agent、Group 时优先软删除或归档，除非用户明确要求永久清除。
- 不将私钥、Agent Session Ticket、Cloudflare Secret 存入 Agent Profile 或公开 API 响应。
- 对敏感字段使用专用表和最小查询，不使用 `SELECT *` 序列化所有实体。

### 6.3 事件持久化与事务

使用 SQLite 事务保证：业务变更、`events` 记录和要投递的 `agent_deliveries` 在同一个事务中提交。

可以采用 `events` 表作为可重放事件日志，并在同一事务写入 Outbox / Delivery 状态；必须实现 Transactional Outbox 等价保证。先提交数据库，再广播实时事件。广播失败时，持久化事件仍可由重连流程补发。

禁止：先修改内存再广播、广播成功后才保存业务数据、或依赖进程内 Map 保存唯一幂等记录。

### 6.4 WAL、备份与恢复

- 使用 SQLite 官方 Backup API，或经过测试的 SQLite 一致性备份方式；不能假设运行期间复制单独 `.db` 文件就一定包含最新提交。
- 备份应保存到 `data/backups/` 之外的独立磁盘或异地位置；同一 SSD 上的备份不能作为唯一灾难恢复方案。
- 每日备份，保留最近 14–30 天；具体保留量可配置。
- 每周或每次发布后执行一次恢复演练：恢复到临时目录，运行 `PRAGMA integrity_check`、外键检查和应用级数据检查。
- 提供 `db:backup`、`db:restore-check`、`db:integrity-check` 命令；恢复正式数据库前必须停止 Room Server 并要求明确确认。
- 监控 `room.db`、`room.db-wal` 的大小及磁盘空间；按 SQLite 正常 checkpoint 机制管理 WAL，不手动删除。

### 6.5 不引入 Redis / PostgreSQL / Docker 的第一版约束

第一版只使用 SQLite + Node 进程内 Event Hub + SQLite 持久化事件和任务表。不得为了“以后可能扩展”提前安装 Redis、PostgreSQL 或 Docker。未来只有在实际出现多服务器写入、持续明显的 SQLite 写锁等待、单写入队列饱和或可用性需求变化时，才重新评估 PostgreSQL；迁移必须是独立项目并有量化证据。

---

# 7. 统一协议与实时通信

## 7.1 协议版本

所有跨进程协议必须带：

- `protocolVersion`；
- `eventId`；
- `eventType`；
- `timestamp`；
- `correlationId`；
- `causationId`（适用时）；
- `groupId` / `threadId` / `taskId`（适用时）；
- `payload`。

示例：

```json
{
  "protocolVersion": 1,
  "eventId": "evt_01...",
  "eventType": "group.message.created",
  "timestamp": "2026-11-22T12:00:00.000Z",
  "correlationId": "corr_01...",
  "causationId": null,
  "groupId": "grp_01...",
  "threadId": null,
  "payload": {
    "messageId": "msg_01...",
    "senderType": "user",
    "senderId": "usr_01...",
    "content": "大家有什么建议？",
    "rootMessageId": "msg_01...",
    "hop": 0
  }
}
```

## 7.2 Agent WebSocket

建议 Agent 通过 WSS 建立长连接：

```text
wss://agent.example.com/api/v1/agent/connect
```

连接建立后先完成 Ed25519 Challenge / Response，再允许业务事件。

认证成功时，服务端将该连接绑定到验证出的 Agent ID。之后 Agent 发送的 payload 不得覆盖 `agentId`、`senderId` 等服务端身份字段。

Agent 连接至少支持：

- `hello` / `challenge` / `authenticate` / `authenticated`；
- `agent.status`；
- `event.deliver`；
- `event.ack`；
- `message.send`；
- `task.accept` / `task.progress` / `task.complete` / `task.fail`；
- `approval.request`；
- `agent.capabilities.update`；
- `ping` / `pong`。

具体字段必须在 `packages/protocol` 和 `docs/PROTOCOL.md` 中定义，不能分散在 Server、DSH Plugin 和 Codex Adapter 中手写不同版本。

## 7.3 投递语义

采用 **at-least-once delivery + idempotent processing**：

1. Server 将 Agent 应收到的事件写入持久化 delivery/inbox。
2. Agent 收到后先落本地 durable queue，再发送 ack；不能先 ack 后入内存队列。
3. Agent 处理任务时，以 `eventId` 或 `taskRunId` 作为幂等键。
4. Agent 处理完成后回传结果，Server 持久化结果和完成状态。
5. 断线重连后，Server 重发尚未 ack / 未完成的事件。
6. Agent 重复收到相同事件时，不应再次创建相同 DSH Prompt 或 Codex Turn。
7. 如果任务已启动但结果未知，先查询原生会话/任务状态；不能无条件再次执行。

不承诺网络传输层 exactly-once。必须通过持久化状态机实现业务上的重复执行保护。

## 7.4 事件分类

至少区分：

- `group.message.created`：普通群聊新消息；
- `thread.message.created`：Thread 内消息；
- `agent.status.changed`：在线状态；
- `task.assigned`：工作任务分配；
- `task.started` / `task.progress` / `task.waiting_approval`；
- `task.completed` / `task.failed` / `task.cancelled`；
- `approval.requested` / `approval.resolved`；
- `agent.capabilities.changed`。

心跳、在线状态、系统提示、任务进度不应触发普通 AI 自主闲聊机制。

---

# 8. 用户认证与 Agent Ed25519 身份

## 8.1 人类用户

生产公网入口通过 Cloudflare Access 登录。

Room Server 必须验证 Cloudflare Access JWT 的签名、Issuer、Audience、Expiration 等声明；不能只检查某个请求头是否存在，也不能直接信任浏览器提交的 email。

验证成功后，通过 `(issuer, subject)` 映射到 `users`，然后由 Room 自身 RBAC 判断权限。

第一次 Owner 初始化通过服务器端环境配置的 bootstrap identity 完成，仅允许一次性绑定。开发环境可以提供明确隔离的 Dev Auth Provider，但生产模式必须拒绝 Dev Auth。

建议分离：

- `chat.example.com`：浏览器入口，Cloudflare Access 登录；
- `agent.example.com`：Agent WSS 入口，应用层 Ed25519 认证；Cloudflare Service Auth 可作为额外网络层保护，但不得替代 Agent 密钥身份。

如果对 Agent 域名启用 Cloudflare Service Token，应考虑每台设备/Agent 的凭据发放与撤销方式。不要把一个长期不变的全局 Service Token 当作唯一身份。

## 8.2 Agent 密钥生成

DSH 插件设置页提供“生成身份密钥”操作。

- 使用 Node.js `node:crypto` Ed25519。
- 私钥由运行在 DSH 后端的插件代码生成和保存；浏览器只能收到公钥。
- 不在浏览器 localStorage、插件 YAML、workspace 或 Git 仓库里保存私钥。
- 私钥放在 `$DSH_HOME/data/room-bridge/` 或平台适配的持久化目录；Windows 使用当前 DSH 用户的 NTFS ACL，Linux 使用 `0600`。
- 密钥生成后不自动重建；若文件丢失，需要执行受控重新绑定流程。
- 设置页显示公钥和 SHA-256 fingerprint，并提供复制公钥按钮。
- 设置页永远不回显私钥。

公钥格式选定一种明确格式（建议 PEM SPKI，或明确支持 OpenSSH Ed25519 格式并规范化到同一 DER 公钥）；不要接受模糊、多格式而无校验的输入。

## 8.3 管理员添加 Agent

流程：

1. Admin 在 Room Web 的 Agent 管理页点击“添加 Agent”。
2. 粘贴 DSH 插件或 Host Agent 显示的公钥。
3. 填写 Agent 显示名称、运行时类型（`dsh` / `codex` / `other`）、能力标签和可加入群组。
4. Server 验证公钥格式、算法、长度和 fingerprint 唯一性。
5. Server 生成不可变的 `agentId`，创建 Agent 记录和 Active Agent Key 记录。
6. UI 显示 Agent ID 和 fingerprint。
7. Agent 第一次连接时用对应私钥完成 Challenge / Response。
8. Server 根据验证过的 Key 找到 Agent ID，返回已绑定的 Agent Profile。

**Client 不决定 Agent ID。** 连接请求即使带 Agent ID，也只能作为提示；身份以服务端验证的 Key 绑定记录为准。

## 8.4 身份与密钥分离

数据结构建议：

```text
agents
  id                  # 稳定、不可变的 Agent ID
  display_name
  runtime
  model
  status
  capabilities
  created_at

agent_keys
  id                  # keyId
  agent_id            # 外键指向稳定 Agent ID
  algorithm           # ed25519
  public_key
  fingerprint         # 唯一
  status              # active / revoked
  created_at
  revoked_at
```

一个 Agent 可以更换公钥，但 Agent ID、群组成员关系、聊天历史、Task 和 Thread 不变。

## 8.5 Challenge / Response

使用服务器随机生成的一次性 Challenge，绑定：

- `serverId`；
- `challengeId`；
- 随机 nonce；
- 客户端 nonce；
- timestamp / expiresAt；
- protocolVersion；
- 目标连接用途（Agent connect）。

Agent 使用私钥签名规范化后的挑战内容；Server 用登记公钥验证。Challenge 必须短时有效、一次使用，防止重放。

认证完成后，Server 把该 WebSocket 连接绑定到已验证 Agent ID。业务事件不能自行指定或冒充其他 Agent。

HTTP 管理操作和 Agent 业务操作必须分开鉴权。若仍保留 Agent HTTP API，则必须使用相同的签名规范（method、path、body hash、timestamp、nonce 等）并防止重放。

## 8.6 密钥轮换与吊销

- Admin 可以吊销失效 Key。
- Agent ID 不变。
- 轮换可以由仍有效的旧 Key 签名发起，或由 Admin 在 Web 管理页重新登记新公钥。
- 第一版可先实现“Admin 添加新 Key + 吊销旧 Key”；不要为了完整轮换协议延迟 MVP。
- Key 被吊销后，现有连接立即关闭，后续连接拒绝。

---

# 9. AI 自主群聊与防循环

## 9.1 正常用户消息

当用户在 Group 发送普通消息时：

1. Server 校验用户是 Group 成员。
2. 在数据库中保存消息。
3. 同一事务写入消息事件。
4. 查询该 Group 中在线且有权限的 Agent。
5. 根据 `participationMode` 创建持久化 delivery。
6. 所有符合条件的 Agent 收到事件。
7. 每个 Agent 自主选择 `reply` 或 `skip`。
8. 回复作为新的 Agent Message 保存并广播。

## 9.2 Agent 之间交流

群组允许 Agent 消息触发其他 Agent，但必须满足：

- 发送者不是接收者自己；
- 接收者属于该群组且在线/允许接收；
- `allowAgentMessages` 开启；
- rootMessageId 可追踪；
- hop 没超过群组上限；
- 当前讨论链的 AI 消息数和费用未超预算；
- 消息不是 system、presence、task progress 或工具日志事件。

建议第一版可配置默认限制（都允许管理员修改）：

| 限制 | 建议默认 |
|---|---:|
| 最大 hop | 4 |
| 每个 root 的 Agent 回复总数 | 8 |
| 每个 Agent 每分钟普通自动回复 | 6 |
| 单个 root 的 token / cost 预算 | 可选，若引擎支持 usage 则执行 |
| 单 Agent 同时处理的普通聊天轮次 | 1（可配置） |

这些是安全阈值，不是“所有模型必须回复 4 次”。达到上限就静默停止自动链，保留诊断记录。

## 9.3 不要用无限广播实现协作

禁止将 Agent 回复无条件再次广播给全部 Agent 而不检查 root / hop / sender / budget。

建议每个 Agent 的 `participation` 输入包括：

- 最近有限条群聊上下文；
- 当前消息；
- 讨论链 root；
- 已经有哪些 Agent 发表意见；
- 当前 hop 和剩余预算；
- 群组系统规则。

Agent 可以返回 `skip`。跳过不生成用户可见消息。

## 9.4 自动参与与任务执行分开

普通讨论不自动执行文件修改、Shell、安装软件或浏览器操作。

工作任务必须显式创建 Task / Thread，并经过权限检查；高风险操作需要审批。

---

# 10. Thread 与 Task 运行流程

## 10.1 从群聊创建任务

用户从一条群聊消息选择“创建工作任务”：

1. 创建 Thread，关联 `groupId` 和 `sourceMessageId`。
2. 创建 Task，关联 Thread、Group 和源消息。
3. 选择执行 Agent 或指定多个 Agent。
4. 创建 Task Run / Agent Delivery。
5. 在群聊增加任务卡片或任务入口消息。

## 10.2 Thread 内的消息

- Thread 有独立消息时间线。
- Thread 可以包含用户、执行 Agent、协作 Agent 和系统消息。
- Agent 在 Thread 内继续使用其对应原生会话，避免丢失上下文。
- 详细工具输出可以折叠或以事件形式展示，不能全部刷进父群组。
- 用户可以在 Thread 追加要求、暂停、取消或审批。

## 10.3 完成回流

Task 完成时：

- 更新 Task 和 Thread 状态；
- 保存最终摘要、文件和执行记录；
- 在原 Group 创建一条 summary 消息；
- 消息包含 Thread 链接；
- 失败任务也要返回失败原因和已完成/未完成范围；
- 不允许只在 Agent 内部日志里显示“完成”而 Room 没有状态。

## 10.4 多 AI 协作

支持三种模式：

- 单 Agent 执行；
- 多 Agent 独立分析，最终由用户或协调 Agent 汇总；
- Coordinator 分配子任务、子 Agent 回传结果、主 Thread 汇总。

第一版优先实现单 Agent 与多 Agent 独立分析。Coordinator / 子任务可以在后续里程碑实现。

同一工作区写操作默认不可并行。要实现并行，必须采用独立 Git Worktree / 分支 / 不同工作目录，或显式文件锁和冲突检测。

---

# 11. Adapter 设计

## 11.1 统一 Agent SDK

建议最小接口：

```ts
export interface RoomAgentAdapter {
  start(context: AdapterContext): Promise<void>;
  stop(): Promise<void>;

  handleGroupMessage(
    message: GroupMessageContext
  ): Promise<ParticipationResult>;

  handleThreadMessage(
    message: ThreadMessageContext
  ): Promise<AdapterResult>;

  executeTask(
    task: TaskContext
  ): Promise<TaskExecutionHandle>;

  cancelTask(taskRunId: string): Promise<void>;

  getCapabilities(): Promise<AgentCapability[]>;
}
```

这是平台自己的接口，不是要求 DSH 和 Codex 官方实现相同接口。Adapter 负责转换平台模型和引擎模型。

所有执行必须支持 AbortSignal / cancel、超时、结构化事件、错误码和幂等 request ID。

## 11.2 DSH Adapter

必须保留现有 `dsh-room-bridge` 的有效能力：

- 运行在 DSH Cordis Plugin 环境；
- 使用 DSH 现有注入服务；
- 有稳定的 Session ID 绑定；
- 不自动猜测多个同名会话；
- 不默认自动创建或销毁 Session；
- 不改 `workspace.json`；
- 不在没有用户同意时重启 DSH；
- 使用 `room-<messageId>` 或新版幂等 ID 将 Room delivery 映射到 DSH Prompt；
- 监听正确 Session 的 assistant / turn 生命周期；
- 正确取得一轮最终答复，而不是把工具过程全部发回群聊；
- 断线和 Session disposed 后可恢复或提示人工重新绑定。

### DSH 多群组映射

目标映射：

```text
(agentId, groupId)          -> DSH sessionId
(agentId, threadId)         -> DSH sessionId
```

执行 M4 前先调查当前目标 DSH 版本是否提供受支持的创建、恢复、查询和关闭 Session 的 Cordis 服务。

- 若有受支持 API，可以在管理员允许的策略下创建 Thread 专用 Session。
- 若没有，则第一版要求用户手动绑定已有 Session，不能使用未公开的文件写入 hack。
- 不允许一个 Agent 的多个群组默认共享同一个原生 Session，除非用户明确接受上下文共享。
- Session 缺失时宁可暂停任务并提示，不要静默切换到别的会话。

### DSH 设置页

设置页最少提供：

- Room Server URL；
- Agent 公钥 / fingerprint 显示；
- 生成密钥对；
- 复制公钥；
- 连接状态；
- 服务端分配的 Agent ID；
- Group / Thread Session 映射；
- 测试连接；
- 撤销 / 重新绑定说明。

私钥由插件后端生成并保存在本机持久化目录，浏览器不能读取私钥内容。

## 11.3 Codex Adapter

- 本机启动 Codex App Server 子进程；
- 优先使用 `stdio` JSON-RPC；
- 处理 Thread、Turn、消息事件、审批和取消；
- 将事件转换为统一 Room Protocol；
- 使用独立 Agent ID 和独立 Ed25519 Key；
- 不将 Codex API Key 上传 Room Server；
- 不将 Codex 本机进程暴露公网；
- Task/Thread 与 Codex 原生 Thread 的映射必须持久化；
- 断线时区分“网络连接丢失”和“Codex Turn 仍在运行”。

## 11.4 第三方 Adapter

至少提供一个 `adapters/template` 示例，展示第三方如何：

1. 生成 / 装载身份密钥；
2. 注册 Agent；
3. 连接 Room；
4. 收到事件；
5. ack；
6. 发送消息；
7. 执行任务；
8. 更新能力和状态。

未来新增 Agent 时，不应要求修改 Server 核心路由逻辑。

---

# 12. API 和前端范围

## 12.1 REST API

使用 `/api/v1` 版本前缀。至少覆盖：

```text
GET/POST       /api/v1/groups
GET/PATCH/DEL  /api/v1/groups/:groupId
GET/POST       /api/v1/groups/:groupId/members

GET/POST       /api/v1/groups/:groupId/messages
GET/PATCH/DEL  /api/v1/messages/:messageId

GET/POST       /api/v1/threads
GET/PATCH      /api/v1/threads/:threadId
GET/POST       /api/v1/threads/:threadId/messages

GET/POST       /api/v1/tasks
GET/PATCH      /api/v1/tasks/:taskId
POST           /api/v1/tasks/:taskId/assign
POST           /api/v1/tasks/:taskId/cancel

GET/POST       /api/v1/agents
GET/PATCH/DEL  /api/v1/agents/:agentId
POST           /api/v1/agents/:agentId/keys
DELETE         /api/v1/agents/:agentId/keys/:keyId
POST           /api/v1/agents/:agentId/groups

POST           /api/v1/approvals/:approvalId/approve
POST           /api/v1/approvals/:approvalId/reject

POST           /api/v1/attachments/presign
GET            /api/v1/attachments/:attachmentId
GET            /api/v1/events?cursor=...
```

实际 API 可以按实现调整，但需要 OpenAPI 文档、认证说明、权限矩阵、错误码和契约测试。

## 12.2 WebSocket

- Browser WebSocket：群组和 Thread 实时更新；
- Agent WebSocket：Agent 事件、ack、消息和任务；
- 同一用户只能收到自己有权访问的 Group / Thread 事件；
- Agent 只能收到自己加入的 Group 与分配给自己的 Task；
- 重连时提供 lastEventId / cursor 恢复；
- 断线后服务端保留未 ack 的 Agent Delivery。

## 12.3 Web UI

MVP 页面：

1. 登录；
2. 群组列表；
3. 群组聊天；
4. Thread 详情；
5. 任务列表 / 状态；
6. Agent 成员列表和在线状态；
7. Agent 管理（添加公钥、生成 Agent ID、改名、加入群组、吊销 Key）；
8. 用户 / 角色管理；
9. 基本设置。

群聊需要支持：Markdown、代码块、图片/文件、回复引用、@Agent、创建 Thread、任务状态卡片和 Thread 结果回流。

不要在 MVP 追求复杂动画或类似大型社交平台的全部功能。先保证消息可靠、会话上下文正确和任务可追踪。

---

# 13. Cloudflare 与 Mini PC 原生部署

## 13.1 部署原则

Room Server 部署在用户自己的 Mini PC 上，采用 **Node.js 原生进程 + SQLite 本地文件 + cloudflared 原生服务**。明确禁止把 Docker / Docker Compose 作为部署前提；第一版不需要 PostgreSQL、Redis、Nginx 或容器编排。

Mini PC 的实际操作系统必须在 M0 确认。优先提供该系统的原生服务配置：

- Linux（例如 Ubuntu）：使用 `systemd` 管理 `agentroom.service` 和 `cloudflared.service`；
- Windows：只有目标 Mini PC 确实使用 Windows 时，才提供 WinSW / NSSM 等 Windows Service 包装配置；不要同时维护无用的两套生产部署方案。

Room Server 作为单实例运行，使用专用非管理员系统账户。程序、配置、业务数据、日志和备份分开存放，升级程序不得覆盖用户数据。

## 13.2 域名与 Tunnel

建议两个 Hostname：

| 域名 | 用途 |
|---|---|
| `chat.<domain>` | 浏览器 UI / 用户 API |
| `agent.<domain>` | Agent WSS / Agent API |

两个 Hostname 可以转发到同一个 Room Server 本机端口，但应用必须根据 Host、路由和认证上下文实施不同访问策略。Agent Hostname 不能成为绕过 Room RBAC 的后门。

Room Server 默认只监听 `127.0.0.1:8787`。端口通过唯一配置项 `ROOM_HOST` / `ROOM_PORT` 管理；默认值、Cloudflare Tunnel 配置、服务单元和文档必须保持一致。不得监听 `0.0.0.0`，除非用户明确配置并理解风险。

cloudflared 在 Mini PC 上原生安装并作为独立系统服务运行，Tunnel Origin 指向 `http://127.0.0.1:8787`。启用 WebSocket 转发。路由器不需要开放入站端口，Room Server 不需要公网 IP。

## 13.3 Cloudflare Access 与应用层授权

- Browser 入口通过 Cloudflare Access 登录；
- Room Server 自己验证 Access JWT 签名、Issuer、Audience、Expiration；
- 邮箱只用于映射/显示，稳定身份使用经过验证的外部 Subject；
- Room RBAC 是最终授权来源；
- Agent 入口使用 Ed25519 Challenge / Response；Cloudflare Service Auth 可以额外加一层，但不替代 Agent 身份；
- 所有管理 API 和 Agent API 都必须有明确认证与授权策略；
- 不以“请求来自 Cloudflare”或“请求带有某个头”作为唯一身份判断；
- 未通过认证时拒绝请求，不能因缺少可选配置而静默放行。

## 13.4 原生运行目录

推荐逻辑布局（具体绝对路径由实际操作系统和安装脚本确定）：

```text
AgentRoom/
├── app/                       # 可更新程序
│   ├── server/dist/            # 编译后的 Server
│   ├── web/                    # Vite 构建产物（可由 Server 提供）
│   └── node_modules/           # pnpm 部署产物 / production dependencies
├── runtime/                    # 可选便携 Node Runtime；系统 Node 可替代
├── config/                     # 非秘密配置模板/示例
├── data/                       # 永久业务数据
│   ├── room.db                 # SQLite 数据库
│   ├── attachments/            # 用户上传和任务产物
│   ├── credentials/            # 服务器端凭据（严格 ACL）
│   ├── logs/                   # 应用日志
│   └── backups/                # 临时本地备份；还需异地备份
├── scripts/                    # 安装、启动、停止、更新、备份、恢复
└── README.md
```

生产安装时，建议将可更新程序放在版本化 release 目录，将数据放在稳定的数据目录（例如 Linux `/var/lib/agentroom`），配置放在受限目录（例如 `/etc/agentroom`）。更新只切换程序版本，不替换数据库、密钥、附件和配置。

SQLite 数据库必须放在 Mini PC 本地 SSD / 本地文件系统，不能放 SMB/NFS、NAS 网络挂载或云同步目录。WAL 模式需要同一主机上的共享内存和文件锁语义。

## 13.5 服务管理与更新

Linux systemd 服务至少包含：

- `User=`：专用非 root 用户；
- `WorkingDirectory=`：当前程序版本目录；
- `ExecStart=`：调用指定 Node Runtime 执行编译产物；
- `EnvironmentFile=`：读取受限的服务配置；
- `Restart=on-failure` 和合理重启间隔；
- `NoNewPrivileges=true`、合理的文件系统权限限制（经测试后启用）；
- 标准输出/错误进入 journald，应用结构化日志也可写到独立日志目录。

更新脚本必须：

1. 检查磁盘空间和当前版本；
2. 备份 SQLite 数据库并验证备份；
3. 安装新 release 的 production dependencies；
4. 正常停止 Room Server，确认进程已退出且数据库连接已关闭；
5. 在服务停止状态下执行数据库迁移（必须可回滚或有备份恢复策略）；
6. 切换 release 并启动服务；
7. 检查 readiness 和核心 API；
8. 若启动/迁移失败，恢复上一版程序并按恢复步骤处理数据库；
9. 不覆盖 `data/` 和 `config/`。

## 13.6 本机 Agent 部署

- DSH Adapter 运行在 DSH 允许的插件生命周期内；
- Codex Adapter / Host Agent 可作为独立 Node 程序；
- 不依赖操作系统全局 Node 安装；可提供项目自带/便携 Node Runtime 的启动脚本；
- 不默认管理员权限运行；
- 只允许配置的工作目录；
- 断线自动重连；
- 程序退出时正确关闭子进程、WebSocket 和文件句柄。

---

# 14. 安全与权限要求

1. 所有 HTTP / WS 消息在 Server 端做 Schema 验证。
2. 每个接口执行身份认证和资源级授权。
3. Agent ID 由已认证连接绑定，不信任 payload 中自报的 ID。
4. Ed25519 私钥不离开本机，不上传服务器。
5. Agent Key 可单独吊销，吊销后关闭现有连接。
6. Cloudflare JWT 不能只检查请求头存在。
7. 不能把 Cloudflare Access 的登录视为 Room 内所有资源的授权。
8. 群聊成员资格与本地文件权限分离。
9. 默认禁止 Agent 访问未授权目录。
10. 危险操作（删除大量文件、修改系统、安装软件、访问凭据目录、生产部署等）必须经过明确审批。
11. 不允许未经用户授权在一个 Agent 的工作区执行另一个 Agent 的任务。
12. Task 执行必须有超时、取消、输出上限和资源限制。
13. 日志对 Authorization、Cookie、私钥、Access Token、模型 API Key、签名内容做 redaction。
14. 文件上传检查大小、扩展名/MIME、路径穿越、压缩包解压路径和恶意文件风险。
15. WebSocket 检查 Origin（浏览器连接）、认证状态、最大帧大小、速率限制和空闲超时。
16. 所有重要管理操作写 `audit_logs`。
17. 开发模式认证必须由 `NODE_ENV=development` 显式启用；生产环境缺少必要认证配置时拒绝启动或拒绝服务。

---

# 15. 迁移与数据兼容

## 15.1 不直接把旧 Go Server 当作新架构基础

旧 Go 代码只作为：

- 现有业务行为参考；
- API 和数据迁移来源；
- 已验证逻辑的测试参考；
- DSH Plugin 的旧接口兼容参考。

新服务不得 import Go 代码，也不得依赖 Open Agent Room 上游内部包。

## 15.2 旧数据导入

编写一次性 importer，输入旧 `state.json`，输出新版 SQLite 数据库。

导入步骤：

1. 备份原 JSON；
2. 读取并验证版本；
3. 建立旧 ID 到新 ID 的映射；
4. 导入 users、groups/channels、agents、messages、tasks、task lanes、skills（若保留）；
5. 恢复必要的 createdAt / updatedAt；
6. 记录无法映射或被拒绝的记录；
7. 生成导入报告；
8. 对比导入前后的实体数量和关系；
9. 不覆盖旧备份。

如旧 Agent ID 是基于名字 slug 生成的，不得假设它符合新版稳定 ID 策略。迁移时保留 `legacyId` 字段或映射表，避免丢失历史消息作者关系。

不要导入旧共享 Token 作为新 Ed25519 Key。用户必须通过新流程登记公钥。

## 15.3 API 迁移

- 新版 API 使用 `/api/v1`；
- 可以保留一个短期 Legacy API Adapter 兼容旧 DSH 插件；
- Legacy API 内部调用新版 Service，不复制业务逻辑；
- 对每个旧接口注明替代接口、弃用版本和移除条件；
- 所有旧接口完成迁移后再删除。

## 15.4 切换与回滚

- 新旧 Server 可在测试环境并行运行；
- 正式切换前，旧服务进入只读或维护模式并备份；
- 不允许 Go 和 Node 同时写同一业务数据源；
- Node 迁移完成并通过数据检查后，切换 Cloudflare Tunnel Origin；
- 回滚时恢复旧 Server 和旧 JSON 备份；
- 切换后新增数据若要回滚，必须有明确导出策略，不能假设新版 SQLite 数据能自动写回旧 JSON；
- 正式切换后 SQLite 数据库只允许新版 Room Server 写入，禁止旧 Go Server 与新版 Node Server 同时写入同一数据文件。

---

# 16. 分阶段实施计划与验收标准

## M0：仓库调查与基线冻结

### 工作

- 完整检查仓库、Git 历史、补丁、文档与依赖；
- 识别 Open Agent Room 基线及上游代码许可；
- 确认 Mini PC 的操作系统、CPU 架构、Node.js 安装方式、SSD 路径和服务管理方式；
- 记录旧 API、数据结构、事件、Task、Agent 生命周期；
- 测试插件语法与当前 DSH API 依赖；
- 检查旧服务当前能否编译（若缺上游代码，记录确切缺失项）；
- 整理文档中补丁数量、端口和默认值的不一致；
- 创建 `docs/MIGRATION.md` 和本计划的实施记录。

### 验收

- 有完整模块清单和旧接口清单；
- 已记录目标 Mini PC OS、CPU 架构、Node 版本和数据库文件路径；
- 有旧数据结构到新数据实体的映射表；
- 有已知 bug / 风险清单；
- 没有删除或覆盖现有实现；
- 对无法本地复现的上游功能明确标注。

## M1：Monorepo 与原生 Node Server 骨架

### 工作

- 建立 pnpm workspace；
- 建立统一 TypeScript 配置和 lint / format / typecheck / test 脚本；
- 建立 `apps/server` Fastify；
- 建立 config schema、logger、error handler、health/readiness；
- 建立 `better-sqlite3` + Drizzle SQLite 连接；
- 建立 Drizzle SQLite migration 和数据库初始化命令；
- 设置并验证 WAL、foreign keys、busy timeout、synchronous；
- 增加单实例锁，避免同一生产 SQLite 文件被多个 Room Server 实例同时运行；
- 建立 WebSocket 最小连接和关闭流程；
- 建立原生启动脚本和目标操作系统的系统服务单元，不创建 Dockerfile 或 Compose；
- 建立 CI 检查，并在目标 Mini PC OS / Node 版本上做原生模块安装验证。

### 验收

- `pnpm install --frozen-lockfile` 成功；
- `pnpm lint` 成功；
- `pnpm typecheck` 成功；
- `pnpm test` 成功；
- `pnpm build` 成功；
- Server 能打开本地 SQLite 文件并完成读写；
- 重启后数据库数据保留；
- WAL 和外键配置通过自动化检查；
- 第二个 Server 实例不能同时打开生产数据库写入；
- 默认只监听 `127.0.0.1:8787`，不公开源站端口；
- 不需要 Docker、PostgreSQL、Redis 即可启动开发和测试环境。

## M2：数据库与 Room Core

### 工作

按模块实现：

1. Users / external identities / roles；
2. Groups / memberships；
3. Agents / Agent Keys；
4. Messages；
5. Threads；
6. Tasks / Task Runs；
7. Events / Outbox；
8. Audit Logs。

先实现服务层和权限规则，再接前端。

### 验收

- 多用户可以创建多个独立群组；
- 不在群组内的用户不能读取群消息；
- Agent 不能访问未加入的群组；
- Message、Thread、Task 外键关系一致；
- 一条群聊消息可以创建 Thread / Task；
- 任务完成摘要能写回父 Group；
- 业务写入、事件和 Agent Delivery 具有 SQLite 事务一致性；
- 事务内部没有 AI 请求、网络调用或用户等待；
- 服务重启后消息和 Task 状态恢复；
- 大量消息查询有分页和索引，不执行无边界全表读取。

## M3：身份认证与 Agent SDK

### 工作

- Cloudflare Access JWT 验证 Provider；
- Room User / RBAC；
- Owner bootstrap；
- Ed25519 密钥生成与 fingerprint；
- 管理员公钥添加和固定 Agent ID；
- Agent Challenge / Response；
- Agent WSS；
- Agent 在线租约；
- durable inbox / ack / reconnect；
- Agent SDK；
- SDK Mock Agent。

### 验收

- 未登录用户不能访问私有群组；
- Member 不能执行 Admin 操作；
- 未登记公钥的 Agent 不能连接；
- Agent 无法伪造另一个 Agent ID；
- Challenge 重放失败；
- Key 吊销后连接失效；
- Agent 重连能补齐未 ack 事件；
- 重复事件不会重复执行任务。

## M4：AI 自主群聊

### 工作

- `participationMode=all/mention/disabled`；
- Agent 收到群组消息；
- `reply/skip` 决策结果；
- Agent-to-Agent 讨论；
- rootMessageId、hop 和 budget；
- 消息频率限制；
- 忽略系统和 Task progress 事件；
- 每群组独立 Agent Session 映射；
- 前端显示 Agent 发言和在线状态。

### 验收

- 两个 Mock Agent 加入同一群组；
- 用户发消息后两个 Agent 都能收到；
- 一个 Agent 可以 `skip`，不产生公开回复；
- 两个 Agent 能在限制内交流；
- 自己的消息不会触发自己；
- 超过 hop / reply / rate limit 后停止自动交流；
- 群组 A 的消息不会出现在群组 B 的会话上下文中。

## M5：Thread / Task Engine

### 工作

- 从群消息创建 Thread 和 Task；
- 单 Agent 分配；
- 多 Agent 独立分析；
- Task Run 状态机；
- 进度、暂停、取消；
- Approval request / approve / reject；
- Thread 详细日志；
- 完成和失败摘要回流群聊；
- 工作区权限与锁策略。

### 验收

- 群聊发起任务后创建独立 Thread；
- Thread 不污染父群组消息流；
- Thread 可持续对话；
- Task 状态变更在服务器重启后保留；
- 用户取消后 Agent 收到取消指令；
- 高风险操作需要审批；
- 完成结果和 Thread 链接回到父群组；
- 失败任务也返回可理解的错误摘要。

## M6：DSH Adapter

### 工作

- 将当前 CommonJS/ESM 现有插件整理为 TypeScript；
- 保留 Cordis Plugin 入口与 DSH 配置机制；
- 通过 `@room/agent-sdk` 连接；
- 设置页生成 Ed25519 Key；
- 显示 fingerprint 和 Agent ID；
- 绑定一个或多个既有 DSH Session；
- Group / Thread Session 映射；
- turn 事件与文本抽取；
- 持久化 delivery 和 outbox；
- 会话断开与重新绑定；
- 兼容 DSH 当前实际 Node Runtime。

### 验收

- 无需修改 DSH 核心代码即可安装插件；
- 插件在 DSH Web 启动后能连 Room；
- 私钥只在本机；
- 用户复制公钥后可被 Admin 登记；
- 连接成功获得固定 Agent ID；
- 两个 Group 不共享原生 Session；
- 重复事件不会触发重复 Prompt；
- DSH 完成任务后 Thread 和父群组都收到正确结果；
- DSH Session 不存在时不会擅自创建或绑定错误 Session。

## M7：Codex Adapter 与独立 Host Agent

### 工作

- 建立独立 Host Agent 启动器；
- 启动 Codex App Server stdio；
- JSON-RPC 请求与通知解析；
- Thread / Turn 映射；
- 事件流转；
- 审批和取消；
- 任务和原生会话映射；
- 本地工作区 allowlist；
- 独立 Ed25519 身份；
- 自动重连和进程异常恢复。

### 验收

- Codex 不监听公网端口；
- Room 可以向指定 Codex Agent 分配任务；
- Codex 输出实时回传 Thread；
- Thread 完成后摘要回流群组；
- Codex 被关闭或网络中断时状态正确；
- 不上传 API Key 或本地敏感凭据。

## M8：React Web Client

如果旧 Web UI 不能合法、完整或干净地复用，建立新的 React + Vite UI。

### 页面

- 登录与用户资料；
- 多群组列表；
- 群聊；
- Thread 详情；
- Task Board；
- Agent 列表 / 在线状态；
- Agent Key 管理；
- 用户与角色管理；
- 系统设置。

### 验收

- 浏览器实时收发消息；
- 刷新页面后历史消息恢复；
- 私有群组隔离；
- 多 Agent 显示正确名称和状态；
- Thread 创建、查看、回复、审批和关闭完整；
- 文件上传和下载符合权限规则。

## M9：Cloudflare / Mini PC 原生部署 / 迁移切换

### 工作

- 在目标 Mini PC 上原生安装 Node.js LTS 和 Room Server production build；
- 原生安装并配置 cloudflared，不使用 Docker / Docker Compose；
- 将 Room Server 绑定到 `127.0.0.1:8787`；
- 配置 `chat` 与 `agent` Hostname；
- 配置 Cloudflare Access、JWT 验证和 Agent WSS 身份验证；
- 配置目标操作系统的原生服务管理（Linux systemd 或经确认的 Windows Service）；
- 配置 SQLite 本地数据目录、文件权限和本地 SSD 路径；
- 提供 SQLite 在线一致性备份、恢复检查和完整性检查脚本；
- 旧 JSON importer；
- 旧 API 兼容层；
- 新旧服务对照测试；
- 维护窗口和回滚文档。

### 验收

- 服务器源站没有直接公开端口；
- 用户必须经 Access 登录；
- Agent 必须通过 Ed25519 认证；
- 多台电脑从公网连接正常；
- Tunnel / Server 短暂断线后能恢复；
- 消息、Task、Thread 不丢失；
- SQLite 备份能恢复到临时目录并通过完整性检查；
- 旧数据导入报告通过人工核验；
- Mini PC 重启后 Room Server 和 cloudflared 自动启动；
- 更新程序不会覆盖数据库、附件、密钥和配置；
- 回滚步骤经过测试；
- 新版可以在没有 Docker、PostgreSQL 和 Open Agent Room 上游的情况下独立启动。

---

# 17. 自动化测试策略

## 17.1 必须有的测试层

| 类型 | 目标 |
|---|---|
| Unit | 业务规则、权限、参与判断、Task 状态机 |
| Schema | 所有 API / WS 消息结构校验 |
| Contract | Server 与 Agent SDK 的协议一致性 |
| Integration | SQLite、WAL、事务、Outbox、备份恢复、重连 |
| Adapter Mock | DSH / Codex Adapter 行为模拟 |
| E2E | 浏览器到 Agent 再到 Thread 的完整链路 |
| Recovery | 断电、进程崩溃、重复事件、网络中断 |
| Security | 未授权访问、越权、重放、Key 吊销、消息注入 |

## 17.2 必须覆盖的关键测试场景

1. 两个用户加入不同群组，不能相互读取消息。
2. 一个 Agent 加入三个群组，三组上下文完全独立。
3. 同一台 Host 上两个 Agent 使用不同 Agent ID 和 Key。
4. 用户消息发出后，所有在线 Agent 都收到持久化 delivery。
5. Agent skip 时不创建公开消息。
6. Agent A 回复后，Agent B 可以参与，但 A 不会读到自己的消息。
7. hop 或预算达到上限后自动停止讨论。
8. 创建 Thread 时保留父 Group 和源消息关系。
9. Thread 完成后只向正确父 Group 回流摘要。
10. Agent 收到事件后、处理前崩溃；重连后仍能收到事件。
11. Agent 处理完成但 ack 丢失；重试不会重复创建任务。
12. Server 保存业务事务后、WebSocket 广播前崩溃；重启后事件仍可恢复。
13. Agent Key 被吊销后现有连接失效。
14. Admin 可以登记 Agent Key，Member 不可以。
15. WebSocket 消息伪造其他 Agent ID 被拒绝。
16. DSH Session 不存在或有歧义时不自动选择其他 Session。
17. Codex App Server 进程崩溃时 Task 状态不被错误标成成功。
18. Cloudflare Tunnel 中断时本机 Agent 可以重连。

## 17.3 性能测试

不要在没有测量和用户批准的情况下提前引入 Redis、PostgreSQL、Docker 或其他基础设施。

建立可重复的基准：

- 100 个同时在线 WebSocket 连接；
- 其中若干 Mock Agent 加入多个群组；
- 持续发送聊天消息和 Agent 事件；
- 测量 API 延迟、事件广播延迟、CPU、RSS、DB 写入和重连恢复时间；
- 记录 P50 / P95 / P99；
- 测试 1 小时稳定运行和进程重启。

1000 连接作为后续压力测试，不作为 MVP 发布阻塞条件。性能指标以真实测试报告为准，不凭感觉宣称达标。

---

# 18. 面向 AI 开发的仓库规范

这是一个主要由 AI Agent 开发和维护的个人项目，代码可理解性和可验证性优先于抽象复杂度。

## 18.1 模块规范

每个业务模块尽量有：

```text
module-name/
├── README.md          # 模块职责、入口和依赖
├── schema.ts          # 输入输出 Schema
├── types.ts           # 只放确实需要的领域类型
├── service.ts         # 业务逻辑
├── repository.ts      # 数据访问
├── routes.ts          # HTTP 路由（若有）
└── tests/
```

不要强迫每个模块都机械生成所有文件；没有必要的层可以省略，但职责边界必须清楚。

## 18.2 编码规则

- 使用简单、显式的 TypeScript；
- `strict: true`；
- 避免 `any`，必要时在边界处用 `unknown` 并验证；
- 不写复杂条件类型和多层泛型来炫技；
- 优先组合，不滥用继承；
- 使用 async/await；
- 统一错误结构和错误码；
- 不隐藏数据库查询和重要状态变化；
- 不在前端重复实现权限判断；
- 公共接口必须有 Schema 和测试；
- 不为了一个简单功能新增大型依赖。

## 18.3 AI 任务执行规则

每次让 DSH / Codex 开发功能时，任务必须明确：

- 修改哪个模块；
- 允许依赖哪些模块；
- 哪些文件不能改；
- 接口和验收标准；
- 必须执行的测试命令。

AI 完成任务时必须提交变更摘要和测试结果。其他 AI 做 Code Review 时应重点检查：权限、并发、重复事件、数据库事务、断线恢复和跨群组数据泄漏。

不要让多个 AI 同时修改同一核心文件。需要并行时使用独立 Git 分支 / Worktree，最后由一个集成 Agent 合并。

## 18.4 根目录 AGENTS.md

M1 必须重写根目录 `AGENTS.md`，让后续所有 AI 先阅读它。

必须包含：

- 项目目标；
- 技术栈；
- Monorepo 结构；
- 模块依赖方向；
- 开发和测试命令；
- 禁止事项；
- 数据库迁移规则；
- 安全规则；
- 代码提交和验收规则。

---

# 19. 推荐开发命令

根 `package.json` 应提供统一脚本，具体命令按实际依赖配置：

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm dev:server
pnpm dev:web
pnpm dev:agent
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:check
pnpm db:backup
pnpm db:integrity-check
pnpm db:restore-check
```

至少建立：

- `dev`：本地开发编排；
- `build`：所有可部署包构建；
- `lint`；
- `typecheck`；
- `test`；
- `db:migrate`；
- `db:seed`；
- `db:backup`；
- `db:restore-check`；
- `db:integrity-check`；
- `service:install` / `service:uninstall`（按目标操作系统提供）。

不能在 `dev` 脚本里自动删除数据库或重置用户数据。

---

# 20. 发布、备份与运维要求

1. Server 和 Web 可以独立构建，但要有兼容版本声明。
2. Agent SDK 与 Protocol 使用 SemVer；协议破坏性修改需要主版本升级或明确兼容窗口。
3. DSH Plugin、Codex Adapter、Host Agent 可以独立更新，不要让 Room Server 更新覆盖用户的工作区和本地配置。
4. 数据库 Schema 使用迁移工具管理；生产不允许启动时无条件自动 DROP / 重建表。
5. 每次发布记录 Git commit、Protocol 版本、DB migration 版本和构建版本。
6. 提供数据库备份、恢复和迁移验证脚本。
7. 日志使用结构化 JSON，包含 requestId / correlationId，不输出秘密。
8. Health 与 Readiness 分开：进程活着不代表数据库可用。
9. 所有后台任务可观测，失败有重试上限和 dead-letter / failed 状态。
10. 用户文件、Agent 密钥和运行缓存分开存放；缓存允许清理，业务数据必须备份。

---

# 21. 最终完成标准（Definition of Done）

只有以下项目全部满足，才能认为 Go → Node.js 全栈迁移完成：

- [ ] Room Server 使用 TypeScript + Node.js，独立运行，不依赖 Open Agent Room Go 包。
- [ ] Web UI 是独立构建的 React + TypeScript 前端。
- [ ] SQLite 是 Mini PC 上正式业务数据源；数据库位于本地 SSD / 本地文件系统，旧 JSON 只用于导入和备份。
- [ ] 用户登录和 Room RBAC 已工作。
- [ ] Admin 可以粘贴公钥登记 Agent，Server 生成固定 Agent ID。
- [ ] DSH 插件可在本机生成并安全保存 Ed25519 私钥，只显示公钥。
- [ ] Agent 使用 Challenge / Response 认证，不能伪造 Agent ID。
- [ ] Agent 可以加入多个独立群组。
- [ ] 一个 Agent 的不同群组上下文相互隔离。
- [ ] 所有符合条件的在线 AI 都能收到群消息并自主选择回复或 skip。
- [ ] AI-to-AI 交流具有 hop、消息数、频率和预算上限。
- [ ] 普通闲聊不会自动执行本机危险操作。
- [ ] 群聊消息可以创建独立 Thread 和 Task。
- [ ] Thread 的执行细节不污染父群组，最终摘要正确回流父群组。
- [ ] DSH Adapter 可以工作且不破坏 DSH 原有会话。
- [ ] Codex Adapter 通过本机 App Server stdio 工作，不公开本机控制端口。
- [ ] Agent delivery、ack、重连和幂等机制经过故障测试。
- [ ] Cloudflare Tunnel 和 Access 公网访问已验证。
- [ ] SQLite 在线备份、恢复、完整性检查、旧数据导入和回滚流程已验证。
- [ ] Mini PC 原生服务部署已验证；不依赖 Docker、Docker Compose、PostgreSQL 或 Redis。
- [ ] 核心单元、集成、契约和 E2E 测试通过。
- [ ] 根目录文档已更新，项目不再依赖上游 Open Agent Room 的运行代码。

---

# 22. 实施顺序摘要

严格按以下顺序推进，不要跳过基础工作：

```text
M0  仓库盘点、行为基线、接口和数据映射
 │
 ▼
M1  pnpm Monorepo + TypeScript + Fastify + SQLite（better-sqlite3）骨架
 │
 ▼
M2  独立 Room Core：用户、群组、消息、Agent、Thread、Task、事件
 │
 ▼
M3  Cloudflare 用户身份 + Ed25519 Agent 身份 + Agent SDK / WSS
 │
 ▼
M4  多群组 AI 自主参与、AI-to-AI 协作和防循环
 │
 ▼
M5  Thread / Task / Approval / 结果回流
 │
 ▼
M6  DSH Adapter（优先迁移现有已验证功能）
 │
 ▼
M7  Codex Adapter + 独立 Host Agent
 │
 ▼
M8  React Web Client
 │
 ▼
M9  Cloudflare + Mini PC 原生部署、SQLite 备份/恢复、JSON 数据导入、切换和回滚
```

允许在不同模块之间做不改变依赖方向的并行工作，但不要在协议、数据库和服务层尚未稳定前并行开发所有 Adapter。

---

# 23. 执行记录

> DSH Agent 每完成一个里程碑就更新本节。不要预先把未完成项目标记为完成。

| 里程碑 | 状态 | Commit / 分支 | 测试结果 | 备注 |
|---|---|---|---|---|
| M0 | 完成（2026-11-22） | 4d12d79 | 旧服务编译通过、插件语法 6/6、环境核对通过 | 盘点见 docs/INVENTORY.md，迁移参考见 docs/MIGRATION.md |
| M1 | 完成（2026-11-22） | 1ab5092 | lint / typecheck / 18 tests / build 全过；并发启动与 SIGKILL 恢复实测 | 实现记录见 docs/PROGRESS.md「M1」 |
| M2 | 完成（2026-11-22/23，含两轮评审修复 b79a580 + 7ce6437） | 7ce6437 | lint / typecheck / 47 tests / build 全过；权限分级、Task 幂等、Delivery 状态机、归档群组只读实测 | 设计见 docs/DATABASE.md，记录见 docs/PROGRESS.md「M2」「M2 Review Fix」「M2 Review Fix 2」 |
| M3 | 完成（2026-11-23：认证 + Agent SDK，67 tests） | d34d271 | lint / typecheck / 67 tests / build 全过；dev/access、Challenge 重放、吊销断连、重连补齐实测 | 设计见 docs/AUTH.md，记录见 docs/PROGRESS.md「M3」 |
| M4 | 未开始 | | | |
| M5 | 未开始 | | | |
| M6 | 未开始 | | | |
| M7 | 未开始 | | | |
| M8 | 未开始 | | | |
| M9 | 未开始 | | | |

---

# 24. 给 DSH Agent 的最终执行要求

开始后不要先重写全部代码。先执行 M0：实际检查当前仓库和 Git 状态，列出现有功能、接口、依赖、未完成事项和文档偏差；然后建立新架构骨架和测试基线。

完成 M0 后，继续按里程碑逐步实施。每个阶段只做该阶段所需的工作，保持项目始终可运行、可测试、可回滚。

最终目标是一个由 TypeScript / Node.js 驱动、以 SQLite 作为 Mini PC 本地数据库、通过原生系统服务运行并完全独立于 Open Agent Room 上游的 AI Room 平台；不使用 Docker，现有 Go Server 和旧 Bridge 仅作为迁移参考，不作为长期核心依赖。
