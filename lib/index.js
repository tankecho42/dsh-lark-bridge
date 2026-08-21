/**
 * @tankecho42/dsh-lark-bridge — DSH 飞书桥接插件。
 *
 * Host 侧 Cordis 插件（M1）：
 *  - 飞书长连接事件订阅（@larksuiteoapi/node-sdk WSClient）
 *  - DM 一人一会话；群聊 @触发 + 共享 workspace 会话
 *  - 用户文本 → ctx.agents（DSH）→ 回复经 session/event 转发回飞书
 *
 * 参考实现：@lanbaolu/dsh-wechat-bridge（hybrid host plugin + daemon）。
 */
import { createServer } from 'node:http'
import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { FeishuClient } from './feishu.js'
import { SessionManager } from './sessions.js'

export const name = '@tankecho42/dsh-lark-bridge'

/** Host services the plugin needs. */
export const inject = ['tools', 'agents', 'agentDefaultModel']

export const Config = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  dataDir: z.string().default(''),
  autoStart: z.boolean().default(true),
})

const PLUGIN_VERSION = '0.1.0'
const M1_MARK = 'M1'

export function apply(ctx, config) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = config.dataDir || join(dshHome, 'lark-bridge')

  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(dataDir, 'logs'), { recursive: true })

  const pluginLogPath = join(dataDir, 'logs', 'plugin.log')

  function debugLog(message, data) {
    try {
      mkdirSync(join(dataDir, 'logs'), { recursive: true })
      const line = `[${new Date().toISOString()}] [plugin] ${message}${data === undefined ? '' : ' ' + JSON.stringify(data)}\n`
      appendFileSync(pluginLogPath, line, 'utf8')
    } catch {
      /* logging must never crash the plugin */
    }
  }

  debugLog('plugin loaded', { version: PLUGIN_VERSION, milestone: M1_MARK, dataDir })

  const sessions = new SessionManager({ ctx, dataDir, log: debugLog })

  let feishu = null

  function statusPayload() {
    return {
      ok: true,
      plugin: name,
      version: PLUGIN_VERSION,
      milestone: M1_MARK,
      configured: Boolean(config.appId && config.appSecret),
      autoStart: config.autoStart,
      wsRunning: feishu?.started || false,
      dataDir,
    }
  }

  // -----------------------------------------------------------------------
  // Session events → forward assistant replies to Feishu
  // -----------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const sid = String(session?.id)
    const chatId = sessions.chatOf(sid)
    if (!chatId || !feishu) return

    if (event.type === 'assistant/message') {
      const msg = event.data?.message
      const text = extractAssistantText(msg)
      if (text) {
        debugLog('reply', { chatId, sid, len: text.length })
        void feishu.sendText(chatId, text).catch((err) => debugLog('reply send failed', { chatId, err: String(err?.message || err) }))
      }
    } else if (event.type === 'turn/end') {
      debugLog('turn end', { chatId, sid, reason: event.data?.reason })
    }
  })

  function extractAssistantText(message) {
    if (!message) return ''
    const content = message.content
    if (!Array.isArray(content)) return ''
    return content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .trim()
  }

  // -----------------------------------------------------------------------
  // Inbound Feishu message → route into DSH agent
  // -----------------------------------------------------------------------
  async function handleInbound(msg) {
    debugLog('inbound', { chatId: msg.chatId, chatType: msg.chatType, botMentioned: msg.botMentioned, len: msg.text.length })

    // group chats require @mention (unless configured otherwise)
    if (msg.chatType === 'group' && !msg.botMentioned) return

    const text = msg.text.trim()
    if (!text) return

    // slash-ish commands (minimal, M1)
    if (text === '/new' || text === '/reset') {
      await sessions.reset(msg.chatId)
      await feishu.sendText(msg.chatId, '🆕 新会话已开', msg.messageId).catch(() => {})
      return
    }
    if (text === '/stop') {
      sessions.stop(msg.chatId)
      return
    }

    try {
      await sessions.prompt(msg.chatId, text)
    } catch (err) {
      debugLog('prompt failed', { chatId: msg.chatId, err: String(err?.message || err) })
      await feishu.sendText(msg.chatId, `⚠️ 处理失败：${err?.message || err}`, msg.messageId).catch(() => {})
    }
  }

  // -----------------------------------------------------------------------
  // Internal status API (loopback; parity with M0 for daemon/ops)
  // -----------------------------------------------------------------------
  function sendJson(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function startInternalServer() {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
      if (req.method === 'GET' && url.pathname === '/status') {
        sendJson(res, 200, statusPayload())
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    })
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      debugLog('internal api listening', { port: a && typeof a === 'object' ? a.port : 0 })
    })
    return server
  }

  // -----------------------------------------------------------------------
  // Model-facing tools
  // -----------------------------------------------------------------------
  function registerTools() {
    ctx.tools.register(defineTool({
      name: 'lark_bridge_status',
      description: '查看 DSH 飞书桥接状态：里程碑、配置是否就绪、飞书长连接是否在跑。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async () => {
        const p = statusPayload()
        return {
          ok: true,
          message: `M1 已加载。配置: ${p.configured ? '已就绪' : '未配置（appId/appSecret 待填）'}。飞书长连接: ${p.wsRunning ? '运行中' : '未启动'}。数据目录: ${p.dataDir}。版本 ${p.version}。`,
        }
      },
    }))
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------
  ctx.effect(() => {
    const server = startInternalServer()
    registerTools()

    if (config.autoStart && config.appId && config.appSecret) {
      feishu = new FeishuClient({
        appId: config.appId,
        appSecret: config.appSecret,
        onMessage: (msg) => void handleInbound(msg),
        onError: (err) => debugLog('feishu error', { err: String(err?.message || err) }),
        onStatus: (info) => debugLog('feishu status', info),
      })
      feishu.start()
    } else {
      debugLog('not autostarted', { hasAppId: !!config.appId, hasAppSecret: !!config.appSecret, autoStart: config.autoStart })
    }

    ctx.logger?.info?.('[dsh-lark-bridge] loaded', { dataDir, milestone: M1_MARK })

    return () => {
      try {
        server.close()
      } catch {
        /* ignore */
      }
      sessions.dispose()
    }
  })
}
