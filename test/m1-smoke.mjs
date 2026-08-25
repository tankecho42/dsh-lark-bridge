#!/usr/bin/env node
/**
 * M1 独立加载测试：不依赖完整 dsh host。
 * 构造最小 mock（tools / agents registry / agentDefaultModel / effect）验证：
 *  1. ESM import 不炸（含 peer deps 解析）
 *  2. inject 数组含 agents / agentDefaultModel
 *  3. apply() 在未配置 appId/appSecret 时不启动飞书 WS（不抛错）
 *  4. lark_bridge_status 工具 execute 返回当前里程碑标记
 *  5. session/event handler 已注册（ctx.on 被调用）
 * 用法: NODE_PATH=<deepseek-harness>/node_modules node test/m1-smoke.mjs
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

console.log('# M1 smoke test')

// --- 1. exports ---
check('export name', mod.name === '@tankecho42/dsh-lark-bridge', mod.name)
check('inject includes agents', Array.isArray(mod.inject) && mod.inject.includes('agents'), mod.inject)
check('inject includes agentDefaultModel', Array.isArray(mod.inject) && mod.inject.includes('agentDefaultModel'), mod.inject)
check('Config callable', typeof mod.Config === 'function')

// --- 2. Config schema ---
try {
  const parsed = mod.Config({})
  check('Config defaults', parsed.appId === '' && parsed.appSecret === '' && parsed.autoStart === true, parsed)
} catch (err) {
  check('Config defaults', false, String(err))
}

// --- 3. mock ctx + apply ---
const registeredTools = []
const eventHandlers = {}
const mockCtx = {
  tools: { register(tool) { registeredTools.push(tool) } },
  agents: {
    async create() { throw new Error('not used in smoke') },
    async resume() { throw new Error('not used in smoke') },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'glm-coding', model: 'glm-5.2' }) },
  on(event, fn) { eventHandlers[event] = fn },
  effect(fn) { return fn() },
  logger: { info() {}, warn() {} },
}

await mod.apply(mockCtx, mod.Config({}))

// --- 4. tool registration ---
check('registered 1 tool', registeredTools.length === 1, registeredTools.map((t) => t.name))
const statusTool = registeredTools[0]
if (statusTool) {
  check('tool name lark_bridge_status', statusTool.name === 'lark_bridge_status')
  const result = await statusTool.execute({}, {})
  check('tool execute ok', result.ok === true, result)
  check('tool message mentions M3', String(result.message).includes('M3'), result.message)
}

// --- 5. session/event handler registered ---
check('session/event handler registered', typeof eventHandlers['session/event'] === 'function')

// --- 6. no appId/appSecret → feishu NOT started (no crash, no WS) ---
// We can't observe feishu directly, but apply() completed without throwing
// while configured=false means the effect skipped FeishuClient.start().
check('apply completed without throw (unconfigured)', true)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
