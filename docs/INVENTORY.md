# M0 盘点报告（基线冻结）

- 日期：2026-11-22
- 执行：DSH agent（lead）
- 范围：`/data/work/dsh-room-bridge`（旧实现）、`/data/src/open-agent-room`（上游基线）、本机 Mini PC 环境
- 结论：**基线可编译、插件可加载、接口与数据可迁移；无阻塞项。** 旧实现保持不动，新代码从 M1 开始。

---

## 1. 仓库基线

### 1.1 旧仓库

- 路径：`/data/work/dsh-room-bridge`
- HEAD：`93f3cdc`（干净，无未提交改动）
- 提交历史（9 个）：

| 提交 | 说明 |
|---|---|
| `3f33d86` | 初始：DSH session ↔ Open Agent Room bridge |
| `1e6d786` | 面向 agent 的契约文档（AGENTS.md、API、插件参考） |
| `80b0d74` | 可配置绑定、更安全的匹配、有界队列 |
| `f6653c2` | 不丢回复；加固房间 API（outbox、幂等） |
| `5d93b1c` | agent 之间消息（include_agents）与 hop 上限 |
| `cb4f4fe` | 按 agent id 而不是显示名识别自己 |
| `a307110` | presence 心跳与 per-agent token |
| `d37754a` | 协同协议文档（身份、presence、claim-first） |
| `93f3cdc` | 记录两项待办（未实现，2026-11-22 已被用户放弃） |

### 1.2 服务端补丁与上游

- 补丁实际为 **5 个**（旧文档写“两个补丁”，已过时）：

| 补丁 | 提交 | 内容 |
|---|---|---|
| `0001` | `0253760` | 按 runtime 选 daemon、`/portable/` 路由、agent 路由整理 |
| `0002` | `20c0abe` | 外部 DSH 会话桥接的房间侧 API |
| `0003` | `fca2ca9` | 加固 agent 桥接 API（token、幂等、长度、成员校验、审计） |
| `0004` | `03a7657` | agent 间消息 `include_agents` 与 hop 标记 |
| `0005` | `73f5717` | external agent presence 与 per-agent 身份 |

- 上游：`github.com/xargin/open-agent-room`，**MIT 许可**；基线提交 `3cac309`（`0001` 的父提交）。
- 上游仓库 `/data/src/open-agent-room` 的 HEAD 为 `73f5717`（即补丁 0005），完整源码、`go.mod` 可用。

### 1.3 可编译性验证（已完成）

```text
git clone /data/src/open-agent-room /tmp/oar-m0
git checkout 3cac309
git am server/patches/*.patch      → AM OK
go build ./...                     → BUILD OK（go1.26.8；go.mod 声明 go 1.22）
go build ./cmd/server ./cmd/daemon → open-agent-room 11.0 MB / agent-room-daemon 6.6 MB
cmp 四个文件与 server/src/         → SAME（逐字节一致）
```

**缺失项：** 仓库内 `server/src` 不是自包含项目（只有 4 个文件、无 `go.mod`、无其它 internal 包）；编译必须使用上游 `3cac309` 检出。M0 记录这一事实，新版不依赖 Go 代码或上游内部包。

### 1.4 运行中的旧服务

- `agent-room.service`：`PORT=8791`、`DATA_PATH=/data/agent-room/state.json`、二进制 `/data/src/open-agent-room/bin/open-agent-room`、`Restart=always`。
- 实际监听 `*:8791`（不是 loopback），除 `/api/agent/*`（设置 `AGENT_API_TOKEN` 时）外无鉴权。
- 数据文件 `/data/agent-room/state.json`：283,512 B。

---

## 2. DSH 插件清单

### 2.1 文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `plugin/lib/index.js` | 45 | Cordis 插件入口 |
| `plugin/lib/config.js` | 84 | schemastery 配置 schema（唯一默认值来源） |
| `plugin/lib/discover.js` | 139 | 按 sessionId / workspace + 精确标题查找会话 |
| `plugin/lib/bridge.js` | 786 | 轮询、队列、prompt、turn 等待、回复、outbox、心跳、重绑定 |
| `plugin/lib/room.js` | 109 | 房间 HTTP 客户端（inbox/reply/heartbeat） |
| `plugin/scripts/find-session.mjs` | 99 | 离线折标题找会话（不开 Harness） |

