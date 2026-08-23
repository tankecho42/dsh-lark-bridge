/**
 * Slash command framework for the Feishu bridge (schema 2.0 cards).
 *
 * Registry pattern: each command is { name, aliases, usage, desc, run }.
 * Interactive cards carry `bridge_action` values; the card-action callback
 * in index.js dispatches them back to `handleBridgeAction` below.
 */
import { cmdCard, md, table, buttonRows, hint } from './cmd-card.js'

/** @type {Array<{name: string, aliases?: string[], usage?: string, desc: string, run: Function}>} */
export const commands = []

export function registerCommand(cmd) {
  commands.push(cmd)
}

export function findCommand(name) {
  const n = String(name || '').toLowerCase()
  return commands.find((c) => c.name === n || (c.aliases || []).includes(n)) || null
}

// ---------------------------------------------------------------------------
// Shared: preset listing / switching (used by /mode and card callbacks)
// ---------------------------------------------------------------------------
async function listPresets(ctx) {
  const svc = ctx.get('agentPresets')
  const presets = (await svc.list()) || []
  presets.sort((a, b) => ((a.order ?? 99) - (b.order ?? 99)) || String(a.id).localeCompare(String(b.id)))
  return { svc, presets }
}

async function switchPreset(ctx, presetId) {
  const { svc } = await listPresets(ctx)
  if (svc?.settings?.update) {
    await svc.settings.update({ default: presetId })
    return true
  }
  // fallback: raw settings service replace
  const settings = ctx.get('settings')
  if (settings?.replace) {
    // AGENT_PRESETS settings namespace (dsh-agent-presets SETTINGS_NAMESPACE)
    await settings.replace('agent-presets', { default: presetId })
    return true
  }
  throw new Error('settings provider unavailable')
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------
registerCommand({
  name: 'help',
  aliases: ['?'],
  usage: '/help',
  desc: '命令清单',
  async run({ feishu, chatId }) {
    const rows = commands.map((c) => [c.usage || `/${c.name}`, c.desc])
    await feishu.sendCard(chatId, cmdCard('📖 命令清单', [
      table({ columns: ['命令', '说明'], rows }),
      hint('配置类命令会发交互卡片，点按钮即可切换'),
    ])).catch(() => {})
  },
})

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------
registerCommand({
  name: 'status',
  usage: '/status',
  desc: '当前会话状态（session、模式、模型、cwd）',
  async run({ ctx, sessions, feishu, chatId }) {
    const sid = sessions.sessionIds.get(chatId) || '(未创建)'
    let model = '(部署默认)'
    try {
      const sel = ctx.agentDefaultModel?.currentSelection?.()
      if (sel?.model) model = `${sel.provider || '?'} / ${sel.model}`
    } catch { /* keep default */ }
    let presetName = '(默认)'
    try {
      const { presets, svc } = await listPresets(ctx)
      const cur = presets.find((p) => p.id === svc.defaultId)
      presetName = cur ? `${cur.name || cur.id}（${cur.id}）` : String(svc.defaultId || '(默认)')
    } catch { /* keep default */ }
    const rows = [
      ['会话', `\`${sid}\``],
      ['模式', presetName],
      ['模型', model],
      ['工作目录', `\`${sessions.defaultCwd}\``],
      ['活跃会话数', String(sessions.handles.size)],
    ]
    await feishu.sendCard(chatId, cmdCard('📊 会话状态', [
      table({ columns: ['项', '值'], rows }),
    ])).catch(() => {})
  },
})

// ---------------------------------------------------------------------------
// /mode — interactive preset picker
// ---------------------------------------------------------------------------
registerCommand({
  name: 'mode',
  usage: '/mode [preset]',
  desc: '查看/切换 Agent 模式（标准/PTC/极简/创造）',
  async run({ ctx, feishu, chatId, arg }) {
    let svc, presets
    try {
      ;({ svc, presets } = await listPresets(ctx))
    } catch (err) {
      await feishu.sendText(chatId, `⚠️ agentPresets 服务不可用：${err?.message || err}`).catch(() => {})
      return
    }
    const current = svc.defaultId
    const cur = presets.find((p) => p.id === current)

    if (arg) {
      const wanted = presets.find((p) => p.id === arg || String(p.name || '').includes(arg))
      if (!wanted) {
        await feishu.sendText(chatId, `⚠️ 未找到模式「${arg}」。可用：${presets.map((p) => p.id).join(' / ')}`).catch(() => {})
        return
      }
      await applyModeSwitch({ ctx, feishu, chatId, preset: wanted })
      return
    }

    const rows = presets.map((p) => [
      p.id === current ? '✅' : '',
      `${p.name || p.id}`,
      `\`${p.id}\``,
      (p.description || '').slice(0, 50),
    ])
    await feishu.sendCard(chatId, cmdCard('🎛️ Agent 模式', [
      md(`当前默认：**${cur?.name || current || '(默认)'}**`),
      table({ columns: ['', '模式', 'ID', '说明'], rows }),
      md('点击切换（新会话生效）：'),
      ...buttonRows(presets.map((p) => ({
        text: `${p.id === current ? '✅ ' : ''}${p.name || p.id}`,
        value: { bridge_action: 'mode_switch', preset_id: p.id },
        disabled: p.id === current,
      }))),
      hint('切换只影响新会话；运行中的会话保持原模式'),
    ])).catch(() => {})
  },
})

async function applyModeSwitch({ ctx, feishu, chatId, preset }) {
  try {
    await switchPreset(ctx, preset.id)
    await feishu.sendCard(chatId, cmdCard('🔀 模式已切换', [
      md(`默认模式 → **${preset.name || preset.id}**（\`${preset.id}\`）`),
      md(preset.description || ''),
      hint('新会话生效；运行中的会话不受影响'),
    ], { template: 'turquoise' })).catch(() => {})
  } catch (err) {
    await feishu.sendText(chatId, `⚠️ 切换失败：${err?.message || err}`).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// /model — interactive model picker
// ---------------------------------------------------------------------------
registerCommand({
  name: 'model',
  usage: '/model [provider/model]',
  desc: '查看/配置主模型',
  async run({ ctx, feishu, chatId, arg }) {
    const svc = ctx.agentDefaultModel
    const sel = svc?.currentSelection?.()
    if (arg) {
      let provider = sel?.provider || ''
      let model = arg
      if (arg.includes('/')) {
        const [p, ...rest] = arg.split('/')
        provider = p
        model = rest.join('/')
      }
      await applyModelSwitch({ ctx, feishu, chatId, provider, model })
      return
    }
    // discover models per provider
    const discovered = []
    try {
      const llm = ctx.get('llm')
      const providers = [...(llm?.adapters?.keys?.() || [])]
      for (const p of providers.slice(0, 5)) {
        try {
          const models = (await llm.listModels(p)) || []
          for (const m of models.slice(0, 12)) {
            discovered.push({ provider: p, model: typeof m === 'string' ? m : m.id })
          }
        } catch { /* provider listing may fail */ }
      }
    } catch { /* llm optional */ }

    const elements = [
      md(`**当前主模型**：${sel ? `\`${sel.provider || '?'} / ${sel.model}\`` : '(部署默认)'}`),
    ]
    if (discovered.length) {
      const rows = discovered.map((d) => [
        d.provider === sel?.provider && d.model === sel?.model ? '✅' : '',
        `\`${d.model}\``,
        d.provider,
      ])
      elements.push(table({ columns: ['', '模型', 'provider'], rows }))
      elements.push(md('点击切换（新会话生效）：'))
      elements.push(...buttonRows(discovered.slice(0, 8).map((d) => ({
        text: `${d.model}`,
        value: { bridge_action: 'model_switch', provider: d.provider, model: d.model },
        disabled: d.provider === sel?.provider && d.model === sel?.model,
      }))))
    } else {
      elements.push(md('_(模型列表不可用；用 \`/model provider/model\` 手动设置)_'))
    }
    await feishu.sendCard(chatId, cmdCard('🤖 模型配置', elements)).catch(() => {})
  },
})

async function applyModelSwitch({ ctx, feishu, chatId, provider, model }) {
  const svc = ctx.agentDefaultModel
  const sel = svc?.currentSelection?.()
  try {
    await svc.saveSelection({ provider, model, ...(sel?.reasoning ? { reasoning: sel.reasoning } : {}) })
    await feishu.sendCard(chatId, cmdCard('🤖 模型已更新', [
      md(`主模型 → **${provider} / ${model}**`),
      hint('新会话生效'),
    ], { template: 'turquoise' })).catch(() => {})
  } catch (err) {
    await feishu.sendText(chatId, `⚠️ 保存失败：${err?.message || err}`).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// /usage — sessionStats aggregation, native table
// ---------------------------------------------------------------------------
registerCommand({
  name: 'usage',
  usage: '/usage',
  desc: '用量统计（轮次 / token / 耗时）',
  async run({ ctx, sessions, feishu, chatId }) {
    let rows
    try {
      const projections = ctx.get('sessionProjections')
      const stats = []
      for (const sid of sessions.sessionIds.values()) {
        try {
          const snap = await projections.snapshot?.(sid, 'sessionStats')
          if (snap) stats.push(snap)
        } catch { /* session may be gone */ }
      }
      const sum = (k) => stats.reduce((a, s) => a + (Number(s[k]) || 0), 0)
      const n = stats.length || 1
      rows = [
        ['会话数', String(stats.length)],
        ['轮次 turns', String(sum('turns'))],
        ['步骤 steps', String(sum('steps'))],
        ['输出 tokens', sum('decodeTokens').toLocaleString()],
        ['LLM 耗时', fmtMs(sum('llmMs'))],
        ['工具耗时', fmtMs(sum('toolMs'))],
        ['平均 TTFT', fmtMs(Math.round(sum('ttftMs') / n))],
      ]
    } catch (err) {
      await feishu.sendText(chatId, `⚠️ sessionStats 不可用：${err?.message || err}`).catch(() => {})
      return
    }
    await feishu.sendCard(chatId, cmdCard('📈 用量统计', [
      table({ columns: ['指标', '值'], rows }),
      hint('统计范围：本桥接创建的全部会话'),
    ])).catch(() => {})
  },
})

function fmtMs(ms) {
  if (!ms) return '0s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

// ---------------------------------------------------------------------------
// /tools — read-only inventory
// ---------------------------------------------------------------------------
registerCommand({
  name: 'tools',
  usage: '/tools',
  desc: '查看已挂载的工具/插件清单（只读）',
  async run({ ctx, feishu, chatId }) {
    const rows = []
    try {
      const tools = ctx.get('tools')
      const names = [...(tools?.registry?.keys?.() || [])]
      for (const t of names) rows.push([`\`${t}\``, '工具'])
    } catch { /* ignore */ }
    try {
      const inv = ctx.get('pluginInventory')
      if (inv?.list) {
        const plugins = (await inv.list()) || []
        for (const p of plugins) rows.push([p.name || p.id, p.disabled ? '插件（停用）' : '插件'])
      }
    } catch { /* optional */ }
    const elements = rows.length
      ? [table({ columns: ['名称', '类型'], rows })]
      : [md('(工具注册表为空或不可枚举)')]
    await feishu.sendCard(chatId, cmdCard('🔧 工具 / 插件', elements)).catch(() => {})
  },
})

// ---------------------------------------------------------------------------
// /sessions
// ---------------------------------------------------------------------------
registerCommand({
  name: 'sessions',
  usage: '/sessions',
  desc: '活跃会话列表',
  async run({ sessions, feishu, chatId }) {
    const rows = []
    for (const [cid, sid] of sessions.sessionIds.entries()) {
      rows.push([`\`${short(cid)}\``, `\`${short(sid)}\``, sessions.handles.has(cid) ? '🟢 活跃' : '⚪ 持久化'])
    }
    await feishu.sendCard(chatId, cmdCard('🗂️ 会话列表', [
      table({ columns: ['chat', 'session', '状态'], rows }),
    ])).catch(() => {})
  },
})

function short(s) {
  s = String(s)
  return s.length > 24 ? s.slice(0, 12) + '…' + s.slice(-8) : s
}

// ---------------------------------------------------------------------------
// Card action dispatcher (called from index.js on 'card.action.trigger')
// ---------------------------------------------------------------------------
export async function handleBridgeAction({ action, operator, ctx, feishu, chatId }) {
  const value = action?.value || {}
  const { bridge_action: bridgeAction } = value
  if (!bridgeAction) return null

  if (bridgeAction === 'mode_switch') {
    const { presets } = await listPresets(ctx)
    const preset = presets.find((p) => p.id === value.preset_id)
    if (!preset) return { text: `⚠️ 未找到模式 ${value.preset_id}` }
    await switchPreset(ctx, preset.id)
    return {
      card: cmdCard('🎛️ Agent 模式', [
        md(`✅ 已切换默认模式 → **${preset.name || preset.id}**（\`${preset.id}\`）`),
        md(`操作的用户：${operator?.name || operator?.openId || 'unknown'}`),
        md(preset.description || ''),
        hint('新会话生效；运行中的会话不受影响'),
      ], { template: 'turquoise' }),
    }
  }

  if (bridgeAction === 'model_switch') {
    const sel = ctx.agentDefaultModel?.currentSelection?.()
    await ctx.agentDefaultModel.saveSelection({
      provider: value.provider, model: value.model,
      ...(sel?.reasoning ? { reasoning: sel.reasoning } : {}),
    })
    return {
      card: cmdCard('🤖 模型已更新', [
        md(`✅ 主模型 → **${value.provider} / ${value.model}**`),
        md(`操作的用户：${operator?.name || operator?.openId || 'unknown'}`),
        hint('新会话生效'),
      ], { template: 'turquoise' }),
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// /new /reset /stop are inline in index.js; registered for /help listing.
// ---------------------------------------------------------------------------
registerCommand({ name: 'new', usage: '/new', desc: '开启新会话', async run() {} })
registerCommand({ name: 'reset', usage: '/reset', desc: '重置会话（同 /new）', async run() {} })
registerCommand({ name: 'stop', usage: '/stop', desc: '停止当前生成', async run() {} })
