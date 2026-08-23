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
import { buildThinkingCard, buildStreamingCard, buildDoneCard, buildErrorCard, SPINNER_FRAMES } from './card.js'
import { findCommand, handleBridgeAction } from './commands.js'
import { ApprovalBridge } from './approval.js'

export const name = '@tankecho42/dsh-lark-bridge'

/** Host services the plugin needs. */
export const inject = ['tools', 'agents', 'agentDefaultModel']

export const Config = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  dataDir: z.string().default(''),
  defaultCwd: z.string().default(''),
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

  const sessions = new SessionManager({ ctx, dataDir, defaultCwd: config.defaultCwd || undefined, log: debugLog })

  let feishu = null
  let approvals = null

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
  // Session events → streaming card updates
  // -----------------------------------------------------------------------
  /** @type {Map<string, {cardMessageId: string, text: string, texts: string[], reasoning: string, chunked: boolean, phase: 'thinking'|'answering', frame: number, startedAt: number, dirty: boolean, timer: any, model: string}>} */
  const liveTurns = new Map()   // sessionId → live turn state
  const PATCH_THROTTLE_MS = 500

  function flushCard(sid) {
    const st = liveTurns.get(sid)
    if (!st || !st.cardMessageId) return
    // thinking: spinner animates even when silent; answering: heartbeat every ~2s
    // (elapsed counter) so long tool executions never make the card look dead
    if (!st.dirty && st.phase === 'answering') {
      st.hbTick = (st.hbTick || 0) + 1
      if (st.hbTick % 4 !== 0) return
    }
    st.dirty = false
    st.frame = (st.frame + 1) % SPINNER_FRAMES.length
    const elapsed = Math.round((Date.now() - st.startedAt) / 1000)
    if (st.phase === 'thinking') {
      feishu.updateCard(st.cardMessageId, buildThinkingCard({ reasoning: st.reasoning, frame: st.frame, elapsed }))
        .catch((err) => debugLog('card patch failed', { sid, err: String(err?.message || err) }))
    } else {
      const thinkSecs = st.thinkSecs != null ? st.thinkSecs : undefined
      feishu.updateCard(st.cardMessageId, buildStreamingCard(st.text, { elapsed, reasoning: st.reasoning, thinkSecs }))
        .catch((err) => debugLog('card patch failed', { sid, err: String(err?.message || err) }))
    }
  }

  /** immediate phase-transition flush (bypasses throttle timer) */
  function flushPhaseChange(sid) {
    const st = liveTurns.get(sid)
    if (!st || !st.cardMessageId) return
    st.dirty = false
    const elapsed = Math.round((Date.now() - st.startedAt) / 1000)
    const thinkSecs = st.thinkSecs != null ? st.thinkSecs : undefined
    feishu.updateCard(st.cardMessageId, st.phase === 'thinking'
      ? buildThinkingCard({ reasoning: st.reasoning, frame: st.frame, elapsed })
      : buildStreamingCard(st.text, { elapsed, reasoning: st.reasoning, thinkSecs }))
      .catch((err) => debugLog('card patch failed', { sid, err: String(err?.message || err) }))
  }

  function startCardTimer(sid) {
    const st = liveTurns.get(sid)
    if (!st) return
    if (st.timer) clearInterval(st.timer)
    st.timer = setInterval(() => flushCard(sid), PATCH_THROTTLE_MS)
  }

  function stopCardTimer(sid) {
    const st = liveTurns.get(sid)
    if (st?.timer) clearInterval(st.timer)
  }

  ctx.on('session/event', (session, event) => {
    const sid = String(session?.id)
    const chatId = sessions.chatOf(sid)
    if (!chatId || !feishu) return

    if (event.type === 'assistant/chunk') {
      const st = liveTurns.get(sid)
      if (!st) return
      const chunk = event.data?.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
        st.text += chunk.text
        st.chunked = true
        st.dirty = true
        if (st.phase === 'thinking') {
          st.phase = 'answering'   // first answer token: collapse thinking, start answer
          st.thinkSecs = Math.round((Date.now() - st.startedAt) / 1000)
          flushPhaseChange(sid)
        }
      } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text) {
        st.reasoning += chunk.text
        st.dirty = true
      }
      return
    }

    if (event.type === 'assistant/message') {
      const st = liveTurns.get(sid)
      const msg = event.data?.message
      const text = extractAssistantText(msg)
      // one assistant message per step: accumulate (a turn can interleave text and tool calls)
      if (st) {
        if (text) {
          st.texts.push(text)
          // authoritative snapshot for display: cumulative streamed text so far,
          // or fall back to accumulated step texts when chunks were unavailable
          if (!st.chunked) st.text = st.texts.join('\n\n')
          st.dirty = true
        }
        if (msg?.source?.model) st.model = String(msg.source.model)
      }
      return
    }

    if (event.type === 'turn/start') {
      // turn started → send thinking card (once per turn)
      if (!liveTurns.has(sid)) {
        const st = { cardMessageId: '', text: '', texts: [], reasoning: '', chunked: false, phase: 'thinking', frame: 0, thinkSecs: null, startedAt: Date.now(), dirty: false, timer: null, model: '' }
        liveTurns.set(sid, st)
        feishu.sendCard(chatId, buildThinkingCard({ frame: 0 }))
          .then((mid) => {
            st.cardMessageId = mid
            if (st.text || st.reasoning) st.dirty = true  // tokens may have arrived before the card id
            startCardTimer(sid)
          })
          .catch((err) => debugLog('thinking card send failed', { sid, err: String(err?.message || err) }))
      }
      return
    }

    if (event.type === 'turn/end') {
      const st = liveTurns.get(sid)
      if (!st) return
      stopCardTimer(sid)
      liveTurns.delete(sid)
      const elapsed = Math.round((Date.now() - st.startedAt) / 1000)
      const isErr = event.data?.reason?.kind === 'error'
      const isMaxTokens = event.data?.reason?.kind === 'max-tokens'
      const reason = event.data?.reason
      // final text: joined per-step texts (authoritative); fall back to streamed chunks
      const finalText = st.texts.filter(Boolean).join('\n\n') || st.text

      if (isErr) {
        const errMsg = reason?.error?.message || JSON.stringify(reason)
        const card = buildErrorCard(`turn 失败: ${errMsg}`)
        if (st.cardMessageId) {
          void feishu.updateCard(st.cardMessageId, card).catch(() => {})
        } else {
          void feishu.sendCard(chatId, card).catch(() => {})
        }
        debugLog('turn end (error)', { sid, reason: errMsg })
        return
      }

      if (isMaxTokens && !finalText.trim()) {
        // thinking model burned the entire output budget on reasoning — surface it
        const card = buildErrorCard('⛔ 输出上限打满（max-tokens）：模型思考内容耗尽了本轮输出配额，正文为空。已调大 maxTokens 配置；新会话重试该任务即可。')
        if (st.cardMessageId) {
          void feishu.updateCard(st.cardMessageId, card).catch(() => {})
        } else {
          void feishu.sendCard(chatId, card).catch(() => {})
        }
        debugLog('turn end (max-tokens, empty)', { sid, reasoningLen: st.reasoning.length })
        return
      }

      if (st.text.trim() || st.reasoning.trim()) {
        const card = buildDoneCard(finalText, { elapsed, model: st.model, reasoning: st.reasoning, thinkSecs: st.thinkSecs ?? undefined })
        if (st.cardMessageId) {
          void feishu.updateCard(st.cardMessageId, card).catch(() => {})
        } else {
          void feishu.sendCard(chatId, card).catch(() => {})
        }
      }
      debugLog('turn end', { sid, elapsed, len: st.text.length, model: st.model })
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

    // slash commands — registry-dispatched (commands.js); /new /stop kept inline
    if (text.startsWith('/')) {
      const [rawName, ...rest] = text.slice(1).trim().split(/\s+/)
      const arg = rest.join(' ')
      if (rawName === 'new' || rawName === 'reset') {
        await sessions.reset(msg.chatId)
        await feishu.sendText(msg.chatId, '🆕 新会话已开', msg.messageId).catch(() => {})
        return
      }
      if (rawName === 'stop') {
        const had = sessions.stop(msg.chatId)
        await feishu.sendText(msg.chatId, had ? '⏹️ 已停止当前生成' : 'ℹ️ 当前没有正在生成的回复').catch(() => {})
        return
      }
      const cmd = findCommand(rawName)
      if (cmd) {
        try {
          await cmd.run({ chatId: msg.chatId, arg, ctx, sessions, feishu, log: debugLog })
        } catch (err) {
          debugLog('command failed', { cmd: rawName, err: String(err?.message || err) })
          await feishu.sendText(msg.chatId, `⚠️ 命令执行失败：${err?.message || err}`).catch(() => {})
        }
        return
      }
      if (rawName) {
        await feishu.sendText(msg.chatId, `未知命令 /${rawName}，发送 /help 查看清单`).catch(() => {})
        return
      }
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
        onMessage: (msg) => {
          handleInbound(msg).catch((err) => {
            debugLog('inbound handler failed', { err: String(err?.stack || err) })
          })
        },
        onCardAction: async (evt) => {
          try {
            // approval card buttons first
            if (evt.action?.value?.bridge_approval) {
              const { rpcId, outcome } = evt.action.value
              return await approvals.resolve(rpcId, outcome === 'allowed-once' ? 'allowed-once' : 'rejected')
            }
            const result = await handleBridgeAction({
              action: evt.action,
              operator: evt.operator,
              ctx,
              feishu,
              chatId: evt.chatId,
            })
            if (!result) return undefined
            // Sync card update (returned to Feishu as the callback response)
            if (result.card) {
              return { toast: { type: 'success', content: '已更新' }, card: { type: 'raw', data: result.card } }
            }
            if (result.text) return { toast: { type: 'info', content: result.text } }
            return undefined
          } catch (err) {
            debugLog('card action failed', { err: String(err?.message || err) })
            return { toast: { type: 'error', content: `操作失败：${err?.message || err}` } }
          }
        },
        onError: (err) => debugLog('feishu error', { err: String(err?.message || err) }),
        onStatus: (info) => debugLog('feishu status', info),
      })
      feishu.start()

      // Approval bridging: DSH escalation asks → Feishu card → /api/respond
      approvals = new ApprovalBridge({ webUrl: 'http://127.0.0.1:3080', feishu, sessions, log: debugLog })
      approvals.start()
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
      approvals?.stop()
    }
  })
}
