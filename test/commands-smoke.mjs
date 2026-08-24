#!/usr/bin/env node
/**
 * Slash command smoke test v2 — 2.0 cards, native tables, card actions.
 */
const mod = await import('../lib/commands.js')
const { commands, findCommand, handleBridgeAction } = mod
const { buildCommandCard, buildDoneCard, buildStreamingCard, buildContextDonutChart, fmtSmartSec, FOOTER_CHART_INSIDE_PANEL } = await import('../lib/card.js')

let failures = 0
function check(label, cond, extra) {
  if (cond) console.log(`  ok - ${label}`)
  else { failures++; console.error(`  FAIL - ${label}${extra ? ' :: ' + JSON.stringify(extra) : ''}`) }
}
function bodyText(card) {
  return JSON.stringify(card?.body?.elements || [])
}

console.log('# slash command smoke test v2')

check('registry non-empty', commands.length >= 8)

// lookup
check('find /help', findCommand('help')?.name === 'help')
check('find /? alias', findCommand('?')?.name === 'help')
check('find /mode', findCommand('mode')?.name === 'mode')
check('unknown → null', findCommand('nosuchcmd') === null)
check('every command has desc', commands.every((c) => c.desc))

const stubFeishu = () => {
  const sent = []
  return {
    sent,
    feishu: {
      sendCard: async (cid, card) => { sent.push({ cid, card }) },
      sendText: async (cid, t) => { sent.push({ cid, text: t }) },
    },
  }
}

// /help — native table
{
  const { sent, feishu } = stubFeishu()
  await findCommand('help').run({ feishu, chatId: 'oc_t' })
  check('/help sends 2.0 card', sent[0]?.card?.schema === '2.0')
  const tbl = sent[0].card.body.elements.find((e) => e.tag === 'table')
  check('/help uses native table', !!tbl)
  check('/help table columns have display_name', tbl?.columns?.every((c) => typeof c.display_name === 'string'))
}

// /mode with stub presets
const stubPresets = () => ({
  defaultId: 'standard',
  list: async () => [
    { id: 'standard', name: '标准模式', description: 'd1', order: 1 },
    { id: 'minimal', name: '极简模式', description: 'd3', order: 3 },
  ],
  settings: { update: async () => {} },
})

{
  const { sent, feishu } = stubFeishu()
  const ctx = { get: () => stubPresets() }
  await findCommand('mode').run({ ctx, feishu, chatId: 'oc_t' })
  const tbl = sent[0].card.body.elements.find((e) => e.tag === 'table')
  check('/mode native table lists presets', JSON.stringify(tbl).includes('标准模式'))
  const btns = sent[0].card.body.elements.flatMap((e) => e.tag === 'column_set' ? e.columns.flatMap((c) => c.elements) : [])
  check('/mode has switch buttons with bridge_action', btns.some((b) => b.value?.bridge_action === 'mode_switch'))
  check('/mode current preset disabled', btns.find((b) => b.value?.preset_id === 'standard')?.disabled === true)
}

// /mode switch via arg (settings.update path)
{
  const { sent, feishu } = stubFeishu()
  let updated = null
  const svc = { ...stubPresets(), settings: { update: async (patch) => { updated = patch } } }
  const ctx = { get: () => svc }
  await findCommand('mode').run({ ctx, feishu, chatId: 'oc_t', arg: 'minimal' })
  check('/mode arg switch calls settings.update', updated?.default === 'minimal')
  check('/mode arg switch confirm card', bodyText(sent[0]?.card).includes('极简模式'))
}

// /mode unknown arg
{
  const { sent, feishu } = stubFeishu()
  const ctx = { get: () => stubPresets() }
  await findCommand('mode').run({ ctx, feishu, chatId: 'oc_t', arg: 'nope' })
  check('/mode unknown arg warns', sent[0]?.text?.includes('未找到'))
}

// card action: mode_switch
{
  const { sent, feishu } = stubFeishu()
  const ctx = { get: () => stubPresets() }
  const res = await handleBridgeAction({
    action: { value: { bridge_action: 'mode_switch', preset_id: 'minimal' } },
    operator: { openId: 'ou_test', name: 'Derek' },
    ctx, feishu, chatId: 'oc_t',
  })
  check('mode_switch returns updated card', res?.card?.schema === '2.0')
  check('mode_switch card shows operator', bodyText(res.card).includes('Derek'))
}

