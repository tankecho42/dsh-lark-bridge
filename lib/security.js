const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000
const DEFAULT_DEDUPE_MAX = 4096

/** Retry-safe inbound event deduplication with bounded memory. */
export class MessageDeduper {
  constructor({ ttlMs = DEFAULT_DEDUPE_TTL_MS, maxEntries = DEFAULT_DEDUPE_MAX, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
    this.seen = new Map()
  }

  /** Returns true only for the first observation inside the TTL window. */
  accept(messageId) {
    const id = String(messageId || '')
    if (!id) return true
    const now = this.now()
    const previous = this.seen.get(id)
    if (previous != null && now - previous < this.ttlMs) return false
    if (previous != null) this.seen.delete(id)
    this.seen.set(id, now)
    if (this.seen.size > this.maxEntries) this.prune(now)
    return true
  }

  prune(now = this.now()) {
    for (const [id, timestamp] of this.seen) {
      if (now - timestamp >= this.ttlMs || this.seen.size > this.maxEntries) this.seen.delete(id)
      if (this.seen.size <= this.maxEntries && now - timestamp < this.ttlMs) break
    }
  }

  clear() {
    this.seen.clear()
  }
}

/** Backward-compatible allowlists: an empty list means unrestricted. */
export class AccessPolicy {
  constructor({ allowedUserIds = [], allowedChatIds = [], adminUserIds = [] } = {}) {
    this.allowedUsers = new Set(allowedUserIds.filter(Boolean).map(String))
    this.allowedChats = new Set(allowedChatIds.filter(Boolean).map(String))
    this.admins = new Set(adminUserIds.filter(Boolean).map(String))
  }

  allowsUser(userId) {
    const id = String(userId || '')
    if (!id) return false
    return this.admins.has(id) || this.allowedUsers.size === 0 || this.allowedUsers.has(id)
  }

  allowsChat(chatId) {
    const id = String(chatId || '')
    return Boolean(id) && (this.allowedChats.size === 0 || this.allowedChats.has(id))
  }

  authorizeMessage(msg) {
    if (!this.allowsChat(msg?.chatId)) return { ok: false, reason: 'chat-not-allowed' }
    if (!this.allowsUser(msg?.senderId)) return { ok: false, reason: 'user-not-allowed' }
    return { ok: true }
  }

  /** With no explicit admins configured, preserve the legacy allow-all behavior. */
  isAdmin(userId) {
    return this.admins.size === 0 ? this.allowsUser(userId) : this.admins.has(String(userId || ''))
  }

  canApprove(userId, requesterId) {
    if (!this.allowsUser(userId)) return false
    if (this.isAdmin(userId)) return true
    return !requesterId || String(userId || '') === String(requesterId)
  }
}
