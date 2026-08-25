/**
 * Slash command framework for the Feishu bridge (schema 2.0 cards).
 *
 * Registry pattern: each command is { name, aliases, usage, desc, run }.
 * Interactive cards carry `bridge_action` values; the card-action callback
 * in index.js dispatches them back to `handleBridgeAction` below.
 */
import { accessSync, constants, statSync } from 'node:fs'
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
  const settings = ctx.get('settings')
  if (settings?.replace) {
    await settings.replace('agent-presets', { default: presetId })
    return true
  }
  throw new Error('settings provider unavailable')
}

/** Tools visible to the global scope via the tools service's view(). */
function visibleTools(ctx) {
  try {
    const tools = ctx.get('tools')
    const view = tools?.view?.(undefined)
    return view?.visible ? [...view.visible.keys()] : []
  } catch {
    return []
  }
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
    ]))
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
    const override = sessions.chatModelOf?.(chatId) || null
    let globalModel = '(部署默认)'
    try {
      const sel = ctx.agentDefaultModel?.currentSelection?.()
      if (sel?.model) globalModel = `${sel.provider || '?'} / ${sel.model}`
    } catch { /* keep default */ }
    const model = override ? `${override.provider} / ${override.model}（本会话覆盖）` : globalModel
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
      ...(override ? [['全局默认', `\`${globalModel}\``]] : []),
      ['工作目录', `\`${sessions.cwdOf?.(chatId) || sessions.defaultCwd}\``],
      ['活跃会话数', String(sessions.handles.size)],
    ]
    await feishu.sendCard(chatId, cmdCard('📊 会话状态', [
      table({ columns: ['项', '值'], rows }),
    ]))
  },
})

// ---------------------------------------------------------------------------
// /cwd — per-chat persistent workspace (switching requires a fresh session)
// ---------------------------------------------------------------------------
registerCommand({
  name: 'cwd',
  usage: '/cwd [绝对路径]',
  desc: '查看/切换当前聊天的工作目录（切换会新建会话）',
  async run({ sessions, feishu, chatId, arg }) {
    if (!arg) {
      await feishu.sendCard(chatId, cmdCard('📁 工作目录', [
        md(`当前：\`${sessions.cwdOf(chatId)}\``),
        hint('切换：/cwd /absolute/path；切换后自动开启新会话'),
      ]))
      return
    }
    const cwd = sessions.setCwd(chatId, arg)
    await sessions.reset(chatId)
    await feishu.sendCard(chatId, cmdCard('📁 工作目录已切换', [
      md(`当前：\`${cwd}\``),
      md('已为该目录开启新会话。'),
    ], { template: 'turquoise' }))
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
      await feishu.sendText(chatId, `⚠️ agentPresets 服务不可用：${err?.message || err}`)
      return
    }
    const current = svc.defaultId
    const cur = presets.find((p) => p.id === current)

    if (arg) {
      const wanted = presets.find((p) => p.id === arg || String(p.name || '').includes(arg))
      if (!wanted) {
        await feishu.sendText(chatId, `⚠️ 未找到模式「${arg}」。可用：${presets.map((p) => p.id).join(' / ')}`)
        return
      }
      await applyModeSwitch({ ctx, feishu, chatId, preset: wanted })
      return
    }

    const rows = presets.map((p) => [
      p.id === current ? '✅ 当前' : '',
      `${p.name || p.id}`,
      p.id,
      (p.description || '').slice(0, 50),
    ])
    await feishu.sendCard(chatId, cmdCard('🎛️ Agent 模式', [
      md(`当前默认：**${cur?.name || current || '(默认)'}**`),
      table({ columns: ['状态', '模式', 'ID', '说明'], rows }),
      md('点击切换（新会话生效）：'),
      ...buttonRows(presets.map((p) => ({
        text: `${p.id === current ? '✅ ' : ''}${p.name || p.id}`,
        value: { bridge_action: 'mode_switch', preset_id: p.id },
        disabled: p.id === current,
      }))),
      hint('切换只影响新会话；运行中的会话保持原模式'),
    ]))
  },
})

async function applyModeSwitch({ ctx, feishu, chatId, preset }) {
  try {
    await switchPreset(ctx, preset.id)
    await feishu.sendCard(chatId, cmdCard('🔀 模式已切换', [
      md(`默认模式 → **${preset.name || preset.id}**（\`${preset.id}\`）`),
      md(preset.description || ''),
      hint('新会话生效；运行中的会话不受影响'),
    ], { template: 'turquoise' }))
  } catch (err) {
    await feishu.sendText(chatId, `⚠️ 切换失败：${err?.message || err}`)
  }
}

