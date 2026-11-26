# 浏览器实时事件通道

面向 M8 Web Client 的服务端实时层。它只把已持久化的 `events` 行推送给浏览器；
内存不保存唯一副本，刷新、断线和重连都从 SQLite 重放。

## 认证

浏览器无法在 WebSocket Upgrade 上设置 `Authorization` 头，因此先换取一次性 ticket：

```http
POST /api/v1/realtime/ticket
Authorization: Cf-Access-Jwt-Assertion: <Access JWT>   # 生产
x-dev-user-id: usr_...                                  # 开发模式
```

响应：

```json
{ "ticket": "<opaque>", "expiresAt": 1790000000000 }
```

- ticket 只保存在 Server 进程内（哈希后），默认 60 秒过期，使用一次即失效；
- `GET /api/v1/realtime/ws?ticket=<opaque>` 升级 WebSocket；
- 缺失、过期、重复使用或伪造的 ticket 会以 `1008` 关闭连接；
- 进程重启会让未使用的 ticket 失效，但**业务事件不会丢失**（仍可从 `events` 表重放）。

## 帧

Server → Client：

```json
{ "type": "hello", "userId": "usr_...", "now": 1790000000000, "pollMs": 300 }
```

Client → Server 订阅一个 Group（同一连接同一时间只订阅一个 Group）：

```json
{ "type": "subscribe", "groupId": "grp_...", "afterSeq": 123 }
```

- `afterSeq` 可省略：省略时只接收订阅之后的新事件；
- `afterSeq` 存在时从该 `events.seq` 之后开始重放；
- 订阅时会校验 Group 成员身份，非成员收到 `{ "type": "error", "code": "forbidden" }`。

Server → Client 确认：

```json
{ "type": "subscribed", "groupId": "grp_...", "afterSeq": 123 }
```

订阅成功后，Server 立即推送一次 Agent 在线快照；之后每 300ms 检查一次，变化时才再推：

```json
{
  "type": "presence",
  "groupId": "grp_...",
  "agents": [
    { "agentId": "agt_...", "displayName": "dsh-linux", "status": "online", "online": true }
  ]
}
```

`status` 是 Agent 的持久状态（`online` / `offline` / `disabled`），`online` 是当前 lease
（默认 60 秒）内是否有活跃 Agent Session；两者可能短暂不一致。

事件帧：

```json
{
  "type": "event",
  "event": {
    "seq": 124,
    "id": "evt_...",
    "type": "message.created",
    "groupId": "grp_...",
    "threadId": null,
    "taskId": null,
    "actorType": "user",
    "actorId": "usr_...",
    "payload": { "messageId": "msg_...", "content": "hello" },
    "createdAt": 1790000000123
  }
}
```

其他帧：

```json
{ "type": "ping" }
{ "type": "pong", "now": 1790000000000 }
{ "type": "unsubscribe" }
{ "type": "unsubscribed" }
{ "type": "error", "code": "invalid_json" | "invalid_frame" | "frame_too_large" |
                            "groupId_required" | "afterSeq_invalid" | "forbidden" |
                            "unknown_frame" }
```

## 投递语义

- 每个连接每 300ms 最多读取 100 条 `seq > cursor` 的 Group 事件（`events_group_seq_idx`）；
- 只推进 cursor 到已发送事件，慢客户端不会阻塞其他连接；
- 事件先提交事务、后广播（WebSocket 只是 `events` 表的读取者），广播失败不会丢事件；
- 刷新页面后先用 REST 拉历史（`/api/v1/groups/{groupId}/messages`、
  `/api/v1/groups/{groupId}/events`），再用最后看到的 `seq` 作为 `afterSeq` 订阅；
- 单帧上限 64 KiB，超出以 `1009` 关闭。

## 权限生命周期

- ticket 只能由已认证的 User Principal 获取；兑换时重新查询用户状态，禁用用户的旧
  ticket 不能升级连接；
- 订阅/每轮推送前校验 Group 成员身份与用户状态；用户被移出 Group 后由
  `RealtimeHub.revokeGroup()` 撤销订阅并推送 `error membership_revoked`，不再接收该
  Group 的事件；用户被禁用后 `RealtimeHub.closeUser()` 关闭其全部连接（`error
user_disabled` + `1008`）；
- 服务端在 `users.disableUser` / `groups.removeMember` 事务提交后主动通知 Hub，
  不依赖用户刷新或重连；
- 连接登记在 `RealtimeHub`，socket 关闭时注销；未消费的 ticket 60s 过期且单次使用。

## 安全与限制

- `REALTIME_ALLOWED_ORIGINS`（逗号分隔）限制浏览器 Origin；无 Origin 的 CLI 允许，
  但仍必须提供有效 ticket；
- `REALTIME_MAX_CONNECTIONS_PER_USER`（默认 5）限制同时连接数，超出以 1008 关闭；
- `REALTIME_TICKETS_PER_MINUTE`（默认 30）限制 ticket 获取频率，超出返回 429；
- 以上均为单进程内存计数，多实例部署需改为共享存储（M9 评估）。

## 测试

`apps/server/test/realtime.test.ts`（7 例）与 `realtime-revocation.test.ts`（9 例）：

- ticket 未认证 401、无效/重复 ticket 1008、成员收事件、afterSeq 重放、非成员
  forbidden、ping/pong、unsubscribe；
- 移出 Group 后撤销订阅并停止推送、禁用后关闭全部连接、禁用后旧 ticket 失效、
  非成员不能订阅、连接上限、ticket 限流 429、Origin 允许/拒绝、并发撤销后不再推送。

## 已知边界

- Agent 在线状态走 `presence` 轮询帧，每 300ms 重算 lease；
- ticket 与连接计数是单进程内存，符合当前单机部署；
- `thread` 级订阅与多 Group 单连接尚未提供；
- Cloudflare 代理下的 Origin 行为需在部署环境实测（本地 E2E 已验证 5173）。
