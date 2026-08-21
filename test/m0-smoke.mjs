#!/usr/bin/env node
/**
 * M0 骨架独立加载测试：不依赖完整 dsh host，
 * 构造最小 mock（tools registry / logger / effect）验证：
 *  1. ESM import 不炸（依赖解析正确）
 *  2. inject 数组 / Config schema 正确
 *  3. apply() 注册工具 + 启动内部 HTTP 状态端点
 *  4. lark_bridge_status 工具 execute 返回预期 JSON
 *  5. 内部 API /status 返回 200
 * 用法: node test/m0-smoke.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mod = await import('../lib/index.js')

let failures = 0
function check(label, cond, extra) {
  if (cond) {
    console.log(`  ok - ${label}`)
  } else {
    failures++
    console.error(`  FAIL - ${label}${extra ? ' :: ' + JSON.stringify(extra) : ''}`)
  }
}

// --- 1. exports ---
console.log('# M0 smoke test')
check('export name', mod.name === '@tankecho42/dsh-lark-gyorge' || mod.name === '@tankecho42/dsh-lark-bridge', mod.name)
check('export inject', Array.isArray(mod.inject) && mod.inject.includes('tools'), mod.inject)
check('export Config (schemastery object)', typeof mod.Config === 'function' || (mod.Config && typeof mod.Config.parse === 'function'))
check('export apply function', typeof mod.apply === 'function')

// --- 2. Config schema (schemastery objects are callable: Config(obj) === Config.parse(obj)) ---
try {
  const parsed = mod.Config({})
  check('Config defaults', parsed.appId === '' && parsed.autoStart === true, parsed)
} catch (err) {
  check('Config defaults', false, String(err))
}

// --- 3. mock ctx + apply (mock effect executes immediately, like real Cordis) ---
const registeredTools = []
const registeredEffects = []
const mockCtx = {
  tools: {
    register(tool) {
      registeredTools.push(tool)
    },
  },
  effect(fn) {
    registeredEffects.push(fn)
    return fn() // real Cordis runs the effect body immediately; capture disposer
  },
  logger: {
    info() {},
    warn() {},
  },
}

await mod.apply(mockCtx, mod.Config({}))

check('apply registered 1 tool', registeredTools.length === 1, registeredTools.map((t) => t.name))
const statusTool = registeredTools[0]
check('tool name lark_bridge_status', statusTool.name === 'lark_bridge_status')

const result = await statusTool.execute({}, { agent: undefined })
check('tool execute ok', result.ok === true, result)
check('tool message mentions M0', String(result.message).includes('M0'), result.message)

// --- 4. effects (server start) ---
check('apply registered effect', registeredEffects.length === 1)
// run the effect fn — it starts the internal server; the disposer is returned
const dispose = registeredEffects[0]()
if (typeof dispose !== 'function') check('effect returns disposer', false, typeof dispose)
else check('effect returns disposer', true)

// give the server a moment to bind
await new Promise((r) => setTimeout(r, 300))

// find the listening port by scanning the payload — the status endpoint is
// loopback-only; discover port via lsof-free trick: re-check log file
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const logPath = join(homedir(), '.dsh', 'lark-bridge', 'logs', 'plugin.log')
let port = 0
try {
  const text = readFileSync(logPath, 'utf8')
  const m = text.match(/"internal api listening".*?"port":(\d+)/s) || text.match(/internal api listening ({.*})/)
  if (m) {
    try { port = JSON.parse(m[1]).port } catch { port = Number(m[1]) }
  }
} catch {}
check('internal api port logged', port > 0, { port })

if (port > 0) {
  const resp = await fetch(`http://127.0.0.1:${port}/status`)
  const body = await resp.json()
  check('GET /status 200', resp.status === 200, resp.status)
  check('status payload plugin', body.plugin === '@tankecho42/dsh-lark-bridge', body.plugin)
  check('status payload milestone M0', body.milestone === 'M0', body.milestone)
}

// --- cleanup ---
if (typeof dispose === 'function') dispose()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
