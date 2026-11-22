# 迁移方案：旧 JSON → 新 SQLite

目标：把旧 Go 服务的 `state.json` 一次性导入新版 SQLite，保留历史消息与任务语义；旧实现作为只读参考保留，切换前不删除、不双写。

## 1. 原则

1. 单向迁移：JSON → SQLite；新服务不 import Go 代码，不依赖 Open Agent Room 内部包。
2. 旧数据源在切换后只读；Go 与 Node 不得同时写同一业务数据。
3. 保留 `legacy_id` 与原始 `createdAt` / `updatedAt`，不假设旧 ID 符合新 ID 策略。
4. 不导入共享/内存 token；不导入 daemon 运行态；`currentUserId` 不迁移。
5. 导入前备份原 JSON，导入过程在单个事务内完成，失败整体回滚。

## 2. 旧实体 → 新实体映射

| 旧实体 | 旧字段 | 新表 / 实体 | 映射说明 |
|---|---|---|---|
| `User` | id,name,color | `users(legacy_id,name,color,created_at)` | `usr_you` 保留为 legacy_id；新用户由 M3 身份系统创建 |
| `Channel` | id,name,topic,memberIds,defaultAgentId,hidden | `groups(legacy_id,name,topic,kind,hidden,default_agent_id,created_at)` + `group_members` | `memberIds` 拆成成员表；`hidden` 任务频道 → `kind='task'`（Thread 化见 M5） |
| `Message` | id,channelId,authorKind,authorId,authorName,text,kind,timestamp,tags,protocolId | `messages(legacy_id,group_id,thread_id,author_kind,author_id,author_name,text,kind,created_at)` + `message_tags` | `channelId` → `group_id`；`protocolId` 保留在 `client_ref`；tags 拆表 |
| `Agent` | id,name,persona,systemPrompt,runtime,model,status,daemonId,capabilities,memory,skillIds,skills,color,lastSeen,external | `agents(legacy_id,name,persona,system_prompt,runtime_kind,model,status,color,created_at,last_seen)` + `agent_keys` + `agent_memories` + `agent_skills` | `daemonId` 丢弃；`external=true` → `runtime_kind='external'`；token 不导入 |
| `AgentSkill` | id,name,source,content,tags,createdAt | `skills(legacy_id,name,source,content,created_at)` + `skill_tags` | 同名 skill 去重按 `legacy_id` |
| `TaskLane` | id,name,position | `task_lanes(legacy_id,name,position)` | 保留顺序 |
| `Task` | id,title,description,workdir,laneId,channelId,assigneeKind,assigneeId,createdBy,createdAt,updatedAt | `tasks(legacy_id,title,description,workdir,lane_id,group_id,assignee_kind,assignee_id,created_by,created_at,updated_at)` | `channelId` → 关联 group；Task Channel 与 Thread 的最终关系在 M5 定稿（先保留 group_id） |
| `Envelope` | id,type,ts,serverId,actor,scope,payload,trace | `events(legacy_id,type,created_at,actor_kind,actor_id,scope_kind,scope_id,payload_json,trace_json)` | 全部保留，供审计与前端回放 |
| `Daemon` | id,name,status,... | **不导入** | 新架构没有 daemon 概念；运行态不迁移 |
| `Agent.Token` | 内存 | **不导入** | 新流程用 Ed25519 公钥登记 |
| `Meta` | version=1 | `schema_migrations` | 版本号用于导入器校验 |

### 2.1 ID 策略

- 新 ID 沿用可读前缀：`usr_` / `grp_` / `msg_` / `agt_` / `task_` / `lane_` / `evt_`，后接随机 base32。
- 每张表保留 `legacy_id TEXT UNIQUE`；另建 `legacy_map(old_table, old_id, new_id)`，用于消息作者、任务负责人等跨表引用修复。
- 旧 agent ID 基于名字 slug 生成，**不得**假设其稳定；对外只暴露新 ID，历史引用通过映射表还原。

