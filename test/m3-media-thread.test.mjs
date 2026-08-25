import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { FeishuClient, parseInbound } from '../lib/feishu.js'
import { InboundMediaStore, sanitizeFilename } from '../lib/media.js'
import { SessionManager } from '../lib/sessions.js'
import { createDshSimulator, createFeishuResourceSimulator, pngFixture } from './simulators.mjs'

function resourceClient(resources) {
  const simulator = createFeishuResourceSimulator(resources)
  const client = new FeishuClient({
    appId: 'cli_test', appSecret: 'secret', onMessage() {}, fetchImpl: simulator.fetchImpl,
  })
  client.token = 'cached-token'
  client.tokenExpireAt = Date.now() + 600_000
  return { client, simulator }
}

test('Feishu post image flows through safe admission into an isolated thread session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-m3-thread-'))
  try {
    const event = {
      sender: { sender_id: { open_id: 'ou_sender' } },
      message: {
        message_id: 'om_thread_message', chat_id: 'oc_group', chat_type: 'group',
        message_type: 'post', thread_id: 'omt_thread', root_id: 'om_root',
        content: JSON.stringify({
          zh_cn: {
            title: 'request',
            content: [[
              { tag: 'text', text: '@_user_1 inspect this' },
              { tag: 'img', image_key: 'img_thread' },
            ]],
          },
        }),
        mentions: [{ id: { open_id: 'ou_bot' } }],
      },
    }
    const inbound = parseInbound(event, 'ou_bot')
    assert.equal(inbound.scopeId, 'oc_group#thread:omt_thread')
    assert.equal(inbound.replyTo, 'om_thread_message')
    assert.equal(inbound.replyInThread, true)
    assert.equal(inbound.text, 'request\ninspect this')
    assert.deepEqual(inbound.attachments, [{ kind: 'image', fileKey: 'img_thread', resourceType: 'image' }])

    const dsh = createDshSimulator(root)
    const { client, simulator } = resourceClient({
      img_thread: { data: pngFixture(), mediaType: 'image/png', fileName: 'screen.png' },
    })
    const media = new InboundMediaStore({ dataDir: root, attachments: dsh.ctx.attachments, log() {} })
    const prepared = await media.prepare(inbound, client)
    const sessions = new SessionManager({ ctx: dsh.ctx, dataDir: root, defaultCwd: root, log() {} })
    sessions.noteRoute(inbound.scopeId, {
      chatId: inbound.chatId, replyTo: inbound.replyTo, replyInThread: inbound.replyInThread,
    })
    await sessions.prompt(inbound.scopeId, prepared.text, { images: prepared.images })
    await sessions.prompt('oc_group', 'group-level conversation')

    assert.equal(simulator.calls.length, 1)
    assert.equal(dsh.calls.images.length, 1)
    assert.equal(dsh.calls.creates.length, 2)
    assert.deepEqual(sessions.routeOf(inbound.scopeId), {
      chatId: 'oc_group', replyTo: 'om_thread_message', replyInThread: true,
    })
    const content = dsh.calls.prompts[0].message.content
    assert.equal(content[0].type, 'text')
    assert.match(content[0].text, /inspect this/)
    assert.equal(content[1].type, 'image')
    assert.equal(content[1].attachment.mediaType, 'image/png')
    sessions.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generic files are path-sanitized, owner-only, extension-gated, and retained for a bounded time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-m3-file-'))
  try {
    assert.equal(sanitizeFilename('../../notes.txt'), '_.._notes.txt')
    const { client } = resourceClient({
      file_safe: { data: new TextEncoder().encode('hello'), mediaType: 'text/plain', fileName: '../../notes.txt' },
      file_bad: { data: new Uint8Array([0, 1, 2]), mediaType: 'application/octet-stream', fileName: 'payload.exe' },
    })
    const media = new InboundMediaStore({
      dataDir: root, attachments: null, allowedExtensions: ['.txt'], retentionDays: 1, log() {},
    })
    const safe = await media.prepare({
      messageId: 'om_file', chatId: 'oc_dm', scopeId: 'oc_dm', text: '',
      attachments: [{ kind: 'file', fileKey: 'file_safe', fileName: '../../notes.txt', resourceType: 'file' }],
    }, client)

    assert.equal(safe.files.length, 1)
    assert.equal(resolve(safe.files[0].path).startsWith(resolve(join(root, 'inbound-media')) + '/'), true)
    assert.equal(existsSync(safe.files[0].path), true)
    assert.equal(statSync(safe.files[0].path).mode & 0o777, 0o600)
    assert.match(safe.text, /不要执行/)

    await assert.rejects(media.prepare({
      messageId: 'om_bad', chatId: 'oc_dm', scopeId: 'oc_dm', text: '',
      attachments: [{ kind: 'file', fileKey: 'file_bad', fileName: 'payload.exe', resourceType: 'file' }],
    }, client), /不在允许列表/)

    const removed = media.cleanup({ now: () => Date.now() + 2 * 24 * 3600 * 1000 })
    assert.equal(removed, 1)
    assert.deepEqual(readdirSync(join(root, 'inbound-media')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('declared resource size is rejected before buffering', async () => {
  const { client, simulator } = resourceClient({
    file_large: {
      data: new Uint8Array([1, 2, 3]), declaredBytes: 1024,
      mediaType: 'application/octet-stream', fileName: 'large.bin',
    },
  })

  await assert.rejects(
    client.downloadResource('om_large', 'file_large', 'file', { maxBytes: 10 }),
    /超过大小限制/,
  )
  assert.equal(simulator.calls.length, 1)
  assert.equal(client.diagnostics().resourceDownloads, 0)
})

test('actual streamed resource size is rejected when Content-Length understates the body', async () => {
  const { client } = resourceClient({
    file_large: {
      data: new Uint8Array(32), declaredBytes: 1,
      mediaType: 'application/octet-stream', fileName: 'large.bin',
    },
  })

  await assert.rejects(
    client.downloadResource('om_large_stream', 'file_large', 'file', { maxBytes: 10 }),
    /超过大小限制/,
  )
  assert.equal(client.diagnostics().resourceDownloads, 0)
})

test('Feishu voice without a filename keeps the OPUS fallback and owner-only mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-m3-audio-'))
  try {
    const { client } = resourceClient({
      voice_key: { data: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), mediaType: 'application/octet-stream' },
    })
    const media = new InboundMediaStore({ dataDir: root, attachments: null, log() {} })
    const prepared = await media.prepare({
      messageId: 'om_voice', chatId: 'oc_dm', scopeId: 'oc_dm', text: '',
      attachments: [{ kind: 'audio', fileKey: 'voice_key', resourceType: 'file' }],
    }, client)

    assert.equal(prepared.files[0].name, 'audio-1.opus')
    assert.equal(statSync(prepared.files[0].path).mode & 0o777, 0o600)
    assert.match(prepared.text, /语音\/音频/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
