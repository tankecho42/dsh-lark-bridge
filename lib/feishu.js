/**
 * Feishu WS client — long-connection event subscription + message send.
 * Built on @larksuiteoapi/node-sdk (official SDK).
 *
 * Inbound:  im.message.receive_v1  →  normalized InboundMessage
 * Outbound: im/v1/messages (text / reply)
 */
import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk'
import { randomUUID } from 'node:crypto'

const FEISHU_BASE = 'https://open.feishu.cn'
const API_TIMEOUT_MS = 15_000
const API_MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 4_000
const RATE_LIMIT_CODES = new Set([99991400])

export class FeishuClient {
  /**
   * @param {object} opts
   * @param {string} opts.appId
   * @param {string} opts.appSecret
   * @param {(msg: object) => void} opts.onMessage
   * @param {(err: Error) => void} [opts.onError]
   * @param {(info: object) => void} [opts.onStatus]
   * @param {typeof fetch} [opts.fetchImpl] injectable transport for tests
   * @param {(ms: number) => Promise<void>} [opts.sleep] injectable delay for tests
   * @param {() => number} [opts.random] injectable jitter source for tests
   */
  constructor(opts) {
    this.appId = opts.appId
    this.appSecret = opts.appSecret
    this.onMessage = opts.onMessage
    this.onError = opts.onError || (() => {})
    this.onStatus = opts.onStatus || (() => {})
    /** @type {(evt: {chatId: string, messageId: string, operator: {openId: string, name?: string}, action: {value: any}}) => any} */
    this.onCardAction = opts.onCardAction || null
    this.ws = null
    this.token = ''
    this.tokenExpireAt = 0
    this.started = false
    this.generation = 0
    this.botOpenId = ''
    this.fetchImpl = opts.fetchImpl || fetch
    this.sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = opts.random || Math.random
    this.requestController = new AbortController()
    this.tokenPending = null
    this.metrics = { retries: 0, coalescedCardUpdates: 0, lastRetryAt: 0 }
    /** @type {Map<string, {running: boolean, pending: null | {card: object, waiters: Array<{resolve: Function, reject: Function}>}}>} */
    this.cardUpdates = new Map()
  }

  /** Fetch bot identity (for precise @-mention detection in groups). */
  async loadBotInfo() {
    try {
      const info = await this.api('GET', '/open-apis/bot/v3/info')
      this.botOpenId = info?.open_id || ''
      return info
    } catch (err) {
      this.onError(err)
      return null
    }
  }

  // ---- tenant_access_token with cache ----
  async getToken() {
    const now = Date.now()
    if (this.token && now < this.tokenExpireAt - 60_000) return this.token
    if (!this.tokenPending) {
      this.tokenPending = this._refreshToken().finally(() => { this.tokenPending = null })
    }
    return this.tokenPending
  }

