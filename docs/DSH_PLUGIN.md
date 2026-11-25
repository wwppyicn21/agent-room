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

安装后由 DSH Settings 的配置表单管理以下字段（`Config` schema 校验）：

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
- 管理员修改映射后重启/重新加载插件即可生效。

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

## 4. Delivery 幂等与恢复

状态持久化在 `dataDir/deliveries.json`（原子 `tmp` + `rename`，`0600`）：

- `completed`：重复投递直接 ack，不重复 Prompt；
- `processing`：进程崩溃后由 Room 重投，`requestId` 由 eventId 派生，DSH 侧天然去重；
- `failed`：记录原因并 ack，等待管理员修复映射/身份后由 Room 侧重新投递；
- `pending`：正常执行。

Socket 断开时插件按 0.5s–30s 指数退避重连；每次 `hello` 后 SDK 会重投未 ack 的
Delivery，并调用 `onRecover` 恢复当前 Agent 仍拥有的 Task 映射。

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
  key 权限与 store 原子性；
- 集成测试用假 DSH ctx + 真实 Room Server/AgentClient，验证认证、投递、Prompt、
  assistant 抽取与 Room 回复。
