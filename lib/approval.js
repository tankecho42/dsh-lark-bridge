/**
 * Approval bridging: DSH approval/request events → Feishu confirmation card
 * → user taps Allow/Deny → POST /api/respond on the dsh web host.
 *
 * The apiproxy mux pushes `approval/requested` server-request frames to every
 * connected client; we subscribe through one WebSocket on the webserver's
 * HTTP port (the same process serves /api + frontend).
 */

import { cmdCard, md, buttonRows } from './cmd-card.js'
import WebSocket from 'ws'

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000 // user has 10 min to answer
const RESPONSE_TIMEOUT_MS = 15_000

export class ApprovalBridge {
  /**
   * @param opts { webUrl, feishu, sessions, log }
   */
  constructor({ webUrl, feishu, sessions, log }) {
    const base = new URL(webUrl || 'http://127.0.0.1:3080')
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('approval webUrl must use http or https')
    this.webUrl = base.toString().replace(/\/$/, '')
    const eventsUrl = new URL('/api/events.mux', base)
    eventsUrl.protocol = eventsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    this.eventsUrl = eventsUrl.toString()
    this.respondUrl = new URL('/api/respond', base).toString()
    this.feishu = feishu
    this.sessions = sessions
    this.log = log || (() => {})
    this.pending = new Map() // rpcId → { rpcId, sessionId, approvalId, toolName, reason, cardMessageId, timer }
    this.autoAllow = new Set() // `${sessionId}\u0000${toolName}` grants from "允许本会话" button
    this.onApprovalCardSent = null // hook: (sessionId) → seal the live streaming card
    this.onApprovalResolved = null // hook: (sessionId, outcome) → start continuation card after an explicitly allowed prompt
    this.started = false
  }

  start() {
    if (this.started) return
    this.started = true
    this._loop().catch((err) => this.log('approval sse failed', { err: String(err?.message || err) }))
  }

