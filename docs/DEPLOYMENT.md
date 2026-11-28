# Agent Room 部署与迁移（M9）

目标拓扑：Mini PC 上单实例 Node.js + SQLite，`cloudflared` 只把本地 `127.0.0.1:8787`
暴露给 Cloudflare；源站不开放公网端口。

```text
Internet
  │
  ▼
Cloudflare Access (room.example.com / agent.example.com)
  │
  ▼
cloudflared (Mini PC, systemd)
  │  http://127.0.0.1:8787
  ▼
agentroom.service ── SQLite /var/lib/agentroom/room.db
                  ├─ backups/
                  ├─ 静态 Web apps/web/dist
                  └─ /etc/agentroom/agentroom.env
```

## 1. 目录与权限

| 路径                           | 用途                        | 权限                       |
| ------------------------------ | --------------------------- | -------------------------- |
| `/opt/agentroom/releases/<id>` | 每次构建的完整 release      | `root:root`，只读          |
| `/opt/agentroom/current`       | 指向当前 release 的符号链接 | `root:root`                |
| `/etc/agentroom/agentroom.env` | 配置（含 Access 配置）      | `0600 root:root`           |
| `/var/lib/agentroom`           | SQLite、WAL/SHM、lock db    | `0700 agentroom:agentroom` |
| `/var/lib/agentroom/backups`   | 备份与 sha256               | `0700 agentroom:agentroom` |
| `/var/log/agentroom`           | 应用日志（若不用 journald） | `0700 agentroom:agentroom` |

服务进程以 `agentroom` 用户运行；`UMask=0077`。SQLite 主库、WAL、SHM 与锁库由程序在
启动时收紧为 `0600`。**已有目录不会被程序自动 chmod**；首次部署需手工执行：

```bash
sudo install -d -o agentroom -g agentroom -m 0700 /var/lib/agentroom
sudo install -d -o agentroom -g agentroom -m 0700 /var/lib/agentroom/backups
sudo install -d -o root -g root -m 0700 /etc/agentroom
sudo install -m 0600 -o root -g root config/agentroom.env.example /etc/agentroom/agentroom.env
```

## 2. 构建与发布

```bash
pnpm install --frozen-lockfile
pnpm build
# 产物：apps/server/dist、packages/*/dist、apps/web/dist、adapters/dsh-plugin/lib
RELEASE=/opt/agentroom/releases/$(date -u +%Y%m%dT%H%M%SZ)
sudo mkdir -p "$RELEASE"
# 包含已安装的 node_modules 与构建产物；个人 Mini PC 单实例可接受
sudo rsync -a --delete ./ "$RELEASE"/
sudo chown -R root:root "$RELEASE"
sudo /opt/agentroom/current/deployment/scripts/switch-release.sh \
  /opt/agentroom/releases "$(basename "$RELEASE")" /opt/agentroom/current
sudo systemctl restart agentroom
```

`switch-release.sh` 原子切换符号链接，并保留旧 release；失败时可直接指回旧目录。

## 3. systemd

```bash
sudo cp deployment/systemd/agentroom.service /etc/systemd/system/
sudo cp deployment/systemd/agentroom-backup.service /etc/systemd/system/
sudo cp deployment/systemd/agentroom-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentroom
sudo systemctl enable --now agentroom-backup.timer
```

`agentroom.service` 已包含 `NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、
`PrivateTmp`、`UMask=0077`、`ReadWritePaths=/var/lib/agentroom`。重启恢复由 systemd
`Restart=on-failure` 与 SQLite WAL 共同保证。

## 4. 配置

生产环境至少设置：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
DATABASE_PATH=/var/lib/agentroom/room.db
AUTH_MODE=access
ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
ACCESS_AUDIENCE=<Access application AUD>
BOOTSTRAP_OWNER_EMAIL=owner@example.com
WEB_ROOT=/opt/agentroom/current/apps/web/dist
TRUST_PROXY=true
REALTIME_ALLOWED_ORIGINS=https://room.example.com
```

`WEB_ROOT` 由 Room Server 直接托管 Web 构建产物：`/`、`/assets/*`、SPA 路由回退；
`/api/*` 永不回退为 HTML。`TRUST_PROXY=true` 仅应在本地 cloudflared 后启用。

## 5. Cloudflare Tunnel 与 Access

1. 安装 `cloudflared`，执行 `cloudflared tunnel login`、`cloudflared tunnel create agent-room`。
2. 将 `deployment/cloudflare/config.yml.example` 复制为 `/etc/cloudflared/config.yml`，
   替换 tunnel UUID 与凭据路径；两个 hostname 都指向 `http://127.0.0.1:8787`。
