# systemd 原生部署（M1 示例）

不通过 Docker。以下是目标 Mini PC 上的安装步骤，M9 会补完整的更新/回滚脚本。

```bash
# 1. 运行账号与目录
sudo useradd --system --home /var/lib/agentroom --shell /usr/sbin/nologin agentroom
sudo install -d -o agentroom -g agentroom /var/lib/agentroom /etc/agentroom /opt/agentroom
sudo install -d -o root -g root /opt/agentroom/current

# 2. 代码放到 /opt/agentroom/current（git clone 或发布包），构建：
cd /opt/agentroom/current
pnpm install --frozen-lockfile
pnpm build

# 3. 配置
sudo cp config/agentroom.env.example /etc/agentroom/agentroom.env
sudo editor /etc/agentroom/agentroom.env   # 数据库指向 /var/lib/agentroom/room.db

# 4. 单元
sudo cp deployment/systemd/agentroom.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentroom
systemctl status agentroom
curl -s http://127.0.0.1:8787/healthz
```

数据库文件位于 `DATABASE_PATH`；单实例锁是同目录下的 `room.db.lockdb`（一个由 SQLite 持有 `BEGIN IMMEDIATE` 的锁库，进程退出即释放，无需手工删除）。

## 端口与网络

- 默认只监听 `127.0.0.1:8787`，源站端口不对外开放。
- 公网访问走 Cloudflare Tunnel：`chat.<domain>` → `http://127.0.0.1:8787`，并在 Cloudflare Access 配置策略（M3 接 JWT 验证）。
- 旧 Go 房间（`:8791`）与新版互不共享数据源。

## 注意

- `ProtectSystem=strict` 下只有 `ReadWritePaths` 里的目录可写；如果把数据库放到别处，需要同步修改单元。
- `EnvironmentFile` 中的变量就是 `@room/config` 的唯一来源；不要另建配置文件。
