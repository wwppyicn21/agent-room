# M5 — Thread / Task Engine 设计

状态：M5 设计（2026-11-23）。实现进度与证据以 `docs/PROGRESS.md` 为准；本文件定义状态机、API 契约与边界。

## 1. 范围

M5 把已有的基础 Thread / Task 扩展为完整任务执行引擎：

- Group Message → Thread / Task（同事务）；
- Task 分配、Run、Progress；
- Pause / Resume / Cancel，并把指令投递给执行 Agent；
- Approval（request / approve / reject）；
- Result / Error / Summary 回流父群组，含 Thread Reference；
- Thread 独立消息流、详情、日志与分页；
- REST API + OpenAPI + 契约测试；
- 重启恢复与群组隔离。

非目标：完整 Workspace 管理 UI、Plugin 的本地执行实现、Codex 能力对接（M6/M7）。

## 2. 数据模型

新增 / 扩展（迁移 `packages/database/drizzle/0008_*.sql`）：

- `tasks`：`started_at`、`result`、`summary`、`error`、`cancelled_at`；
- `task_runs`：状态增加 `paused`，新增 `progress_percent`、`progress_stage`、`progress_message`、`updated_at`；
- `approvals`：`id`、`task_id`、`run_id`、`thread_id`、`requested_by_agent_id`、`title`、`details`、`status`、`decided_by_user_id`、`decided_at`、`reason`、`expires_at`、`created_at`、`updated_at`；
- `threads.status`：增加 `failed`；
- `events`：`task.progress`、`task.paused`、`task.resumed`、`task.cancelled`、`task.approval_requested`、`task.approval_decided`。

所有业务写入、事件、Agent Delivery 在同一 SQLite 事务内提交（计划 §6.3）。事务内不发起 AI / 网络调用。

## 3. Task 状态机

```text
queued ──► assigned ──► running ──► succeeded
  │           │           │  │
  │           │           │  ├──► failed
  │           │           │  ├──► waiting_approval ──► running (approved)
  │           │           │  │                    └─► failed (rejected)
  │           │           │  ├──► paused ──► running (resume)
  │           │           │  └──► cancelled
  │           └───────────┴──────► cancelled
  └──────────────────────────────► cancelled
```

| From                                                    | To                 | Actor          | 条件                                               |
| ------------------------------------------------------- | ------------------ | -------------- | -------------------------------------------------- |
| queued                                                  | assigned           | 群管理员       | 被分配 Agent 是群成员且 active                     |
| assigned                                                | assigned           | 群管理员       | 换人；旧投递不撤销                                 |
| assigned                                                | running            | assignee Agent | 仅 assignee；创建 `task_run`                       |
| running                                                 | waiting_approval   | assignee Agent | 请求审批；同一 Task 只能有一个 pending approval    |
| waiting_approval                                        | running            | 审批人         | approval approved                                  |
| waiting_approval                                        | failed             | 审批人         | approval rejected；run 失败，摘要回流              |
| running / assigned / waiting_approval                   | paused             | 群管理员       | 写事件并投递 `task.paused` 给 assignee             |
| paused                                                  | running            | 群管理员       | 投递 `task.resumed`                                |
| queued / assigned / running / waiting_approval / paused | cancelled          | 群管理员       | 写事件、投递 `task.cancelled`；run → cancelled     |
| running                                                 | succeeded / failed | assignee Agent | 写 result / error / summary；Thread 终态；摘要回流 |
| succeeded / failed / cancelled                          | 任意               | —              | 终态，拒绝                                         |

所有转换由 Server 校验；REST / Plugin 不能直接写 `tasks.status`。非法转换返回 `409 conflict`。

## 4. Approval

- 仅 assignee Agent 在 `running` 时请求；请求后 Task → `waiting_approval`，Run 保持 running；
- 审批人：该 Group 的 owner/admin 或系统 owner/admin；请求者不能审批（Agent 不是用户，故天然不冲突）；
- 只有 `pending` 可 approve/reject；重复 approve 返回已决定结果，不改变状态；
- reject 必须给 `reason`；Task → `failed`，Run → `failed`，摘要写回群组；
- Approval 状态、决策人、时间、原因持久化；写 `audit_logs` 与 `task.approval_decided` 事件；
- `expiresAt` 可选；Server 启动时和每 30 秒扫描 `pending` 且到期的 Approval，事务内置 `expired`、Task/Run/Thread → `failed`、写失败摘要、`task.approval_expired` 事件与 `approval.expire` 审计；重复过期幂等（不重复摘要/事件/审计），已批准/已拒绝/已取消拒绝过期；扫描入口 `expireDueApprovals`，不暴露用户 API（Server Authority）。

## 5. Progress

`progress_percent`（0–100，可选）、`progress_stage`、`progress_message`、`updated_at` 写入当前 Run；同时写 `task.progress` 事件。仅 assignee Agent、Task 处于 `running` 时允许。Progress 不进入群聊消息流。

## 6. Pause / Resume / Cancel 与 Agent 通知

- 群管理员可 Pause / Resume / Cancel；取消是终态；
- 产生事件并复用 durable delivery：`task.paused`、`task.resumed`、`task.cancelled`；
- Agent 离线时 Delivery 保留，重连后按租约补齐；
- Cancel 后不允许把 Task 恢复为 running；恢复逻辑只对非终态 Task 生效。