// ---------------------------------------------------------------------------
// /model — per-chat model selection (the global default stays untouched;
// /model reset drops the chat override)
// ---------------------------------------------------------------------------
registerCommand({
  name: 'model',
  usage: '/model [provider/model | reset]',
  desc: '查看/配置本会话模型（不影响全局默认）',
  async run({ ctx, sessions, feishu, chatId, arg }) {
    const override = sessions.chatModelOf?.(chatId) || null
    const globalSel = ctx.agentDefaultModel?.currentSelection?.()

    if (arg && arg.toLowerCase() === 'reset') {
      try {
        const removed = sessions.clearChatModel(chatId)
        if (removed) await sessions.refreshAgent(chatId)
        await feishu.sendCard(chatId, cmdCard(removed ? '🤖 本会话模型已重置' : 'ℹ️ 本会话未设置模型覆盖', [
          md(removed
            ? `已恢复跟随全局默认：**${globalSel?.provider || '?'} / ${globalSel?.model || '(部署默认)'}**`
            : '当前本来就是全局默认模型'),
          hint('下一条消息起新模型生效，对话上下文保留'),
        ], { template: 'turquoise' }))
      } catch (err) {
        await feishu.sendText(chatId, `⚠️ 重置失败：${err?.message || err}`).catch(() => {})
      }
      return
    }

    if (arg) {
      let provider = override?.provider || globalSel?.provider || ''
      let model = arg
      if (arg.includes('/')) {
        const [p, ...rest] = arg.split('/')
        provider = p
        model = rest.join('/')
      }
      await applyModelSwitch({ sessions, feishu, chatId, provider, model })
      return
    }

    // current selection: chat override > global default
    const effective = override || (globalSel ? { provider: globalSel.provider, model: globalSel.model } : null)

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
      md(`**本会话模型**：${effective ? `\`${effective.provider || '?'} / ${effective.model}\`` : '(部署默认)'}`),
      md(override
        ? `_覆盖设置（仅本会话）；全局默认仍是 \`${globalSel?.provider || '?'}/${globalSel?.model || '?'}\`。用 \`/model reset\` 恢复跟随全局_`
        : '_跟随全局默认；在此切换只影响本会话_'),
    ]
    if (discovered.length) {
      const rows = discovered.map((d) => [
        d.provider === effective?.provider && d.model === effective?.model ? '✅ 当前' : '',
        d.model,
        d.provider,
      ])
      elements.push(table({ columns: ['状态', '模型', 'provider'], rows }))
      elements.push(md('点击切换（仅本会话，上下文保留）：'))
      elements.push(...buttonRows([
        ...discovered.slice(0, 8).map((d) => ({
          text: `${d.model}`,
          value: { bridge_action: 'model_switch', provider: d.provider, model: d.model },
          disabled: d.provider === effective?.provider && d.model === effective?.model,
        })),
        ...(override ? [{ text: '↩️ 重置为全局默认', value: { bridge_action: 'model_reset' } }] : []),
      ]))
    } else {
      elements.push(md('_(模型列表不可用；用 `/model provider/model` 手动设置，`/model reset` 恢复默认)_'))
    }
    await feishu.sendCard(chatId, cmdCard('🤖 模型配置（本会话）', elements))
  },
})

