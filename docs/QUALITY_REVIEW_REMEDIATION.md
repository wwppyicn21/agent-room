# 质量审查整改报告（2026-11-26）

本报告对应 M8 完成后的专项整改：WebSocket 权限生命周期、DSH Plugin 未完成回复恢复、
DeliveryStore 并发写、CI、WebSocket 安全与浏览器 E2E。所有结论以本次实际执行的命令和
代码为准；未执行的项目明确标注。

## 1. 整改总览

| 项目                   | 状态    | 说明                                                                                                                                                   |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WebSocket 权限撤销     | PASS    | `RealtimeHub` 登记连接；禁用用户关闭全部 socket，移出 Group 撤销订阅；每轮推送前复核用户状态与成员身份。                                               |
| Ticket 二次验证        | PASS    | 兑换时重新查询 `users.status === "active"`；单次使用、60s TTL。                                                                                        |
| PendingTurn 持久化     | PASS    | `deliveries.json` v2 保存 turn（requestId/session/group/thread/message/prompt/state/text）；兼容读取 v1。                                              |
| 插件重启恢复           | PARTIAL | 已覆盖“等待回复中重启、回复已结束但未写回、写回后未更新状态（同 clientMessageId 幂等）”测试；采用 at-least-once + 幂等回复，不承诺 exactly-once。      |
| DeliveryStore 并发安全 | PASS    | 所有写操作串行化；唯一临时文件名；启动清理残留 tmp；并发/同 Delivery 更新测试通过。                                                                    |
| 历史数据清理           | PASS    | `prune({retentionDays})` 仅删除已终态且超期记录，默认 30 天，可配置；未完成/等待回复记录永不清理。                                                     |
| GitHub Actions         | PARTIAL | Install 历史失败根因是插件 lockfile 与依赖不一致，已由 `0948c7c` 修复且后续运行成功；本次整改新增 Playwright 步骤，待本次推送的 CI 运行验证（见 §4）。 |
| WebSocket Origin       | PASS    | 配置化 allowlist；无 Origin 的 CLI 允许但仍需 ticket；不在列表内以 1008 关闭。                                                                         |
| E2E 测试               | PASS    | Playwright 6 个场景覆盖 10 个流程（含登录、群聊、重连补偿、重复消息、Thread/Task、移除成员、踢出后不可读取）。                                         |
| 文档同步               | PASS    | 本报告 + README/PROGRESS/REALTIME/DSH_PLUGIN/env 示例。                                                                                                |

## 2. 修改文件清单

| 文件                                                                                                      | 原因                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/config/src/index.ts`、`packages/config/test/config.test.ts`                                     | 新增 `REALTIME_ALLOWED_ORIGINS`、`REALTIME_MAX_CONNECTIONS_PER_USER`、`REALTIME_TICKETS_PER_MINUTE` 及校验。 |
| `apps/server/src/modules/realtime.ts`                                                                     | Ticket 兑换二次校验、连接登记 `RealtimeHub`、推送前权限复核、Origin 判断、连接/速率限制。                    |
| `apps/server/src/modules/context.ts`                                                                      | `RoomContext.realtime` 可选 hub。                                                                            |
| `apps/server/src/routes/realtime.ts`                                                                      | Origin/连接数/限流接入，注册到 hub。                                                                         |
| `apps/server/src/app.ts`                                                                                  | 创建并注入 `RealtimeHub` 与路由依赖。                                                                        |
| `apps/server/src/modules/users.ts`                                                                        | 禁用用户后关闭其浏览器实时连接。                                                                             |
| `apps/server/src/modules/groups.ts`                                                                       | 移除用户后撤销其对应 Group 订阅。                                                                            |
| `apps/server/test/realtime-revocation.test.ts`                                                            | 9 例权限生命周期、Origin、限流、连接上限测试。                                                               |
| `adapters/dsh-plugin/src/store.ts`                                                                        | v2 持久化（delivery + turn）、写串行化、唯一 tmp、残留清理、保留期清理。                                     |
| `adapters/dsh-plugin/src/config.ts`                                                                       | `deliveryRetentionDays`（默认 30）。                                                                         |
| `adapters/dsh-plugin/src/bridge.ts`                                                                       | Prompt 前记录 turn；turn 结束持久化；重启后按 Session 快照恢复；回复使用稳定 `clientMessageId`。             |
| `adapters/dsh-plugin/test/store.test.ts`、`bridge.test.ts`                                                | 并发/保留下沉与恢复场景测试。                                                                                |
| `apps/web/src/realtime.ts`、`apps/web/src/views/ChatView.tsx`、`apps/web/src/api.ts`                      | 修复实时 `payload` 对象解析、重连游标和 effect 抖动；暴露 dev 重连测试钩子。                                 |
| `playwright.config.ts`、`e2e/room.spec.ts`                                                                | 浏览器 E2E（真实 Room Server + Vite dev server）。                                                           |
| `.github/workflows/ci.yml`                                                                                | 增加 Playwright 浏览器安装与 `pnpm e2e`。                                                                    |
| `README.md`、`docs/PROGRESS.md`、`docs/REALTIME.md`、`docs/DSH_PLUGIN.md`、`config/agentroom.env.example` | 状态、配置、测试与已知边界同步。                                                                             |
| `.gitignore`、`.prettierignore`                                                                           | 忽略 `test-results/`、`playwright-report/`。                                                                 |

## 3. 测试结果

> 本节保留 2026-11-26 整改时的历史基线（39 files / 277 tests）。2026-11-27 的 DSH 后续整改将基线更新为
> **43 files / 291 tests**（E2E 9 passed），详见 `docs/QUALITY_REVIEW_FOLLOWUP_2026-11-27.md`。

实际执行的命令与结果：

```text
pnpm test
  Test Files  39 passed (39)
       Tests  277 passed (277)

