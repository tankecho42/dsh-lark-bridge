#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@tankecho42/dsh-lark-bridge'
const PACKAGE_PATH = join('node_modules', '@tankecho42', 'dsh-lark-bridge')
const PACKAGE_LOCK_PATH = 'node_modules/@tankecho42/dsh-lark-bridge'
const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function fail(message) {
  throw new Error(message)
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${label} unreadable: ${path}: ${error.message}`)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function inside(child, parent) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function verifyLock(profileDir, spec, expectedVersion) {
  const npmLockPath = join(profileDir, 'package-lock.json')
  const pnpmLockPath = join(profileDir, 'pnpm-lock.yaml')
  if (existsSync(npmLockPath)) {
    const lock = readJson(npmLockPath, 'npm lockfile')
    const installed = lock.packages?.[PACKAGE_LOCK_PATH]
    if (installed?.version !== expectedVersion) {
      fail(`npm lockfile does not pin ${PACKAGE_NAME}@${expectedVersion}`)
    }
    return 'package-lock.json'
  }
  if (existsSync(pnpmLockPath)) {
    const lock = readFileSync(pnpmLockPath, 'utf8')
    const packageKeyForms = [`'${PACKAGE_NAME}':`, `"${PACKAGE_NAME}":`, `${PACKAGE_NAME}:`]
    const specifierForms = [`specifier: ${spec}`, `specifier: '${spec}'`, `specifier: "${spec}"`]
    if (!packageKeyForms.some((candidate) => lock.includes(candidate))
      || !specifierForms.some((candidate) => lock.includes(candidate))) {
      fail(`pnpm lockfile does not pin ${PACKAGE_NAME} to ${spec}`)
    }
    return 'pnpm-lock.yaml'
  }
  fail('profile has no package-lock.json or pnpm-lock.yaml')
}

function verifyDependencySpec(profileDir, spec, expectedVersion, artifactSha256) {
  if (typeof spec !== 'string' || !spec) fail(`${PACKAGE_NAME} is absent from profile dependencies`)
  if (/^(?:link|workspace):/i.test(spec)) {
    fail(`mutable dependency rejected: ${spec}; install an exact registry version or a verified .tgz`)
  }

  if (spec.startsWith('file:')) {
    const rawPath = spec.slice('file:'.length)
    const artifactPath = resolve(profileDir, rawPath)
    if (!rawPath.endsWith('.tgz')) {
      fail(`mutable file dependency rejected: ${spec}; only an immutable .tgz is allowed`)
    }
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
      fail(`release artifact is missing: ${artifactPath}`)
    }
    if (!artifactSha256) fail('a file:.tgz deployment requires --artifact-sha256')
    if (!/^[0-9a-f]{64}$/i.test(artifactSha256)) fail('--artifact-sha256 must be 64 hexadecimal characters')
    const actualSha256 = sha256(artifactPath)
    if (actualSha256 !== artifactSha256.toLowerCase()) {
      fail(`release artifact SHA-256 mismatch: expected ${artifactSha256.toLowerCase()}, got ${actualSha256}`)
    }
    return { mode: 'tarball', artifactPath, artifactSha256: actualSha256 }
  }

  if (!EXACT_VERSION.test(spec)) {
    fail(`unfixed dependency rejected: ${spec}; ranges, tags, URLs, and directories are not allowed`)
  }
  if (spec !== expectedVersion) {
    fail(`profile pins ${PACKAGE_NAME}@${spec}, expected ${expectedVersion}`)
  }
  return { mode: 'registry', version: spec }
}

async function fetchJson(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    let body
    try { body = await response.json() } catch { body = null }
    return { status: response.status, body }
  } finally {
    clearTimeout(timeout)
  }
}

async function verifyRunningHealth(healthFile, expectedVersion) {
  const record = readJson(healthFile, 'health discovery record')
  if (!LOOPBACK_HOSTS.has(record.host)) fail(`health endpoint is not loopback: ${record.host}`)
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) fail('health discovery record has an invalid port')
  if (record.plugin !== PACKAGE_NAME || record.version !== expectedVersion) {
    fail(`health discovery reports ${record.plugin || '(unknown)'}@${record.version || '(unknown)'}, expected ${PACKAGE_NAME}@${expectedVersion}`)
  }
  if (!Number.isInteger(record.pid) || record.pid < 1) fail('health discovery record has an invalid pid')
  try { process.kill(record.pid, 0) } catch { fail(`health discovery pid is not running: ${record.pid}`) }

  const base = `http://${record.host.includes(':') ? `[${record.host}]` : record.host}:${record.port}`
  const health = await fetchJson(`${base}/healthz`)
  if (health.status !== 200 || health.body?.plugin !== PACKAGE_NAME || health.body?.version !== expectedVersion) {
    fail(`/healthz did not report ${PACKAGE_NAME}@${expectedVersion}`)
  }
  const ready = await fetchJson(`${base}/readyz`)
  if (ready.status !== 200 || ready.body?.ok !== true || ready.body?.plugin !== PACKAGE_NAME || ready.body?.version !== expectedVersion) {
    fail(`/readyz is not ready as ${PACKAGE_NAME}@${expectedVersion}`)
  }
  return { pid: record.pid, health: 'ok', ready: 'ok' }
}

