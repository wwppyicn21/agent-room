# systemd 原生部署（M1 示例）

不通过 Docker。以下是目标 Mini PC 上的安装步骤，M9 会补完整的更新/回滚脚本。

```bash
# 1. 运行账号与目录
sudo useradd --system --home /var/lib/agentroom --shell /usr/sbin/nologin agentroom
sudo install -d -o agentroom -g agentroom -m 0700 /var/lib/agentroom
sudo install -d -o root -g root -m 0700 /etc/agentroom
sudo install -d -o root -g root -m 0755 /opt/agentroom /opt/agentroom/current

# 2. 代码放到 /opt/agentroom/current（git clone 或发布包），构建：
cd /opt/agentroom/current
pnpm install --frozen-lockfile
pnpm build

# 3. 配置
sudo install -m 0600 -o root -g root config/agentroom.env.example /etc/agentroom/agentroom.env
sudo editor /etc/agentroom/agentroom.env   # 数据库指向 /var/lib/agentroom/room.db

# 4. 单元
sudo cp deployment/systemd/agentroom.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentroom
systemctl status agentroom
curl -s http://127.0.0.1:8787/healthz
```

数据库文件位于 `DATABASE_PATH`；单实例锁是同目录下的 `room.db.lockdb`（一个由 SQLite 持有 `BEGIN IMMEDIATE` 的锁库，进程退出即释放，无需手工删除）。

## SQLite 与配置权限

数据目录、数据库、锁库以及 SQLite 的 `-wal` / `-shm` 文件包含用户、消息与审计数据，必须仅对运行账号可读：

| 路径 | 权限 | 说明 |
|---|---|---|
| `/var/lib/agentroom` | `0700`，属主 `agentroom:agentroom` | 数据库目录 |
| `room.db` / `room.db.lockdb` | `0600` | `openDatabase`/`acquireInstanceLock` 会收紧自己创建或打开的文件 |
| `room.db-wal` / `room.db-shm` | `0600` | 由 SQLite 创建；systemd `UMask=0077` 保证运行期新建文件私有 |
| 备份文件 | `0600`（建议目录 `0700`） | 不要放在其他账号可读的目录 |
| `/etc/agentroom/agentroom.env` | `root:root`，`0600` | 含密钥/Token；systemd 由 PID 1 以 root 读取 EnvironmentFile |

新建部署按上文 `install -d -m 0700` 与 `install -m 0600` 操作即可；服务端也会对数据库/锁库自身设置 `0600`，不会 chmod 任意父目录。

已有部署升级（不要删除数据库、锁库或正在使用的 WAL/SHM）：

```bash
# 1. 停服并确认 SQLite 已正常关闭（lockdb 无活动进程）
sudo systemctl stop agentroom
sudo -u agentroom test ! -e /var/lib/agentroom/room.db.lockdb || echo "lock db may still be held"

# 2. 修正目录与文件权限（文件不存在时跳过，不要 rm）
sudo chown -R agentroom:agentroom /var/lib/agentroom
sudo chmod 0700 /var/lib/agentroom
sudo find /var/lib/agentroom -maxdepth 1 -type f \( -name 'room.db' -o -name 'room.db.lockdb' -o -name 'room.db-wal' -o -name 'room.db-shm' -o -name '*.backup' -o -name '*.bak' \) -exec chmod 0600 {} +
sudo chown root:root /etc/agentroom/agentroom.env
sudo chmod 0600 /etc/agentroom/agentroom.env

# 3. 启动并检查
sudo systemctl start agentroom
sudo stat -c '%a %U:%G %n' /var/lib/agentroom /var/lib/agentroom/room.db*
```

`deployment/systemd/agentroom.service` 已设置 `UMask=0077`；如果修改了数据库路径，需同步修改 `ReadWritePaths` 并按上述规则设置新目录。

## 端口与网络

- 默认只监听 `127.0.0.1:8787`，源站端口不对外开放。
- 公网访问走 Cloudflare Tunnel：`chat.<domain>` → `http://127.0.0.1:8787`，并在 Cloudflare Access 配置策略（M3 接 JWT 验证）。
- 旧 Go 房间（`:8791`）与新版互不共享数据源。

## 注意

- `ProtectSystem=strict` 下只有 `ReadWritePaths` 里的目录可写；如果把数据库放到别处，需要同步修改单元。
- 本地开发（非 systemd）可把数据库放到仅自己可访问的目录；服务进程启动时设置 `umask 0077`，但已有目录不会被自动 chmod。
- `EnvironmentFile` 中的变量就是 `@room/config` 的唯一来源；不要另建配置文件。

## M9 生产部署

生产目录、Cloudflare Tunnel、Access、备份/恢复、升级/回滚与验收清单见
`docs/DEPLOYMENT.md`。本文件只保留 unit 的安装步骤。