async function applyModelSwitch({ sessions, feishu, chatId, provider, model }) {
  try {
    sessions.setChatModel(chatId, provider, model)
    await sessions.refreshAgent(chatId)
    await feishu.sendCard(chatId, cmdCard('🤖 本会话模型已更新', [
      md(`本会话模型 → **${provider} / ${model}**`),
      hint('仅本会话生效；全局默认不变；下一条消息起用新模型，上下文保留'),
    ], { template: 'turquoise' }))
  } catch (err) {
    await feishu.sendText(chatId, `⚠️ 保存失败：${err?.message || err}`).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// /usage — sessionStats aggregation via agent.session objects
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
      for (const [, handle] of sessions.handles.entries()) {
        try {
          const snap = projections.snapshot?.(handle.agent.session)
          const s = snap?.values?.sessionStats
          if (s) stats.push(s)
        } catch { /* session may be gone */ }
      }
      const sum = (k) => stats.reduce((a, s) => a + (Number(s[k]) || 0), 0)
      const n = stats.length || 1
      rows = [
        ['在线会话数', String(stats.length)],
        ['轮次 turns', String(sum('turns'))],
        ['步骤 steps', String(sum('steps'))],
        ['输出 tokens', sum('decodeTokens').toLocaleString()],
        ['LLM 耗时', fmtMs(sum('llmMs'))],
        ['工具耗时', fmtMs(sum('toolMs'))],
        ['平均 TTFT', fmtMs(Math.round(sum('ttftMs') / n))],
      ]
    } catch (err) {
      await feishu.sendText(chatId, `⚠️ sessionStats 不可用：${err?.message || err}`)
      return
    }
    await feishu.sendCard(chatId, cmdCard('📈 用量统计', [
      table({ columns: ['指标', '值'], rows }),
      hint('统计范围：当前在线（活跃挂载）的桥接会话'),
    ]))
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
// /tools — per-chat agent-scoped tool policy + plugin inventory
// ---------------------------------------------------------------------------
registerCommand({
  name: 'tools',
  usage: '/tools [on|off 工具名]',
  desc: '查看/切换当前聊天的 Agent 工具（新会话生效）',
  async run({ ctx, sessions, feishu, chatId, arg }) {
    if (arg) {
      const match = String(arg).trim().match(/^(on|off)\s+(.+)$/i)
      if (!match) {
        await feishu.sendText(chatId, '用法：/tools on 工具名 或 /tools off 工具名')
        return
      }
      const enabled = match[1].toLowerCase() === 'on'
      const toolName = match[2].trim()
      const known = visibleTools(ctx)
      if (!known.includes(toolName)) {
        await feishu.sendText(chatId, `⚠️ 未找到工具「${toolName}」。可用：${known.join(' / ') || '(无)'}`)
        return
      }
      sessions.setToolEnabled(chatId, toolName, enabled)
      await sessions.reset(chatId)
    }
    await feishu.sendCard(chatId, await buildToolsCard({ ctx, sessions, chatId }))
  },
})

async function buildToolsCard({ ctx, sessions, chatId, operator }) {
  const tools = visibleTools(ctx).sort()
  const denied = new Set(sessions.toolDenyOf?.(chatId) || [])
  const rows = tools.map((name) => [name, name === 'run_code' ? '🔒 保留' : denied.has(name) ? '⛔ 已停用' : '✅ 已启用'])
  try {
    const inv = ctx.get('pluginInventory')
    if (inv?.list) {
      const plugins = (await inv.list()) || []
      for (const p of plugins) rows.push([String(p.name || p.id), p.disabled ? '插件（停用）' : '插件（只读）'])
    }
  } catch { /* optional inventory */ }
  const elements = rows.length
    ? [table({ columns: ['名称', '状态'], rows })]
    : [md('(工具注册表为空或不可枚举)')]
  const switchable = tools.filter((name) => name !== 'run_code').slice(0, 20)
  if (switchable.length) {
    elements.push(md('点击切换当前聊天的工具策略：'))
    elements.push(...buttonRows(switchable.map((name) => ({
      text: `${denied.has(name) ? '启用' : '停用'} ${name}`,
      value: { bridge_action: 'tool_toggle', tool_name: name, enabled: denied.has(name) },
    }))))
  }
  if (operator) elements.push(md(`操作的用户：${operator}`))
  elements.push(hint('工具策略按聊天持久化；切换会自动新建会话。插件清单仅展示，不能在桥内全局停用。'))
  return cmdCard('🔧 工具 / 插件', elements)
}

// ---------------------------------------------------------------------------
// /doctor — read-only bridge self-check (never exposes credentials)
// ---------------------------------------------------------------------------
registerCommand({
  name: 'doctor',
  usage: '/doctor',
  desc: '检查飞书连接、目录、模型、工具与发送队列',
  async run({ ctx, sessions, feishu, chatId }) {
    const rows = []
    let problems = 0

    const add = (level, item, detail) => {
      const marker = level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : '❌'
      if (level === 'error') problems++
      rows.push([marker, item, String(detail)])
    }

    const wsState = String(feishu.connectionStatus?.() || 'unknown')
    if (wsState === 'connected') add('ok', '飞书长连接', wsState)
    else if (wsState === 'connecting' || wsState === 'reconnecting' || wsState === 'starting') add('warn', '飞书长连接', wsState)
    else add('error', '飞书长连接', wsState)

    const workspace = sessions.cwdOf?.(chatId) || sessions.defaultCwd
    const workspaceCheck = inspectDirectory(workspace)
    add(workspaceCheck.ok ? 'ok' : 'error', '工作目录', workspaceCheck.detail)

    const dataCheck = inspectDirectory(sessions.dataDir)
    add(dataCheck.ok ? 'ok' : 'error', '状态目录', dataCheck.detail)

    let selection
    try { selection = ctx.agentDefaultModel?.currentSelection?.() } catch { /* reported below */ }
    const override = sessions.chatModelOf?.(chatId) || null
    if (override) add('ok', '本会话模型', `${override.provider} / ${override.model}（覆盖）`)
    else if (selection?.provider && selection?.model) add('ok', '默认模型', `${selection.provider} / ${selection.model}`)
    else add('warn', '默认模型', '使用部署默认或当前不可读取')

    const toolNames = visibleTools(ctx)
    if (toolNames.length) add('ok', 'Agent 工具', `${toolNames.length} 个可见`)
    else add('warn', 'Agent 工具', '注册表为空或不可枚举')

    const diagnostics = feishu.diagnostics?.()
    if (diagnostics) {
      add('ok', '卡片发送队列', `${diagnostics.pendingCardMessages || 0} 个消息待处理；已合并 ${diagnostics.coalescedCardUpdates || 0} 次`)
      add(diagnostics.retries ? 'warn' : 'ok', 'API 重试', `${diagnostics.retries || 0} 次`)
    }

    const sid = sessions.sessionIds?.get(chatId)
    add('ok', '当前会话', sid ? `已绑定 ${short(sid)}` : '尚未创建（收到普通消息后创建）')

    await feishu.sendCard(chatId, cmdCard(
      problems ? `🩺 自检发现 ${problems} 个问题` : '🩺 自检通过',
      [
        table({ columns: ['状态', '检查项', '详情'], rows }),
        hint('该命令只做本地只读检查，不会显示 App Secret，也不会修改配置或重启服务。'),
      ],
      { template: problems ? 'orange' : 'turquoise' },
    ))
  },
})

function inspectDirectory(path) {
  if (!path) return { ok: false, detail: '(未配置)' }
  try {
    if (!statSync(path).isDirectory()) return { ok: false, detail: `${path}（不是目录）` }
    accessSync(path, constants.R_OK | constants.W_OK)
    return { ok: true, detail: `${path}（可读写）` }
  } catch (err) {
    return { ok: false, detail: `${path}（${err?.code || err?.message || '不可访问'}）` }
  }
}

// ---------------------------------------------------------------------------
// /sessions
// ---------------------------------------------------------------------------
registerCommand({
  name: 'sessions',
  usage: '/sessions',
  desc: '活跃会话列表',
  async run({ sessions, feishu, chatId }) {
    const rows = []
    const fmtAgo = (ts) => {
      if (!ts) return '—'
      const mins = Math.floor((Date.now() - ts) / 60000)
      if (mins < 1) return '刚刚'
      if (mins < 60) return `${mins} 分钟前`
      const hours = Math.floor(mins / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
    }
    for (const [cid, sid] of sessions.sessionIds.entries()) {
      rows.push([
        `\`${short(cid)}\``,
        `\`${short(sid)}\``,
        sessions.handles.has(cid) ? '🟢 活跃' : '⚪ 持久化',
        fmtAgo(sessions.chatLastActive?.get(cid)),
      ])
    }
    await feishu.sendCard(chatId, cmdCard('🗂️ 会话列表', [
      table({ columns: ['chat', 'session', '状态', '最近活跃'], rows }),
    ]))
  },
})

function short(s) {
  s = String(s)
  return s.length > 24 ? s.slice(0, 12) + '…' + s.slice(-8) : s
}

// ---------------------------------------------------------------------------
// Card action dispatcher (called from index.js on 'card.action.trigger')
// ---------------------------------------------------------------------------
export async function handleBridgeAction({ action, operator, ctx, sessions, feishu, chatId }) {
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
    await applyModelSwitch({ sessions, feishu, chatId, provider: value.provider, model: value.model })
    return {
      card: cmdCard('🤖 本会话模型已更新', [
        md(`✅ 本会话模型 → **${value.provider} / ${value.model}**`),
        md(`操作的用户：${operator?.name || operator?.openId || 'unknown'}`),
        hint('仅本会话生效；全局默认不变；上下文保留'),
      ], { template: 'turquoise' }),
    }
  }

  if (bridgeAction === 'model_reset') {
    const removed = sessions.clearChatModel?.(chatId)
    if (removed) await sessions.refreshAgent?.(chatId)
    return {
      card: cmdCard('🤖 本会话模型已重置', [
        md('已恢复跟随全局默认模型'),
        md(`操作的用户：${operator?.name || operator?.openId || 'unknown'}`),
        hint('下一条消息起生效，对话上下文保留'),
      ], { template: 'turquoise' }),
    }
  }

  if (bridgeAction === 'tool_toggle') {
    const toolName = String(value.tool_name || '')
    if (!visibleTools(ctx).includes(toolName)) return { text: `⚠️ 未找到工具 ${toolName}` }
    sessions.setToolEnabled(chatId, toolName, value.enabled === true || value.enabled === 'true')
    await sessions.reset(chatId)
    return {
      card: await buildToolsCard({
        ctx, sessions, chatId,
        operator: operator?.name || operator?.openId || 'unknown',
      }),
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
