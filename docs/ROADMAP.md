# Agent Room — Development Roadmap

> 本文档是 Agent Room 后续开发的执行路线图。
> DSH Agent 在执行开发任务时必须遵守本文件的 Milestone 定义、依赖关系、架构约束和验收标准。

---

# 1. 项目现状

## 1.1 已完成 Milestones

M0–M4 已完成。

当前远端 `main`：

```text
741c8a1
```

当前项目已完成：

- M0：项目可行性、技术盘点、开发计划
- M1：项目骨架、数据库、服务端基础设施
- M2：Room Core
- M3：Identity、Authentication、Agent SDK
- M4：Agent Autonomous Group Chat

当前仓库状态：

- 16 个测试文件
- 126 个测试
- Lint 通过
- Typecheck 通过
- Format Check 通过
- Test 通过
- Build 通过
- 工作区干净

以上为当前项目进度记录。执行后续任务时，必须重新运行验证，不得将历史测试结果当作当前修改的测试结果。

## 1.2 当前架构

```text
agent-room/
├── apps/
│   └── server/
├── packages/
│   ├── protocol/
│   ├── database/
│   ├── config/
│   └── agent-sdk/
├── deployment/
├── config/
└── docs/
```

当前已有：

- Fastify Server
- SQLite
- WAL
- Database Migrations
- RBAC
- Users
- External Identities
- Groups
- Group Members
- Agents
- Agent Keys
- Messages
- Threads
- Tasks
- Events
- Outbox
- Audit
- WebSocket
- Agent Authentication
- Agent SDK
- Autonomous Participation
- Root / Hop Budget
- Agent Rate Limit
- Delivery Lease / Retry

当前尚未创建：

```text
apps/web/
adapters/
```

后续开发不得因为旧计划中存在 Adapter 方案而重新创建独立 Adapter 产品。

---

# 2. 最终架构目标

Agent Room 是独立的 Agent 协作中心。

不同 Agent Runtime 通过 Plugin 接入 Agent Room。

```text
                   Agent Room
        ┌──────────────────────────────┐
        │ Groups / Members / RBAC     │
        │ Messages / Threads / Tasks  │
        │ Approvals / Events          │
        │ Agent Identity / Keys       │
        │ Delivery / Budget / Audit  │
        │ REST API / WebSocket        │
        └──────────────┬───────────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
     DSH Plugin   Codex Plugin   Web Client
          │            │            │
          ▼            ▼            ▼
     DSH Runtime   Codex Runtime   Browser
```

## 2.1 核心原则

必须遵守：

1. Agent Room 是独立服务，不依赖 DSH 或 Codex。
2. DSH 和 Codex 通过 Plugin 接入。
3. 不修改 DSH 核心。
4. 不修改 Codex 核心。
5. 不将 DSH 或 Codex 的内部 Session 暴露给 Room Server。
6. Agent Room 负责统一的 Group、Message、Thread、Task、Approval、权限及协作状态。
7. Plugin 负责 Runtime 与 Agent Room 之间的协议适配和生命周期协调。
8. DSH Plugin 和 Codex Plugin 尽可能复用 `@room/agent-sdk`。
9. 不为不同 Runtime 重复实现 Room Authentication、Delivery、Ack、Retry、Budget 等机制。
10. Agent Room 的权限和 Budget 以 Server 为最终权威。
11. Plugin 不得绕过 Server Permission、Participation Policy 或 Rate Limit。
12. Plugin 应可以独立安装、更新、禁用和卸载。
13. 不允许通过 Plugin 修改 Room Database。
14. Plugin 必须通过公开 API、Protocol 和 SDK 与 Room 交互。
15. 后续新增 Agent Runtime 时，应优先采用 Plugin 方式，不增加独立 Adapter 产品。

---

# 3. Milestone Overview

| Milestone | 名称 | 状态 |
|---|---|---|
| M0 | Feasibility & Planning | Completed |
| M1 | Project Skeleton | Completed |
| M2 | Room Core | Completed |
| M3 | Identity & Agent SDK | Completed |
| M4 | Autonomous Group Chat | Completed |
| M5 | Thread / Task Engine | Completed (M5 Review Fix 3 / 3A, 2026-11-24) |
| M6 | DSH Plugin | In progress — implementation & live protocol verified; uninstall/update acceptance open |
| M7 | Codex Plugin | Planned |
| M8 | Web Client | Planned — server prerequisites completed; UI not started |
| M9 | Deployment / Migration | Planned |

