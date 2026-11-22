# Cloudflare Tunnel（M1 说明，M3/M9 落地）

- 域名：`chat.<domain>`（用户 2026-11-22 决定）。Agent 机器连接也走这个 hostname。
- 本机 cloudflared 由 systemd 运行，token 托管，ingress 在 Cloudflare 侧配置；本地看不到 ingress 文件，修改需在 Cloudflare Zero Trust 控制台完成。
- 目标：`chat.<domain>` → `http://127.0.0.1:8787`。
- 认证：Cloudflare Access 保护 `chat.<domain>`；应用层仍要做授权，不依赖“只有本机能访问”。
- 源站端口 8787 只绑定 loopback，不加入任何端口转发或防火墙放行。

M3 接入 Access JWT 校验（`Cf-Access-Jwt-Assertion`），M9 完成 Tunnel 与 Access 策略的最终配置。