pnpm exec playwright test
  6 passed (6)   # 12 passed with --repeat-each 2

pnpm lint      -> exit 0
pnpm typecheck -> exit 0
pnpm format:check -> exit 0
pnpm build     -> exit 0
```

新增/相关测试文件与用例数：

- `apps/server/test/realtime-revocation.test.ts`：9 例；
- `adapters/dsh-plugin/test/store.test.ts`：5 例；
- `adapters/dsh-plugin/test/bridge.test.ts`：17 例（含重启恢复 3 例）；
- `e2e/room.spec.ts`：6 例。

E2E 覆盖：登录 → 授权 Group → 进入群聊 → 发送/接收 → 断开重连并补偿 →
重复 `clientMessageId` 去重 → Thread 创建/查看 → Task 创建/查看 → 管理员移除成员 →
被移除用户无法继续读取且浏览器的实时消息停止。

## 4. CI 结果

- 历史失败：2026-11-25 的 run `45720589996`（`08b0a38`）等，失败步骤均为
  `Install`；本地干净复现为 `ERR_PNPM_OUTDATED_LOCKFILE`，根因是
  `adapters/dsh-plugin/package.json` 的运行时依赖与锁文件不一致。
- 修复：`0948c7c`（依赖改为 devDependencies、重新生成 lockfile）。其后
  run `45807887373`（`f1e4ce6`）Install/Lint/Typecheck/Test/Build/Native SQLite 全部 success。
- 本次整改首次 CI run `45842860896`（`c071c3c`）在 Browser E2E 失败：Thread/Task 创建后的
  断言命中列表项与详情标题两个元素（strict mode violation）；通过 `::error` 注解取得
  `error-context.md`，修正为 heading 断言并让 TasksView 创建后自动选中 Task。
- 修复后 run `45844424920`（`ccc23a3`）完成：Install、Lint、Typecheck、Test、Build、
  Install Playwright browser、Browser E2E、Native SQLite 全部 success。
  https://github.com/wwppyicn21/agent-room/actions/runs/45844424920
- CI 中 Playwright `retries=1`（本地 0），用于吸收浏览器时序抖动；测试内容未改变。

## 5. 未解决问题

1. Plugin 恢复为 at-least-once：Room 回复靠 `clientMessageId=plugin-reply-<eventId>` 幂等；
   DSH Prompt 靠 `requestId=room-<eventId>` 去重。无法证明 exactly-once，重复副作用风险
   已降到“服务端幂等 + 客户端稳定 ID”。
2. 恢复只覆盖插件重启，不负责 DSH Session 内部进程崩溃后的自动重跑；由 DSH 自身的
   Session 状态决定。
3. 保留期清理在加载时执行，没有周期任务；长期常驻进程需重启或手动触发才清理。
4. 浏览器实时连接上限与 ticket 频率限制是单进程内存计数，多实例部署需共享存储。
5. Origin allowlist 依赖部署配置；Cloudflare 代理下需实测 `Origin` 与 WebSocket upgrade
   行为（本地 E2E 已验证 5173 origin）。
6. E2E 的“管理员移除成员”通过 REST 执行移除，浏览器侧验证被移除用户失去访问；UI 的
   成员管理点击流程未纳入 E2E。
7. M6 卸载/更新实机验收、M7 Codex Plugin、M9 部署仍未完成。

## 6. 数据库与兼容性

- 本次整改没有新增/修改 SQLite 表或列，无数据库迁移。
- Plugin `deliveries.json` 从 version 1 升级为 version 2：读取兼容 v1，下次写入时升级；
  旧数据不会丢失。
- 服务端 API 与 WebSocket 帧协议未破坏：新增的 `error` code（`user_disabled`、
  `membership_revoked`）是既有错误帧的扩展；连接数与 origin 限制可通过配置放宽。
- 新增环境变量均有默认值，旧配置可继续启动（生产环境应显式设置 Origin）。

## 7. 最终结论

- **是否可以进入 M9**：本次整改已完成且 CI 绿，可以进入 M9；M9 尚未开始，部署前仍需
  完成 M6 卸载/更新验收与 Cloudflare Origin 实测。
- **是否可以部署到生产环境**：不建议直接部署；需配置 `REALTIME_ALLOWED_ORIGINS`、
  验证 Cloudflare WebSocket 行为，并补齐 M9 部署项。
- **是否还有 P1/P2 问题**：没有已知未修复的 P1；P2 剩余为上述第 5–7 项与
  插件 exactly-once 的固有语义限制（已用稳定 requestId/clientMessageId 幂等缓解）。
- **尚未验证的关键功能**：M7 Codex Plugin、M6 卸载/更新、生产级多实例限流与
  Cloudflare Origin 的实际行为。