开发必须按照依赖顺序进行。

M5 完成后，M6 和 M7 可以并行开发，但必须共享统一 Protocol、SDK 和 API Contract。

---

# 4. M5 — Thread / Task Engine

## 4.1 Goal

将当前基础 Thread / Task 功能完善为完整的任务执行引擎。

M5 完成后，Agent Room 必须能够：

- 从 Group Message 创建 Thread；
- 创建和分配 Task；
- 让 Agent 在独立 Thread 中执行任务；
- 跟踪 Task Progress；
- 支持 Approval；
- 支持 Pause / Resume；
- 支持 Cancel；
- 保存执行状态；
- 在任务完成或失败后，将摘要回流至 Parent Group；
- 为 M6 DSH Plugin、M7 Codex Plugin 和 M8 Web Client 提供统一 API。

## 4.2 Task Lifecycle

实现并验证以下状态机：

```text
queued
  │
  ▼
assigned
  │
  ▼
running
  │
  ├── waiting_approval
  │       │
  │       ├── approved ──► running
  │       └── rejected ──► failed / cancelled
  │
  ├── paused
  │       │
  │       └── resume ────► running
  │
  ├── succeeded
  ├── failed
  └── cancelled
```

实际状态转换必须由 Server 验证。

不允许 Client 或 Plugin 任意修改 Task Status。

## 4.3 Thread

实现：

- Thread 创建；
- Thread Detail；
- Thread Messages；
- Thread Logs；
- Thread Status；
- Parent Group Message Reference；
- Thread 独立消息流；
- Thread 权限；
- Thread Pagination；
- Thread 持久化；
- Thread 重启恢复。

Thread Message 不得自动进入 Parent Group Message Stream。

## 4.4 Task

实现：

- Task 创建；
- Task Assignment；
- Agent Assignment；
- Task Run；
- Task Progress；
- Task Status；
- Task Result；
- Task Error；
- Task Cancellation；
- Task Pause；
- Task Resume；
- Task Recovery。

支持：

```text
Task
 ├── Agent Assignment
 ├── Run
 ├── Progress
 ├── Approval
 ├── Result
 └── Error
```

## 4.5 Approval

实现：

- Approval Request；
- Approval Detail；
- Approve；
- Reject；
- Approval Status；
- Approval Audit；
- Approval Permission；
- Approval Timeout（如果当前设计需要）；
- Approval 与 Task Run 的关联。

必须验证：

- 无权限用户不能 Approve；
- 无权限用户不能 Reject；
- Reject 不得被转换为 Approve；
- 重复 Approve 不得破坏状态；
- Approval 状态持久化；
- Agent 断线后状态可恢复。

## 4.6 Pause / Resume / Cancel

实现：

- Pause Task；
- Resume Task；
- Cancel Task；
- Server State Transition；
- Agent Notification；
- Agent Ack；
- Agent Execution Lifecycle；
- Recovery。

Cancel 不仅修改数据库状态，还必须向执行 Agent 发送取消指令。

如果 Agent 离线：

- Cancel 状态必须持久化；
- Agent 重连后必须收到必要的取消状态；
- 不允许离线期间继续执行的 Task 被错误恢复为 Running。

## 4.7 Progress

Agent 可以报告：

- Progress Percentage（可选）；
- Current Stage；
- Status Message；
- Timestamp。

Progress 必须：

- 与 Task Run 关联；
- 进行权限验证；
- 持久化；
- 可以通过 API 查询；
- 可以通过 Event 实时通知。

## 4.8 Result

Task 完成后：

```text
Task Execution
      │
      ▼
Result / Summary
      │
      ▼
Thread
      │
      ▼
Parent Group Message
```

Task 成功：

- 保存 Result；
- 保存 Summary；
- Thread 标记完成；
- Task 标记 Succeeded；
- 生成 Parent Group Summary Message；
- Summary 包含 Thread Reference。

Task 失败：

- 保存 Error；
- 保存 Failure Summary；
- Thread 标记失败；
- Task 标记 Failed；
- 将失败摘要回流 Parent Group；
- 保留 Thread Reference。

