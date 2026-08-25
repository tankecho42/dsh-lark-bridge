import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FeishuClient } from '../lib/feishu.js'
import { createFileLogger } from '../lib/logger.js'

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  })
}

function transportClient(fetchImpl, extra = {}) {
  const client = new FeishuClient({
    appId: 'cli_test',
    appSecret: 'secret',
    onMessage() {},
    fetchImpl,
    sleep: extra.sleep || (async () => {}),
    random: () => 0,
    onStatus: extra.onStatus,
  })
  client.token = 'cached-token'
  client.tokenExpireAt = Date.now() + 600_000
  return client
}

test('Feishu API retries documented rate-limit responses and honors Retry-After', async () => {
  const waits = []
  const statuses = []
  let calls = 0
  const client = transportClient(async () => {
    calls++
    if (calls === 1) {
      return jsonResponse({ code: 99991400, msg: 'rate limited' }, {
        status: 400,
        headers: { 'retry-after': '1' },
      })
    }
    return jsonResponse({ code: 0, data: { ok: true } })
  }, {
    sleep: async (ms) => { waits.push(ms) },
    onStatus: (info) => statuses.push(info),
  })

  const result = await client.api('GET', '/open-apis/test')

  assert.deepEqual(result, { ok: true })
  assert.equal(calls, 2)
  assert.deepEqual(waits, [1000])
  assert.equal(statuses[0]?.type, 'api-retry')
  assert.equal(statuses[0]?.code, 99991400)
  assert.equal(client.diagnostics().retries, 1)
})

test('terminal HTTP-200 Feishu API errors count as failures', async () => {
  const client = transportClient(async () => jsonResponse({ code: 230001, msg: 'permission denied' }))

  await assert.rejects(client.api('GET', '/open-apis/denied'), /230001/)

  assert.equal(client.diagnostics().apiFailures, 1)
})

test('outbound message retries are idempotent through one stable uuid', async () => {
  const bodies = []
  let calls = 0
  const client = transportClient(async (_url, init) => {
    calls++
    bodies.push(JSON.parse(init.body))
    if (calls === 1) return jsonResponse({ code: 1, msg: 'temporary' }, { status: 503 })
    return jsonResponse({ code: 0, data: { message_id: 'om_ok' } })
  })

  const messageId = await client.sendText('oc_test', 'hello')

  assert.equal(messageId, 'om_ok')
  assert.equal(calls, 2)
  assert.ok(bodies[0].uuid)
  assert.equal(bodies[0].uuid, bodies[1].uuid)
  assert.equal(bodies[0].receive_id, 'oc_test')
})

test('reply payload uses Feishu reply schema and carries an idempotency uuid', async () => {
  let body
  const client = transportClient(async (_url, init) => {
    body = JSON.parse(init.body)
    return jsonResponse({ code: 0, data: { message_id: 'om_reply' } })
  })

  await client.sendText('oc_unused', 'hello', 'om_parent')

  assert.ok(body.uuid)
  assert.equal(body.receive_id, undefined)
})

test('thread reply payload opts into reply_in_thread', async () => {
  let body
  const client = transportClient(async (_url, init) => {
    body = JSON.parse(init.body)
    return jsonResponse({ code: 0, data: { message_id: 'om_thread_reply' } })
  })

  await client.sendCard('oc_unused', { schema: '2.0' }, 'om_parent', { replyInThread: true })

  assert.equal(body.receive_id, undefined)
  assert.equal(body.reply_in_thread, true)
})

test('resource download retries Feishu rate-limit codes and bounds the error body', async () => {
  const waits = []
  const statuses = []
  let calls = 0
  const client = transportClient(async () => {
    calls++
    if (calls === 1) {
      return jsonResponse({ code: 99991400, msg: 'rate limited' }, {
        status: 400,
        headers: { 'retry-after': '1' },
      })
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="ok.bin"' },
    })
  }, {
    sleep: async (ms) => waits.push(ms),
    onStatus: (info) => statuses.push(info),
  })

  const result = await client.downloadResource('om_test', 'file_test', 'file', { maxBytes: 10 })

  assert.equal(calls, 2)
  assert.deepEqual(waits, [1000])
  assert.equal(statuses[0]?.code, 99991400)
  assert.equal(result.fileName, 'ok.bin')
  assert.deepEqual([...result.data], [1, 2, 3])
})

