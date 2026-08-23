/**
 * Slash command framework for the Feishu bridge.
 *
 * Registry pattern: each command is { name, aliases, usage, desc, run }.
 * `run({ chatId, arg, ctx, sessions, feishu, log })` sends a reply card/text.
 * Group chats reach here only after @-mention filtering in index.js.
 */
import { buildCommandCard } from './card.js'

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
// /help
// ---------------------------------------------------------------------------
registerCommand({
  name: 'help',
  aliases: ['?', '命令'],
  usage: '/help',
  desc: '命令清单',
  async run({ feishu, chatId }) {
    const lines = commands
      .map((c) => `- **${c.usage || '/' + c.name}** — ${c.desc}`)
      .join('\n')
    await feishu.sendCard(chatId, buildCommandCard('📖 命令清单', lines)).catch(() => {})
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
    let model = '(默认)'
    try {
      const sel = ctx.agentDefaultModel?.currentSelection?.()
      if (sel?.model) model = `${sel.provider || '?'} / ${sel.model}`
    } catch { /* keep default */ }
    let preset = '(默认)'
    try {
      const presets = ctx.get('agentPresets')
      preset = presets?.defaultId || '(默认)'
    } catch { /* keep default */ }
    const body = [
      `| 项 | 值 |`,
      `| --- | --- |`,
      `| 会话 | \`${sid}\` |`,
      `| 模式 | ${preset} |`,
      `| 模型 | ${model} |`,
      `| 工作目录 | \`${sessions.defaultCwd}\` |`,
      `| 活跃会话数 | ${sessions.handles.size} |`,
    ].join('\n')
    await feishu.sendCard(chatId, buildCommandCard('📊 会话状态', body)).catch(() => {})
  },
})

// ---------------------------------------------------------------------------
// /mode — view & switch agent presets
// ---------------------------------------------------------------------------
registerCommand({
  name: 'mode',
  usage: '/mode [preset]',
  desc: '查看/切换 Agent 模式（standard / code / minimal / cordis）',
  async run({ ctx, feishu, chatId, arg }) {
    let presets = []
    try {
      presets = (await ctx.get('agentPresets').list()) || []
    } catch (err) {
      await feishu.sendText(chatId, `⚠️ agentPresets 服务不可用：${err?.message || err}`).catch(() => {})
      return
    }
    // stable display order
    presets.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) ?? String(a.id).localeCompare(String(b.id)))
    const svc = ctx.get('agentPresets')
    const current = svc?.defaultId

    if (arg) {
      const wanted = presets.find((p) => p.id === arg || String(p.name || '').includes(arg))
      if (!wanted) {
        await feishu.sendText(chatId, `⚠️ 未找到模式「${arg}」。可用：${presets.map((p) => p.id).join(' / ')}`).catch(() => {})
        return
      }
      try {
        // write user default via settings (hot-reloaded; new sessions pick it up)
        if (svc?.settings?.set) {
          await svc.settings.set({ base: { default: wanted.id } })
        } else {
          throw new Error('settings provider unavailable')
        }
        await feishu.sendCard(chatId, buildCommandCard('🔀 模式已切换',
          `已切换默认模式 → **${wanted.name || wanted.id}**（\`${wanted.id}\`）\n\n${wanted.description || ''}\n\n> 新会话生效；当前运行中的会话不受影响。`)).catch(() => {})
      } catch (err) {
        await feishu.sendText(chatId, `⚠️ 切换失败：${err?.message || err}`).catch(() => {})
      }
      return
    }

    const lines = presets.map((p) => {
      const mark = p.id === current ? ' ✅' : ''
      return `- **${p.name || p.id}**（\`${p.id}\`）${mark}\n  ${p.description || ''}`
    }).join('\n\n')
    const cur = presets.find((p) => p.id === current)
    const body = `当前默认：**${cur?.name || current || '(默认)'}**\n\n${lines}\n\n> 切换：\`/mode <id>\`（新会话生效）`
    await feishu.sendCard(chatId, buildCommandCard('🎛️ Agent 模式', body)).catch(() => {})
  },
})

