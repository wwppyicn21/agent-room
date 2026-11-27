# M8 React Web Client

`apps/web` 是 Agent Room 的统一 Web 客户端：React 19 + Vite 8 + REST + 浏览器 WebSocket。
它只通过公开 HTTP / WebSocket API 与 Server 交互，不访问数据库，也不直接依赖 DSH。

## 运行

```bash
# Server（默认 127.0.0.1:8787，dev auth 示例）
AUTH_MODE=dev BOOTSTRAP_OWNER_EMAIL=owner@example.com pnpm dev

# Web（另一个终端，http://127.0.0.1:5173）
pnpm --filter @room/web dev
```

Vite 将 `/api` 代理到 `http://127.0.0.1:8787`（含 WebSocket upgrade）。生产构建：

```bash
pnpm --filter @room/web build   # 输出 apps/web/dist
```

当前生产部署仍以 Server 为主；Web 静态文件的同源托管与 systemd 化属于 M9。

## 认证

- `GET /api/v1/auth-info`（公开）返回 `{ "authMode": "dev" | "access" }`，UI 据此选择登录方式。
- `dev`：登录框接受已注册用户邮箱，客户端用 `x-dev-user-email` 头请求；值只存 localStorage。
- `access`：浏览器先通过 Cloudflare Access 登录，UI 只显示“刷新”。
- 所有 REST 请求由 `ApiClient` 统一附加开发头，并把 `{ error: { code, message } }` 映射为 `ApiError`。

## 页面

| Tab    | 功能                                                                                      |
| ------ | ----------------------------------------------------------------------------------------- |
| 群聊   | 历史消息、实时消息、发送/回复/删除、在线 Agent presence                                   |
| Thread | Thread 列表/详情/消息/事件、从群消息创建、Thread 内回复、关闭 Thread                      |
| 任务   | 任务列表与详情、从群消息创建、分配、暂停/恢复/取消、审批批准/拒绝                         |
| 成员   | 成员列表、添加用户/Agent、角色调整（owner/admin/member）、移除                            |
| Agent  | 全局 Agent 列表、注册、禁用/启用、Key 列表/添加/吊销                                      |
| 用户   | 系统用户列表、创建、角色调整、禁用/启用（需系统管理员）                                   |
| 设置   | 群组名称/描述、participationMode、Agent 发言开关、hop/回复预算/限流、Workspace 列表与创建 |
| 诊断   | Delivery 状态统计与分页列表、事件历史（`events.seq` 游标）                                |

URL 不携带路由；当前 Group 与 dev 邮箱存 localStorage。刷新后重新拉取历史消息，
实时通道从 `0` 订阅并靠消息 id 去重，因此“刷新恢复历史”不依赖内存状态。

## 实时

`RealtimeClient` 先 `POST /api/v1/realtime/ticket` 换取一次性 ticket，再连接
`/api/v1/realtime/ws?ticket=…`，订阅当前 Group。连接断开时按 0.5s → 30s 指数退避重连；
20s 心跳 ping；`presence` 帧刷新在线 Agent；`message.created` / `message.deleted` 增量更新 UI。

## 代码结构

- `src/api.ts`：REST 客户端与 DTO、错误映射、事件 payload 解析；
- `src/realtime.ts`：ticket + Group 订阅 + 重连；
- `src/state.ts`：消息/实体合并工具；
- `src/App.tsx`：登录、群组选择、Tab 路由、全局错误/toast；
- `src/views/*`：8 个页面；
- `test/`：api / state / realtime 单元测试（7 例）；`e2e/room.spec.ts`：Playwright 浏览器 E2E（9 例）。

## 已知边界

- 没有 react-router；页面状态不进入 URL，不能直接分享深链。
- 浏览器 E2E 已覆盖登录/群组、发消息去重、断线重连补偿、Thread/Task、成员移除后不可读、普通成员任务页、群组 Agent 隔离与 `eventCursor` 断点；仍不做跨浏览器矩阵与视觉回归。
- 文件上传/下载未实现（Server 尚无附件 API）。
- `Task Progress` 的 run 明细没有独立 REST 端点，UI 展示 Task 级状态与摘要；细粒度 progress 属于后续增强。
- 实时通道是单进程内存实现；多实例部署需要 M9 评估。
