# dsh-lark-bridge

DSH (DeepSeek Harness) 飞书桥接插件 — 在飞书里跟你的 DSH agents 对话。

```
飞书 DM / 群聊 ──► 飞书长连接事件订阅 (WS) ──► 本插件 (dsh host 内) ──► ctx.agents (DSH)
      ▲                                                                  │
      └────────────────────────── 回复发回飞书 ──────────────────────────┘
```

## 功能状态

- **M0** ✅ Cordis 插件骨架：加载进 web profile，`lark_bridge_status` 工具 + loopback 内部状态 API
- **M1** ✅ 飞书长连接事件订阅：DM 一人一会话；群聊 @ 触发 + 共享会话
- **M2** ✅ session resume、每聊天 workspace、斜杠命令、流式 CardKit 2.0 卡片、工具审批、安全白名单和消息去重

## 安装（本地开发）

```bash
dsh plugin --profile web add /path/to/dsh-lark-bridge
dsh web
```

## 配置

profile 的 `cordis.patch.yml` 里对 `dsh-lark-bridge` 行的 config 覆盖：

```yaml
- id: dsh-lark-bridge
  config:
    appId: '<DSH Bridge 飞书应用 App ID>'
    appSecret: '<App Secret>'
    webUrl: 'http://127.0.0.1:3080'
    defaultCwd: '/Users/me/projects'
    workspaceRoots:
      - '/Users/me/projects'
    allowedUserIds: []
    allowedChatIds: []
    adminUserIds: []
```

白名单为空时不限制，兼容旧配置。建议生产环境至少配置 `allowedUserIds` 和 `adminUserIds`；`workspaceRoots` 非空时，`/cwd` 只能切换到这些目录或其子目录。

## 飞书命令

- `/help`：命令清单
- `/status`：当前 session、模式、模型和工作目录
- `/cwd [绝对路径]`：查看或切换当前聊天的工作目录；切换会自动新建会话
- `/new`、`/reset`、`/stop`：新建、重置或停止当前会话
- `/mode`、`/model`：查看或切换默认模式/模型（配置了管理员后仅管理员可改）
- `/usage`、`/sessions`：查看用量和桥接会话
- `/tools [on|off 工具名]`：查看或切换当前聊天的 Agent 工具；切换会自动新建会话，配置管理员后只有管理员可改

群聊默认只处理真实 @ 机器人的消息。审批按钮仅允许本轮任务发起人或管理员操作。

## 验证

```bash
npm test
```

## License

MIT
