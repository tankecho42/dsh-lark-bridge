import test from 'node:test'
import assert from 'node:assert/strict'

import { FeishuClient, parseInbound } from '../lib/feishu.js'
import { ApprovalBridge } from '../lib/approval.js'

test('FeishuClient.stop force-closes WS and is idempotent', () => {
  const statuses = []
  const client = new FeishuClient({
    appId: 'cli_0000000000000000',
    appSecret: 'secret',
    onMessage() {},
    onStatus(info) { statuses.push(info.type) },
  })
  const closeArgs = []
  client.ws = { close(args) { closeArgs.push(args) } }
  client.started = true
  const oldGeneration = client.generation

  client.stop()
  client.stop()

  assert.equal(client.started, false)
  assert.equal(client.ws, null)
  assert.equal(client.generation, oldGeneration + 1)
  assert.deepEqual(closeArgs, [{ force: true }])
  assert.deepEqual(statuses, ['ws-stop'])
  assert.equal(client.connectionStatus(), 'stopped')
})

test('group mention routing fails closed until bot identity is known', () => {
  const event = {
    sender: { sender_id: { open_id: 'ou_sender' } },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 hello' }),
      mentions: [{ id: { open_id: 'ou_someone_else' } }],
    },
  }
  assert.equal(parseInbound(event, '')?.botMentioned, false)
  assert.equal(parseInbound(event, 'ou_bot')?.botMentioned, false)
  event.message.mentions.push({ id: { open_id: 'ou_bot' } })
  assert.equal(parseInbound(event, 'ou_bot')?.botMentioned, true)
})

function approvalFixture() {
  const updates = []
  const bridge = new ApprovalBridge({
    webUrl: 'http://127.0.0.1:3080',
    feishu: {
      async sendCard() { return 'card-1' },
      async updateCard(_id, card) { updates.push(card) },
    },
    sessions: {
      chatOf(sessionId) { return sessionId === 'session-1' ? 'chat-1' : '' },
    },
    log() {},
  })
  return { bridge, updates }
}

test('rejected approval does not start a continuation card', async () => {
  const { bridge } = approvalFixture()
  const continued = []
  bridge.onApprovalResolved = (...args) => continued.push(args)
  bridge._respond = async () => true
  bridge.pending.set('rpc-1', {
    rpcId: 'rpc-1', sessionId: 'session-1', approvalId: 'approval-1',
    toolName: 'shell', cardMessageId: '', timer: null,
  })

  const result = await bridge.resolve('rpc-1', 'rejected')

  assert.equal(result.text, '已拒绝')
  assert.deepEqual(continued, [])
  assert.equal(bridge.pending.has('rpc-1'), false)
})

test('explicit allow starts one continuation and session grant is remembered', async () => {
  const { bridge } = approvalFixture()
  const continued = []
  const outcomes = []
  bridge.onApprovalResolved = (...args) => continued.push(args)
  bridge._respond = async (_entry, outcome) => { outcomes.push(outcome); return true }
  bridge.pending.set('rpc-1', {
    rpcId: 'rpc-1', sessionId: 'session-1', approvalId: 'approval-1',
    toolName: 'shell', cardMessageId: '', timer: null,
  })

  const result = await bridge.resolve('rpc-1', 'allowed-session')

  assert.equal(result.text, '已允许')
  assert.deepEqual(outcomes, ['allowed-once'])
  assert.deepEqual(continued, [['session-1', 'allowed-once']])
  assert.equal(bridge.autoAllow.has('session-1\u0000shell'), true)
})

test('auto-allow keeps the current live card instead of creating a continuation', async () => {
  const { bridge } = approvalFixture()
  const continued = []
  const outcomes = []
  bridge.onApprovalResolved = (...args) => continued.push(args)
  bridge._respond = async (_entry, outcome) => { outcomes.push(outcome); return true }
  bridge.autoAllow.add('session-1\u0000shell')

  await bridge._onApprovalRequested({
    rpcId: 'rpc-2',
    payload: { sessionId: 'session-1', approvalId: 'approval-2', toolName: 'shell' },
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(outcomes, ['allowed-once'])
  assert.deepEqual(continued, [])
  assert.equal(bridge.pending.has('rpc-2'), false)
})

test('failed approval response remains pending for retry', async () => {
  const { bridge } = approvalFixture()
  bridge._respond = async () => false
  bridge.pending.set('rpc-1', {
    rpcId: 'rpc-1', sessionId: 'session-1', approvalId: 'approval-1',
    toolName: 'shell', cardMessageId: '', timer: null,
  })

  const result = await bridge.resolve('rpc-1', 'allowed-once')

  assert.match(result.text, /重试/)
  assert.equal(bridge.pending.has('rpc-1'), true)
  clearTimeout(bridge.pending.get('rpc-1').timer)
})

test('approval card failure falls back to text and still seals the live card', async () => {
  const sentText = []
  const sealed = []
  const bridge = new ApprovalBridge({
    webUrl: 'http://127.0.0.1:3080',
    feishu: {
      async sendCard() { throw new Error('card unavailable') },
      async sendText(_chatId, message) { sentText.push(message) },
      async updateCard() {},
    },
    sessions: { chatOf: () => 'chat-1' },
    log() {},
  })
  bridge.onApprovalCardSent = (sessionId) => sealed.push(sessionId)
  bridge._respond = async () => { throw new Error('should not reject when text fallback worked') }

  await bridge._onApprovalRequested({
    rpcId: 'rpc-fallback',
    payload: { sessionId: 'session-1', approvalId: 'approval-1', toolName: 'shell', reason: 'run a command' },
  })

  assert.equal(sentText.length, 1)
  assert.match(sentText[0], /允许.*拒绝/)
  assert.deepEqual(sealed, ['session-1'])
  assert.equal(bridge.pending.has('rpc-fallback'), true)
  clearTimeout(bridge.pending.get('rpc-fallback').timer)
})

test('ApprovalBridge normalizes HTTP endpoints and rejects unsafe protocols', () => {
  const { bridge } = approvalFixture()
  assert.equal(bridge.eventsUrl, 'ws://127.0.0.1:3080/api/events.mux')
  assert.equal(bridge.respondUrl, 'http://127.0.0.1:3080/api/respond')
  assert.throws(() => new ApprovalBridge({
    webUrl: 'file:///tmp/socket', feishu: {}, sessions: {}, log() {},
  }), /http or https/)
})