  async _refreshToken() {
    const data = await this._requestJson(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    }, { retryable: true, operation: 'tenant_access_token' })
    if (data.code !== 0) throw apiError(`tenant_access_token failed: ${data.code} ${data.msg}`, data)
    this.token = data.tenant_access_token
    this.tokenExpireAt = Date.now() + (data.expire || 7200) * 1000
    return this.token
  }

  /**
   * JSON request with bounded timeout and exponential backoff.
   * POST callers must opt in only when their body carries a stable idempotency key.
   */
  async _requestJson(url, init, { retryable = false, operation = 'api' } = {}) {
    let lastError
    // Capture the generation's controller. start() may replace the instance
    // after stop(); an old request must still observe the old abort signal.
    const requestController = this.requestController
    for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt++) {
      let response
      let data
      let timedOut = false
      const controller = new AbortController()
      const abortForStop = () => controller.abort(requestController.signal.reason || new Error('Feishu client stopped'))
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`Feishu request timed out after ${API_TIMEOUT_MS}ms`))
      }, API_TIMEOUT_MS)
      requestController.signal.addEventListener('abort', abortForStop, { once: true })
      try {
        if (requestController.signal.aborted) abortForStop()
        response = await this.fetchImpl(url, { ...init, signal: controller.signal })
        const raw = await response.text()
        try {
          data = raw ? JSON.parse(raw) : {}
        } catch {
          data = { msg: raw || response.statusText || 'non-JSON response' }
        }

        const retryableResponse = response.status === 429
          || response.status >= 500
          || RATE_LIMIT_CODES.has(Number(data?.code))
        if (retryable && retryableResponse && attempt < API_MAX_ATTEMPTS) {
          const delayMs = this._retryDelay(attempt, response.headers?.get?.('retry-after'))
          this.metrics.retries++
          this.metrics.lastRetryAt = Date.now()
          this.onStatus({ type: 'api-retry', operation, attempt, status: response.status, code: data?.code, delayMs })
          await this.sleep(delayMs)
          continue
        }

        if (!response.ok) {
          throw apiError(`feishu http ${init.method || 'GET'} ${operation} -> ${response.status} ${data?.msg || response.statusText || ''}`, {
            ...data, status: response.status,
          })
        }
        return data
      } catch (err) {
        lastError = err
        const stopped = requestController.signal.aborted
        const isApiResponseError = Number.isFinite(err?.status) || Number.isFinite(err?.code)
        if (!retryable || stopped || isApiResponseError || attempt >= API_MAX_ATTEMPTS) throw err
        const delayMs = this._retryDelay(attempt)
        this.metrics.retries++
        this.metrics.lastRetryAt = Date.now()
        this.onStatus({ type: 'api-retry', operation, attempt, status: timedOut ? 'timeout' : 'network', delayMs })
        await this.sleep(delayMs)
      } finally {
        clearTimeout(timer)
        requestController.signal.removeEventListener('abort', abortForStop)
      }
    }
    throw lastError || new Error(`feishu request failed: ${operation}`)
  }

  _retryDelay(attempt, retryAfter) {
    const headerDelay = parseRetryAfter(retryAfter)
    if (headerDelay != null) return Math.min(headerDelay, RETRY_MAX_MS)
    const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** (attempt - 1)))
    return Math.round(exponential * (0.75 + this.random() * 0.5))
  }

  async api(method, path, body, { retryable = method !== 'POST' } = {}) {
    const token = await this.getToken()
    const data = await this._requestJson(`${FEISHU_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }, { retryable, operation: path.split('?')[0] })
    if (data.code !== 0) {
      throw apiError(`feishu api ${method} ${path} -> ${data.code} ${data.msg}`, data)
    }
    return data.data
  }

  // ---- WS long connection ----
  start() {
    if (this.started) return
    if (this.requestController.signal.aborted) this.requestController = new AbortController()
    this.started = true
    const generation = ++this.generation
    void this.loadBotInfo()

    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        if (!this.started || generation !== this.generation) return
        try {
          const inbound = parseInbound(data, this.botOpenId)
          if (inbound) this.onMessage(inbound)
        } catch (err) {
          this.onError(err)
        }
      },
      'card.action.trigger': async (data) => {
        if (!this.started || generation !== this.generation) return undefined
        try {
          const evt = normalizeCardAction(data)
          if (evt && this.onCardAction) {
            const next = await this.onCardAction(evt)
            if (next) return next
          }
        } catch (err) {
          this.onError(err)
        }
        return undefined
      },
    })

    const client = new WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: FEISHU_BASE,
      loggerLevel: 'warn',
    })
    this.ws = client

    client
      .start({ eventDispatcher: dispatcher })
      .then(() => {
        if (this.started && generation === this.generation) this.onStatus({ type: 'ws-started' })
      })
      .catch((err) => {
        if (generation !== this.generation) return
        this.started = false
        this.onError(err)
      })
    this.onStatus({ type: 'ws-start' })
  }

  /** Stop the long connection and invalidate callbacks queued by an old plugin context. */
  stop() {
    const client = this.ws
    if (!this.started && !client && this.requestController.signal.aborted) return
    this.ws = null
    this.started = false
    this.generation++
    this.requestController.abort(new Error('Feishu client stopped'))
    const stoppedError = new Error('Feishu client stopped')
    for (const state of this.cardUpdates.values()) {
      if (!state.pending) continue
      for (const waiter of state.pending.waiters) waiter.reject(stoppedError)
      state.pending = null
    }
    if (client) {
      try {
        client.close({ force: true })
      } catch (err) {
        this.onError(err)
      }
    }
    this.onStatus({ type: 'ws-stop' })
  }

  connectionStatus() {
    if (!this.started) return 'stopped'
    try { return this.ws?.getConnectionStatus?.().state || 'starting' } catch { return 'unknown' }
  }

  diagnostics() {
    return {
      wsState: this.connectionStatus(),
      tokenCached: Boolean(this.token && Date.now() < this.tokenExpireAt),
      pendingCardMessages: this.cardUpdates.size,
      ...this.metrics,
    }
  }

  // ---- outbound ----
  /**
   * Send a text message. If replyTo given, send as a reply to that message id.
   * @returns {Promise<string>} message_id of the sent message
   */
  async sendText(chatId, text, replyTo) {
    const body = {
      msg_type: 'text',
      content: JSON.stringify({ text }),
      uuid: randomUUID(),
    }
    let path = `/open-apis/im/v1/messages?receive_id_type=chat_id`
    if (replyTo) {
      path = `/open-apis/im/v1/messages/${replyTo}/reply`
    } else {
      body.receive_id = chatId
    }
    const data = await this.api('POST', path, body, { retryable: true })
    return data?.message_id || ''
  }

  /**
   * Send an interactive card (config.update_multi must be true for repeated updates).
   * @returns {Promise<string>} message_id of the sent card message
   */
  async sendCard(chatId, card, replyTo) {
    const body = { msg_type: 'interactive', content: JSON.stringify(card), uuid: randomUUID() }
    if (!replyTo) body.receive_id = chatId
    const path = replyTo
      ? `/open-apis/im/v1/messages/${replyTo}/reply`
      : `/open-apis/im/v1/messages?receive_id_type=chat_id`
    const data = await this.api('POST', path, body, { retryable: true })
    return data?.message_id || ''
  }

  /** Update (replace) the card content of an existing card message. */
  updateCard(messageId, card) {
    if (!messageId) return Promise.reject(new Error('messageId is required'))
    if (this.requestController.signal.aborted) return Promise.reject(new Error('Feishu client stopped'))

    let state = this.cardUpdates.get(messageId)
    if (!state) {
      state = { running: false, pending: null }
      this.cardUpdates.set(messageId, state)
    }

    const promise = new Promise((resolve, reject) => {
      if (state.pending) {
        // Only the newest not-yet-started card matters; all callers settle
        // when that newest state has reached Feishu.
        state.pending.card = card
        state.pending.waiters.push({ resolve, reject })
        this.metrics.coalescedCardUpdates++
      } else {
        state.pending = { card, waiters: [{ resolve, reject }] }
      }
    })
    if (!state.running) void this._drainCardUpdates(messageId, state)
    return promise
  }

  async _drainCardUpdates(messageId, state) {
    state.running = true
    while (state.pending) {
      const job = state.pending
      state.pending = null
      try {
        const result = await this.api('PATCH', `/open-apis/im/v1/messages/${messageId}`, {
          msg_type: 'interactive',
          content: JSON.stringify(job.card),
        })
        for (const waiter of job.waiters) waiter.resolve(result)
      } catch (err) {
        for (const waiter of job.waiters) waiter.reject(err)
      }
      if (this.requestController.signal.aborted && state.pending) {
        const err = new Error('Feishu client stopped')
        for (const waiter of state.pending.waiters) waiter.reject(err)
        state.pending = null
      }
    }
    state.running = false
    this.cardUpdates.delete(messageId)
  }
}

function apiError(message, details = {}) {
  const err = new Error(message)
  if (Number.isFinite(Number(details.code))) err.code = Number(details.code)
  if (Number.isFinite(Number(details.status))) err.status = Number(details.status)
  return err
}

function parseRetryAfter(value) {
  if (value == null || value === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  return Math.max(0, date - Date.now())
}

/**
 * Normalize a card.action.trigger payload → {chatId, messageId, operator, action}.
 * Returns null when the shape is unexpected.
 */
function normalizeCardAction(data) {
  try {
    const operator = data?.operator?.open_id
      ? { openId: data.operator.open_id, name: data.operator.name || undefined }
      : { openId: data?.operator?.open_id || data?.operator?.user_id || '' }
    return {
      chatId: data?.chat_id || data?.context?.open_chat_id || '',
      messageId: data?.message_id || '',
      operator,
      action: {
        value: data?.action?.value ?? {},
        tag: data?.action?.tag || '',
        name: data?.action?.name || undefined,
        option: data?.action?.option || undefined,
      },
    }
  } catch {
    return null
  }
}

/**
 * Normalize an im.message.receive_v1 payload.
 * Returns null for messages we should ignore (non-text, empty).
 * @param {object} data  raw event payload
 * @param {string} botOpenId  this bot's open_id (group routing waits when it is not known yet)
 */
export function parseInbound(data, botOpenId) {
  const msg = data?.message
  if (!msg) return null
  if (msg.message_type !== 'text') return null

  let text = ''
  try {
    const content = JSON.parse(msg.content || '{}')
    text = String(content.text || '')
  } catch {
    return null
  }
  // strip @mention placeholders of anyone
  const stripped = text.replace(/@_user_\d+/g, '').trim()
  if (!stripped) return null

  const senderId = data?.sender?.sender_id?.open_id || ''
  const chatType = msg.chat_type === 'p2p' ? 'p2p' : 'group'
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : []

  // Fail closed until bot identity is known: treating any mention as ours can
  // route a group message that only mentioned another user during startup.
  const botMentioned = chatType === 'p2p'
    || (Boolean(botOpenId) && mentions.some((m) => m?.id?.open_id === botOpenId))

  return {
    messageId: msg.message_id,
    chatId: msg.chat_id,
    chatType,
    senderId,
    senderName: data?.sender?.sender_id?.name || msg.ai_info || '',
    text: stripped,
    mentions,
    botMentioned,
  }
}
