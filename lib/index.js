/**
 * @tankecho42/dsh-lark-bridge — DSH 飞书桥接插件。
 *
 * Host 侧 Cordis 插件（M3）：
 *  - 飞书长连接事件订阅（@larksuiteoapi/node-sdk WSClient）
 *  - DM 一人一会话；群聊 @触发 + 共享 workspace 会话
 *  - 用户文本 → ctx.agents（DSH）→ 回复经 session/event 转发回飞书
 *
 * 参考实现：@lanbaolu/dsh-wechat-bridge（hybrid host plugin + daemon）。
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { FeishuClient } from './feishu.js'
import { SessionManager } from './sessions.js'
import { buildThinkingCard, buildStreamingCard, buildDoneCard, buildErrorCard, SPINNER_FRAMES } from './card.js'
import { findCommand, handleBridgeAction } from './commands.js'
import { ApprovalBridge } from './approval.js'
import { AccessPolicy, MessageDeduper } from './security.js'
import { createFileLogger } from './logger.js'
import { DEFAULT_ALLOWED_EXTENSIONS, InboundMediaStore } from './media.js'

export const name = '@tankecho42/dsh-lark-bridge'

/** Host services the plugin needs. */
export const inject = ['tools', 'agents', 'agentDefaultModel', 'attachments']

export const Config = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  dataDir: z.string().default(''),
  webUrl: z.string().default('http://127.0.0.1:3080'),
  defaultCwd: z.string().default(''),
  workspaceRoots: z.array(z.string()).default([]),
  allowedUserIds: z.array(z.string()).default([]),
  allowedChatIds: z.array(z.string()).default([]),
  adminUserIds: z.array(z.string()).default([]),
  logMaxBytes: z.natural().min(64 * 1024).default(5 * 1024 * 1024),
  logBackups: z.natural().min(1).max(10).default(3),
  sessionTtlDays: z.natural().min(0).default(14),
  maxAttachments: z.natural().min(1).max(20).default(8),
  maxImageBytes: z.natural().min(64 * 1024).default(10 * 1024 * 1024),
  maxFileBytes: z.natural().min(64 * 1024).default(20 * 1024 * 1024),
  allowedFileExtensions: z.array(z.string()).default(DEFAULT_ALLOWED_EXTENSIONS),
  mediaRetentionDays: z.natural().min(0).default(7),
  healthHost: z.string().default('127.0.0.1'),
  healthPort: z.natural().min(0).max(65535).default(0),
  alertFailureThreshold: z.natural().min(1).max(100).default(3),
  autoStart: z.boolean().default(true),
})

const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const MILESTONE = 'M3'