## 7. Result / Error / Summary

完成（succeeded / failed）时：

- 更新 Task（result / summary / error / completedAt）与当前 Run；
- Thread 标记 `closed`（成功）或 `failed`（失败）；
- 在 Parent Group 写一条 `system` 摘要消息（`clientMessageId = task-summary:<taskId>`），内容含 Task 状态与 Thread 引用（`threadId` + 标题）；
- 写 `task.completed` / `task.failed` 事件与 `message.created`；
- 投递排除执行 Agent 自己。

## 8. Thread

- Thread Detail：Thread + 源消息引用 + 状态 + 计数；
- Thread Messages：独立消息流（`messages.threadId = thread`），分页 keyset；
- Thread Logs：该 Thread 的 Events（时间倒序，仅成员）；
- **Thread 消息不进入 Parent Group 消息流**：`listMessages(groupId)` 默认只返回 `threadId IS NULL`；
- Thread 消息不能跨群组；关闭 / 失败的 Thread 不能写入；
- Thread 列表使用 keyset 分页（`createdAt DESC, id DESC`），返回 `{ items, nextCursor }`；cursor 是上一页最后一个 Thread id，必须属于同一 Group，否则 `400`；
- Thread 回复隔离：Thread 内消息只能回复同 Thread 的消息或该 Thread 的源群消息；群聊消息不能回复 Thread 消息；跨 Thread / 跨群 / 不存在均拒绝；
- 手动关闭保护：关联 Task 未进入终态（succeeded / failed / cancelled）时 `closeThread` 返回 `409`，且不写事件/审计；普通 Thread 与终态 Task Thread 可关闭；
- 权限：群成员读取；写需 `requireWriteUser`（与 M2 一致）。

## 9. REST API（M5 实现）

`/api/v1`，完整定义见 `docs/openapi.yaml`（已实现）：

```text
GET/POST        /api/v1/groups
GET/PATCH       /api/v1/groups/:groupId
GET/POST        /api/v1/groups/:groupId/members
DELETE          /api/v1/groups/:groupId/members/:memberType/:memberId

GET/POST        /api/v1/groups/:groupId/messages
GET             /api/v1/messages/:messageId

GET/POST        /api/v1/groups/:groupId/threads
GET             /api/v1/threads/:threadId
POST            /api/v1/threads/:threadId/close
GET/POST        /api/v1/threads/:threadId/messages
GET             /api/v1/threads/:threadId/events

GET/POST        /api/v1/groups/:groupId/tasks
GET             /api/v1/tasks/:taskId
POST            /api/v1/tasks/:taskId/assign
POST            /api/v1/tasks/:taskId/start
POST            /api/v1/tasks/:taskId/progress
POST            /api/v1/tasks/:taskId/pause
POST            /api/v1/tasks/:taskId/resume
POST            /api/v1/tasks/:taskId/cancel
POST            /api/v1/tasks/:taskId/complete

GET/POST        /api/v1/tasks/:taskId/approvals
GET             /api/v1/approvals/:approvalId
POST            /api/v1/approvals/:approvalId/approve
POST            /api/v1/approvals/:approvalId/reject

GET             /api/v1/events?groupId=&cursor=&limit=
```

实现：`apps/server/src/routes/room.ts`；Task 执行端点使用 Agent Bearer 会话 token，其余端点使用用户 Principal。契约测试见 `apps/server/test/http-room.test.ts`。

认证：

- 用户：现有 Dev Auth（仅 loopback）或 Cloudflare Access；
- Agent：`Authorization: Bearer agt_...`（M3 session token），只能操作分配给自己的 Task；
- 所有路由在应用层校验资源权限；Group Isolation 必须由 Server 保证。

错误契约沿用 `{ error: { code, message } }`；分页使用 `{ items, nextCursor }`；Thread 列表为 `GET /groups/:groupId/threads?status&limit&cursor`（limit 1–200，默认 50）；创建接口支持 `clientMessageId` / `idempotencyKey`，同一 `idempotencyKey` 的 payload（source / title / description / assignee）不一致返回 `409` 且不写任何行。

## 10. 恢复

- Task / Run / Approval 状态全部持久化；
- 重启后：未终态 Task 保持原状态，Run 保留 progress；Agent 重连后按未 ack Delivery 补齐；
- 不把 `cancelled` / `failed` 误恢复为 running；
- 不自动把 `running` 改成失败（无法区分执行中与崩溃）；由人工 Cancel 或重新 Start 处理。

## 11. Workspace Policy（基础）

M5 只定义边界，不实现执行环境：

- Task 可带 `workspaceId`（后续 M6/M7 使用），Server 不做路径访问；
- 执行 Agent 只能使用自己被授权的 Group / Task 工作区；
- Plugin 不得自行扩大权限；Room Server 不直接访问 Agent 本地文件；
- 具体 allowlist 由 M6/M7 的 Plugin 与本机策略执行。

## 12. 事件与诊断

新增事件：`task.progress`、`task.paused`、`task.resumed`、`task.cancelled`、`task.approval_requested`、`task.approval_decided`、`task.approval_expired`。事件 payload 不含密钥；Summary 进群聊，Progress 只进事件。

## 13. 验收映射

见 `docs/ROADMAP.md` §4.11；每条验收在 `docs/PROGRESS.md` 的 M5 章节给出测试名或手动证据。
