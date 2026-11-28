# @room/dsh-plugin

Agent Room 的 DSH 原生 Host Plugin，把显式映射的 Room Group 桥接到独立 DSH Session。

- 入口：`lib/index.js`（`src/index.ts` 经 esbuild 自包含打包）
- Bundle：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`
- 配置：DSH Settings（`Config`，schemastery）
- 身份：本地 Ed25519 key（0600），不写入配置/日志/Git
- Delivery：`deliveries.json` 持久化 pending/processing/completed/failed

完整说明见 [docs/DSH_PLUGIN.md](../../docs/DSH_PLUGIN.md)。

## 构建

```bash
pnpm --filter @room/dsh-plugin build
```

## 配置示例

```yaml
enabled: true
roomBaseUrl: http://127.0.0.1:8787
groups:
  - groupId: grp_...
    sessionId: ses_...
    label: main
  - groupId: grp_...
    sessionId: ses_...
    label: ops
```

Session 必须已存在；插件不会创建 Session。两个 Group 不得共享同一个 Session。

## 设置页

安装 bundle 并在 DSH 中启用后，打开 **Settings → Built-in plugins → Agent Room**。
页面可编辑 `roomBaseUrl` 与 Group→Session 映射（增删行、校验 groupId/sessionId 唯一）。
这两个字段是 volatile：保存后插件不重启，`RoomBridge` 每秒读取新配置并应用；Room URL
变化时自动重连。其余字段通过 profile patch 配置，修改后重启插件生效。
