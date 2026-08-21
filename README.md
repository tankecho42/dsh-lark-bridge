# dsh-lark-bridge

DSH (DeepSeek Harness) 飞书桥接插件 — 在飞书里跟你的 DSH agents 对话。

```
飞书 DM / 群聊 ──► 飞书长连接事件订阅 (WS) ──► 本插件 (dsh host 内) ──► ctx.agents (DSH)
      ▲                                                                  │
      └────────────────────────── 回复发回飞书 ──────────────────────────┘
```

## 里程碑

- **M0** ✅ Cordis 插件骨架：加载进 web profile，`lark_bridge_status` 工具 + loopback 内部状态 API
- **M1** 飞书长连接事件订阅：DM 一人一会话；群聊 @触发 + 共享 workspace 会话
- **M2** session resume、`/new` `/model` `/cwd`、流式卡片

## 安装（本地开发）

```bash
dsh plugin --profile web add /Users/tank/projects/dsh-lark-bridge
dsh web
```

## 配置

profile 的 `cordis.patch.yml` 里对 `dsh-lark-bridge` 行的 config 覆盖：

```yaml
- id: dsh-lark-bridge
  config:
    appId: '<DSH Bridge 飞书应用 App ID>'
    appSecret: '<App Secret>'
```

credentials 也可以走 `$DSH_HOME/lark-bridge/.env`（M1 实现时支持）。

## License

MIT