test('WebSocket simulator exposes disconnect and recovery transitions', async () => {
  const statuses = []
  const errors = []
  let hooks
  let state = 'idle'
  const ws = {
    start() { state = 'connecting'; return Promise.resolve() },
    close() { state = 'idle' },
    getConnectionStatus() { return { state, reconnectAttempts: state === 'reconnecting' ? 1 : 0 } },
  }
  const client = new FeishuClient({
    appId: 'cli_0000000000000000',
    appSecret: 'secret',
    onMessage() {},
    onError(err) { errors.push(err) },
    onStatus(info) { statuses.push(info.type) },
    wsFactory(params) { hooks = params; return ws },
  })
  client.loadBotInfo = async () => null

  client.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(client.connectionStatus(), 'connecting')

  state = 'connected'
  hooks.onReady()
  assert.equal(client.connectionStatus(), 'connected')

  state = 'reconnecting'
  hooks.onReconnecting()
  assert.equal(client.connectionStatus(), 'reconnecting')

  state = 'connected'
  hooks.onReconnected()
  hooks.onError(new Error('terminal disconnect'))

  assert.deepEqual(statuses, ['ws-start', 'ws-started', 'ws-ready', 'ws-reconnecting', 'ws-reconnected', 'ws-failed'])
  assert.match(errors[0]?.message || '', /terminal disconnect/)
  assert.equal(client.diagnostics().wsReconnects, 1)
  assert.equal(client.diagnostics().wsFailures, 1)
  client.stop()
})

test('same-message card updates are serialized and queued states are coalesced', async () => {
  const client = transportClient(async () => jsonResponse({ code: 0, data: {} }))
  const revisions = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  client.api = async (_method, _path, body) => {
    const card = JSON.parse(body.content)
    revisions.push(card.revision)
    if (card.revision === 1) await firstGate
    return { revision: card.revision }
  }

  const first = client.updateCard('om_card', { revision: 1 })
  const second = client.updateCard('om_card', { revision: 2 })
  const third = client.updateCard('om_card', { revision: 3 })
  assert.deepEqual(revisions, [1])

  releaseFirst()
  const results = await Promise.all([first, second, third])

  assert.deepEqual(revisions, [1, 3])
  assert.deepEqual(results.map((value) => value.revision), [1, 3, 3])
  assert.equal(client.diagnostics().coalescedCardUpdates, 1)
  assert.equal(client.cardUpdates.size, 0)
})

test('stop aborts an in-flight API request instead of retrying it', async () => {
  let fetchStarted
  const started = new Promise((resolve) => { fetchStarted = resolve })
  const client = transportClient(async (_url, init) => {
    fetchStarted()
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  })

  const request = client.api('GET', '/open-apis/slow')
  await started
  client.stop()

  await assert.rejects(request, /Feishu client stopped/)
  assert.equal(client.diagnostics().retries, 0)
})

test('file logger rotates bounded backups without interrupting writes', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-lark-log-'))
  try {
    const log = createFileLogger({ dataDir, maxBytes: 64 * 1024, backups: 2 })
    log('first', { payload: 'a'.repeat(40_000) })
    log('second', { payload: 'b'.repeat(40_000) })
    log('third', { payload: 'c'.repeat(40_000) })

    assert.equal(existsSync(log.path), true)
    assert.equal(existsSync(`${log.path}.1`), true)
    assert.equal(existsSync(`${log.path}.2`), true)
    assert.match(readFileSync(log.path, 'utf8'), /third/)
    assert.match(readFileSync(`${log.path}.1`, 'utf8'), /second/)
    assert.match(readFileSync(`${log.path}.2`, 'utf8'), /first/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
