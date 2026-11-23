# 认证与 Agent 身份（M3）

本文档记录 M3 的人类身份、Agent 密钥、Challenge/Response、WSS 会话与在线租约设计。
实现以 `apps/server/src/auth/`、`apps/server/src/modules/agentAuth.ts` 与
`packages/protocol/src/agent.ts` 为准。

## 1. 人类用户

| 模式     | 凭证                                                      | 说明                                                         |
| -------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `dev`    | `x-dev-user-id` 或 `x-dev-user-email`                     | 仅开发/测试；只接受已登记且 active 的用户，不自动建用户      |
| `access` | `Cf-Access-Jwt-Assertion`（Cloudflare Access 注入的 JWT） | `jose` 校验 `iss` / `aud` / 过期时间；生产环境默认且唯一允许 |

- `NODE_ENV=production` 时配置层直接拒绝 `AUTH_MODE=dev`（`packages/config`）。
- Access JWT 的 `email` 先映射 `external_identities(issuer, subject)`；未映射时按小写邮箱匹配已有用户并自动建立映射，
  未登记邮箱返回 401，禁用用户返回 403。
- 首个 Owner 由 `BOOTSTRAP_OWNER_EMAIL` 在**用户表为空**时创建一次；之后该环境变量被忽略，Owner/Admin 必须走 RBAC。
- RBAC：`owner` / `admin` / `member` / `readonly`。`readonly` 不能写；只有 `owner` 能授予或撤销 `admin` / `owner`；
  系统 Owner/Admin 可以管理自己不在其中的群组；普通成员只能看自己加入的群组。

## 2. Agent 密钥

- 每个 Agent 至少一把 **Ed25519** 公钥；私钥永远只在 Agent 侧。
- 提交的是 SPKI PEM；服务端用 `crypto.createPublicKey` 校验算法，导出规范 PEM，并计算
  `fingerprint = sha256(SPKI DER) hex`。调用方不能自带 fingerprint。
- 注册（`POST /api/v1/agents`，仅 Owner/Admin）在**同一事务**内写 `agents` + `agent_keys` +
  `agent.registered` / `agent.key_registered` 事件 + 两条审计。
- 追加/吊销密钥同样只允许 Owner/Admin；吊销会关闭该 key 关联的所有 session，并断开在线 socket。

## 3. Challenge / Response

Agent 证明私钥持有，服务端据此解析身份；请求里的 `agentId` 只是提示，绝不用于鉴权。

1. `POST /api/v1/agent/challenge`，body `{ fingerprint, agentId?, clientNonce? }`。
   未登记 / 已吊销 / 禁用一律 401，不区分原因。
2. 服务端生成 `challengeId`、32 字节 `nonce`，TTL 默认 60s，写入 `agent_challenges`。
3. 签名串固定为（UTF-8，`\n` 分隔，**顺序不可变**）：

```text
agentroom-agent-connect-v1
serverId=<serverId>
challengeId=<challengeId>
nonce=<nonce>
clientNonce=<clientNonce>
agentId=<agentId>
keyFingerprint=<fingerprint>
expiresAt=<毫秒整数>
purpose=agent-connect
protocolVersion=1
```

4. `POST /api/v1/agent/connect`，body `{ challengeId, signature }`；`signature = base64(Ed25519(canonical))`。
5. 服务端先验签，再以 `UPDATE ... SET used_at = ... WHERE id = ? AND used_at IS NULL` 原子消费 challenge：
   受影响行数不是 1 即视为重放。并发 connect 只有一个成功。

签名串由 `packages/protocol/src/agent.ts` 的 `buildAgentChallengeString` 生成，Server、SDK、mock Agent 共用同一实现，避免漂移。

## 4. 会话与 WSS

- connect 成功返回 `sessionToken`（32 字节 base64url，只展示一次）；数据库只存 `sha256(token)`。
- 默认会话 TTL 12h；服务端对活跃 socket 也执行到期关闭（`error: session_expired` + close 1008）。
- 升级凭证：`POST /api/v1/agent/socket-ticket`（`Authorization: Bearer <sessionToken>`）换取一次性、短时的 `ticket`，再 `GET /api/v1/agent/connect?ticket=...`；也接受 `Authorization: Bearer <sessionToken>` 直接升级。长期 session token 不再出现在 URL，重复使用或过期 ticket 均 401。
- 帧：