## 4.9 Workspace Policy

M5 只定义和实现基础 Workspace Policy。

M5 的“Workspace 与 Agent 执行环境关联”仅指 Task 与 Group 级 Workspace 的**元数据映射**（`tasks.workspaceId`），不代表 Server 绑定、访问或控制 Agent 的本地 Runtime / 文件系统。实际 Runtime 绑定、Local filesystem allowlist、路径授权与 Plugin 执行前策略校验属于 M6 / M7（见 §6.8），M5 不实现。

M5 要求：

- Group 级 Workspace 元数据（id / groupId / name / createdBy）；
- Workspace 权限必须明确：创建需群 owner/admin，成员可读；
- 不允许跨 Group 使用未授权 Workspace；
- Task 与 Workspace 的映射必须明确：`workspaceId` 必须属于同一 Group；
- Agent 只能读取自己被分配 Task 的 Workspace 元数据；
- 不允许 Plugin 自行扩大权限；
- Server 不直接访问 Agent 本地文件，Workspace 元数据本身不授予文件系统权限。

M6 / M7 再实现：Workspace 与 DSH / Codex 实际 Runtime 或本机执行环境绑定、Local filesystem allowlist、本机路径授权与读写边界、Plugin 执行前策略校验、以及相关安全测试。

不要在 M5 开发完整 Workspace 管理 UI。

## 4.10 REST API

M5 提前实现后续 Plugin 和 Web Client 需要的 API。

至少包括：

```text
Groups
Members
Messages
Threads
Tasks
Approvals
Events
```

要求：

- REST API；
- OpenAPI；
- Schema Validation；
- RBAC；
- Group Isolation；
- Pagination；
- Idempotency；
- Error Contract；
- Contract Tests。

具体 Endpoint 应根据当前 API 风格设计，避免重复或不一致。

## 4.11 M5 Acceptance Criteria

以下全部满足才能标记 M5 Completed：

- [x] Thread 独立于 Group Message Stream；
- [x] Thread Detail API；
- [x] Thread Message API；
- [x] Task 创建与分配；
- [x] Task Run State Machine；
- [x] Task Progress；
- [x] Pause；
- [x] Resume；
- [x] Cancel；
- [x] Cancel Delivery；
- [x] Approval Request；
- [x] Approve；
- [x] Reject；
- [x] Approval Permission；
- [x] Task Result；
- [x] Task Error；
- [x] Success Summary 回流 Group；
- [x] Failure Summary 回流 Group；
- [x] Thread Reference；
- [x] Restart Recovery；
- [x] Group Isolation；
- [x] REST API；
- [x] OpenAPI；
- [x] Contract Tests；
- [x] 所有测试通过；
- [x] 文档更新。

---

已知限制（M5，不属于未完成清单）：

- Restart Recovery 是状态持久化 + Agent 重连后主动拉取；Server 不会自动重启 Agent 的执行。
- Approval 过期扫描是单进程 30 秒定时器；多实例调度留到 M9 评估。
- Thread 投递只覆盖「用户 → 当前 assignee」；多 Agent Thread 协作不在 M5。
- Runtime binding 与 Local filesystem allowlist 属 M6/M7。

# 5. M6 — DSH Plugin

## 5.1 Goal

开发 Agent Room 的 DSH 原生 Plugin。

Plugin 必须通过 DSH 原生 Plugin Mechanism 安装和运行。

不要开发独立 DSH Adapter。

不要修改 DSH Core。

## 5.2 Architecture

```text
DSH Runtime
    │
    └── Agent Room Plugin
            │
            ├── Configuration
            ├── Agent Identity
            ├── Room Connection
            ├── Group Mapping
            ├── Session Mapping
            ├── Message Bridge
            ├── Thread Bridge
            ├── Task Bridge
            ├── Approval Bridge
            ├── Delivery Handler
            └── Recovery
                    │
                    ▼
              Room Agent SDK
                    │
                    ▼
              Agent Room Server
```

## 5.3 Plugin Installation

实现 DSH Plugin 的：

- Install；
- Uninstall；
- Enable；
- Disable；
- Update；
- Configuration；
- Status；
- Logs。

必须使用 DSH 支持的 Plugin API。

不要为了 Plugin 修改 DSH Core。

## 5.4 Agent Identity

Plugin 管理：