// ---------------------------------------------------------------------------
// /model — view & configure primary/fallback models
// ---------------------------------------------------------------------------
registerCommand({
  name: 'model',
  usage: '/model [provider/model]',
  desc: '查看/配置主模型',
  async run({ ctx, feishu, chatId, arg }) {
    const svc = ctx.agentDefaultModel
    const sel = svc?.currentSelection?.()
    if (arg) {
      // accept "provider/model" or bare "model" (keep current provider)
      let provider = sel?.provider || ''
      let model = arg
      if (arg.includes('/')) {
        const [p, ...rest] = arg.split('/')
        provider = p
        model = rest.join('/')
      }
      try {
        await svc.saveSelection({ provider, model, ...(sel?.reasoning ? { reasoning: sel.reasoning } : {}) })
        await feishu.sendCard(chatId, buildCommandCard('🤖 模型已更新', `主模型 → **${provider} / ${model}**\n\n> 新会话生效。`)).catch(() => {})
      } catch (err) {
        await feishu.sendText(chatId, `⚠️ 保存失败：${err?.message || err}`).catch(() => {})
      }
      return
    }
    // list discoverable models per provider
    let modelLines = ''
    try {
      const llm = ctx.get('llm')
      const providers = [...(llm?.adapters?.keys?.() || [])]
      for (const p of providers.slice(0, 5)) {
        try {
          const models = (await llm.listModels(p)) || []
          if (models.length) {
            modelLines += `\n**${p}**：\n${models.slice(0, 10).map((m) => `- \`${typeof m === 'string' ? m : m.id}\``).join('\n')}\n`
          }
        } catch { /* provider may fail listing */ }
      }
    } catch { /* llm service optional */ }
    const body = [
      `**当前主模型**：${sel ? `${sel.provider || '?'} / ${sel.model}` : '(部署默认)'}`,
      sel?.reasoning ? `**reasoning**：${sel.reasoning}` : '',
      '',
      modelLines || '_(模型列表不可用)_',
      '',
      '> 设置：`/model provider/model`（新会话生效）',
    ].filter(Boolean).join('\n')
    await feishu.sendCard(chatId, buildCommandCard('🤖 模型配置', body)).catch(() => {})
  },
})

// ---------------------------------------------------------------------------
// /usage — token/cost analytics from sessionStats projections
// ---------------------------------------------------------------------------
registerCommand({
  name: 'usage',
  usage: '/usage',
  desc: '用量统计（轮次 / token / 耗时 / 花销估算）',
  async run({ ctx, sessions, feishu, chatId }) {
    // Aggregate over this bridge's sessions via the session-projection seam.
    let rows = []
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
        ['输出 tokens', String(sum('decodeTokens'))],
        ['LLM 耗时', fmtMs(sum('llmMs'))],
        ['工具耗时', fmtMs(sum('toolMs'))],
        ['平均 TTFT', fmtMs(Math.round(sum('ttftMs') / n))],
      ]
    } catch (err) {
      await feishu.sendText(chatId, `⚠️ sessionStats 不可用：${err?.message || err}`).catch(() => {})
      return
    }
    const table = ['| 项 | 值 |', '| --- | --- |', ...rows.map((r) => `| ${r[0]} | ${r[1]} |`)].join('\n')
    const body = `${table}\n\n> 统计范围：本桥接创建的全部会话（历史会话若已清理则不计）`
    await feishu.sendCard(chatId, buildCommandCard('📈 用量统计', body)).catch(() => {})
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
// /tools — read-only inventory of mounted tools/plugins
// ---------------------------------------------------------------------------
registerCommand({
  name: 'tools',
  usage: '/tools',
  desc: '查看已挂载的工具/插件清单（只读）',
  async run({ ctx, feishu, chatId }) {
    let body = ''
    try {
      const tools = ctx.get('tools')
      const names = [...(tools?.registry?.keys?.() || [])]
      body = names.length
        ? names.map((t) => `- \`${t}\``).join('\n')
        : '(工具注册表为空或不可枚举)'
    } catch {
      body = '(tools 服务不可用)'
    }
    // plugin inventory (best-effort)
    try {
      const inv = ctx.get('pluginInventory')
      if (inv?.list) {
        const plugins = await inv.list()
        const lines = (plugins || []).map((p) => `- ${p.name || p.id}${p.disabled ? ' _(disabled)_' : ''}`)
        if (lines.length) body += `\n\n**插件**：\n${lines.join('\n')}`
      }
    } catch { /* optional service */ }
    await feishu.sendCard(chatId, buildCommandCard('🔧 工具 / 插件', body || '(无)')).catch(() => {})
  },
})

// ---------------------------------------------------------------------------
// /sessions — list this bridge's sessions
// ---------------------------------------------------------------------------
registerCommand({
  name: 'sessions',
  usage: '/sessions',
  desc: '活跃会话列表',
  async run({ sessions, feishu, chatId }) {
    const rows = ['| chat | session |', '| --- | --- |']
    for (const [cid, sid] of sessions.sessionIds.entries()) {
      const live = sessions.handles.has(cid) ? ' 🟢' : ' ⚪'
      rows.push(`| \`${short(cid)}\`${live} | \`${short(sid)}\` |`)
    }
    const body = rows.length > 2 ? rows.join('\n') : '(暂无会话)'
    await feishu.sendCard(chatId, buildCommandCard('🗂️ 会话列表', body)).catch(() => {})
  },
})

function short(s) {
  s = String(s)
  return s.length > 24 ? s.slice(0, 12) + '…' + s.slice(-8) : s
}

// ---------------------------------------------------------------------------
// /new /reset /stop /verbose are handled in index.js (existing behaviour);
// registered here so /help lists them.
// ---------------------------------------------------------------------------
registerCommand({ name: 'new', usage: '/new', desc: '开启新会话', async run() {} })
registerCommand({ name: 'reset', usage: '/reset', desc: '重置会话（同 /new）', async run() {} })
registerCommand({ name: 'stop', usage: '/stop', desc: '停止当前生成', async run() {} })