| 方向           | 帧                                                                     |
| -------------- | ---------------------------------------------------------------------- |
| Server → Agent | `hello`（serverId、heartbeatMs、sessionExpiresAt、agent、outstanding） |
| Server → Agent | `event.deliver`（deliveryId + 事件体）                                 |
| Agent → Server | `event.ack` `{ deliveryIds }` → `ack.ok`                               |
| Agent → Server | `ping` → `pong`；`message.send` → `message.sent`；`agent.status`       |
| Server → Agent | `error`（`unauthorized` / `session_closed` / `command_failed` 等）     |

- 投递顺序：`pending → delivered`（发送前标记）→ `acked`。进程每秒扫描一次该 Agent 的
  `pending` + 已送达未 ack 的投递；重连后未 ack 的事件会再次投递，Agent 按 `deliveryId` 去重。
- Agent 自己发送的消息不会生成给自己的投递。

## 5. 在线租约

- WSS 认证成功即 `online`，断开最后一个 socket 即 `offline`；状态变化写 `agent.status.changed` 事件。
- 客户端默认每 20s `ping`；服务端按 `AGENT_PRESENCE_TTL_MS`（默认 60s）清扫静默 session，
  超时置 `offline` 并断开对应 socket。进程崩溃后，过期 session 同样会被清扫。

## 6. 关键端点

| 方法 | 路径                                        | 权限                       |
| ---- | ------------------------------------------- | -------------------------- |
| GET  | `/api/v1/me`                                | 登录用户                   |
| GET  | `/api/v1/users`、`POST /api/v1/users`       | Admin 起                   |
| GET  | `/api/v1/agents`、`POST /api/v1/agents`     | Owner/Admin                |
| GET  | `/api/v1/agents/:id`、`/keys`、`POST /keys` | Owner/Admin                |
| POST | `/api/v1/agents/:id/keys/:keyId/revoke`     | Owner/Admin                |
| POST | `/api/v1/agent/challenge`、`/connect`       | 公钥持有者                 |
| POST | `/api/v1/agent/socket-ticket`               | 会话 token                 |
| GET  | `/api/v1/agent/connect`（WebSocket）        | 一次性 ticket / 会话 token |

`/healthz`、`/readyz` 与旧版 `/ws` 保持公开；其他路径必须先解析出 Principal。

## 7. 已知偏差与边界

- 握手走「HTTP challenge → HTTP connect → WSS 带 token」；计划中的“在 WSS 内完成 challenge”尚未实现，
  但签名串、一次性消费与身份解析逻辑一致。后续可在不改变协议字符串的前提下迁移。
- 群组/消息没有 HTTP API（M4 提供），因此 mock Agent 目前只能验证连接与事件接收，不能主动拉取群消息。
- 会话 token 目前固定 TTL，没有主动轮换；Access JWT 只做在线校验，不在服务端保存。
- 审计覆盖注册、加/吊销密钥、用户与群组管理、任务操作；Agent 连接本身不逐条写审计（状态事件已足够）。

## 8. M3 评审修复（2026-11-23）

- **Agent 公开发言默认关闭**：`AGENT_MESSAGES_ENABLED=false`（生产禁止设为 true）时，WSS `message.send` 返回 `error: agent_messages_disabled`，不写 message/event/delivery。重新开放的条件：M4 完成 `allowAgentMessages`、`maxHops`、`maxRepliesPerRoot`、`maxAgentMessagesPerMinute` 的服务端原子校验（含 hop 递增），并补超限与循环停止测试。
- **SDK 至少一次投递**：`onEvent(event, { deliveryId, attempt })`；未配置 handler 不 ack，handler 抛错不 ack，`attempt` 在 socket 生命周期内递增，便于应用做持久化幂等；收到服务端 `ack.ok` 后删除对应计数，Map 不随已确认事件增长。SDK 不承诺去重。
- **升级票据**：`agent_socket_tickets` 只存 `sha256(ticket)`，原子消费，TTL 由 `AGENT_SOCKET_TICKET_TTL_MS`（5s–5min）控制；应用日志 `requestLogSerializer` 去掉 query string，代理侧日志也不应记录升级 URL。
- **会话 TTL**：`AGENT_SESSION_TTL_MS` 对活跃连接生效（到期定时器 + 每帧校验）；到期断开、关闭数据库 session，并在没有其他活跃 socket 时置 `offline`。
- **Challenge 防滥用**：每个 key 最多 5 个活跃 challenge（超出 429 `rate_limited`）；每 10 分钟清理已消费/过期的 challenge 与 ticket。
- **邮箱唯一**：`users_email_lower_uq` 唯一索引（`lower(email)`）；迁移前检查旧库重复邮箱并明确报错，Access 邮箱映射不再有歧义。