export async function inspectLiveProfile({
  profileDir,
  expectedVersion = PACKAGE_JSON.version,
  artifactSha256,
  healthFile,
  requireRunning = false,
}) {
  if (!profileDir) fail('--profile is required')
  const resolvedProfile = realpathSync(resolve(profileDir))
  const profilePackage = readJson(join(resolvedProfile, 'package.json'), 'profile package.json')
  const spec = profilePackage.dependencies?.[PACKAGE_NAME]
  const source = verifyDependencySpec(resolvedProfile, spec, expectedVersion, artifactSha256)
  const lockfile = verifyLock(resolvedProfile, spec, expectedVersion)

  const installedPath = join(resolvedProfile, PACKAGE_PATH)
  if (!existsSync(installedPath)) fail(`${PACKAGE_NAME} is not installed in the profile`)
  const installedRealPath = realpathSync(installedPath)
  const installedPackage = readJson(join(installedRealPath, 'package.json'), 'installed package.json')
  if (installedPackage.name !== PACKAGE_NAME || installedPackage.version !== expectedVersion) {
    fail(`installed package is ${installedPackage.name || '(unknown)'}@${installedPackage.version || '(unknown)'}, expected ${PACKAGE_NAME}@${expectedVersion}`)
  }
  if (lstatSync(installedPath).isSymbolicLink() && !inside(installedRealPath, join(resolvedProfile, 'node_modules'))) {
    fail(`installed package resolves outside the profile node_modules: ${installedRealPath}`)
  }
  if (requireRunning && !healthFile) fail('--require-running also requires --health-file')
  const running = healthFile ? await verifyRunningHealth(resolve(healthFile), expectedVersion) : null

  return {
    ok: true,
    package: `${PACKAGE_NAME}@${expectedVersion}`,
    profile: resolvedProfile,
    dependency: spec,
    source,
    lockfile,
    installedPath: installedRealPath,
    running,
  }
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--require-running') options.requireRunning = true
    else if (arg === '--profile') options.profileDir = argv[++i]
    else if (arg === '--expect-version') options.expectedVersion = argv[++i]
    else if (arg === '--artifact-sha256') options.artifactSha256 = argv[++i]
    else if (arg === '--health-file') options.healthFile = argv[++i]
    else if (arg === '--help') options.help = true
    else fail(`unknown argument: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: node scripts/release-gate.mjs --profile <dir> [--expect-version <version>] [--artifact-sha256 <hex>] [--health-file <path> --require-running]\n')
    return
  }
  const result = await inspectLiveProfile(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`release gate failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