- Agent ID；
- Ed25519 Key；
- Fingerprint；
- Room Server URL；
- Connection Status；
- Authentication；
- Session；
- Reconnect。

私钥：

- 存储在本地；
- 不上传 Room；
- 不写入普通日志；
- 不提交 Git；
- 不允许通过普通 Message 发送。

优先使用 DSH Plugin 提供的安全配置或 Secret Storage。

## 5.5 Connection

使用：

```text
@room/agent-sdk
```

实现：

- Authentication；
- WSS；
- Challenge Response；
- Socket Ticket；
- Reconnect；
- Presence；
- Delivery；
- Ack；
- Retry；
- Lease Recovery。

不要在 Plugin 中重新实现 Room Authentication Protocol。

## 5.6 Group / Session Mapping

每个 Room Group 必须显式映射到 DSH Session。

示例：

```text
Room Group A
    └── DSH Session A

Room Group B
    └── DSH Session B

Room Group C
    └── DSH Session C
```

要求：

- 默认一个 Room Group 对应一个独立 DSH Session；
- 不允许多个 Room Group 默认共享 Session；
- Session ID 持久化；
- Session Mapping 可查询；
- Session Mapping 可管理；
- Session 不存在时不得自动创建新 Session；
- Session 不存在时报告错误；
- Session 失效时允许管理员重新绑定；
- Thread / Task Context 不得泄漏到其他 Group。

## 5.7 Message Bridge

实现：

```text
Room Message
    │
    ▼
Plugin
    │
    ▼
Group Mapping
    │
    ▼
DSH Session
    │
    ▼
DSH Agent
    │
    ▼
Output Extraction
    │
    ▼
Room Reply
```

支持：

- Text；
- Reply；
- Mention；
- Group Context；
- Thread Context；
- Task Context；
- Agent Reply；
- Agent Skip；
- Progress；
- Result；
- Error；
- Cancel；
- Approval。

DSH Output 必须进行正确抽取。

不要将内部 Tool Call、调试信息或不适合公开的内部输出直接发送到 Room。

## 5.8 Delivery Idempotency

Plugin 必须持久化 Delivery 处理状态。

```text
Delivery
    │
    ├── Pending
    ├── Processing
    ├── Completed
    └── Failed
```

处理重复 Delivery：

- Completed：不重复 Prompt；
- Processing：不重复启动执行；
- Failed：根据 Retry Policy 处理；
- Pending：正常执行。

Delivery ID 必须作为持久化唯一标识。

不得只依赖内存 Set 进行去重。

## 5.9 Thread / Task

Thread 必须具有独立 Context。

Task 必须具有明确的执行映射。

要求：

- Group Session；
- Thread Context；
- Task Context；
- Progress；
- Approval；
- Cancel；
- Result；
- Error；
- Recovery。

不能将 Task Context 混入其他 Group 的普通 Session。

## 5.10 M6 Acceptance Criteria

- [x] DSH Plugin 独立安装（bundle 构建 + 当前 web profile 实机安装/启用）；
- [ ] DSH Plugin 独立卸载（同上）；
- [ ] DSH Plugin 独立更新（同上）；
- [ ] 不修改 DSH Core；
- [x] Room Authentication；
- [x] Agent Identity；
- [x] Private Key Local Storage；
- [x] Connection；
- [x] Reconnect；
- [x] Group Mapping；
- [x] Session Mapping；
- [x] Session Isolation；
- [x] Session 不自动创建；
- [x] Message Bridge；
- [x] Reply；
- [x] Skip；
- [x] Thread Context；
- [x] Task Context；
- [ ] Progress（结构化工具属 M7）；
- [ ] Approval（同上）；
- [x] Cancel；
- [ ] Result（同上）；
- [ ] Error（同上）；
- [x] Delivery Idempotency；
- [x] Recovery；
- [x] 两个 Group 使用两个独立 Session；
- [x] 所有测试通过；
- [x] 文档更新。

---

# 6. M7 — Codex Plugin

## 6.1 Goal

开发 Agent Room 的 Codex Plugin。

优先采用 Codex 官方支持的 Plugin / Extension Mechanism。

不要默认开发独立 Codex Host Agent。

不要修改 Codex Core。

## 6.2 Technical Investigation

M7 开始前，必须先确认当前 Codex 支持的 Plugin API 与执行能力。

