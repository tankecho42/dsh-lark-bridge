/**
 * Approval bridging: DSH approval/request events → Feishu confirmation card
 * → user taps Allow/Deny → POST /api/respond on the dsh web host.
 *
 * The apiproxy mux pushes `approval/requested` server-request frames to every
 * connected SSE client; we poll-free subscribe by holding one SSE stream on
 * the webserver's HTTP port (same process serves /api + frontend).
 */

import { cmdCard, md } from './cmd-card.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
// ws lives in the harness node_modules (peer); resolve lazily with fallbacks
function loadWebSocket() {
  const candidates = [
    () => require('ws'),
    () => require('/Users/tank/projects/deepseek-harness/node_modules/ws/index.js'),
  ]
  for (const c of candidates) { try { return c() } catch { /* next */ } }
  throw new Error('ws package unavailable')
}

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000 // user has 10 min to answer

export class ApprovalBridge {
  /**
   * @param opts { webUrl, feishu, sessions, log }
   */
  constructor({ webUrl, feishu, sessions, log }) {
    this.webUrl = (webUrl || 'http://127.0.0.1:3080').replace(/\/$/, '')
    this.feishu = feishu
    this.sessions = sessions
    this.log = log || (() => {})
    this.pending = new Map() // rpcId → { rpcId, sessionId, approvalId, toolName, reason, cardMessageId, timer }
    this.started = false
    this.abort = null
  }

  start() {
    if (this.started) return
    this.started = true
    this._loop().catch((err) => this.log('approval sse failed', { err: String(err?.message || err) }))
  }

  stop() {
    this.started = false
    try { this._ws?.close() } catch { /* ignore */ }
    this.abort?.abort()
  }

  async _loop() {
    const WebSocket = loadWebSocket()
    while (this.started) {
      try {
        const ws = new WebSocket(`${this.webUrl.replace('http', 'ws')}/api/events.mux`)
        this._ws = ws
        await new Promise((resolve, reject) => {
          ws.on('open', () => {
            this.log('approval ws open', {})
            resolve()
            ws.on('close', () => { if (this.started) reject(new Error('ws closed')) })
          })
          ws.on('error', reject)
          ws.on('message', (d) => {
            try {
              const m = JSON.parse(d.toString())
              if (m.type === 'server-request' && m.method === 'approval/requested') {
                this._onApprovalRequested({ rpcId: m.rpcId, payload: m.payload }).catch(() => {})
              }
            } catch { /* ignore malformed frame */ }
          })
        })
        // connected: park until closed
        await new Promise((resolve) => { ws.on('close', resolve); ws.on('error', resolve) })
      } catch (err) {
        if (!this.started) return
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
    this.pending.set(rpcId, entry)
    this._lastSessionId = p.sessionId
    this._lastApprovalId = p.approvalId

    const reasonShort = String(entry.reason).slice(0, 120).replace(/\n/g, ' ')
    const card = cmdCard('🔐 权限确认', [
      md(`工具 **${entry.toolName || 'unknown'}** 请求授权：\n\n> ${reasonShort || '(无说明)'}`),
      md('点击按钮应答（10 分钟内有效）：'),
      {
        tag: 'column_set',
        flex_mode: 'bisect',
        background_style: 'default',
        columns: [
          {
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{ tag: 'button', text: { tag: 'plain_text', content: '✅ 允许一次' }, type: 'primary', value: { bridge_approval: rpcId, outcome: 'allowed-once' } }],
          },
          {
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{ tag: 'button', text: { tag: 'plain_text', content: '❌ 拒绝' }, type: 'danger', value: { bridge_approval: rpcId, outcome: 'rejected' } }],
          },
        ],
      },
      md('*也可以直接回复「允许」或「拒绝」*'),
    ], { template: 'orange' })

    try {
      entry.cardMessageId = await this.feishu.sendCard(chatId, card)
    } catch (err) {
      this.log('approval card send failed', { err: String(err?.message || err) })
    }
    entry.timer = setTimeout(() => this._expire(rpcId), APPROVAL_TIMEOUT_MS)
    this.log('approval requested', { rpcId, tool: entry.toolName, chatId })
  }

  _expire(rpcId) {
    const entry = this.pending.get(rpcId)
    if (!entry) return
    this.pending.delete(rpcId)
    this._respond(rpcId, 'rejected').catch(() => {})
    if (entry.cardMessageId) {
      void this.feishu.updateCard(entry.cardMessageId, cmdCard('🔐 权限确认（已超时拒绝）', [
        md('超过 10 分钟未应答，已自动拒绝。需要时请重试任务。'),
      ], { template: 'grey' })).catch(() => {})
    }
  }

  /** Card-action or text reply resolves a pending approval. */
  async resolve(rpcId, outcome) {
    const entry = this.pending.get(rpcId)
    if (!entry) return { text: '⚠️ 该确认已失效（已回答或超时）' }
    clearTimeout(entry.timer)
    this.pending.delete(rpcId)
    const ok = await this._respond(rpcId, outcome)
    if (entry.cardMessageId) {
      const label = outcome === 'allowed-once' ? '✅ 已允许' : '❌ 已拒绝'
      void this.feishu.updateCard(entry.cardMessageId, cmdCard(`🔐 权限确认 ${label}`, [
        md(`工具 **${entry.toolName}** 的请求已${outcome === 'allowed-once' ? '允许' : '拒绝'}，任务继续。`),
      ], { template: outcome === 'allowed-once' ? 'green' : 'grey' })).catch(() => {})
    }
    return { text: ok ? `已${outcome === 'allowed-once' ? '允许' : '拒绝'}` : '⚠️ 应答失败（可能已过期）' }
  }

  async _respond(rpcId, outcome) {
    const entry = this.pending.get(rpcId) || [...this.pending.values()].find((e) => e.rpcId === rpcId)
    // fall back to the ws frame bookkeeping for already-deleted entries
    const sessionId = entry?.sessionId || this._lastSessionId
    const approvalId = entry?.approvalId || this._lastApprovalId
    if (!sessionId || !approvalId) return false
    try {
      const res = await fetch(`${this.webUrl}/api/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