export function apply(ctx, config) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = config.dataDir || join(dshHome, 'lark-bridge')

  mkdirSync(dataDir, { recursive: true })
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.healthHost)) {
    throw new Error('healthHost 只允许 loopback 地址（127.0.0.1 / ::1 / localhost）')
  }
  const debugLog = createFileLogger({
    dataDir,
    maxBytes: config.logMaxBytes,
    backups: config.logBackups,
  })

  debugLog('plugin loaded', { version: PLUGIN_VERSION, milestone: MILESTONE, dataDir })

  const sessions = new SessionManager({
    ctx, dataDir,
    defaultCwd: config.defaultCwd || undefined,
    workspaceRoots: config.workspaceRoots,
    log: debugLog,
  })
  const access = new AccessPolicy(config)
  const deduper = new MessageDeduper()
  let attachments
  try { attachments = ctx.get?.('attachments') || ctx.attachments } catch { attachments = ctx.attachments }
  const mediaStore = new InboundMediaStore({
    dataDir,
    attachments,
    maxAttachments: config.maxAttachments,
    maxImageBytes: config.maxImageBytes,
    maxFileBytes: config.maxFileBytes,
    allowedExtensions: config.allowedFileExtensions,
    retentionDays: config.mediaRetentionDays,
    log: debugLog,
  })
  const bridgeMetrics = {
    inboundMessages: 0,
    duplicateMessages: 0,
    deniedMessages: 0,
    promptFailures: 0,
    turnFailures: 0,
    mediaFailures: 0,
    healthAlerts: 0,
  }
  const health = { consecutiveFailures: 0, lastErrorAt: 0, lastError: '' }

  // Session/media retention maintenance: sweep once at boot, then daily.
  let maintenanceTimer = null
  function runMaintenance() {
    try {
      if (config.sessionTtlDays) sessions.expireIdle(config.sessionTtlDays * 24 * 3600 * 1000)
    } catch (err) {
      debugLog('idle session sweep failed', { err: String(err?.message || err) })
    }
    try { mediaStore.cleanup() } catch (err) {
      debugLog('media retention sweep failed', { err: String(err?.message || err) })
    }
  }
  runMaintenance()
  maintenanceTimer = setInterval(runMaintenance, 24 * 3600 * 1000)
  maintenanceTimer.unref?.()

  let feishu = null
  let approvals = null
  let disposed = false
  let internalPort = 0
  const endpointOwner = randomUUID()

  function noteHealthFailure(err) {
    health.consecutiveFailures++
    health.lastErrorAt = Date.now()
    health.lastError = String(err?.message || err || 'unknown').slice(0, 300)
    if (health.consecutiveFailures === config.alertFailureThreshold) {
      bridgeMetrics.healthAlerts++
      debugLog('health alert threshold reached', {
        consecutiveFailures: health.consecutiveFailures,
        threshold: config.alertFailureThreshold,
        error: health.lastError,
      })
    }
  }

  function noteHealthRecovery(source) {
    if (health.consecutiveFailures) {
      debugLog('health recovered', { source, previousFailures: health.consecutiveFailures })
      health.consecutiveFailures = 0
      health.lastError = ''
    }
  }

  function statusPayload() {
    const diagnostics = feishu?.diagnostics?.() || {}
    const configured = Boolean(config.appId && config.appSecret)
    const wsState = feishu?.connectionStatus?.() || 'stopped'
    const ready = configured && config.autoStart && feishu?.started === true
      && wsState === 'connected'
      && health.consecutiveFailures < config.alertFailureThreshold
    return {
      ok: true,
      ready,
      plugin: name,
      version: PLUGIN_VERSION,
      milestone: MILESTONE,
      configured,
      autoStart: config.autoStart,
      wsRunning: feishu?.started || false,
      wsState: feishu?.connectionStatus?.() || 'stopped',
      apiRetries: diagnostics.retries || 0,
      pendingCardMessages: diagnostics.pendingCardMessages || 0,
      coalescedCardUpdates: diagnostics.coalescedCardUpdates || 0,
      sessionTtlDays: config.sessionTtlDays || 0,
      chatOverrides: sessions.chatModels.size,
      activeSessions: sessions.handles.size,
      persistedSessions: sessions.sessionIds.size,
      healthHost: config.healthHost,
      healthPort: internalPort,
      healthFailures: health.consecutiveFailures,
      healthAlerts: bridgeMetrics.healthAlerts,
      lastErrorAt: health.lastErrorAt || null,
      lastError: health.lastError || null,
      media: mediaStore.diagnostics(),
      bridgeMetrics: { ...bridgeMetrics },
      dataDir,
      logPath: debugLog.path,
    }
  }

  function decorateCardScope(card, scopeId) {
    const copy = structuredClone(card)
    const visit = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      if (!value || typeof value !== 'object') return
      if (value.value && typeof value.value === 'object'
        && (value.value.bridge_action || value.value.bridge_approval)) {
        value.value.bridge_scope = scopeId
      }
      for (const nested of Object.values(value)) visit(nested)
    }
    visit(copy)
    return copy
  }

  function routeFor(scopeId) {
    return sessions.routeOf?.(scopeId) || { chatId: scopeId }
  }

  async function sendCardToScope(scopeId, card, replyTo) {
    const route = routeFor(scopeId)
    return feishu.sendCard(
      route.chatId,
      decorateCardScope(card, scopeId),
      replyTo === undefined ? route.replyTo : replyTo,
      { replyInThread: route.replyInThread === true },
    )
  }

  async function sendTextToScope(scopeId, text, replyTo) {
    const route = routeFor(scopeId)
    return feishu.sendText(
      route.chatId,
      text,
      replyTo === undefined ? route.replyTo : replyTo,
      { replyInThread: route.replyInThread === true },
    )
  }

  function routedFeishu(scopeId) {
    return {
      sendCard: (_ignored, card, replyTo) => sendCardToScope(scopeId, card, replyTo),
      sendText: (_ignored, text, replyTo) => sendTextToScope(scopeId, text, replyTo),
      updateCard: (...args) => feishu.updateCard(...args),
      connectionStatus: () => feishu.connectionStatus(),
      diagnostics: () => ({
        ...feishu.diagnostics(),
        bridge: statusPayload(),
        media: mediaStore.diagnostics(),
      }),
    }
  }

  // -----------------------------------------------------------------------
  // Session events → streaming card updates
  // -----------------------------------------------------------------------
  /** @type {Map<string, {cardMessageId: string, text: string, texts: string[], reasoning: string, tools: any[], chunked: boolean, phase: 'thinking'|'answering', frame: number, startedAt: number, dirty: boolean, timer: any, model: string, tokenUsageStart?: object}>} */
  const liveTurns = new Map()   // sessionId → live turn state
  const PATCH_THROTTLE_MS = 500

  function projectionValues(sid, chatId) {
    try {
      const projections = ctx.get('sessionProjections')
      const handle = sessions.handles.get(chatId) || sessions.handles.get(sid)
      const values = projections.snapshot?.(handle?.agent?.session)?.values
      return values ? {
        tokenUsage: values.tokenUsage ? { ...values.tokenUsage } : undefined,
        contextPressure: values.contextPressure ? { ...values.contextPressure } : undefined,
      } : {}
    } catch {
      return {}
    }
  }

  function tokenUsageDelta(start, end) {
    if (!start || !end) return undefined
    const keys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    return Object.fromEntries(keys.map((key) => [key, Math.max(0, (Number(end[key]) || 0) - (Number(start[key]) || 0))]))
  }

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
      feishu.updateCard(st.cardMessageId, buildStreamingCard(st.text, { elapsed, reasoning: st.reasoning, thinkSecs, tools: st.tools }))
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
    if (disposed) return
    const sid = String(session?.id)
    const chatId = sessions.chatOf(sid)
    if (!chatId || !feishu) return

    if (event.type === 'tool/call' || event.type === 'tool/result') {
      // surface tool activity inside the streaming card
      const st = liveTurns.get(sid)
      if (!st) return
      const d = event.data || {}
      if (event.type === 'tool/call') {
        st.tools.push({ name: d.name || 'tool', args: d.arguments || '', callId: d.callId })
        st.dirty = true
      } else {
        // attach result summary to the most recent open tool call (matched by callId when present)
        const raw = extractToolResultText(d)
        const byId = d?.message?.source?.callId ? st.tools.find((t) => t.callId === d.message.source.callId) : null
        const last = byId || st.tools[st.tools.length - 1]
        if (last && last.result === undefined) {
          last.result = raw.slice(0, 200)
          st.dirty = true
        }
      }
      return
    }

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
      } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && chunk.block.text) {
        // glm providers sample deltas sparsely ('你好', '行。') — most of the text
        // only arrives in the authoritative block-end. Reconcile: keep the streamed
        // text if it already covers this block, else append the full block.
        const full = chunk.block.text
        if (!st.text.includes(full) && !full.includes(st.text)) {
          st.text += (st.text ? (st.text.endsWith('\n') ? '' : '\n\n') : '') + full
        } else if (full.includes(st.text) && full.length > st.text.length && st.text) {
          // st.text is a sparse prefix of this block — replace with the full block
          st.text = st.text.replace(new RegExp(`${st.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') + full
        }
        st.chunked = true
        st.dirty = true
        if (st.phase === 'thinking') {
          st.phase = 'answering'
          st.thinkSecs = Math.round((Date.now() - st.startedAt) / 1000)
          flushPhaseChange(sid)
        }
      } else if (chunk?.type === 'block-end' && chunk.block?.type === 'reasoning' && typeof chunk.block.text === 'string' && chunk.block.text) {
        const full = chunk.block.text
        if (!st.reasoning.includes(full) && !full.includes(st.reasoning)) {
          st.reasoning += (st.reasoning ? '\n' : '') + full
        } else if (full.includes(st.reasoning) && full.length > st.reasoning.length && st.reasoning) {
          st.reasoning = full
        }
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
        const tokenUsageStart = projectionValues(sid, chatId).tokenUsage
        const st = { cardMessageId: '', text: '', texts: [], reasoning: '', tools: [], chunked: false, phase: 'thinking', frame: 0, thinkSecs: null, startedAt: Date.now(), dirty: false, timer: null, model: '', tokenUsageStart }
        liveTurns.set(sid, st)
        sendCardToScope(chatId, buildThinkingCard({ frame: 0 }))
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
      const projectionEnd = projectionValues(sid, chatId)
      const tokenUsage = tokenUsageDelta(st.tokenUsageStart, projectionEnd.tokenUsage)
      // final text: joined per-step texts (authoritative); fall back to streamed chunks
      const finalText = st.texts.filter(Boolean).join('\n\n') || st.text

      if (isErr) {
        bridgeMetrics.turnFailures++
        const errMsg = reason?.error?.message || JSON.stringify(reason)
        const card = buildErrorCard(`turn 失败: ${errMsg}`)
        if (st.cardMessageId) {
          void feishu.updateCard(st.cardMessageId, card).catch((err) => debugLog('error card update failed', { sid, err: String(err?.message || err) }))
        } else {
          void sendCardToScope(chatId, card).catch((err) => debugLog('error card send failed', { sid, err: String(err?.message || err) }))
        }
        debugLog('turn end (error)', { sid, reason: errMsg })
        return
      }

      if (isMaxTokens && !finalText.trim()) {
        // thinking model burned the entire output budget on reasoning — surface it
        const card = buildErrorCard('⛔ 输出上限打满（max-tokens）：模型思考内容耗尽了本轮输出配额，正文为空。已调大 maxTokens 配置；新会话重试该任务即可。')
        if (st.cardMessageId) {
          void feishu.updateCard(st.cardMessageId, card).catch((err) => debugLog('max-token card update failed', { sid, err: String(err?.message || err) }))
        } else {
          void sendCardToScope(chatId, card).catch((err) => debugLog('max-token card send failed', { sid, err: String(err?.message || err) }))
        }
        debugLog('turn end (max-tokens, empty)', { sid, reasoningLen: st.reasoning.length })
        return
      }

      if (st.text.trim() || st.reasoning.trim() || st.tools.length) {
        const card = buildDoneCard(finalText, {
          elapsed, model: st.model, reasoning: st.reasoning,
          thinkSecs: st.thinkSecs ?? undefined, tools: st.tools,
          tokenUsage, contextPressure: projectionEnd.contextPressure,
        })
        if (st.cardMessageId) {
          void feishu.updateCard(st.cardMessageId, card).catch((err) => debugLog('final card update failed', { sid, err: String(err?.message || err) }))
        } else {
          void sendCardToScope(chatId, card).catch((err) => debugLog('final card send failed', { sid, err: String(err?.message || err) }))
        }
      }
      debugLog('turn end', { sid, elapsed, len: st.text.length, model: st.model, tokenUsage })
    }
  })

  /**
   * An approval card was just inserted mid-turn: seal the live streaming card
   * (freeze what it has, mark it continued) and stop its update timer. The turn
   * is suspended while waiting for the user's answer — no card activity until
   * the approval resolves.
   */
  function sealCardForApproval(sid) {
    const st = liveTurns.get(sid)
    if (!st) return
    stopCardTimer(sid)
    const elapsed = Math.round((Date.now() - st.startedAt) / 1000)
    const sealedText = st.texts.filter(Boolean).join('\n\n') || st.text
    if (!st.cardMessageId) return
    void feishu.updateCard(st.cardMessageId, buildDoneCard(sealedText, {
      elapsed, model: st.model, reasoning: st.reasoning,
      thinkSecs: st.thinkSecs ?? undefined, tools: st.tools, continued: true,
    })).catch((err) => debugLog('seal card failed', { sid, err: String(err?.message || err) }))
  }

  /**
   * Approval answered: if allowed, the turn resumes — start a fresh streaming
   * card for the rest of the turn. On rejection the turn ends shortly and the
   * turn/end handler emits the final card itself, so nothing to do here.
   */
  function continueCardAfterApproval(sid) {
    const st = liveTurns.get(sid)
    if (!st) return
    const chatId = sessions.chatOf(sid)
    if (!chatId) return
    // reset accumulator state; a fresh card will carry the rest of the turn
    st.cardMessageId = ''
    st.text = ''
    st.texts = []
    st.reasoning = ''
    st.tools = []
    st.chunked = false
    st.startedAt = Date.now()
    st.thinkSecs = null
    st.phase = 'thinking'
    st.dirty = false
    sendCardToScope(chatId, buildThinkingCard({ frame: 0 }))
      .then((mid) => {
        st.cardMessageId = mid
        if (st.text || st.reasoning) st.dirty = true
        startCardTimer(sid)
      })
      .catch((err) => debugLog('continuation card send failed', { sid, err: String(err?.message || err) }))
  }

  function extractToolResultText(d) {
    const content = d?.message?.content
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const c of content) {
      if (c?.type === 'tool-result' && Array.isArray(c.content)) {
        for (const p of c.content) {
          if (p?.type === 'text' && typeof p.text === 'string') parts.push(p.text)
        }
      }
    }
    return parts.join('\n').trim()
  }

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
  async function sendTextSafe(chatId, text, replyTo, label = 'text reply') {
    try {
      return await sendTextToScope(chatId, text, replyTo)
    } catch (err) {
      debugLog(`${label} failed`, { chatId, err: String(err?.message || err) })
      return ''
    }
  }

  async function handleInbound(msg) {
    if (disposed) return
    bridgeMetrics.inboundMessages++
    if (!deduper.accept(msg.messageId)) {
      bridgeMetrics.duplicateMessages++
      debugLog('duplicate inbound ignored', { messageId: msg.messageId, chatId: msg.chatId })
      return
    }
    const auth = access.authorizeMessage(msg)
    if (!auth.ok) {
      bridgeMetrics.deniedMessages++
      debugLog('inbound denied', { reason: auth.reason, chatId: msg.chatId, senderId: msg.senderId })
      return
    }
    debugLog('inbound', {
      chatId: msg.chatId,
      scopeId: msg.scopeId,
      chatType: msg.chatType,
      messageType: msg.messageType,
      botMentioned: msg.botMentioned,
      len: msg.text.length,
      attachments: msg.attachments?.length || 0,
    })

    // group chats require @mention (unless configured otherwise)
    if (msg.chatType === 'group' && !msg.botMentioned) return

    const scopeId = msg.scopeId || msg.chatId
    sessions.noteRoute(scopeId, {
      chatId: msg.chatId,
      replyTo: msg.replyTo,
      replyInThread: msg.replyInThread,
    })
    const text = msg.text.trim()
    const hasMedia = Boolean(msg.attachments?.length)
    if (!text && !hasMedia) return

    // approval quick replies — resolve the newest pending approval card in this chat
    if (!hasMedia && approvals && (text === '允许' || text === '拒绝' || text.toLowerCase() === 'allow' || text.toLowerCase() === 'deny')) {
      const outcome = (text === '允许' || text.toLowerCase() === 'allow') ? 'allowed-once' : 'rejected'
      const pending = approvals.pendingForChat(scopeId)
      if (pending) {
        const requesterId = sessions.requesterOfSession(pending.sessionId)
        if (!access.canApprove(msg.senderId, requesterId)) {
          await sendTextSafe(scopeId, '⛔ 只有本轮任务发起人或管理员可以处理该授权', msg.messageId, 'approval denial reply')
          return
        }
        const res = await approvals.resolve(pending.rpcId, outcome)
        await sendTextSafe(scopeId, res.text || '已处理', msg.messageId, 'approval reply')
        return
      }
      // no pending approval — fall through to the agent (user might be chatting about 允许 in general)
    }

    // slash commands — registry-dispatched (commands.js); /new /stop kept inline
    if (!hasMedia && text.startsWith('/')) {
      const [rawName, ...rest] = text.slice(1).trim().split(/\s+/)
      const arg = rest.join(' ')
      const privilegedCommand = ['mode', 'model', 'cwd'].includes(rawName) || (rawName === 'tools' && Boolean(arg))
      if (privilegedCommand && !access.isAdmin(msg.senderId)) {
        await sendTextSafe(scopeId, '⛔ 该命令仅管理员可用', msg.messageId, 'admin denial reply')
        return
      }
      if (rawName === 'new' || rawName === 'reset') {
        try {
          await sessions.reset(scopeId)
          await sendTextSafe(scopeId, '🆕 新会话已开', msg.messageId, 'new session reply')
        } catch (err) {
          debugLog('session reset failed', { scopeId, err: String(err?.message || err) })
          await sendTextSafe(scopeId, `⚠️ 新会话创建失败：${err?.message || err}`, msg.messageId, 'new session error reply')
        }
        return
      }
      if (rawName === 'stop') {
        try {
          const had = sessions.stop(scopeId)
          await sendTextSafe(scopeId, had ? '⏹️ 已停止当前生成' : 'ℹ️ 当前没有正在生成的回复', undefined, 'stop reply')
        } catch (err) {
          debugLog('session stop failed', { scopeId, err: String(err?.message || err) })
          await sendTextSafe(scopeId, `⚠️ 停止失败：${err?.message || err}`, undefined, 'stop error reply')
        }
        return
      }
      const cmd = findCommand(rawName)
      if (cmd) {
        try {
          await cmd.run({ chatId: scopeId, arg, ctx, sessions, feishu: routedFeishu(scopeId), log: debugLog })
        } catch (err) {
          debugLog('command failed', { cmd: rawName, err: String(err?.message || err) })
          await sendTextSafe(scopeId, `⚠️ 命令执行失败：${err?.message || err}`, undefined, 'command error reply')
        }
        return
      }
      if (rawName) {
        await sendTextSafe(scopeId, `未知命令 /${rawName}，发送 /help 查看清单`, undefined, 'unknown command reply')
        return
      }
    }

    try {
      let prepared = { text, images: [] }
      if (hasMedia) {
        try {
          prepared = await mediaStore.prepare(msg, feishu)
        } catch (err) {
          bridgeMetrics.mediaFailures++
          debugLog('inbound media rejected', { scopeId, messageId: msg.messageId, err: String(err?.message || err) })
          await sendTextSafe(scopeId, `⚠️ 附件接收失败：${err?.message || err}`, msg.messageId, 'media rejection reply')
          return
        }
      }
      sessions.noteRequester(scopeId, msg.senderId)
      await sessions.prompt(scopeId, prepared.text, { images: prepared.images })
    } catch (err) {
      bridgeMetrics.promptFailures++
      debugLog('prompt failed', { scopeId, err: String(err?.message || err) })
      await sendTextSafe(scopeId, `⚠️ 处理失败：${err?.message || err}`, msg.messageId, 'prompt error reply')
    }
  }

  // -----------------------------------------------------------------------
  // Internal status API (loopback; daemon/ops health checks)
  // -----------------------------------------------------------------------
  function sendJson(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  function prometheusPayload() {
    const p = statusPayload()
    const transport = feishu?.diagnostics?.() || {}
    const values = {
      dsh_lark_bridge_ready: p.ready ? 1 : 0,
      dsh_lark_bridge_ws_running: p.wsRunning ? 1 : 0,
      dsh_lark_bridge_active_sessions: p.activeSessions,
      dsh_lark_bridge_persisted_sessions: p.persistedSessions,
      dsh_lark_bridge_inbound_messages_total: bridgeMetrics.inboundMessages,
      dsh_lark_bridge_duplicate_messages_total: bridgeMetrics.duplicateMessages,
      dsh_lark_bridge_denied_messages_total: bridgeMetrics.deniedMessages,
      dsh_lark_bridge_prompt_failures_total: bridgeMetrics.promptFailures,
      dsh_lark_bridge_turn_failures_total: bridgeMetrics.turnFailures,
      dsh_lark_bridge_media_failures_total: bridgeMetrics.mediaFailures,
      dsh_lark_bridge_health_alerts_total: bridgeMetrics.healthAlerts,
      dsh_lark_bridge_health_consecutive_failures: health.consecutiveFailures,
      dsh_lark_bridge_feishu_api_requests_total: transport.apiRequests || 0,
      dsh_lark_bridge_feishu_api_failures_total: transport.apiFailures || 0,
      dsh_lark_bridge_feishu_api_retries_total: transport.retries || 0,
      dsh_lark_bridge_feishu_messages_sent_total: transport.messagesSent || 0,
      dsh_lark_bridge_feishu_card_updates_total: transport.cardUpdates || 0,
      dsh_lark_bridge_feishu_resource_downloads_total: transport.resourceDownloads || 0,
      dsh_lark_bridge_feishu_resource_bytes_total: transport.resourceBytes || 0,
      dsh_lark_bridge_feishu_ws_reconnects_total: transport.wsReconnects || 0,
      dsh_lark_bridge_feishu_ws_failures_total: transport.wsFailures || 0,
      dsh_lark_bridge_pending_card_messages: transport.pendingCardMessages || 0,
      process_uptime_seconds: Math.floor(process.uptime()),
    }
    return `${Object.entries(values).map(([key, value]) => `${key} ${Number(value) || 0}`).join('\n')}\n`
  }

  function startInternalServer() {
    const endpointPath = join(dataDir, 'health-endpoint.json')
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/status') {
        sendJson(res, 200, statusPayload())
        return
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true, plugin: name, version: PLUGIN_VERSION })
        return
      }
      if (req.method === 'GET' && url.pathname === '/readyz') {
        const status = statusPayload()
        sendJson(res, status.ready ? 200 : 503, {
          ok: status.ready,
          plugin: name,
          version: PLUGIN_VERSION,
          wsState: status.wsState,
          configured: status.configured,
        })
        return
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(prometheusPayload())
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    })
    server.listen(config.healthPort, config.healthHost, () => {
      const a = server.address()
      internalPort = a && typeof a === 'object' ? a.port : 0
      const temporary = `${endpointPath}.${process.pid}.${endpointOwner}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify({
          host: config.healthHost,
          port: internalPort,
          pid: process.pid,
          owner: endpointOwner,
          plugin: name,
          version: PLUGIN_VERSION,
          endpoints: ['/healthz', '/readyz', '/status', '/metrics'],
        }, null, 2), { mode: 0o600 })
        renameSync(temporary, endpointPath)
      } catch (err) {
        try { unlinkSync(temporary) } catch { /* absent */ }
        debugLog('health endpoint discovery persist failed', { err: String(err?.message || err) })
      }
      debugLog('internal api listening', { host: config.healthHost, port: internalPort })
    })
    server.on('error', (err) => {
      noteHealthFailure(err)
      debugLog('internal api error', { err: String(err?.message || err) })
    })
    server.endpointPath = endpointPath
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
          message: `${MILESTONE} 已加载。配置: ${p.configured ? '已就绪' : '未配置（appId/appSecret 待填）'}。飞书长连接: ${p.wsState}。数据目录: ${p.dataDir}。版本 ${p.version}。`,
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
          if (disposed) return
          handleInbound(msg).catch((err) => {
            noteHealthFailure(err)
            debugLog('inbound handler failed', { err: String(err?.stack || err) })
          })
        },
        onCardAction: async (evt) => {
          try {
            if (!access.allowsChat(evt.chatId) || !access.allowsUser(evt.operator?.openId)) {
              debugLog('card action denied by access policy', { chatId: evt.chatId, operatorId: evt.operator?.openId })
              return { toast: { type: 'error', content: '无权在此会话执行该操作' } }
            }
            // approval card buttons first
            if (evt.action?.value?.bridge_approval) {
              // value shape from lib/approval.js: { bridge_approval: rpcId, outcome }
              const rpcId = evt.action.value.bridge_approval
              const rawOutcome = evt.action.value.outcome
              const outcome = rawOutcome === 'allowed-once' || rawOutcome === 'allowed-session' ? rawOutcome : 'rejected'
              const entry = approvals.pending.get(rpcId)
              const requesterId = entry ? sessions.requesterOfSession(entry.sessionId) : ''
              if (!access.canApprove(evt.operator?.openId, requesterId)) {
                debugLog('approval action denied', { rpcId, operatorId: evt.operator?.openId, requesterId })
                return { toast: { type: 'error', content: '只有本轮任务发起人或管理员可以处理该授权' } }
              }
              const r = await approvals.resolve(rpcId, outcome)
              return { toast: { type: r?.text?.startsWith('⚠️') ? 'error' : 'success', content: r?.text || '已处理' } }
            }
            if (evt.action?.value?.bridge_action && !access.isAdmin(evt.operator?.openId)) {
              debugLog('configuration action denied', { action: evt.action?.value?.bridge_action, operatorId: evt.operator?.openId })
              return { toast: { type: 'error', content: '该操作仅管理员可用' } }
            }
            const scopeId = String(evt.action?.value?.bridge_scope || evt.chatId)
            const route = routeFor(scopeId)
            if (route.chatId !== evt.chatId) {
              debugLog('card scope mismatch denied', { scopeId, expectedChatId: route.chatId, eventChatId: evt.chatId })
              return { toast: { type: 'error', content: '卡片会话已失效，请重新发送命令' } }
            }
            const result = await handleBridgeAction({
              action: evt.action,
              operator: evt.operator,
              ctx,
              sessions,
              feishu: routedFeishu(scopeId),
              chatId: scopeId,
            })
            if (!result) return undefined
            // Sync card update (returned to Feishu as the callback response)
            if (result.card) {
              return { toast: { type: 'success', content: '已更新' }, card: { type: 'raw', data: decorateCardScope(result.card, scopeId) } }
            }
            if (result.text) return { toast: { type: 'info', content: result.text } }
            return undefined
          } catch (err) {
            debugLog('card action failed', { err: String(err?.message || err) })
            return { toast: { type: 'error', content: `操作失败：${err?.message || err}` } }
          }
        },
        onError: (err) => {
          noteHealthFailure(err)
          debugLog('feishu error', { err: String(err?.message || err) })
        },
        onStatus: (info) => {
          if (info?.type === 'ws-ready' || info?.type === 'ws-reconnected') {
            noteHealthRecovery(info.type)
          } else if (info?.type === 'ws-reconnecting') {
            noteHealthFailure(new Error('Feishu WebSocket reconnecting'))
          }
          debugLog('feishu status', info)
        },
      })
      feishu.start()

      // Approval bridging: DSH escalation asks → Feishu card → /api/respond
      const approvalFeishu = {
        sendCard: (scopeId, card) => sendCardToScope(scopeId, card),
        sendText: (scopeId, text) => sendTextToScope(scopeId, text),
        updateCard: (...args) => feishu.updateCard(...args),
      }
      approvals = new ApprovalBridge({ webUrl: config.webUrl, feishu: approvalFeishu, sessions, log: debugLog })
      approvals.onApprovalCardSent = sealCardForApproval
      approvals.onApprovalResolved = continueCardAfterApproval
      approvals.start()
    } else {
      debugLog('not autostarted', { hasAppId: !!config.appId, hasAppSecret: !!config.appSecret, autoStart: config.autoStart })
    }

    ctx.logger?.info?.('[dsh-lark-bridge] loaded', { dataDir, milestone: MILESTONE })

    return () => {
      disposed = true
      if (maintenanceTimer) clearInterval(maintenanceTimer)
      approvals?.stop()
      feishu?.stop()
      deduper.clear()
      for (const st of liveTurns.values()) {
        if (st.timer) clearInterval(st.timer)
      }
      liveTurns.clear()
      try {
        server.close()
      } catch {
        /* ignore */
      }
      try {
        if (server.endpointPath) {
          const record = JSON.parse(readFileSync(server.endpointPath, 'utf8'))
          if (record.owner === endpointOwner) unlinkSync(server.endpointPath)
        }
      } catch { /* absent, replaced by a newer HMR instance, or malformed */ }
      sessions.dispose()
    }
  })
}
