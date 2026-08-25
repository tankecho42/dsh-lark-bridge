
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SessionManager } from '../lib/sessions.js'

function stubCtx(selection = { provider: 'global-p', model: 'global-m' }) {
  const calls = { resumes: [], creates: [] }
  const mkHandle = (id) => ({ agent: { id }, disposed: false, async dispose() { this.disposed = true } })
  const store = new Map()
  return {
    calls,
    agentDefaultModel: { currentSelection: () => selection },
    agents: {
      async create(options) {
        calls.creates.push(options)
        const h = mkHandle(String(options.sessionId))
        store.set(String(options.sessionId), h)
        return h
      },
      async resume({ resumeSessionId, agentOptions }) {
        const id = String(resumeSessionId)
        if (!store.has(id)) throw new Error('no such session')
        calls.resumes.push({ id, agentOptions })
        return store.get(id)
      },
    },
  }
}

test('per-chat model override applies at resume and persists; global default untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-chatmodel-'))
  const ctx = stubCtx()
  const sessions = new SessionManager({ ctx, dataDir: root, defaultCwd: root, log() {} })

  // no override yet → global selection
  await sessions.ensureAgent('chat-1')
  assert.deepEqual(ctx.calls.creates[0].agentOptions, { provider: 'global-p', model: 'global-m' })

  // set override → persisted, agentOptions switch, conversation mapping kept
  sessions.setChatModel('chat-1', 'chat-p', 'chat-m')
  assert.deepEqual(sessions.chatModelOf('chat-1'), { provider: 'chat-p', model: 'chat-m' })
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, 'chat-models.json'), 'utf8'))['chat-1'],
    { provider: 'chat-p', model: 'chat-m' },
  )
  const refreshed = await sessions.refreshAgent('chat-1')
  assert.equal(refreshed, true)
  await sessions.ensureAgent('chat-1')
  assert.equal(ctx.calls.resumes.length, 1)
  assert.deepEqual(ctx.calls.resumes[0].agentOptions, { provider: 'chat-p', model: 'chat-m' })

  // a second chat still follows the global default
  await sessions.ensureAgent('chat-2')
  assert.equal(ctx.calls.creates[1].agentOptions.provider, 'global-p')

  // clear override → back to global
  assert.equal(sessions.clearChatModel('chat-1'), true)
  assert.equal(sessions.clearChatModel('chat-1'), false)
  assert.equal(sessions.chatModelOf('chat-1'), null)
  await sessions.ensureAgent('chat-2') // existing handle reused, no new resume
  rmSync(root, { recursive: true, force: true })
})

test('chat model map reloads from disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-chatmodel2-'))
  const ctx = stubCtx()
  const first = new SessionManager({ ctx, dataDir: root, defaultCwd: root, log() {} })
  first.setChatModel('chat-9', 'p9', 'm9')

  const second = new SessionManager({ ctx, dataDir: root, defaultCwd: root, log() {} })
  assert.deepEqual(second.chatModelOf('chat-9'), { provider: 'p9', model: 'm9' })
  rmSync(root, { recursive: true, force: true })
})

test('setChatModel rejects empty provider/model and rolls back on persist failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-chatmodel3-'))
  const ctx = stubCtx()
  const sessions = new SessionManager({ ctx, dataDir: root, defaultCwd: root, log() {} })

  assert.throws(() => sessions.setChatModel('c', '', 'm'), /不能为空/)
  assert.throws(() => sessions.setChatModel('c', 'p', ' '), /不能为空/)
  assert.equal(sessions.chatModelOf('c'), null)

  // make the model map path unwritable to force a rollback
  const fs = await import('node:fs')
  const { join: j } = await import('node:path')
  const modelPath = j(root, 'chat-models.json')
  fs.writeFileSync(modelPath, 'x') // directory-entry occupied by a non-dir file? no — write real json then chmod dir
  fs.rmSync(modelPath)
  fs.mkdirSync(modelPath) // a DIRECTORY at the json path → writeFileSync inside fails
  assert.throws(() => sessions.setChatModel('c', 'p', 'm'))
  assert.equal(sessions.chatModelOf('c'), null)
  fs.rmSync(modelPath, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('touch records activity; expireIdle drops idle mappings but keeps live handles and explicit config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-expire-'))
  const ctx = stubCtx()
  const sessions = new SessionManager({ ctx, dataDir: root, defaultCwd: root, workspaceRoots: [root], log() {} })

  await sessions.ensureAgent('chat-1')
  sessions.touch('chat-1')
  // touch persisted a real timestamp; verify persistence, then pin a fake clock value
  const metaOnDisk = JSON.parse(readFileSync(join(root, 'chat-meta.json'), 'utf8'))
  assert.equal(Number.isFinite(metaOnDisk['chat-1']?.lastActiveAt), true)
  const activeAt = 500_000
  sessions.chatLastActive.set('chat-1', activeAt)
  let now = activeAt
  sessions.chatLastActive.set('chat-old', 1000)
  sessions.sessionIds.set('chat-old', 'lark-old')
  sessions.setChatModel('chat-old', 'p', 'm')
  sessions.setCwdSafe?.('chat-old', root)

  // first sweep: chat-old (idle long ago) expires; chat-1 is protected by its live handle
  const kept = sessions.expireIdle(60_000, { now: () => now })
  assert.deepEqual(kept, ['chat-old'])
  assert.equal(sessions.sessionIds.has('chat-1'), true)
  assert.equal(sessions.sessionIds.has('chat-old'), false)

  // drop the live handle (as refreshAgent would) → chat-1 now expires too
  await sessions.refreshAgent('chat-1')
  now = activeAt + 120_000
  const expired = sessions.expireIdle(60_000, { now: () => now })
  assert.deepEqual(expired, ['chat-1'])
  assert.equal(sessions.sessionIds.has('chat-1'), false)
  assert.equal(sessions.sessionIds.has('chat-old'), false)
  // explicit per-chat config survives expiry for re-engagement
  assert.deepEqual(sessions.chatModelOf('chat-old'), { provider: 'p', model: 'm' })
  assert.equal(sessions.chatLastActive.has('chat-old'), false)
  rmSync(root, { recursive: true, force: true })
})