- `node --check`：6 个文件全部 OK。
- 依赖：`@deepseek-ai/schemastery ~3.19.0`；DSH 版本 `0.2.2-rc.5`。
- DSH 依赖面：Cordis 注入 `sessionQuery`、`sessionController`（`workspaceRegistry` 经 `ctx.get`）；监听 `session/event`；`prompt({sessionId, requestId, mode:"queue", content})`；requestId 稳定为 `room-<messageId>`。

### 2.2 配置字段（29 项，默认值）

| 组 | 字段（默认值） |
|---|---|
| 开关 / 房间 | `enabled=true`、`roomBaseUrl=http://127.0.0.1:8791` |
| 会话绑定 | `sessionId=""`、`workspacePath=/data/work`、`sessionTitle=dsh`、`allowAmbiguous=false` |
| 接收规则 | `agentName=dsh`、`mentionNames=[dsh,领队]`、`stripMention=false`、`channelIds=[]`、`acceptAgentMessages=false`、`maxAgentHops=4` |
| 节流 / 安全 | `pollIntervalMs=1000`、`maxQueue=20`、`ackWhenBusy=false`、`turnTimeoutMs=900000`（15 min） |
| 回复 | `replyMode=last`、`maxReplyChars=8000`、`replyPrefix=""`、`bridgeId=""` |
| 凭证 | `bridgeToken=""`（Bearer）、`agentToken=""`（X-Agent-Token） |
| 运维 | `heartbeatMs=20000`、`statePath=$DSH_HOME/room-bridge-state.json`、`outboxPath`（同目录）、`logToConsole=true` |
| 分阶段验证 | `discoverOnly=false`、`roomEnabled=true`、`promptOnStart=""` |

### 2.3 生产安装

- `/data/dsh/profiles/web/package.json`：依赖 `@local/dsh-room-bridge: file:/opt/dsh-room-bridge`，bundle 列表包含该插件。
- `cordis.patch.yml` 配置：`workspacePath=/data/work`、`sessionTitle=dsh`、`agentName=dsh-linux`、`mentionNames=[dsh-linux, dsh]`、`acceptAgentMessages=true`、`maxAgentHops=4`、`agentToken` 已配置（**不记录值**）。
- 运行证据：`/data/dsh/room-bridge-state.json` 存在，`cursor=60`、`primed=true`、`handled` 8 条。

---

## 3. 旧接口清单

鉴权说明：除 `/api/agent/*` 在设置 `AGENT_API_TOKEN` 时要求 `Authorization: Bearer` 外，其余接口均无鉴权；服务监听 `*:8791`。

| 路径 | 方法 | 用途 | 新版去向 |
|---|---|---|---|
| `/api/state` | GET | 全量快照（users/channels/agents/tasks/messages/events） | `/api/v1/bootstrap` |
| `/api/events` | GET | 事件流（`?since`） | `/api/v1/events` |
| `/api/messages` | POST | 发送消息并触发路由 | `/api/v1/groups/:id/messages` |
| `/api/channels` | POST | 建频道 | `/api/v1/groups` |
| `/api/channels/{id}` | DELETE | 删频道 | 删除 group |
| `/api/channels/{id}/default-agent` | POST | 设默认 agent | group settings |
| `/api/users` | POST | 建用户 | M3 后由身份系统替代 |
| `/api/users/{id}` | DELETE | 删用户 | 同上 |
| `/api/skills` | POST | 建 skill | `/api/v1/skills` |
| `/api/skills/{id}` | DELETE | 删 skill | 同上 |
| `/api/task-lanes` | POST | 建 lane | `/api/v1/task-lanes` |
| `/api/task-lanes/{id}` | PATCH / DELETE | 移动 / 删除 lane | 同上 |
| `/api/tasks` | POST | 建任务 | `/api/v1/tasks` |
| `/api/tasks/{id}` | PATCH / DELETE | 更新 / 删除任务 | 同上 |
| `/api/tasks/{id}/channel` | POST | 建任务专属频道 | 新架构用 Thread |
| `/api/agents` | POST | 建 agent | `/api/v1/agents` |
| `/api/agents/{id}` | PATCH / DELETE | 更新 / 删除 agent | 同上 |
| `/api/agents/{id}/token` | POST | 签发 agent token | M3 改为 Ed25519 |
| `/api/agents/{id}/external` | POST | 标记 external（外部推理） | 新架构的 runtime kind |
| `/api/agents/{id}/assign` | POST | 分配任务 | 新架构 task assign |
| `/api/agents/{id}/skills` | POST | 挂 skill | 新架构 agent_skills |
| `/api/agent/inbox` | GET | 外部 agent 收件箱（`?name=&since=&include_agents=`） | Legacy Adapter（迁移期） |
| `/api/agent/reply` | POST | 以 agent 身份发帖 | Legacy Adapter |
| `/api/agent/heartbeat` | POST | 心跳 / presence | Legacy Adapter |
| `/daemon` | WS | daemon 注册与事件通道 | 新架构 Host Agent 协议 |
| `/portable/*` | GET | 便携工具静态分发 | 不迁移 |
| `/` | GET | 内嵌 Web UI | 新 Web Client |