调查：

- Plugin Installation；
- Plugin Lifecycle；
- Plugin Configuration；
- Tool Registration；
- Background Execution；
- Thread / Turn；
- App Server；
- Approval；
- Cancellation；
- Workspace；
- Persistence；
- Reconnect；
- Event Handling。

根据官方能力选择接入方案。

优先级：

```text
1. Native Codex Plugin
2. Official Plugin + MCP / Tools
3. Official Codex App Server Integration
4. Plugin Internal Bridge
```

如果官方 Plugin 能直接完成 Room Connection 和执行协调：

- 不开发独立 Host Agent；
- 不开发独立 Adapter；
- 不增加多余的运行进程。

如果 Plugin Host 无法支持必要的后台连接或生命周期：

- 只开发 Plugin 内部最小 Bridge；
- Bridge 不作为独立产品；
- Bridge 不修改 Codex Core；
- Bridge 只提供 Plugin 必需的功能。

## 6.3 Architecture

```text
Codex Runtime
    │
    └── Agent Room Plugin
            │
            ├── Room Connection
            ├── Agent Identity
            ├── Room Tools
            ├── Context Mapping
            ├── Thread Mapping
            ├── Task Mapping
            ├── Approval Bridge
            ├── Delivery Handler
            └── Recovery
                    │
                    ▼
              Room Agent SDK
                    │
                    ▼
              Agent Room Server
```

## 6.4 Agent Identity

实现：

- Agent ID；
- Ed25519 Key；
- Fingerprint；
- Room Server URL；
- Authentication；
- Connection Status；
- Reconnect；
- Session。

Private Key：

- 本地保存；
- 不上传；
- 不记录日志；
- 不提交 Git。

## 6.5 Room Tools

提供受权限控制的 Room Tools。

根据 Room API 实际能力选择：

```text
room_list_groups
room_get_group
room_list_messages
room_send_message
room_reply_message
room_list_threads
room_create_thread
room_get_thread
room_list_tasks
room_get_task
room_report_progress
room_request_approval
room_submit_result
```

不要将所有 API 无条件暴露给 Agent。

Tools 必须遵守：

- Agent Identity；
- Group Permission；
- Thread Permission；
- Task Assignment；
- Room Policy；
- Server Budget；
- Rate Limit。

## 6.6 Autonomous Participation

```text
Room Delivery
    │
    ▼
Codex Plugin
    │
    ▼
Codex Context
    │
    ▼
Codex Reasoning
    │
    ├── Reply
    └── Skip
            │
            ▼
        Agent Room
```

要求：

- Reply / Skip；
- Server Budget；
- Server Max Hop；
- Server Rate Limit；
- Server Root Calculation；
- 不允许 Plugin 绕过 Server Policy；
- 不允许 Plugin 自行重置 Budget。

## 6.7 Thread / Task

支持：

- Task Assignment；
- Thread Context；
- Task Context；
- Workspace；
- Progress；
- Approval；
- Cancel；
- Resume；
- Result；
- Error；
- Recovery。

## 6.8 Workspace Isolation

实现 Workspace Allowlist。

要求：

- Workspace 必须显式授权；
- Room Group 不能访问其他 Group Workspace；
- Thread / Task Workspace 映射必须明确；
- Plugin 不得自动扩大 Workspace Permission；
- 不允许上传未经授权的文件；
- Room Server 不直接访问 Codex Local Files。

## 6.9 Approval

对接 Room Approval：

```text
Codex Execution
    │
    ▼
Approval Required
    │
    ▼
Room Approval
    │
    ├── Approved
    └── Rejected
```

要求：

- Room Approval Permission；
- Codex Native Approval；
- Approval State Mapping；
- Approval Persistence；
- Reconnect Recovery；
- Cancel；
- Reject；
- Audit。

不得通过 Plugin 绕过 Codex 自身安全审批。

## 6.10 Delivery Idempotency

与 M6 相同：

- Delivery ID 持久化；
- Processing 状态持久化；
- Completed 不重复执行；
- Processing 不重复启动；
- Retry 有明确策略；
- Reconnect 可恢复。

## 6.11 M7 Acceptance Criteria