### 2.2 明确不迁移 / 需产品决策

- `daemons`（17 条历史残留）与 `agent.daemonId`：丢弃。
- `currentUserId=usr_you`：不迁移，M3 用真实身份替换。
- 旧 Task Channel ↔ 新 Thread 的关系：M5 前只保留 `group_id`；是否把每个 Task Channel 升级为 Thread、以及完成回流目标群，需在 M5 设计确认。
- 旧 `THREAD_STATUS` 标记：迁移时可解析为事件标签，不写入消息正文（新协议单独字段）。

## 3. 导入器

```text
pnpm db:import \
  --in  /data/agent-room/state.json \
  --db  /var/lib/agentroom/room.db \
  --report import-report.json
```

步骤（对应计划 §15.2）：

1. 备份原 JSON（`state.json.bak-<timestamp>`），校验可读。
2. 读取并校验 `meta.version == 1`；未知版本直接拒绝。
3. 建立旧 ID → 新 ID 映射。
4. 按顺序导入 users → groups/members → agents → skills → task_lanes → tasks → messages → events。
5. 恢复 `createdAt` / `updatedAt` / `lastSeen`；UTC ISO 字符串。
6. 记录无法映射或被拒绝的记录（缺作者、缺频道、重复 legacy_id）。
7. 生成导入报告：各表数量、被拒绝清单、耗时。
8. 对比导入前后实体数与关系（messages 作者均在 users/agents 中；task.lane_id、message.group_id 均存在）。
9. 不覆盖旧备份；重复执行默认拒绝（非空库需 `--force` 且先备份）。

验收：抽样 10 条消息与旧 JSON 逐字段一致；任务数与 lane 分布一致；事件数一致。

## 4. Legacy API Adapter（迁移期）

迁移期保留三个旧接口，由新服务内部调用新版 Service 实现，不复制业务逻辑：

- `GET /api/agent/inbox?name=&since=&include_agents=`
- `POST /api/agent/reply`（`Idempotency-Key`、`X-Agent-Token`、`X-Bridge-Hop`）
- `POST /api/agent/heartbeat`

用途：现有已安装的 DSH 插件（`/opt/dsh-room-bridge`）在插件 TS 移植完成前仍可工作。插件迁移到 `adapters/dsh-plugin` 并通过验收后删除 Legacy Adapter（计划 §15.3）。

## 5. 切换与回滚

前置：新版在 `127.0.0.1:8787` 与旧版 `:8791` 并行运行；旧服务停止写入前，新版只读旧 JSON 做演练，不双写。

切换步骤：

1. 通知使用者，备份 `state.json` 与 `data/` 全量。
2. 停止 `agent-room.service`，确认端口释放、无写入。
3. 对生产库执行导入器（先在副本演练通过）。
4. 启动新版 Room Server（systemd），检查 readiness、核心 API、WebSocket。
5. 切换 Cloudflare Tunnel origin 到新版端口；旧服务保持停止（或仅回滚时启动）。
6. 验证：登录、群组消息、Agent 收件箱、Thread/Task 基本流程。
7. 保留旧二进制与 JSON 备份至少 14 天。

回滚：

1. 停止新版服务；恢复旧 `state.json` 备份。
2. 启动旧 `agent-room.service`，确认 `:8791` 正常。
3. 切换 Tunnel origin 回旧端口。
4. 新版切换后若产生新数据，必须先用导出脚本（M9 提供）导出为旧格式，**不能**假设 SQLite 能自动写回 JSON。

## 6. 已知限制

- 旧 `state.json` 中 17 个 daemon 与部分 agent 的 `daemonId` 已失效，导入时直接丢弃并记入报告。
- 旧事件 120 条、消息 61 条、任务 3 条，规模很小，导入可在数秒内完成；不需要分批。
- 旧 Task Channel 的 `hidden` 语义在新版用 group kind + Thread 表达，最终形态在 M5 确认前不写入历史消息。
