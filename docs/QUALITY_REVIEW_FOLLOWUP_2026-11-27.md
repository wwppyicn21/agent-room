# DSH 插件与服务器整改复核（2026-11-27）

针对 `agent-room-dsh-remediation.md` 的 6 项审查意见（P1 SQLite/配置权限、P2 Realtime 清理、P2 PendingTurn 超时、P2 prune 提交、P2 文档一致性、P1 最新 HEAD CI），
本轮只改本仓库，不引入新服务、不改 DSH 工作区、不 push/部署/重启。

## 1. 项目状态

| 项目                             | 结果               | 证据                                                                                                                                                                 |
| -------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 SQLite 与配置权限             | 已修复（本地验证） | `packages/database/src/db.ts`、`src/lock.ts`、`apps/server/src/main.ts`；`packages/database/test/file-permissions.test.ts` 3 例；systemd `UMask=0077` 与部署手册     |
| P2 Realtime send 异常清理        | 已修复             | `apps/server/src/modules/realtime.ts` 的 `closed`/`cleaned` 分离、`cleanup()` 幂等；`realtime-cleanup.test.ts` 2 例                                                  |
| P2 PendingTurn 超时              | 已修复             | `adapters/dsh-plugin/src/bridge.ts` 超时改为异步持久化 `failed/turn_timeout`；`bridge.test.ts` 19 例（新增 2 例）                                                    |
| P2 prune 删除但未提交            | 已修复             | `adapters/dsh-plugin/src/store.ts` 删除任一 delivery/turn 都提交；store 6 例（新增同 eventId 场景）                                                                  |
| P2 文档一致性                    | 已更新             | README、PROGRESS、本文件、部署手册、`QUALITY_REVIEW_REMEDIATION.md` 的基线说明                                                                                       |
| P1 最新 HEAD GitHub Actions 全绿 | PASS               | push `fb005d2` 后 Run [`46047104203`](https://github.com/wwppyicn21/agent-room/actions/runs/46047104203) 全绿（Install/Lint/Typecheck/Test/Build/Native SQLite/E2E） |

## 2. 实际修改

| 文件                                              | 修改                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/db.ts`                     | 新建目录 `0700`（仅新建时 chmod）；打开前以 `0600` 预创建数据库；`umask 0077` 内执行 pragma/迁移；结束收紧 `db`/`-wal`/`-shm` 为 `0600`。                               |
| `packages/database/src/lock.ts`                   | 锁库目录 `0700`、锁库文件预创建并 `0600`、打开与 `BEGIN IMMEDIATE` 在受限 umask 内。                                                                                    |
| `apps/server/src/main.ts`                         | 非 Windows 启动时 `process.umask(0o077)`，覆盖运行期新建的 WAL/SHM/备份。                                                                                               |
| `deployment/systemd/agentroom.service`            | `UMask=0077`。                                                                                                                                                          |
| `deployment/systemd/README.md`                    | `/var/lib/agentroom` `0700`、`/etc/agentroom` `0700`、env `0600 root:root`；新增权限表与停服升级步骤（chown/chmod、不删除 DB/lockdb/WAL/SHM）。                         |
| `apps/server/src/modules/realtime.ts`             | `closed` 与 `cleaned` 分离；`cleanup()` 幂等并清 interval/unregister；`send` 异常清理并以 `1011 send_failed` 关闭；`connection.close` 以 `1008` 关闭；重复 close 安全。 |
| `adapters/dsh-plugin/src/bridge.ts`               | 超时回调异步执行：确认仍在队列→移出→若持久化仍非终态则 `failed/turn_timeout` 并 warning；`stopped` 时不写；迟到事件因队列为空被忽略。                                   |
| `adapters/dsh-plugin/src/store.ts`                | prune 用 `changed` 标志提交任何删除；`removed` 统计实际删除的记录；未终态 Turn 永不删除。                                                                               |
| `apps/server/test/realtime-cleanup.test.ts`       | 新增 2 例（send 抛错、主动关闭的幂等清理）。                                                                                                                            |
| `packages/database/test/file-permissions.test.ts` | 新增 3 例（新建库/WAL/SHM、已有宽权限收紧、锁库）。                                                                                                                     |
| `adapters/dsh-plugin/test/bridge.test.ts`         | 新增 2 例（超时落盘 failed 且重启仍 failed、迟到事件不回复；stop 后保留 awaiting）。                                                                                    |
| `adapters/dsh-plugin/test/store.test.ts`          | 新增 1 例（过期 completed delivery + 未终态 turn 同 eventId，删除后 reload 不丢 turn）。                                                                                |

未修改 SQLite schema；`deliveries.json` 保持 v1 读取、v2 写入；API 与帧格式未变。

## 3. 实际测试

本轮实际执行（2026-11-27）：

```text
pnpm test
  Test Files  43 passed (43)
       Tests  291 passed (291)

CI=true pnpm e2e
  9 passed

pnpm lint         -> exit 0
pnpm typecheck    -> exit 0
pnpm format:check -> exit 0
pnpm build        -> exit 0
```

新增用例：SQLite 权限 3、Realtime 清理 2、PendingTurn 超时 2、prune 1；插件 bridge 共 19 例、store 共 6 例。

## 4. 文档同步

- `README.md`：测试基线改为 43 files / 291 tests，记录本轮整改，补 REALTIME / DSH_PLUGIN / WEB_CLIENT / DATABASE 文档入口。
- `docs/PROGRESS.md`：新增「DSH 整改（2026-11-27）」并更新当前进度与后续计划。
- `docs/QUALITY_REVIEW_REMEDIATION.md`：标注其 39/277 为 2026-11-26 整改时的历史基线，指向本文件。
- `docs/REALTIME.md`：补 send 异常清理（1011）、`closed`/`cleaned` 幂等与测试。
- `docs/DSH_PLUGIN.md`：补 PendingTurn 超时持久化、迟到事件忽略、stop 保留 awaiting、prune 提交与测试数量。
- `docs/DATABASE.md`：新增「文件权限」表（db/lockdb/WAL/SHM 0600、目录 0700、umask）。
- `docs/WEB_CLIENT.md`：移除“无浏览器 E2E”，补 Playwright 9 例覆盖范围。
- `docs/PLAN.md`、`docs/ROADMAP.md`：M8 状态更新为 43 files / 291 tests + E2E 9；HEAD `fb005d2` 已 push，CI Run `46047104203` 全绿。
- `deployment/systemd/README.md`：权限与升级步骤。

## 5. 未解决与后续项

1. **CI 验收（已完成）**：代码与文档推送后，Run `46047104203` 全绿；后续文档提交若触发新 Run，以最新 Run 为准。
2. **已存在目录不会自动收紧**：服务端只 chmod 自己创建/打开的数据库、锁库和 sidecar，不会 chmod 任意父目录；已有部署需按部署手册执行一次 chown/chmod。
3. **多进程/多实例**：文件权限、realtime ticket/presence、审批过期扫描仍按单实例设计；多实例共享限流与调度属 M9。
4. **插件 exactly-once**：仍为 at-least-once + 持久化幂等，不承诺 exactly-once。
5. **systemd 未在本机重启**：仅静态修改 unit/文档，未部署、未重启任何服务。

## 6. 结论

4 项代码问题已修复并有回归测试；本地 lint / typecheck / format / 291 tests / E2E 9 / build 全过。
文档已同步，代码与文档已 push；GitHub Actions Run `46047104203` 全绿，本轮整改 6 项均为 PASS。
后续若文档提交产生新的 CI Run，以最终 HEAD 的 Run 结果为准。
