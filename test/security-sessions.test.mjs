import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AccessPolicy, MessageDeduper } from '../lib/security.js'
import { SessionManager } from '../lib/sessions.js'
import { createLarkAgentSetup } from '../lib/agent-setup.js'

test('MessageDeduper rejects retries inside TTL and accepts them after expiry', () => {
  let now = 100
  const dedupe = new MessageDeduper({ ttlMs: 50, now: () => now })
  assert.equal(dedupe.accept('om_1'), true)
  assert.equal(dedupe.accept('om_1'), false)
  now = 151
  assert.equal(dedupe.accept('om_1'), true)
  assert.equal(dedupe.accept(''), true)
})

test('AccessPolicy keeps empty lists compatible and enforces configured boundaries', () => {
  const open = new AccessPolicy()
  assert.equal(open.authorizeMessage({ chatId: 'c', senderId: 'u' }).ok, true)
  assert.equal(open.isAdmin('u'), true)
  assert.equal(open.authorizeMessage({ chatId: '', senderId: 'u' }).ok, false)
  assert.equal(open.authorizeMessage({ chatId: 'c', senderId: '' }).ok, false)

  const policy = new AccessPolicy({
    allowedUserIds: ['member'], allowedChatIds: ['chat'], adminUserIds: ['admin'],
  })
  assert.equal(policy.authorizeMessage({ chatId: 'chat', senderId: 'member' }).ok, true)
  assert.equal(policy.authorizeMessage({ chatId: 'other', senderId: 'member' }).reason, 'chat-not-allowed')
  assert.equal(policy.authorizeMessage({ chatId: 'chat', senderId: 'stranger' }).reason, 'user-not-allowed')
  assert.equal(policy.authorizeMessage({ chatId: 'chat', senderId: 'admin' }).ok, true)
  assert.equal(policy.canApprove('member', 'member'), true)
  assert.equal(policy.canApprove('member', 'someone-else'), false)
  assert.equal(policy.canApprove('admin', 'someone-else'), true)
})

test('SessionManager persists per-chat cwd and creates the next session there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-sessions-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const canonicalWorkspace = realpathSync(workspace)
  let created
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agents: {
      async create(options) {
        created = options
        return { agent: { id: options.sessionId }, async dispose() {} }
      },
    },
  }
  const sessions = new SessionManager({ ctx, dataDir: root, defaultCwd: root, workspaceRoots: [root], log() {} })

  assert.equal(sessions.setCwd('chat-1', workspace), canonicalWorkspace)
  assert.equal(sessions.cwdOf('chat-1'), canonicalWorkspace)
  await sessions.ensureAgent('chat-1')
  assert.equal(created.meta.cwd, canonicalWorkspace)
  assert.equal(JSON.parse(readFileSync(join(root, 'chat-workspaces.json'), 'utf8'))['chat-1'], canonicalWorkspace)

  assert.equal(sessions.setToolEnabled('chat-1', 'shell', false), false)
  assert.deepEqual(sessions.toolDenyOf('chat-1'), ['shell'])
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'chat-tools.json'), 'utf8'))['chat-1'], ['shell'])
  assert.equal(sessions.setToolEnabled('chat-1', 'shell', true), true)
  assert.deepEqual(sessions.toolDenyOf('chat-1'), [])
  assert.throws(() => sessions.setToolEnabled('chat-1', 'run_code', false), /保留/)

  assert.throws(() => sessions.setCwd('chat-1', '/'), /根目录/)
  assert.throws(() => sessions.setCwd('chat-1', 'relative/path'), /绝对路径/)
  assert.throws(() => sessions.setCwd('chat-1', tmpdir()), /workspaceRoots/)
  rmSync(root, { recursive: true, force: true })
})

test('agent setup applies only known scoped tool restrictions', async () => {
  const restricted = []
  const sections = []
  const services = {
    agentPresets: { async mount() { return { id: 'standard' } } },
    tools: {
      view() { return { visible: new Map([['shell', {}], ['read_file', {}], ['run_code', {}]]) } },
      restrict(filter) { restricted.push(filter) },
    },
    systemPrompt: { section(value) { sections.push(value) } },
  }
  const setup = createLarkAgentSetup({ deniedTools: ['shell', 'missing', 'run_code'], log() {} })
  await setup({ get(name) { return services[name] } })

  assert.deepEqual(restricted, [{ deny: ['shell'] }])
  assert.equal(sections.length, 1)
})
