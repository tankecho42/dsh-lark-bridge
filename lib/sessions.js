/**
 * chat → DSH agent session mapping.
 * - p2p chat: one conversation per chat (per user), persisted mapping
 * - group chat: one shared session per group, @-mention triggered
 * Resumes via ctx.agents.resume, creates via ctx.agents.create.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export class SessionManager {
  /**
   * @param {object} opts
   * @param {import('@deepseek-ai/cordis').Context} opts.ctx
   * @param {string} opts.dataDir
   * @param {string} [opts.defaultCwd]  workspace for new sessions (dsh prompt needs {{cwd}})
   * @param {(msg: string, data?: object) => void} opts.log
   */
  constructor({ ctx, dataDir, defaultCwd, log }) {
    this.ctx = ctx
    this.dataDir = dataDir
    this.defaultCwd = defaultCwd || process.cwd()
    this.log = log
    this.mapPath = join(dataDir, 'chat-sessions.json')
    /** @type {Map<string, any>} chatId → live handle */
    this.handles = new Map()
    /** @type {Map<string, string>} chatId → sessionId */
    this.sessionIds = new Map()
    /** @type {Set<string>} sessions owned by this bridge */
    this.ownedSessions = new Set()
    /** @type {Map<string, Promise<any>>} in-flight creates */
    this.creating = new Map()
    this._load()
  }

  _load() {
    try {
      if (existsSync(this.mapPath)) {
        const data = JSON.parse(readFileSync(this.mapPath, 'utf8'))
        for (const [k, v] of Object.entries(data || {})) this.sessionIds.set(k, String(v))
      }
    } catch {
      /* start fresh */
    }
  }

  _persist() {
    try {
      mkdirSync(this.dataDir, { recursive: true })
      const obj = Object.fromEntries(this.sessionIds)
      writeFileSync(this.mapPath, JSON.stringify(obj, null, 2), 'utf8')
    } catch {
      /* persistence best-effort */
    }
  }

  /** agentOptions derived from the dsh default-model selection (like wechat-bridge). */
  _agentOptions() {
    const selection = this.ctx.agentDefaultModel?.currentSelection?.()
    const provider = selection?.provider
    const model = selection?.model
    return {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    }
  }

  async ensureAgent(chatId, { cwd } = {}) {
    const existing = this.handles.get(chatId)
    if (existing) return existing
    const inflight = this.creating.get(chatId)
    if (inflight) return inflight

    const task = (async () => {
      const agentOptions = this._agentOptions()
      let handle
      let sid = this.sessionIds.get(chatId)

      if (sid) {
        try {
          handle = await this.ctx.agents.resume({
            resumeSessionId: SessionId(sid),
            agentOptions,
          })
          this.log('resumed', { chatId, sid })
        } catch (err) {
          this.log('resume failed, will create', { chatId, sid, err: String(err?.message || err) })
          handle = undefined
        }
      }

      if (!handle) {
        sid = `lark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        handle = await this.ctx.agents.create({
          sessionId: SessionId(sid),
          meta: { cwd: cwd || this.defaultCwd },
          agentOptions,
        })
        this.log('created', { chatId, sid })
      }

      this.handles.set(chatId, handle)
      this.sessionIds.set(chatId, String(handle.agent.id))
      this.ownedSessions.add(String(handle.agent.id))
      this._persist()
      return handle
    })()

    this.creating.set(chatId, task)
    try {
      return await task
    } finally {
      this.creating.delete(chatId)
    }
  }

  /** Send user text into the agent (fire-and-forget; replies arrive via session/event). */
  async prompt(chatId, text, { cwd } = {}) {
    const handle = await this.ensureAgent(chatId, { cwd })
    handle.agent.followup(createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    }))
    return String(handle.agent.id)
  }

  /** stop the active turn */
  stop(chatId) {
    const handle = this.handles.get(chatId)
    if (handle) handle.agent.cancel({ kind: 'user' })
  }

  /** new session for a chat */
  async reset(chatId, { cwd } = {}) {
    const old = this.handles.get(chatId)
    if (old) {
      this.handles.delete(chatId)
      try {
        await old.dispose()
      } catch {
        /* ignore */
      }
    }
    this.sessionIds.delete(chatId)
    this._persist()
    return this.ensureAgent(chatId, { cwd })
  }

  /** chatId of a session (reverse lookup) */
  chatOf(sessionKey) {
    for (const [chatId, sid] of this.sessionIds.entries()) {
      if (sid === sessionKey) return chatId
    }
    return null
  }

  dispose() {
    for (const [, handle] of this.handles) {
      Promise.resolve(handle.dispose?.()).catch(() => {})
    }
    this.handles.clear()
  }
}
