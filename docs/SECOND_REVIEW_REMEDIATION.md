# 第二轮审查整改记录（2026-11-28）

基线：`4e15105`；代码提交：`6249863`。逐项先复核、补回归测试，再最小修复。

## 状态表

| Issue                         | 状态   | 修改文件                                                                 | 新增/关键测试                                                                          |
| ----------------------------- | ------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| P0-01 Owner 权限              | 已修复 | `apps/server/src/modules/permissions.ts`、`groups.ts`                    | `group-owner-permissions.test.ts`（6）                                                 |
| P0-02 Turn 串扰/超时          | 已修复 | `adapters/dsh-plugin/src/bridge.ts`、`store.ts`                          | `bridge.test.ts`：A 超时 B 正常、迟到事件忽略、非 Room 对话忽略、连续请求              |
| P0-03 取消影响整个 Session    | 已修复 | `bridge.ts`、`store.ts`、`packages/agent-sdk/src/index.ts`               | 取消 Task A 不影响 Task B、未恢复时拒绝取消、重启后状态保留                            |
| P0-04 回复无服务端 ACK        | 已修复 | `bridge.ts`、`store.ts`、`packages/agent-sdk/src/index.ts`               | ACK 前 `reply_pending`、ACK 后 completed、失败保留、重连同 `clientMessageId` 补发      |
| P1-01 Prompt 入队竞态         | 已修复 | `bridge.ts`                                                              | prompt 未 resolve 时先发 user/message + turn/end 不丢回合                              |
| P1-02 恢复丢失 Assistant 文本 | 待验证 | `bridge.ts`                                                              | 现有恢复测试覆盖 turnNumber/requestId 与 partial text；未单独构造「仅有 turn/end」场景 |
| P1-03 取消后重投              | 已修复 | `bridge.ts`、`store.ts`                                                  | 取消后同一 Delivery 重投不再 Prompt，状态保持 cancelled                                |
| P1-04 task.cancelled 事件     | 已修复 | `bridge.ts`、`apps/server/src/modules/tasks.ts`                          | task.cancelled 只取消所属 Task                                                         |
| P1-05 Graceful Stop           | 已修复 | `bridge.ts`                                                              | stop 调用 `deliveryStore.flush()`，待写入落盘                                          |
| P1 Web-01 ChatView Grid       | 已修复 | `apps/web/src/views/ChatView.tsx`、`styles.css`                          | 构建 + E2E                                                                             |
| P1 Web-02 群组切换竞态        | 已修复 | `ChatView.tsx`                                                           | E2E 切群不显示其他群消息                                                               |
| P1 Web-03 历史滚动位置        | 待验证 | `ChatView.tsx`                                                           | 代码实现；无独立组件测试                                                               |
| P1 Web-04 MembersView 权限    | 已修复 | `MembersView.tsx`、`apps/server/src/modules/groups.ts`、`routes/room.ts` | HTTP 候选接口 403/200；群范围候选                                                      |
| P1 Web-05 DiagnosticsView     | 已修复 | `DiagnosticsView.tsx`                                                    | 代码 + 构建；非管理员不请求诊断接口                                                    |
| P1 Web-06 TasksView 残留      | 已修复 | `TasksView.tsx`                                                          | 切群清空 selected/approvals                                                            |
| P2-01 回复预算后无效派发      | 已修复 | `apps/server/src/modules/participation.ts`                               | 用户插话在预算耗尽后零 fan-out + `reply_budget`                                        |
| P2-02 Session TTL 溢出        | 已修复 | `packages/config/src/index.ts`、`routes/agent.ts`                        | 1h/7d/上限通过，超限 ConfigError                                                       |
| P2-03 生产 WS Origin          | 已修复 | `config/agentroom.env.example`、`packages/config/src/index.ts`           | access 不继承 localhost；显式域名生效                                                  |
| P2-04 查询参数校验            | 已修复 | `routes/room.ts`                                                         | 非法 limit / threads status / tasks status 返回 400                                    |
| P2-05 Realtime 错误帧         | 已修复 | `modules/realtime.ts`、`apps/web/src/realtime.ts`                        | web 错误帧 message/fallback code 测试                                                  |
| P2-06 Session 到期关闭        | 待验证 | `routes/agent.ts`                                                        | 到期前 `hub.unregister`；无独立单测                                                    |
| P2-07 UUID 兼容               | 待验证 | `ChatView.tsx`                                                           | `randomId()` 回退；无独立单测                                                          |
| P3-01 Bearer 大小写           | 已修复 | `auth/plugin.ts`、`routes/room.ts`                                       | 小写 `bearer` HTTP 测试通过                                                            |
| P3-02 deleteMessage 类型      | 已修复 | `apps/web/src/api.ts`                                                    | bodyless DELETE + void 测试                                                            |
| P3-03 Agent Keys 不可达 UI    | 已修复 | `AgentsView.tsx`                                                         | 删除 revokedAt 分支（API 仅返回 active）                                               |
| P3-04 ThreadsView 合并        | 已修复 | `ThreadsView.tsx`                                                        | 统一 `mergeMessages()`                                                                 |
| P3-05 finishTurn 异常传播     | 已修复 | `bridge.ts`                                                              | ACK 失败保留 `reply_pending`；终态守卫                                                 |

## 验证

- `pnpm test`：46 files / 334 tests 全部通过。
- `CI=true pnpm e2e`：10 passed。
- `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm build`：全部通过。
- 数据库：无新增迁移；`deliveries.json` 保持 v1 读取 / v2 写入兼容。

## 遗留

- P1-02、P1 Web-03、P2-06、P2-07 标注「待验证」，未声称已通过。
- 插件回复语义为 at-least-once + 幂等（同 `clientMessageId`），非 exactly-once。
- Realtime 仍为 300ms 轮询（单实例 SQLite 架构下的已知选择）。
