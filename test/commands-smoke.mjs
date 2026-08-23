#!/usr/bin/env node
/**
 * Slash command smoke test — no dsh host, no Feishu.
 * Verifies:
 *  1. commands.js imports cleanly
 *  2. findCommand resolves names & aliases
 *  3. every command has name + desc (help listing invariant)
 *  4. /help handler runs against a stub feishu and sends one card
 *  5. /mode handler degrades gracefully when agentPresets is unavailable
 *  6. unknown command → null (index.js shows the hint)
 */
const mod = await import('../lib/commands.js')
const { commands, findCommand } = mod

let failures = 0
function check(label, cond, extra) {
  if (cond) {
    console.log(`  ok - ${label}`)
  } else {
    failures++
    console.error(`  FAIL - ${label}${extra ? ' :: ' + JSON.stringify(extra) : ''}`)
  }
}

console.log('# slash command smoke test')

// 1. import + registry
check('registry non-empty', commands.length >= 8, commands.length)

// 2. lookup
check('find /help', findCommand('help')?.name === 'help')
check('find /? alias', findCommand('?')?.name === 'help')
check('find /mode', findCommand('mode')?.name === 'mode')
check('find /usage', findCommand('usage')?.name === 'usage')
check('find /tools', findCommand('tools')?.name === 'tools')
check('find /model', findCommand('model')?.name === 'model')
check('unknown → null', findCommand('nosuchcmd') === null)

// 3. help listing invariant
check('every command has desc', commands.every((c) => c.desc))
check('every command has name', commands.every((c) => c.name))

// 4. /help run with stub feishu
{
  const sent = []
  const feishu = { sendCard: async (cid, card) => { sent.push({ cid, card }) }, sendText: async () => {} }
  await findCommand('help').run({ feishu, chatId: 'oc_test' })
  check('/help sends one card', sent.length === 1)
  check('/help card lists /mode', sent[0]?.card?.elements?.[0]?.content?.includes('/mode'))
}

// 5. /mode degrades when service unavailable
{
  const sent = []
  const feishu = { sendCard: async (cid, card) => { sent.push({ cid, card }) }, sendText: async () => {} }
  const ctx = { get: () => { throw new Error('service missing') } }
  await findCommand('mode').run({ ctx, feishu, chatId: 'oc_test' })
  check('/mode graceful degrade (text sent)', sent.length === 0) // sendText stubbed noop; must not throw
}

// 5b. /mode with stub presets service
{
  const sent = []
  const feishu = { sendCard: async (cid, card) => { sent.push({ cid, card }) }, sendText: async () => {} }
  const svc = {
    defaultId: 'standard',
    list: async () => [
      { id: 'standard', name: '标准模式', description: 'd1', order: 1 },
      { id: 'minimal', name: '极简模式', description: 'd3', order: 3 },
    ],
    settings: { set: async () => {} },
  }
  const ctx = { get: (n) => (n === 'agentPresets' ? svc : undefined) }
  await findCommand('mode').run({ ctx, feishu, chatId: 'oc_test' })
  check('/mode lists presets', sent.length === 1 && sent[0].card.elements[0].content.includes('标准模式'))
  check('/mode marks current', sent[0].card.elements[0].content.includes('✅'))

  // switch arg path
  sent.length = 0
  await findCommand('mode').run({ ctx, feishu, chatId: 'oc_test', arg: 'minimal' })
  check('/mode switch sends confirm', sent.length === 1 && sent[0].card.elements[0].content.includes('极简模式'))

  // switch unknown arg path
  sent.length = 0
  let textSent = ''
  feishu.sendText = async (_c, t) => { textSent = t }
  await findCommand('mode').run({ ctx, feishu, chatId: 'oc_test', arg: 'nope' })
  check('/mode unknown arg warns', textSent.includes('未找到'))
}

// 6. /status with stubs
{
  const sent = []
  const feishu = { sendCard: async (cid, card) => { sent.push({ cid, card }) }, sendText: async () => {} }
  const sessions = { sessionIds: new Map([['oc_t', 'lark-abc']]), defaultCwd: '/tmp/w', handles: new Map() }
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'glm-5.2' }) }, get: () => ({ defaultId: 'standard' }) }
  await findCommand('status').run({ ctx, sessions, feishu, chatId: 'oc_t' })
  check('/status renders table', sent.length === 1 && sent[0].card.elements[0].content.includes('| 会话 |'))
  check('/status shows model', sent[0].card.elements[0].content.includes('glm-5.2'))
}

// 7. /sessions
{
  const sent = []
  const feishu = { sendCard: async (cid, card) => { sent.push({ cid, card }) }, sendText: async () => {} }
  const sessions = { sessionIds: new Map([['oc_a', 'lark-1'], ['oc_b', 'lark-2']]), handles: new Map([['oc_a', {}]]) }
  await findCommand('sessions').run({ sessions, feishu, chatId: 'oc_a' })
  check('/sessions lists rows', sent[0].card.elements[0].content.includes('oc_a'))
  check('/sessions live marker', sent[0].card.elements[0].content.includes('🟢'))
}

if (failures > 0) {
  console.error(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nALL PASS')
