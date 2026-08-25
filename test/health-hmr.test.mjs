import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, Config } from '../lib/index.js'

function createContext() {
  let dispose
  const ctx = {
    tools: { register() {} },
    agents: {},
    agentDefaultModel: { currentSelection: () => ({}) },
    attachments: { async saveImages() { return [] } },
    get(name) {
      if (name === 'attachments') return this.attachments
      throw new Error(`service unavailable in simulator: ${name}`)
    },
    effect(fn) { dispose = fn(); return dispose },
    on() {},
    logger: { info() {}, warn() {} },
  }
  return { ctx, dispose: () => dispose?.() }
}

async function waitForRecord(path, previousOwner = '') {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'))
      if (record.port > 0 && record.owner && record.owner !== previousOwner) return record
    } catch { /* server has not published discovery yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('health discovery record did not appear')
}

test('health endpoints fail closed and an old HMR disposer preserves the new discovery record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-hmr-'))
  const endpointPath = join(root, 'health-endpoint.json')
  const first = createContext()
  const second = createContext()
  try {
    apply(first.ctx, Config({ dataDir: root, autoStart: false }))
    const firstRecord = await waitForRecord(endpointPath)

    apply(second.ctx, Config({ dataDir: root, autoStart: false }))
    const secondRecord = await waitForRecord(endpointPath, firstRecord.owner)
    assert.notEqual(firstRecord.owner, secondRecord.owner)

    const health = await fetch(`http://${secondRecord.host}:${secondRecord.port}/healthz`)
    assert.equal(health.status, 200)
    const ready = await fetch(`http://${secondRecord.host}:${secondRecord.port}/readyz`)
    assert.equal(ready.status, 503)
    const metrics = await fetch(`http://${secondRecord.host}:${secondRecord.port}/metrics`)
    assert.match(await metrics.text(), /dsh_lark_bridge_ready 0/)

    first.dispose()
    assert.equal(existsSync(endpointPath), true)
    assert.equal(JSON.parse(readFileSync(endpointPath, 'utf8')).owner, secondRecord.owner)

    second.dispose()
    assert.equal(existsSync(endpointPath), false)
  } finally {
    first.dispose()
    second.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