  stop() {
    this.started = false
    try { this._ws?.close() } catch (err) {
      this.log('approval ws close failed', { err: String(err?.message || err) })
    }
    this._ws = null
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      if (!entry.resolving) {
        void this._respond(entry, 'rejected').then((ok) => {
          if (!ok) this.log('approval shutdown rejection was not accepted', { rpcId: entry.rpcId })
        }).catch((err) => this.log('approval shutdown rejection failed', {
          rpcId: entry.rpcId, err: String(err?.message || err),
        }))
      }
    }
    this.pending.clear()
    this.autoAllow.clear()
  }

  async _loop() {
    while (this.started) {
      try {
        const ws = new WebSocket(this.eventsUrl)
        this._ws = ws
        await new Promise((resolve, reject) => {
          ws.on('open', () => {
            this.log('approval ws open', {})
          })
          ws.once('close', () => {
            if (this.started) reject(new Error('ws closed'))
            else resolve()
          })
          ws.once('error', reject)
          ws.on('message', (d) => {
            try {
              const m = JSON.parse(d.toString())
              if (m.type === 'server-request' && m.method === 'approval/requested') {
                this._onApprovalRequested({ rpcId: m.rpcId, payload: m.payload }).catch((err) => {
                  this.log('approval request handling failed', { rpcId: m.rpcId, err: String(err?.message || err) })
                })
              }
            } catch { /* ignore malformed frame */ }
          })
        })
      } catch (err) {
        if (!this.started) return
        try { this._ws?.terminate?.() } catch { /* already closed */ }
        this._ws = null
        this.log('approval ws reconnect', { err: String(err?.message || err) })
      }
      if (this.started) await new Promise((r) => setTimeout(r, 3000))
    }
  }

  async _onApprovalRequested(envelope) {
    const { rpcId } = envelope
    const p = envelope.payload
    if (this.pending.has(rpcId)) return
    const chatId = this.sessions.chatOf(String(p.sessionId))
    if (!chatId) return // not our session (web UI's own, etc.)

    const entry = {
      rpcId,
      sessionId: p.sessionId,
      approvalId: p.approvalId,
      toolName: p.toolName || '',
      reason: p.reason || '',
      cardMessageId: '',
      timer: null,
    }
    // session-scoped auto-allow: this chat already granted this tool → answer instantly
    if (this.autoAllow.has(`${p.sessionId}\u0000${entry.toolName}`)) {
      // The current live card was never sealed because no approval card was
      // inserted. Resuming it with a continuation callback would split/reset
      // the active answer card, so answer silently and leave the card intact.
      this._respond(entry, 'allowed-once').then((ok) => {
        if (!ok) this.log('approval auto-allow response rejected', { rpcId, sessionId: p.sessionId })
      }).catch((err) => this.log('approval auto-allow failed', { rpcId, err: String(err?.message || err) }))
      this.log('approval auto-allowed', { rpcId, tool: entry.toolName, sessionId: p.sessionId })
      return
    }
    this.pending.set(rpcId, entry)
    this._lastSessionId = p.sessionId
    this._lastApprovalId = p.approvalId

    const reasonShort = String(entry.reason).slice(0, 120).replace(/\n/g, ' ')
    const card = cmdCard('🔐 权限确认', [
      md(`工具 **${entry.toolName || 'unknown'}** 请求授权：\n\n> ${reasonShort || '(无说明)'}`),
      md('点击按钮应答（10 分钟内有效）：'),
      // one full-width button per row — no cramped trisect columns
      ...buttonRows([
        { text: '✅ 允许一次', primary: true, value: { bridge_approval: rpcId, outcome: 'allowed-once' } },
        { text: '🔓 允许本会话（该工具后续自动放行）', primary: true, value: { bridge_approval: rpcId, outcome: 'allowed-session' } },
        { text: '❌ 拒绝', value: { bridge_approval: rpcId, outcome: 'rejected' } },
      ]),
      md('*按钮无反应时，直接回复「允许」或「拒绝」也可以*'),
    ], { template: 'orange' })

    let notified = false
    try {
      entry.cardMessageId = await this.feishu.sendCard(chatId, card)
      notified = true
    } catch (err) {
      this.log('approval card send failed', { err: String(err?.message || err) })
      try {
        await this.feishu.sendText(
          chatId,
          `🔐 工具 ${entry.toolName || 'unknown'} 请求授权：${reasonShort || '(无说明)'}\n请回复“允许”或“拒绝”。`,
        )
        notified = true
        this.log('approval sent as text fallback', { rpcId, chatId })
      } catch (fallbackErr) {
        this.log('approval text fallback failed', { rpcId, err: String(fallbackErr?.message || fallbackErr) })
      }
    }
    if (!notified) {
      const rejected = await this._respond(entry, 'rejected')
      if (rejected) {
        this.pending.delete(rpcId)
        this.log('approval rejected because user notification failed', { rpcId, chatId })
        return
      }
      entry.timer = setTimeout(() => this._expire(rpcId), 60_000)
      return
    }
    // approval card now sits between live updates — seal the current streaming
    // card so nothing ever appends behind the approval card. The continuation
    // card starts only when the approval is actually ALLOWED (turn resumes).
    if (this.onApprovalCardSent) {
      try { this.onApprovalCardSent(String(p.sessionId)) } catch (err) {
        this.log('approval seal failed', { err: String(err?.message || err) })
      }
    }
    entry.timer = setTimeout(() => this._expire(rpcId), APPROVAL_TIMEOUT_MS)
    this.log('approval requested', { rpcId, tool: entry.toolName, chatId })
  }

  _expire(rpcId) {
    const entry = this.pending.get(rpcId)
    if (!entry) return
    this.pending.delete(rpcId)
    this._respond(entry, 'rejected').then((ok) => {
      if (!ok) this.log('approval expiry response rejected', { rpcId })
    }).catch((err) => this.log('approval expiry response failed', { rpcId, err: String(err?.message || err) }))
    if (entry.cardMessageId) {
      void this.feishu.updateCard(entry.cardMessageId, cmdCard('🔐 权限确认（已超时拒绝）', [
        md('超过 10 分钟未应答，已自动拒绝。需要时请重试任务。'),
      ], { template: 'grey' })).catch((err) => {
        this.log('approval expiry card update failed', { rpcId, err: String(err?.message || err) })
      })
    }
  }

  /** Newest pending approval for a chat (for text quick-replies). */
  pendingForChat(chatId) {
    for (const entry of [...this.pending.values()].reverse()) {
      if (this.sessions.chatOf(entry.sessionId) === chatId) return entry
    }
    return null
  }

  /** Card-action or text reply resolves a pending approval.
   *  outcome: 'allowed-once' | 'allowed-session' (bridge-level: allow-once +
   *  remember this tool for the session) | 'rejected'. */
  async resolve(rpcId, outcome) {
    const entry = this.pending.get(rpcId)
    if (!entry) return { text: '⚠️ 该确认已失效（已回答或超时）' }
    if (entry.resolving) return { text: 'ℹ️ 正在处理，请勿重复点击' }
    entry.resolving = true
    clearTimeout(entry.timer)
    const rememberForSession = outcome === 'allowed-session'
    const responseOutcome = rememberForSession ? 'allowed-once' : outcome
    // pass the already-fetched entry straight through — never fall back to stale globals
    const ok = await this._respond(entry, responseOutcome)
    entry.resolving = false
    if (!ok) {
      // Keep the request answerable if the host temporarily rejected the
      // response (network race / stale web connection) instead of losing it.
      entry.timer = setTimeout(() => this._expire(rpcId), 60_000)
      return { text: '⚠️ 应答失败，请重试（该确认仍然有效）' }
    }
    this.pending.delete(rpcId)
    if (rememberForSession) this.autoAllow.add(`${entry.sessionId}\u0000${entry.toolName}`)
    if (responseOutcome === 'allowed-once' && this.onApprovalResolved) {
      try { this.onApprovalResolved(String(entry.sessionId), responseOutcome) } catch (err) {
        this.log('approval continue failed', { err: String(err?.message || err) })
      }
    }
    if (entry.cardMessageId) {
      const label = responseOutcome === 'allowed-once' && this.autoAllow.has(`${entry.sessionId}\u0000${entry.toolName}`)
        ? '✅ 已允许（本会话内该工具不再询问）'
        : responseOutcome === 'allowed-once' ? '✅ 已允许' : '❌ 已拒绝'
      void this.feishu.updateCard(entry.cardMessageId, cmdCard(`🔐 权限确认 ${label === '✅ 已允许（本会话内该工具不再询问）' ? '✅ 已允许+记住' : label}`, [
        md(responseOutcome === 'allowed-once'
          ? `工具 **${entry.toolName}** 的请求已允许${label.includes('不再询问') ? '，本会话内该工具的后续请求将自动放行' : ''}，任务继续。`
          : `工具 **${entry.toolName}** 的请求已拒绝，任务不会执行该操作。`),
      ], { template: responseOutcome === 'allowed-once' ? 'green' : 'grey' })).catch((err) => {
        this.log('approval card update failed', { rpcId, err: String(err?.message || err) })
      })
    }
    return { text: `已${responseOutcome === 'allowed-once' ? '允许' : '拒绝'}` }
  }

  async _respond(entry, outcome) {
    const sessionId = entry?.sessionId
    const approvalId = entry?.approvalId
    const rpcId = entry?.rpcId
    if (!sessionId || !approvalId || !rpcId) return false
    try {
      const res = await fetch(this.respondUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
        body: JSON.stringify({
          type: 'client-response',
          rpcId,
          result: { ok: true, value: { sessionId, approvalId, outcome } },
        }),
      })
      const data = await res.json().catch(() => ({}))
      return data.accepted === true
    } catch (err) {
      this.log('approval respond failed', { err: String(err?.message || err) })
      return false
    }
  }
}