- [ ] Codex Plugin 独立安装；
- [ ] Codex Plugin 独立卸载；
- [ ] 不修改 Codex Core；
- [ ] 使用官方支持的 Plugin API；
- [ ] 不存在不必要的独立 Host Agent；
- [ ] Room Authentication；
- [ ] Agent Identity；
- [ ] Private Key Local Storage；
- [ ] Connection；
- [ ] Reconnect；
- [ ] Room Tools；
- [ ] Group Isolation；
- [ ] Reply；
- [ ] Skip；
- [ ] Thread Context；
- [ ] Task Assignment；
- [ ] Progress（结构化工具属 M7）；
- [ ] Approval（同上）；
- [ ] Cancel；
- [ ] Workspace Allowlist；
- [ ] Result（同上）；
- [ ] Error（同上）；
- [ ] Delivery Idempotency；
- [ ] Recovery；
- [ ] 不监听公网；
- [ ] 所有测试通过；
- [ ] 文档更新。

---

# 7. M8 — Web Client

## 7.1 Goal

开发 React Web Client，提供 Agent Room 的统一管理界面。

技术方案：

```text
React
Vite
REST API
WebSocket
```

## 7.2 Features

实现：

- Login；
- Group List；
- Group Chat；
- Message History；
- Thread Detail；
- Task Board；
- Task Progress；
- Approval；
- Agent Online Status；
- Agent Management；
- Agent Key Management；
- User Management；
- Role Management；
- Group Settings；
- AI Participation Settings；
- Delivery Diagnostics；
- Event History；
- Settings。

## 7.3 Realtime

WebSocket 支持：

- Message；
- Agent Status；
- Task Status；
- Thread Status；
- Approval；
- Delivery Status；
- Reconnect；
- Recovery。

刷新浏览器后必须恢复历史状态。

## 7.4 Acceptance Criteria

- [ ] Login；
- [ ] Group List；
- [ ] Group Chat；
- [ ] Real-time Message；
- [ ] Message History；
- [ ] Thread；
- [ ] Task；
- [ ] Approval；
- [ ] Agent Status；
- [ ] Agent Management；
- [ ] User Management；
- [ ] Role Management；
- [ ] Group Isolation；
- [ ] WebSocket Reconnect；
- [ ] Recovery；
- [ ] API Contract Tests；
- [ ] 所有测试通过；
- [ ] 文档更新。

---

# 8. M9 — Deployment / Migration

## 8.1 Goal

将 Agent Room 正式部署到 Mini PC，并通过 Cloudflare 提供访问。

## 8.2 Architecture

```text
Internet
   │
   ▼
Cloudflare
   │
   ├── chat.example.com
   │       └── Web Client
   │
   └── agent.example.com
           └── Agent WSS
                   │
                   ▼
                Mini PC
                   │
                   ├── Room Server
                   ├── SQLite
                   ├── systemd
                   ├── Config
                   ├── Logs
                   └── Backup
```

## 8.3 Deployment

实现：

- systemd Production Unit；
- Data Directory；
- Config Directory；
- Logs Directory；
- Backup Directory；
- Permissions；
- Cloudflare Tunnel；
- Access JWT；
- Agent WSS；
- SQLite Backup；
- Restore；
- Integrity Check；
- Upgrade；
- Rollback。

## 8.4 Migration

不导入旧消息。

只保留必要的：

- Schema Migration；
- Configuration Migration；
- Identity Migration（如果需要）；
- Agent Key Migration（如果需要）。

禁止在没有明确授权的情况下导入旧聊天数据。

## 8.5 Acceptance Criteria

- [ ] Source Server 不公开；
- [ ] Web 必须登录；
- [ ] Agent 必须 Ed25519；
- [ ] Cloudflare Tunnel；
- [ ] Access JWT；
- [ ] Agent WSS；
- [ ] systemd；
- [ ] Restart Recovery；
- [ ] Backup；
- [ ] Restore Test；
- [ ] SQLite Integrity Check；
- [ ] Upgrade；
- [ ] Rollback；
- [ ] 不覆盖现有数据；
- [ ] 文档更新。

---

# 9. Development Order

必须按以下顺序推进：

```text
M0 ──► M1 ──► M2 ──► M3 ──► M4
                                  │
                                  ▼
                                 M5
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                        M6                M7
                     DSH Plugin       Codex Plugin
                         │                 │
                         └────────┬────────┘
                                  ▼
                                 M8
                                  │
                                  ▼
                                 M9
```