---

## 4. 数据结构

### 4.1 旧 Go 类型（`internal/protocol/protocol.go`）

- `Actor{kind,id,name}`、`Scope{kind,id}`、`Trace{correlationId,causationId}`、`Envelope{id,type,ts,serverId,actor,scope,payload,trace}`
- `Meta{version,serverId,createdAt,updatedAt}`
- `User{id,name,color}`
- `Channel{id,name,topic,memberIds,defaultAgentId,hidden}`
- `Agent{id,name,persona,systemPrompt,runtime,model,status,daemonId,capabilities,memory,skillIds,skills,color,lastSeen,external,token(json:"-")}`
- `Daemon{id,name,status,capabilities,connectedAt,lastSeen}`
- `Message{id,channelId,authorKind,authorId,authorName,text,kind,timestamp,tags,protocolId}`
- `AgentSkill{id,name,source,content,tags,createdAt}`、`MemoryItem{id,text,source,createdAt}`
- `TaskLane{id,name,position}`
- `Task{id,title,description,workdir,laneId,channelId,assigneeKind,assigneeId,createdBy,createdAt,updatedAt}`
- `State{meta,currentUserId,users,channels,skills,taskLanes,tasks,agents,daemons,messages,events}`

### 4.2 实际 `state.json`（2026-11-22 采样）

| 项 | 数量 |
|---|---|
| meta.version | 1（serverId=`srv_local`） |
| users | 1（`usr_you`） |
| channels | 2（`chan_general` 等） |
| agents | 2（`agent_ada`→dsh-linux、`agent_dsh2`→dsh-windows，均 external=true） |
| daemons | 17（历史残留，多已失效） |
| messages | 61 |
| tasks | 3 |
| taskLanes | 6（Backlog/Todo/Doing/Review/Done/Unplanned） |
| events | 120 |
| skills | 0（字段缺省） |

### 4.3 事件类型（Envelope.type）

`message.created`、`agent.message`、`agent.reply`、`agent.created`、`agent.updated`、`agent.deleted`、`agent.spawn`、`agent.ready`、`agent.status`、`agent.skill.created_and_attached`、`agent.skill.attached`、`agent.skill.detached`、`memory.upsert`、`daemon.hello`、`daemon.ready`、`channel.created`、`channel.deleted`、`channel.hidden`、`channel.default_agent.updated`、`user.created`、`user.deleted`、`skill.created`、`skill.deleted`、`task.created`、`task.updated`、`task.assigned`、`task.assignee.changed`、`task.started`、`task.revoked`、`task.deleted`、`task.review_requested`、`task.channel.created`、`task.channel.opened`、`route.arbitrate`、`route.decision`。

### 4.4 生命周期

- **Agent**：创建（POST /api/agents）→ 由 daemon spawn 或标记 external → `status`：`idle` / `working` / `offline` → 心跳更新 `lastSeen` → 删除。
- **Daemon**：WS `/daemon` 注册（`daemon.hello`）→ `daemon.ready` → 接收 `agent.spawn` / `agent.message` / `task.assigned` 等 → 断连标记 offline。
- **Task**：创建（默认进第一个 lane）→ `/channel` 建任务频道 → assign → `task.started` / `task.review_requested` / `task.revoked` → 完成进 Done lane；lane 位置可拖动。
- **Thread**（旧实现只有 `THREAD_STATUS` 标记）：`continue` / `standby` / `handoff` / `final`；`standby|handoff|final` 停止继续路由。
- **Message**：POST /api/messages → 解析 `@mention` / `/assign` → 路由到 agent → daemon 回复或 external inbox → `message.created`；`/api/agent/reply` 带 `Idempotency-Key`。

---

## 5. 目标 Mini PC 环境

