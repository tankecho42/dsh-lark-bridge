import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectLiveProfile } from '../scripts/release-gate.mjs'

const PACKAGE_NAME = '@tankecho42/dsh-lark-bridge'

function makeProfile(root, spec) {
  const profile = join(root, 'profile')
  const installed = join(profile, 'node_modules', '@tankecho42', 'dsh-lark-bridge')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { [PACKAGE_NAME]: spec } }))
  writeFileSync(join(profile, 'pnpm-lock.yaml'), `importers:\n  .:\n    dependencies:\n      '${PACKAGE_NAME}':\n        specifier: ${spec}\n`)
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.4.0' }))
  return profile
}

test('release gate rejects a live profile linked to a mutable development tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-link-'))
  try {
    const profile = makeProfile(root, 'link:/tmp/dsh-lark-bridge')
    await assert.rejects(inspectLiveProfile({ profileDir: profile }), /mutable dependency rejected/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release gate accepts an exact registry version with a profile-local install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-exact-'))
  try {
    const profile = makeProfile(root, '0.4.0')
    const result = await inspectLiveProfile({ profileDir: profile })
    assert.equal(result.ok, true)
    assert.equal(result.source.mode, 'registry')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release gate requires and verifies SHA-256 for a local tarball', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-tarball-'))
  try {
    const artifact = join(root, 'bridge.tgz')
    writeFileSync(artifact, 'immutable release artifact')
    const profile = makeProfile(root, 'file:../bridge.tgz')
    const digest = createHash('sha256').update('immutable release artifact').digest('hex')
    await assert.rejects(inspectLiveProfile({ profileDir: profile }), /requires --artifact-sha256/)
    await assert.rejects(inspectLiveProfile({ profileDir: profile, artifactSha256: '0'.repeat(64) }), /SHA-256 mismatch/)
    const result = await inspectLiveProfile({ profileDir: profile, artifactSha256: digest })
    assert.equal(result.source.mode, 'tarball')
    assert.equal(result.source.artifactSha256, digest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release gate verifies the running pid, readiness, and self-reported bridge version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-health-'))
  const server = createServer((req, res) => {
    const ready = req.url === '/readyz'
    const found = ready || req.url === '/healthz'
    res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(found
      ? { ok: true, plugin: PACKAGE_NAME, version: '0.4.0' }
      : { ok: false }))
  })
  try {
    const profile = makeProfile(root, '0.4.0')
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const healthFile = join(root, 'health-endpoint.json')
    writeFileSync(healthFile, JSON.stringify({
      host: '127.0.0.1',
      port: address.port,
      pid: process.pid,
      plugin: PACKAGE_NAME,
      version: '0.4.0',
    }))
    const result = await inspectLiveProfile({ profileDir: profile, healthFile, requireRunning: true })
    assert.deepEqual(result.running, { pid: process.pid, health: 'ok', ready: 'ok' })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