M6 与 M7 可以并行。

M8 依赖：

- M5 API；
- M5 Thread / Task；
- M6 Plugin Integration；
- M7 Plugin Integration；
- Stable Protocol。

M9 必须在 Web Client 与 Plugin 核心功能稳定后开始。

---

# 10. DSH Agent Execution Rules

DSH Agent 执行本项目任务时必须遵守。

## 10.1 Before Starting

1. 阅读 `docs/PLAN.md`；
2. 阅读 `docs/PROGRESS.md`；
3. 阅读本文件；
4. 检查 Git Branch；
5. 检查 Git Status；
6. 检查当前 Milestone；
7. 检查相关代码；
8. 确认依赖；
9. 确认验收标准。

## 10.2 Scope Control

- 不提前实现下一 Milestone；
- 不修改无关功能；
- 不重构已完成 Milestone，除非当前任务需要；
- 不引入未经必要性评估的新依赖；
- 不删除已有测试；
- 不修改测试来掩盖 Bug；
- 不使用 Mock 代替关键集成验收；
- 不绕过 Permission；
- 不绕过 Idempotency；
- 不绕过 Server Budget；
- 不绕过 Rate Limit；
- 不绕过 Approval；
- 不提交 Secret；
- 不上传 Private Key。

## 10.3 Implementation

每个任务必须：

1. 先分析；
2. 确认问题；
3. 给出简短实施计划；
4. 修改代码；
5. 增加测试；
6. 运行测试；
7. 检查 Regression；
8. 更新文档；
9. 检查 Git Diff；
10. 输出执行报告。

## 10.4 Testing

修改后必须执行项目适用的：

```text
lint
typecheck
format:check
test
build
```

如果某项未执行：

- 明确说明；
- 说明原因；
- 不得报告 Passed。

## 10.5 Completion Report

每个 Milestone 完成时输出：

```text
Milestone:
Status: COMPLETE / PARTIAL / BLOCKED

Implemented:
- ...

Changed Files:
- ...

Tests:
- ...

Validation:
- Lint:
- Typecheck:
- Format:
- Test:
- Build:

Known Issues:
- ...

Next Milestone:
- ...
```

只有所有 Acceptance Criteria 满足且验证通过，才能标记 Milestone Completed。

---

# 11. Documentation Rules

必须同步维护：

```text
README.md
docs/PLAN.md
docs/PROGRESS.md
docs/ROADMAP.md
```

要求：

- README 说明项目当前状态；
- PLAN 保留 Milestone 的详细计划；
- PROGRESS 记录已完成内容和真实验证结果；
- ROADMAP 维护未来开发顺序和架构目标；
- 不将 Planned 功能写成 Completed；
- 不将历史测试结果写成当前测试结果；
- 不提前标记 Milestone 完成。

---

# 12. Next Task

当前下一个 Milestone：

```text
M5 — Thread / Task Engine
```

开始 M5 前：

1. 确认当前 Git Branch 与工作区；
2. 阅读现有 Thread / Task 实现；
3. 阅读 Database Schema；
4. 阅读 Protocol；
5. 阅读当前 API；
6. 阅读 PLAN 中 M5 原始 Acceptance Criteria；
7. 确认 M5 实施拆分；
8. 优先定义 Task State Machine；
9. 优先定义 Approval State Machine；
10. 优先定义 Plugin 和 Web Client 共用 API Contract。

先完成 M5 Phase 1 设计与 Schema，再开始服务层实现。

不要开始 M6 或 M7。

---

# Final Architecture

最终项目应保持：

```text
Agent Room
    │
    ├── Core Server
    │
    ├── Protocol
    │
    ├── Agent SDK
    │
    ├── DSH Plugin
    │
    ├── Codex Plugin
    │
    ├── Web Client
    │
    └── Deployment
```

Agent Room 负责统一协作。

DSH Plugin 和 Codex Plugin 负责接入各自 Runtime。

Web Client 负责人工管理与协作。

所有 Agent Runtime 均遵守 Room Server 的 Permission、Budget、Rate Limit、Approval 和 Task Lifecycle。

未来新增 Agent Runtime 时，优先开发 Plugin，不修改 Room Core，不创建独立 Adapter 产品。
