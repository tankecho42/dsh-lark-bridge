/**
 * Feishu WS client — long-connection event subscription + message send.
 * Built on @larksuiteoapi/node-sdk (official SDK).
 *
 * Inbound:  im.message.receive_v1  →  normalized InboundMessage
 * Outbound: im/v1/messages (text / reply)
 */
import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk'

const FEISHU_BASE = 'https://open.feishu.cn'

export class FeishuClient {
  /**
   * @param {object} opts
   * @param {string} opts.appId
   * @param {string} opts.appSecret
   * @param {(msg: object) => void} opts.onMessage
   * @param {(err: Error) => void} [opts.onError]
   * @param {(info: object) => void} [opts.onStatus]
   */
  constructor(opts) {
    this.appId = opts.appId
    this.appSecret = opts.appSecret
    this.onMessage = opts.onMessage
    this.onError = opts.onError || (() => {})
    this.onStatus = opts.onStatus || (() => {})
    this.ws = null
    this.token = ''
    this.tokenExpireAt = 0
    this.started = false
    this.botOpenId = ''
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
    const res = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    const data = await res.json()
    if (data.code !== 0) throw new Error(`tenant_access_token failed: ${data.code} ${data.msg}`)
    this.token = data.tenant_access_token
    this.tokenExpireAt = now + (data.expire || 7200) * 1000
    return this.token
  }

  async api(method, path, body) {
    const token = await this.getToken()
    const res = await fetch(`${FEISHU_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json()
    if (data.code !== 0) {
      const err = new Error(`feishu api ${method} ${path} -> ${data.code} ${data.msg}`)
      err.code = data.code
      throw err
    }
    return data.data
  }

  // ---- WS long connection ----
  start() {
    if (this.started) return
    this.started = true
    void this.loadBotInfo()

    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const inbound = parseInbound(data, this.botOpenId)
          if (inbound) this.onMessage(inbound)
        } catch (err) {
          this.onError(err)
        }
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
      .then(() => this.onStatus({ type: 'ws-started' }))
      .catch((err) => {
        this.started = false
        this.onError(err)
      })
    this.onStatus({ type: 'ws-start' })
  }

  // ---- outbound ----
  /**
   * Send a text message. If replyTo given, send as a reply to that message id.
   * @returns {Promise<string>} message_id of the sent message
   */
  async sendText(chatId, text, replyTo) {
    const body = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }
    let path = `/open-apis/im/v1/messages?receive_id_type=chat_id`
    if (replyTo) path = `/open-apis/im/v1/messages/${replyTo}/reply`
    const data = await this.api('POST', path, body)
    return data?.message_id || ''
  }
}

/**
 * Normalize an im.message.receive_v1 payload.
 * Returns null for messages we should ignore (non-text, empty).
 * @param {object} data  raw event payload
 * @param {string} botOpenId  this bot's open_id (may be '' early; then any mention counts)
 */
function parseInbound(data, botOpenId) {
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

  // exact bot mention when we know our open_id; otherwise any mention counts
  const botMentioned = chatType === 'p2p'
    || (botOpenId
      ? mentions.some((m) => m?.id?.open_id === botOpenId)
      : mentions.length > 0)

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
