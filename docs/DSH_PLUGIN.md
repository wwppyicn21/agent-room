# DSH Plugin (M6)

Agent Room 的 DSH 原生 Plugin 位于 `adapters/dsh-plugin`。它作为 Cordis Host Plugin
运行在 DSH 进程内，通过 `@room/agent-sdk` 连接 Room Server，并把显式映射的 Room
Group 消息桥接到独立的 DSH Session。它不修改 DSH Core，也不启动独立 Adapter 进程。

## 1. 安装与配置

Plugin 以标准 DSH bundle 发布：`package.json` 的 `dsh.bundle.patch` 指向
`cordis.patch.yml`，入口为构建后的 `lib/index.js`。

```bash
# 在仓库根目录
pnpm --filter @room/dsh-plugin build

# 在 DSH Host 中安装 bundle（会修改当前 profile；需要操作者确认）
#   plugin_manager install_bundle  <package spec>
# 启用/禁用：
#   plugin_manager set_plugin  agent-room  true|false
# 卸载：
#   plugin_manager remove_bundle  @room/dsh-plugin
# 更新（重新安装同 package 的新版本）：
#   plugin_manager install_bundle  <new spec>
```

安装后在 DSH 的 **Settings → Built-in plugins → Agent Room** 打开插件设置页。设置页直接
编辑 `roomBaseUrl` 与 `groups`（这两个字段是 volatile，保存后无需重启插件，`RoomBridge`
每秒重新读取配置并应用；Room URL 变化时自动重连）。其余字段仍通过 profile patch /
配置文件设置，修改后需要重启插件。

设置页也可以手工填写 profile patch（`dsh.profile.bundles` 必须包含本 bundle），字段由
`Config` schema 校验：

| 字段            | 默认                    | 说明                                                      |
| --------------- | ----------------------- | --------------------------------------------------------- |
| `enabled`       | `true`                  | 关闭后插件仍加载但不连接                                  |
| `roomBaseUrl`   | `http://127.0.0.1:8787` | Room Server 地址，仅本机/内网                             |
| `agentKeyPath`  | 空                      | 本地 Ed25519 PKCS#8 PEM 路径；空则使用 profile 数据目录   |
| `dataDir`       | 空                      | Delivery 状态目录；空则使用 `$DSH_PROFILE_DIR/agent-room` |
| `groups`        | `[]`                    | 显式 `{ groupId, sessionId, label }` 映射                 |
| `maxReplyChars` | `8000`                  | 单条 Room 回复上限                                        |
| `turnTimeoutMs` | `900000`                | 等待一轮结束的上限                                        |
| `replyPrefix`   | 空                      | 回复前缀（迁移期可选）                                    |

映射规则：

- 每个 Room Group 必须显式配置一个 DSH Session ID；
- 同一个 Session 不能绑定多个 Group；
- Session 不存在时插件只告警并把 Delivery 标记为 failed，**绝不创建或猜测 Session**；
- 映射目标必须是**未归档** Session：归档 Session 的 Agent 不执行 Prompt，`agent/pre-step`
  直接拒绝、`turn/end` 为 `blocked`；插件在 Prompt 前调用
  `sessionController.resolveAgent(sessionId)` 恢复冷 Session 的 Agent，失败则 failed；
- 管理员在设置页修改 `groups` 后约 1 秒内生效；`roomBaseUrl` 变化会自动断开并重连。

## 2. 身份与私钥

- 首次启动时在 `agentKeyPath`（默认 `$DSH_PROFILE_DIR/agent-room/agent-key.pem`）
  生成 Ed25519 私钥，目录 `0700`、文件 `0600`；
- 已存在的 key 不会被覆盖，因此 Agent 身份稳定；
- 私钥不上传 Room、不写入配置、不写入日志、不进入 Git；
- 启动日志只输出公钥指纹；Room Server 侧通过管理员注册该公钥（M3）。

## 3. 数据流

```text
Room event.deliver (message.created)
  -> delivery 状态持久化 (pending/processing/completed/failed)
  -> group -> session 映射
  -> sessionController.prompt({requestId: room-<eventId>, mode: queue})
  -> DSH turn
  -> assistant/message 的 text blocks
  -> turn/end completed
  -> sessionController 输出 -> AgentClient.sendMessage -> Room
```