| 项 | 实测值 |
|---|---|
| OS | Ubuntu 26.04.1 LTS |
| 架构 | x86_64 |
| CPU | Intel Pentium J3710 @ 1.60 GHz，4 核 |
| 内存 | 3.4 GiB，无 swap（可用约 1.8 GiB） |
| 磁盘 | 119 G SSD（`sda`，ROTA=0），LVM + **ext4**，`/` 可用 91 G |
| Node | v26.13.1（`/opt/node/bin/node`） |
| pnpm | 10.34.9 |
| Go | 1.26.8（仅用于旧服务验证） |
| 服务管理 | systemd：`dsh-web`、`dsh-proxy`、`agent-room`、`cloudflared` |
| 端口 | `127.0.0.1:3080` dsh-web；`127.0.0.1:3081` dsh-proxy；`*:8791` 旧房间；`8787` 空闲（新版目标） |
| DSH | 0.2.2-rc.5，`/opt/dsh`，`DSH_HOME=/data/dsh` |
| Cloudflare | cloudflared 2026.11.1，token 托管（`/etc/cloudflared/token`），本地看不到 ingress |
| SQLite 依赖 | `better-sqlite3` 13.2.0 实测可用：Node 26 预编译（ABI 147）、WAL、SQLite 3.54.1，安装 3 s |

**建议路径（M1 安装脚本确定）：**

- 数据：`/var/lib/agentroom/room.db`（+ `attachments/`、`backups/`、`logs/`）——当前不存在
- 配置：`/etc/agentroom/`（受限权限，`EnvironmentFile`）
- 程序：`/opt/agentroom/releases/<version>/`（更新只切换 release，不动 `data/`、`config/`）

---

## 6. 文档不一致（需在后续修正）

| 位置 | 现状 | 实际 |
|---|---|---|
| `README.md:29` | “两个补丁” | 5 个补丁（0001–0005） |
| `AGENTS.md:38` | “可 git am 的两个补丁” | 5 个 |
| `server/README.md:5` | “两个补丁” | 5 个 |
| 端口 | 文档/服务用 `8791` | 代码默认 `PORT=8787`（`main.go:196`），生产用 `8791`；新版统一 `8787` |
| `docs/TODO.md` | 两项待办（全量落盘、Ed25519） | 2026-11-22 用户已放弃；新计划不包含，文件保留但标注 abandoned |
| `/data/work/AI-Room-Development-Plan-for-DSH.md` | 旧版 64,301 B | 新版 77,443 B（sha256 `490adce5…`），已作为 `docs/PLAN.md` 入仓 |

---

## 7. 已知 bug / 风险

1. `store.saveLocked()` 把整个 State 缩进 JSON 全量重写；presence 变更也触发，实测 274 KB 状态、2 agent × 20 s ≈ 2.3 GB/天写放大，单次 1–3 ms 且持写锁。
2. `Agent.Token` 虽 `json:"-"`，但 token 只存内存、`Store.load` 不恢复；服务重启后旧 agent token 失效（**待 M3 前复验**）。新版用 `agent_keys` 分表持久化。
3. 插件 `pollOnce()` 先推进游标再投递，崩溃窗口可能丢消息；新版必须先持久化 inbox/delivery 再 ack。
4. 旧 `Idempotency-Key` 是内存 map，重启后失效；新版幂等记录必须落库。
5. 旧服务监听 `*:8791` 且大部分路由无鉴权；默认人类身份固定 `usr_you`。
6. 无 daemon 时内置 `fallbackReply` 会抢答，可能造成“agent 自答”；新版 participation engine 必须显式区分。
7. `external` 是裸 bool，无租约；presence 靠 TTL 扫描，进程崩溃后最多 60 s 才显示 offline。
8. `inbox` 每次全量 `Snapshot()` 拷贝；`seq` 用消息下标（1-based），旧数据重排会错位。
9. 旧 Task Channel 不等同新 Thread：缺 `parentGroupId`、`sourceMessageId`、完成后回流语义。
10. `daemons` 数组只增不减（现 17 条残留）；agent 的 `daemonId` 可能指向已断开的 daemon。
11. 本机内存仅 3.4 GiB 且无 swap：M8 Vite 构建、并发测试需注意内存上限。
12. 旧 Go 服务与新版 Node 服务不能同时写同一数据源；切换期必须停旧写。

---

## 8. 无法在本机复现 / 待确认

- **Cloudflare Access 域名与 hostname**（`chat.*` / `agent.*`）：tunnel 为 token 托管，ingress 不在本机，需用户提供域名与 Access 策略后再做 M9。
- **Codex runtime**：本机未安装，M7 延后。
- **Windows 服务包装**：目标机是 Ubuntu，暂不实现；仅在目标变更为 Windows 时再做。
- 旧 Web UI 的部分前端行为（任务拖拽、mobile 布局）只作为参考，不在新版逐像素复刻。