3. `cloudflared service install`，`systemctl enable --now cloudflared`。
4. Cloudflare Zero Trust → Access → Applications：
   - `room.example.com`：允许 owner/admin 邮箱或身份组；JWT 由 Server 校验。
   - `agent.example.com`：为 `/api/v1/agent/*` 建立 **Bypass** 策略（Agent 使用 Ed25519
     会话 Bearer，不经过浏览器登录），其余路径可拒绝。
5. 不开放路由器 8787 端口；`ss -lntp` 应只看到 `127.0.0.1:8787`。

## 6. 备份、恢复与完整性检查

```bash
# 在线备份（SQLite .backup，WAL 安全），保留最近 14 份
deployment/scripts/backup.sh /var/lib/agentroom/room.db /var/lib/agentroom/backups 14

# 验证
sqlite3 /var/lib/agentroom/backups/room-<stamp>.db 'PRAGMA integrity_check;'  # ok

# 恢复（必须先停服务；默认拒绝覆盖）
sudo systemctl stop agentroom
deployment/scripts/restore.sh /var/lib/agentroom/backups/room-<stamp>.db \
  /var/lib/agentroom/room.db --force
sudo systemctl start agentroom
deployment/scripts/healthcheck.sh
```

恢复脚本会先对备份与副本分别执行 `PRAGMA integrity_check`，再原子替换；旧的
`-wal`/`-shm` 不应手工拼接，服务启动时由 SQLite 处理。

## 7. 升级与回滚

```bash
# 升级：构建新 release → switch-release → 重启
sudo /opt/agentroom/current/deployment/scripts/switch-release.sh \
  /opt/agentroom/releases <new-release-id> /opt/agentroom/current
sudo systemctl restart agentroom

# 回滚：切回旧 release
sudo /opt/agentroom/current/deployment/scripts/switch-release.sh \
  /opt/agentroom/releases <previous-release-id> /opt/agentroom/current
sudo systemctl restart agentroom
```

升级不会触碰数据库、备份、Agent Key 或配置；schema 迁移由 Server 启动时执行，失败会
关闭连接并退出，不会留下半迁移状态。回滚前如已执行不可逆迁移，应从备份恢复数据库。

## 8. 迁移

M9 只迁移运行形态，不导入旧聊天消息：

- Schema：由 `packages/database/drizzle` 迁移自动执行。
- 配置：按 `config/agentroom.env.example` 人工迁移，不复制旧 JSON 配置。
- 身份：首个 Owner 用 `BOOTSTRAP_OWNER_EMAIL` 建立，其余用户重新邀请。
- Agent Key：在新环境重新登记 Agent 公钥；私钥不进入仓库、不打印日志。
- 旧 Open Agent Room JSON 数据默认不导入；如未来需要，必须另行授权并做人工核对。

## 9. 验收清单

| 项目              | 本地/脚本验证                                   | 目标机验证         |
| ----------------- | ----------------------------------------------- | ------------------ |
| 源站不公开        | 配置默认 `HOST=127.0.0.1`                       | 待部署确认         |
| Web 需登录        | Access JWT 测试                                 | 待 Cloudflare 配置 |
| Agent Ed25519     | agent-auth 测试                                 | 待目标机           |
| Cloudflare Tunnel | 配置模板                                        | 待部署             |
| Access JWT        | access.test                                     | 待配置             |
| Agent WSS         | 实机已通过                                      | 待目标机           |
| systemd           | unit 文件与 hardening                           | 待安装             |
| 重启恢复          | SQLite/WAL 测试                                 | 待重启演练         |
| 备份              | `deployment-scripts.test.ts`（在线 WAL + 校验） | 待定时器           |
| 恢复测试          | 脚本测试通过                                    | 待目标机           |
| 完整性检查        | 脚本 `PRAGMA integrity_check`                   | 待目标机           |
| 升级/回滚         | `switch-release.sh` 符号链接测试                | 待演练             |
| 不覆盖现有数据    | 脚本拒绝覆盖 + 原子替换                         | 待目标机           |
| 文档              | 本文 + systemd README                           | —                  |

## 10. 已验证 / 未验证

已验证（本仓库、本机）：

- `pnpm test` 覆盖静态 Web 托管、备份/恢复脚本、release 切换；
- `apps/server/test/static-web.test.ts`：`/`、`/assets/*`、SPA 回退、API 不回退、路径穿越拒绝；
- `apps/server/test/deployment-scripts.test.ts`：在线 WAL 备份、sha256、完整性检查、恢复拒绝覆盖/`--force`、release 切换与回滚。

未验证（需要真实 Mini PC、域名与 Cloudflare 账号）：

- cloudflared 实际隧道与 Access 策略；
- systemd 在目标机的启动/重启；
- 真实数据库规模下的备份时间与恢复演练；
- 公网多客户端与断线恢复。