// card action: model_switch
{
  const { sent, feishu } = stubFeishu()
  let saved = null
  const ctx = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'glm-5.2' }),
      saveSelection: async (next) => { saved = next },
    },
    get: () => null,
  }
  const res = await handleBridgeAction({
    action: { value: { bridge_action: 'model_switch', provider: 'zai', model: 'glm-5.3' } },
    operator: { openId: 'ou_test' },
    ctx, feishu, chatId: 'oc_t',
  })
  check('model_switch saves', saved?.provider === 'zai' && saved?.model === 'glm-5.3')
  check('model_switch returns card', res?.card != null)
}

// card action: unknown → null (card not ours)
{
  const res = await handleBridgeAction({ action: { value: { foo: 1 } }, ctx: { get: () => null }, feishu: stubFeishu().feishu, chatId: 'x' })
  check('unrelated card action → null', res === null)
}

// /status — native table
{
  const { sent, feishu } = stubFeishu()
  const sessions = { sessionIds: new Map([['oc_t', 'lark-abc']]), defaultCwd: '/tmp/w', handles: new Map() }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'glm-5.2' }) },
    get: () => stubPresets(),
  }
  await findCommand('status').run({ ctx, sessions, feishu, chatId: 'oc_t' })
  check('/status native table', !!sent[0].card.body.elements.find((e) => e.tag === 'table'))
  check('/status shows model', bodyText(sent[0].card).includes('glm-5.2'))
}

// /sessions — native table with status column
{
  const { sent, feishu } = stubFeishu()
  const sessions = { sessionIds: new Map([['oc_a', 'lark-1']]), handles: new Map([['oc_a', {}]]) }
  await findCommand('sessions').run({ sessions, feishu, chatId: 'oc_a' })
  check('/sessions table + live marker', bodyText(sent[0].card).includes('🟢'))
}

// legacy buildCommandCard still exports (index.js compat)
check('legacy buildCommandCard export intact', typeof buildCommandCard === 'function')

// reply-card footer duration formatting
check('fmtSmartSec seconds', fmtSmartSec(47) === '47s')
check('fmtSmartSec minutes', fmtSmartSec(750) === '12m30s')
check('fmtSmartSec minute boundary', fmtSmartSec(60) === '1m00s')
check('fmtSmartSec hour boundary', fmtSmartSec(3600) === '1h00m00s')
check('fmtSmartSec hours with padding', fmtSmartSec(3920) === '1h05m20s')
check('streaming card uses smart duration', JSON.stringify(buildStreamingCard('x', { elapsed: 750 })).includes('12m30s'))

// context donut: Plotly pie + hole, default placement outside the panel
{
  const pressure = { pressureTokens: 1000, projectedTokens: 32000, contextWindow: 128000 }
  const chart = buildContextDonutChart(pressure)
  check('context chart is donut', chart?.tag === 'chart' && chart.chart_spec?.data?.[0]?.type === 'pie' && chart.chart_spec.data[0].hole > 0)
  check('context chart uses projected occupancy', JSON.stringify(chart?.chart_spec?.data?.[0]?.values) === JSON.stringify([32000, 96000]))
  check('context chart has used/remaining labels', JSON.stringify(chart?.chart_spec?.data?.[0]?.labels) === JSON.stringify(['已用', '剩余']))
  const card = buildDoneCard('done', { elapsed: 47, model: 'model-x', tools: [{}], contextPressure: pressure, tokenUsage: { uncachedInputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 50, outputTokens: 125 } })
  const chartIndex = card.elements.findIndex((e) => e.tag === 'chart')
  const footerIndex = card.elements.findIndex((e) => e.tag === 'collapsible_panel' && e.border?.color === 'grey')
  check('context chart defaults outside footer panel', FOOTER_CHART_INSIDE_PANEL === false && chartIndex >= 0 && chartIndex < footerIndex)
  check('footer shows five metrics and cache ratio', JSON.stringify(card).includes('model-x') && JSON.stringify(card).includes('Context') && JSON.stringify(card).includes('Input 1,050') && JSON.stringify(card).includes('缓存命中 80%') && JSON.stringify(card).includes('工具调用') && JSON.stringify(card).includes('整体时长'))
}

// Missing projections degrade to text fallbacks and omit a misleading chart.
{
  const card = buildDoneCard('done')
  const footer = card.elements.find((e) => e.tag === 'collapsible_panel')
  check('missing footer data uses fallback', footer?.elements?.[0]?.content?.includes('**模型**：—') && footer.elements[0].content.includes('**Context**：—') && footer.elements[0].content.includes('**Token**：—') && footer.elements[0].content.includes('**整体时长**：—'))
  check('missing context omits chart', buildContextDonutChart({ pressureTokens: 100 }) === null && !card.elements.some((e) => e.tag === 'chart'))
}

if (failures > 0) { console.error(`\n${failures} FAIL`); process.exit(1) }
console.log('\nALL PASS')