- 只抽取 assistant 的 text blocks，不把 tool-call、reasoning 或调试内容发回 Room；
- 文本为 `[skip]` 或空时不发公开回复；
- Thread 消息回复到同一 Thread，并 `replyToMessageId` 指向来源消息；
- 回复使用 `clientMessageId = plugin-reply-<eventId>`，Room 侧幂等；
- `task.cancel` 控制指令会调用 `sessionController.cancel({sessionId})`，并清除待回复 turn。

## 4. Delivery 幂等、PendingTurn 与恢复

状态持久化在 `dataDir/deliveries.json`（StoreFile v2：`deliveries` + `turns`；所有写经
Promise queue 串行化，唯一临时文件 + 原子 rename，`0600`；启动时清理残留 tmp）：

- Delivery 状态：`pending` / `processing` / `completed` / `failed`；`completed` 重复投递
  直接 ack，不重复 Prompt；
- PendingTurn：Prompt 前写入 `prompting`（含 requestId、eventId、session、group、thread、
  来源 message、prompt 文本），Prompt 接受后转 `awaiting_response`，收到 `turn/end` 并
  成功写回 Room 后转 `completed`；`[skip]` / 异常也落终态；
- PendingTurn 超时：每个 turn 有 `turnTimeoutMs` 计时器；超时后异步从等待队列移除，并把
  持久化状态置为 `failed` / `error=turn_timeout`（若已 completed/failed 则不覆盖）；迟到
  的 `assistant/message` / `turn/end` 因队列已空被忽略；`stop()` 只清 timer，保留
  `awaiting_response` 供重启恢复；重启后 failed 的 turn 不会再次执行；
- 回复统一使用 `clientMessageId = plugin-reply-<eventId>`，Room 侧幂等；Prompt 使用
  `requestId = room-<eventId>`，DSH 侧去重；
- 重启恢复：连接成功后读取 `sessionQuery.readSession()` 快照，用
  `user/message.data.source.rpcId === requestId` 判断 Prompt 是否已进入 Session；已结束
  则直接提取 assistant 文本写回（同 clientMessageId），未结束则恢复 waiter，尚未进入
  且 state=prompting 时用同一 requestId 重试；
- 保留期：`deliveryRetentionDays`（默认 30）只清理已终态记录；`pending` / `processing` /
  `awaiting_response` 永不清理；加载时执行清理；prune 只要删除了任意 delivery 或 turn 就
  必须原子提交（即使同一 eventId 的 turn 因未终态而保留），删除与保留在同一次写入中生效。

语义是 at-least-once + 幂等副作用，不承诺 exactly-once。Socket 断开时按 0.5s–30s
指数退避重连；每次 `hello` 后 SDK 会重投未 ack 的 Delivery 并调用 `onRecover`。

## 5. 状态与日志

- `RoomBridge.status()` 暴露 `connected`、`agentId`、`fingerprint`、映射数量、各
  Delivery 状态计数与 `lastError`；
- 关键事件写入 Cordis logger：连接/重连、映射缺失、Session 不可用、Prompt 失败、
  skip、取消、恢复；
- 不记录私钥、Bearer token 或完整附件内容。

## 6. 范围与边界

已实现：安装/卸载/更新所需的 bundle 结构、显式配置、Agent 身份、认证连接、重连、
显式 Group→Session 映射、Session 不自动创建、Group/Thread/Task context 透传、
message/reply/skip/cancel、Delivery 持久化幂等、恢复、状态与日志。

未在 M6 实现（按 ROADMAP 属 M7 Room Tools / M8 UI）：

- 结构化的 Task Progress / Approval / Result / Error 工具调用（M6 通过 Thread/Task
  消息上下文与取消指令桥接；DSH Agent 尚无 Room Task 工具）；
- Room 侧触发插件安装/卸载的 Web UI（由 DSH Plugin Manager 提供）；
- 文件/Workspace 运行时隔离（M7 Workspace allowlist）。

## 7. 测试

```bash
pnpm exec vitest run adapters/dsh-plugin
pnpm test        # 全量；插件集成测试会启动真实 Room Server 与真实 Agent WSS
```

- 单元测试覆盖映射、Session 校验、去重、文本抽取、skip、双群隔离、取消、重启恢复、
  超时持久化、prune 提交、key 权限与 store 原子性（`bridge` 19 例、`store` 6 例）；
- 集成测试用假 DSH ctx + 真实 Room Server/AgentClient，验证认证、投递、Prompt、
  assistant 抽取与 Room 回复。
