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
