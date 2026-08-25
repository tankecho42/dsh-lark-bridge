/**
 * chat → DSH agent session mapping.
 * - p2p chat: one conversation per chat (per user), persisted mapping
 * - group chat: one shared session per group, @-mention triggered
 * Resumes via ctx.agents.resume, creates via ctx.agents.create.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { join, isAbsolute, sep, parse } from 'node:path'
import { homedir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createLarkAgentSetup } from './agent-setup.js'

export class SessionManager {
  /**
   * @param {object} opts
   * @param {import('@deepseek-ai/cordis').Context} opts.ctx
   * @param {string} opts.dataDir
   * @param {string} [opts.defaultCwd]  workspace for new sessions (dsh prompt needs {{cwd}})
   * @param {(msg: string, data?: object) => void} opts.log
   */
  constructor({ ctx, dataDir, defaultCwd, workspaceRoots = [], log }) {
    this.ctx = ctx
    this.dataDir = dataDir
    this.defaultCwd = defaultCwd || process.cwd()
    this.log = log
    this.mapPath = join(dataDir, 'chat-sessions.json')
    this.workspacePath = join(dataDir, 'chat-workspaces.json')
    this.toolPolicyPath = join(dataDir, 'chat-tools.json')
    this.modelPath = join(dataDir, 'chat-models.json')
    this.metaPath = join(dataDir, 'chat-meta.json')
    this.workspaceRoots = workspaceRoots.map((root) => this._canonicalCandidate(root)).filter(Boolean)
    /** @type {Map<string, any>} chatId → live handle */
    this.handles = new Map()
    /** @type {Map<string, string>} chatId → sessionId */
    this.sessionIds = new Map()
    /** @type {Map<string, string>} chatId → persistent workspace */
    this.chatCwds = new Map()
    /** @type {Map<string, Set<string>>} chatId → disabled tool names */
    this.chatToolDeny = new Map()
    /** @type {Map<string, {provider: string, model: string}>} chatId → per-chat model override */
    this.chatModels = new Map()
    /** @type {Map<string, number>} chatId → last activity epoch ms */
    this.chatLastActive = new Map()
    /** @type {Map<string, {chatId: string, replyTo?: string, replyInThread?: boolean}>} conversation scope → outbound route */
    this.routes = new Map()
    /** @type {Map<string, string>} chatId → sender who initiated the current/latest turn */
    this.requesters = new Map()
    /** @type {Set<string>} sessions owned by this bridge */
    this.ownedSessions = new Set()
    /** @type {Map<string, Promise<any>>} in-flight creates */
    this.creating = new Map()
    this._load()
  }

  _load() {
    this._loadMap(this.mapPath, this.sessionIds, 'session map')
    this._loadMap(this.workspacePath, this.chatCwds, 'workspace map')
    if (existsSync(this.toolPolicyPath)) {
      try {
        const data = JSON.parse(readFileSync(this.toolPolicyPath, 'utf8'))
        for (const [chatId, names] of Object.entries(data || {})) {
          if (Array.isArray(names)) this.chatToolDeny.set(chatId, new Set(names.map(String).filter(Boolean)))
        }
      } catch (err) {
        this.log('tool policy map load failed', { path: this.toolPolicyPath, err: String(err?.message || err) })
      }
    }
    if (existsSync(this.modelPath)) {
      try {
        const data = JSON.parse(readFileSync(this.modelPath, 'utf8'))
        for (const [chatId, sel] of Object.entries(data || {})) {
          if (sel && typeof sel.provider === 'string' && sel.provider
            && typeof sel.model === 'string' && sel.model) {
            this.chatModels.set(chatId, { provider: sel.provider, model: sel.model })
          }
        }
      } catch (err) {
        this.log('chat model map load failed', { path: this.modelPath, err: String(err?.message || err) })
      }
    }
    if (existsSync(this.metaPath)) {
      try {
        const data = JSON.parse(readFileSync(this.metaPath, 'utf8'))
        for (const [chatId, meta] of Object.entries(data || {})) {
          const at = Number(meta?.lastActiveAt)
          if (Number.isFinite(at) && at > 0) this.chatLastActive.set(chatId, at)
        }
      } catch (err) {
        this.log('chat meta load failed', { path: this.metaPath, err: String(err?.message || err) })
      }
    }
  }

  _loadMap(path, target, label) {
    if (!existsSync(path)) return
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'))
      for (const [k, v] of Object.entries(data || {})) target.set(k, String(v))
    } catch (err) {
      this.log(`${label} load failed`, { path, err: String(err?.message || err) })
    }
  }

  _writeJsonAtomic(path, value) {
    const temporary = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
      renameSync(temporary, path)
    } catch (err) {
      try { unlinkSync(temporary) } catch { /* already absent */ }
      throw err
    }
  }

  _persist() {
    this._persistValue(this.mapPath, Object.fromEntries(this.sessionIds), 'session map')
    this._persistValue(this.workspacePath, Object.fromEntries(this.chatCwds), 'workspace map')
    this._persistValue(this.toolPolicyPath, Object.fromEntries(
      [...this.chatToolDeny].map(([chatId, names]) => [chatId, [...names].sort()]),
    ), 'tool policy map')
    this._persistValue(this.modelPath, Object.fromEntries(this.chatModels), 'chat model map')
    this._persistValue(this.metaPath, Object.fromEntries(
      [...this.chatLastActive].map(([chatId, at]) => [chatId, { lastActiveAt: at }]),
    ), 'chat meta')
  }

  _persistValue(path, value, label, required = false) {
    try {
      mkdirSync(this.dataDir, { recursive: true })
      this._writeJsonAtomic(path, value)
      return true
    } catch (err) {
      this.log(`${label} persist failed`, { path, err: String(err?.message || err) })
      if (required) throw new Error(`${label} 持久化失败：${err?.message || err}`)
      return false
    }
  }

  _canonicalCandidate(input) {
    if (!input) return ''
    const raw = String(input)
    const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
    if (!isAbsolute(expanded)) return ''
    try { return realpathSync(expanded) } catch { return expanded }
  }

  /** Validate and persist a chat-specific workspace. Returns canonical path. */
  setCwd(chatId, input) {
    const candidate = this._canonicalCandidate(input)
    if (!candidate || !isAbsolute(candidate)) throw new Error('工作目录必须是绝对路径')
    if (candidate === parse(candidate).root) throw new Error('不能把文件系统根目录设为工作目录')
    let stat
    try { stat = statSync(candidate) } catch { throw new Error(`目录不存在：${candidate}`) }
    if (!stat.isDirectory()) throw new Error(`不是目录：${candidate}`)
    if (this.workspaceRoots.length && !this.workspaceRoots.some((root) => candidate === root || candidate.startsWith(root + sep))) {
      throw new Error(`目录不在允许的 workspaceRoots 内：${candidate}`)
    }
    const key = String(chatId)
    const previous = this.chatCwds.get(key)
    this.chatCwds.set(key, candidate)
    try {
      this._persistValue(this.workspacePath, Object.fromEntries(this.chatCwds), 'workspace map', true)
    } catch (err) {
      if (previous === undefined) this.chatCwds.delete(key)
      else this.chatCwds.set(key, previous)
      throw err
    }
    return candidate
  }

  cwdOf(chatId) {
    return this.chatCwds.get(String(chatId)) || this.defaultCwd
  }

  noteRequester(chatId, senderId) {
    if (senderId) this.requesters.set(String(chatId), String(senderId))
  }

  /** Remember the physical Feishu destination for a DM/group/thread scope. */
  noteRoute(scopeId, route) {
    const key = String(scopeId)
    const chatId = String(route?.chatId || '')
    if (!key || !chatId) return
    this.routes.set(key, {
      chatId,
      ...(route?.replyTo ? { replyTo: String(route.replyTo) } : {}),
      ...(route?.replyInThread ? { replyInThread: true } : {}),
    })
  }

  routeOf(scopeId) {
    const key = String(scopeId)
    return this.routes.get(key) || { chatId: key }
  }

  /** Record activity for expiry bookkeeping (called on every inbound prompt). */
  touch(chatId) {
    const key = String(chatId)
    this.chatLastActive.set(key, Date.now())
    this._persistValue(this.metaPath, Object.fromEntries(
      [...this.chatLastActive].map(([cid, at]) => [cid, { lastActiveAt: at }]),
    ), 'chat meta')
  }

  /**
   * Drop persisted mappings for chats idle beyond ttlMs. Live handles are kept.
   * Returns the list of expired chatIds.
   */
  expireIdle(ttlMs, { now = Date.now } = {}) {
    const cutoff = now() - ttlMs
    const expired = []
    for (const [chatId, at] of this.chatLastActive.entries()) {
      if (at >= cutoff || this.handles.has(chatId)) continue
      expired.push(chatId)
    }
    if (!expired.length) return expired
    for (const chatId of expired) {
      // session mapping + activity expire; cwd/model/tool-policy are explicit
      // per-chat config and intentionally survive re-engagement
      this.sessionIds.delete(chatId)
      this.chatLastActive.delete(chatId)
      this.routes.delete(chatId)
    }
    this._persist()
    this.log('expired idle chats', { count: expired.length, ttlMs })
    return expired
  }

  requesterOfSession(sessionId) {
    const chatId = this.chatOf(String(sessionId))
    return chatId ? this.requesters.get(chatId) || '' : ''
  }

  toolDenyOf(chatId) {
    return [...(this.chatToolDeny.get(String(chatId)) || [])].sort()
  }

  /** Persist one tool toggle. run_code is a reserved presentation transport. */
  setToolEnabled(chatId, toolName, enabled) {
    const name = String(toolName || '').trim()
    if (!name) throw new Error('工具名不能为空')
    if (name === 'run_code') throw new Error('run_code 是保留传输工具，不能直接开关')
    const key = String(chatId)
    const denied = new Set(this.chatToolDeny.get(key) || [])
    if (enabled) denied.delete(name)
    else denied.add(name)
    const previous = this.chatToolDeny.get(key)
    if (denied.size) this.chatToolDeny.set(key, denied)
    else this.chatToolDeny.delete(key)
    try {
      this._persistValue(this.toolPolicyPath, Object.fromEntries(
        [...this.chatToolDeny].map(([id, names]) => [id, [...names].sort()]),
      ), 'tool policy map', true)
    } catch (err) {
      if (previous === undefined) this.chatToolDeny.delete(key)
      else this.chatToolDeny.set(key, previous)
      throw err
    }
    return !denied.has(name)
  }

  /** Per-chat model override; null when the chat follows the global default. */
  chatModelOf(chatId) {
    return this.chatModels.get(String(chatId)) || null
  }

  /** Persist a per-chat model override (does not touch the global default). */
  setChatModel(chatId, provider, model) {
    const p = String(provider || '').trim()
    const m = String(model || '').trim()
    if (!p || !m) throw new Error('provider 和 model 都不能为空')
    const key = String(chatId)
    const previous = this.chatModels.get(key)
    this.chatModels.set(key, { provider: p, model: m })
    try {
      this._persistValue(this.modelPath, Object.fromEntries(this.chatModels), 'chat model map', true)
    } catch (err) {
      if (previous === undefined) this.chatModels.delete(key)
      else this.chatModels.set(key, previous)
      throw err
    }
    return { provider: p, model: m }
  }

  /** Drop a chat's model override; returns true when one was removed. */
  clearChatModel(chatId) {
    const key = String(chatId)
    if (!this.chatModels.has(key)) return false
    const previous = this.chatModels.get(key)
    this.chatModels.delete(key)
    try {
      this._persistValue(this.modelPath, Object.fromEntries(this.chatModels), 'chat model map', true)
    } catch (err) {
      this.chatModels.set(key, previous)
      throw err
    }
    return true
  }

  /**
   * agentOptions for a chat: per-chat model override first, then the dsh
   * default-model selection (like wechat-bridge).
   */
  _agentOptions(chatId) {
    const override = this.chatModelOf(chatId)
    const selection = override || this.ctx.agentDefaultModel?.currentSelection?.()
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
      const agentOptions = this._agentOptions(chatId)
      const setup = createLarkAgentSetup({ log: this.log, deniedTools: this.toolDenyOf(chatId) })
      let handle
      let sid = this.sessionIds.get(chatId)

      if (sid) {
        try {
          handle = await this.ctx.agents.resume({
            resumeSessionId: SessionId(sid),
            agentOptions,
            setup,
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
          meta: { cwd: cwd || this.cwdOf(chatId) },
          agentOptions,
          setup,
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
  async prompt(chatId, text, { cwd, images = [] } = {}) {
    const handle = await this.ensureAgent(chatId, { cwd })
    this.touch(chatId)
    const content = []
    if (String(text || '').trim()) content.push({ type: 'text', text: String(text) })
    for (const attachment of images) content.push({ type: 'image', attachment })
    if (!content.length) throw new Error('消息没有可投递的文本或图片内容')
    handle.agent.followup(createUserMessage({
      source: { kind: 'user' },
      content,
    }))
    return String(handle.agent.id)
  }

  /** stop the active turn; returns true when a live handle was cancelled */
  stop(chatId) {
    const handle = this.handles.get(chatId)
    if (handle) {
      handle.agent.cancel({ kind: 'user' })
      return true
    }
    return false
  }

  /**
   * Drop the live handle but keep the persisted session mapping, so the next
   * prompt re-resumes the same conversation under fresh agentOptions (e.g. a
   * newly selected model). Returns true when a live handle was disposed.
   */
  async refreshAgent(chatId) {
    const key = String(chatId)
    const handle = this.handles.get(key)
    if (!handle) return false
    this.handles.delete(key)
    try {
      await handle.dispose()
    } catch (err) {
      this.log('session dispose failed during refresh', { chatId: key, err: String(err?.message || err) })
    }
    return true
  }

  /** new session for a chat */
  async reset(chatId, { cwd } = {}) {
    if (cwd) this.setCwd(chatId, cwd)
    const old = this.handles.get(chatId)
    if (old) {
      this.handles.delete(chatId)
      try {
        await old.dispose()
      } catch (err) {
        this.log('old session dispose failed during reset', { chatId, err: String(err?.message || err) })
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
      Promise.resolve(handle.dispose?.()).catch((err) => {
        this.log('session dispose failed', { err: String(err?.message || err) })
      })
    }
    this.handles.clear()
    this.requesters.clear()
    this.routes.clear()
  }
}
