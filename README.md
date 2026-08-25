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
- **M3** ✅ 可靠性第一阶段：限频/服务异常退避重试、消息幂等、卡片更新串行合并、日志轮转和 `/doctor` 自检
- **M3.1** ✅ 每聊天模型选择（`/model` 只影响当前聊天，全局默认不受影响；`/model reset` 恢复跟随全局）+ 闲置会话过期（默认 14 天，`sessionTtlDays: 0` 关闭）

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
    logMaxBytes: 5242880
    logBackups: 3
    sessionTtlDays: 14   # 闲置会话映射过期天数；0 = 永不过期
```

白名单为空时不限制，兼容旧配置。建议生产环境至少配置 `allowedUserIds` 和 `adminUserIds`；`workspaceRoots` 非空时，`/cwd` 只能切换到这些目录或其子目录。

## 飞书命令

- `/help`：命令清单
- `/status`：当前 session、模式、模型和工作目录
- `/cwd [绝对路径]`：查看或切换当前聊天的工作目录；切换会自动新建会话
- `/new`、`/reset`、`/stop`：新建、重置或停止当前会话
- `/mode`、`/model`：查看或切换默认模式 / **本聊天**模型（`/model` 只影响当前聊天，`/model reset` 恢复跟随全局；配置了管理员后仅管理员可改）
- `/usage`、`/sessions`：查看用量和桥接会话（会话列表含最近活跃时间）
- `/tools [on|off 工具名]`：查看或切换当前聊天的 Agent 工具；切换会自动新建会话，配置管理员后只有管理员可改
- `/doctor`：只读检查飞书连接、工作/状态目录、默认模型、工具和卡片发送队列；不显示凭据、不改配置

群聊默认只处理真实 @ 机器人的消息。审批按钮仅允许本轮任务发起人或管理员操作。

飞书 API 请求有 15 秒超时；HTTP 429、5xx 和飞书限频码会最多尝试 4 次指数退避。发送与回复使用同一 `uuid` 重试，避免成功响应丢失时产生重复消息。同一张卡片的 PATCH 严格串行，并只保留尚未发送的最新状态，防止旧响应覆盖新内容。

模型选择按聊天隔离：`/model` 的任何修改只写入该聊天的覆盖配置（`chat-models.json`），创建/恢复 agent 时优先使用；显式配置的 workspace、工具策略和模型覆盖在会话过期后保留，用户回来可无缝续用。闲置超过 `sessionTtlDays`（默认 14 天）且没有活跃 handle 的聊天，其会话映射在启动和每日扫描时自动清理。

插件日志写入 `dataDir/logs/plugin.log`，默认单文件 5 MiB、保留 3 份轮转备份；可用 `logMaxBytes` 和 `logBackups` 调整。

## 验证

```bash
npm test
```

上线前请先执行 [安全与发布手册](SECURITY.md)，尤其是密钥轮换与 Git 历史清理步骤。

## License

MIT
