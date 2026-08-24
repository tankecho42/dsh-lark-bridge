/**
 * Streaming card builder.
 *
 * States: thinking (spinner, live reasoning) → streaming (answer) → done.
 * Thinking phase has NO header — content only, per product feedback.
 * The "animation" is a rotating pointer whose frame advances on every
 * throttled card PATCH (each tick re-renders the next frame).
 */

const MAX_CARD_TEXT = 3800

/**
 * Keep the context chart outside the collapsed footer by default: Feishu is
 * known to drop unsupported children together with their whole panel. Set to
 * true for deployment-side rendering tests once chart-in-panel is confirmed.
 */
export const FOOTER_CHART_INSIDE_PANEL = false

/** Human-friendly whole-second duration used by live and completed cards. */
export function fmtSmartSec(seconds) {
  const raw = Number(seconds)
  const total = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0
  if (total < 60) return `${total}s`
  const secs = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${secs}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m${secs}s`
}

function contextOccupancy(contextPressure) {
  const usedValue = contextPressure?.projectedTokens ?? contextPressure?.pressureTokens
  const windowValue = contextPressure?.contextWindow
  if (usedValue == null || windowValue == null) return null
  const rawUsed = Number(usedValue)
  const contextWindow = Number(windowValue)
  if (!Number.isFinite(rawUsed) || rawUsed < 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) return null
  return {
    usedTokens: rawUsed,
    contextWindow,
    chartUsedTokens: Math.min(rawUsed, contextWindow),
    remainingTokens: Math.max(0, contextWindow - rawUsed),
    percent: Math.min(100, Math.round(rawUsed / contextWindow * 100)),
  }
}

/** Plotly-style donut chart for Feishu's 1.0 card chart component. */
export function buildContextDonutChart(contextPressure) {
  const context = contextOccupancy(contextPressure)
  if (!context) return null
  const kv = (n) => Math.round(n / 100) / 10   // K tokens, 1 decimal
  return {
    tag: 'chart',
    chart_spec: {
      type: 'pie',
      outerRadius: 0.8, innerRadius: 0.55,
      color: ['#3370ff', '#dee0e3'],
      data: { values: [
        { type: '已用', value: kv(context.chartUsedTokens) },
        { type: '剩余', value: Math.max(0.1, kv(context.remainingTokens)) },
      ]},
      valueField: 'value', categoryField: 'type',
      label: { visible: true },
      legends: { visible: true, orient: 'bottom' },
      title: { text: '上下文（K tokens）' },
    },
  }
}

/** Echo-style bar chart: per-turn input / output / cache tokens (K). */
export function buildTokenBarChart(tokenUsage) {
  if (!tokenUsage) return null
  const input = (tokenUsage.uncachedInputTokens || 0) + (tokenUsage.cacheWriteTokens || 0)
  const output = tokenUsage.outputTokens || 0
  const cache = tokenUsage.cacheReadTokens || 0
  if (!input && !output && !cache) return null
  const kv = (n) => Math.round(n / 100) / 10
  return {
    tag: 'chart',
    chart_spec: {
      type: 'bar',
      color: ['#3370ff'],
      data: { values: [
        { name: '输入', value: kv(input) },
        { name: '输出', value: kv(output) },
        { name: '缓存命中', value: kv(cache) },
      ]},
      xField: 'name', yField: 'value',
      label: { visible: true },
      title: { text: '输入 / 输出 / 缓存（K tokens）' },
    },
  }
}

function fmtCount(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)).toLocaleString('en-US') : '—'
}

function tokenSummary(tokenUsage) {
  if (!tokenUsage) return '—'
  const uncached = Number(tokenUsage.uncachedInputTokens) || 0
  const cacheRead = Number(tokenUsage.cacheReadTokens) || 0
  const cacheWrite = Number(tokenUsage.cacheWriteTokens) || 0
  const output = Number(tokenUsage.outputTokens) || 0
  const input = Math.max(0, uncached) + Math.max(0, cacheRead) + Math.max(0, cacheWrite)
  const cacheBase = Math.max(0, cacheRead) + Math.max(0, uncached)
  const cacheHit = cacheBase > 0 ? `${Math.round(Math.max(0, cacheRead) / cacheBase * 100)}%` : '—'
  return `Input ${fmtCount(input)} · Output ${fmtCount(output)} · 缓存命中 ${cacheHit}`
}

function contextSummary(contextPressure) {
  const context = contextOccupancy(contextPressure)
  return context
    ? `${fmtCount(context.usedTokens)} / ${fmtCount(context.contextWindow)} tokens（${context.percent}%）`
    : '—'
}

/** Spinner frames — advanced by the PATCH tick loop in index.js. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function clip(text) {
  return text.length > MAX_CARD_TEXT
    ? text.slice(0, MAX_CARD_TEXT) + '\n\n…(内容过长已截断)'
    : text
}

/**
 * Split markdown text into card elements, converting GFM pipe tables into
 * native 2.0 table components (the card markdown component does NOT render
 * raw pipe tables). Returns an array of {tag:'markdown'} / {tag:'table'}.
 */
export function markdownElements(text) {
  const src = String(text ?? '')
  if (!src.includes('|')) return [{ tag: 'markdown', content: clip(src) || '…' }]
  const lines = src.split('\n')
  const out = []
  let buf = []
  let i = 0
  const flush = () => {
    if (buf.length) { out.push({ tag: 'markdown', content: buf.join('\n') }); buf = [] }
  }
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l)
  while (i < lines.length) {
    const line = lines[i]
    const next = lines[i + 1]
    if (line.includes('|') && line.trim().startsWith('|') && next && isSep(next)) {
      // table block: header + separator + data rows until a non-pipe line
      const parse = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      const columns = parse(line).filter((c) => c !== '')
      const rows = []
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim().startsWith('|')) {
        const cells = parse(lines[j])
        if (cells.some((c) => c !== '')) rows.push(cells)
        j++
      }
      if (columns.length) {
        flush()
        const colDefs = columns.map((c) => ({ name: c, display_name: c, data_type: 'text', width: 'auto' }))
        const body = rows.map((r) => {
          const obj = {}
          columns.forEach((c, k) => { obj[c] = String(r[k] ?? '') })
          return obj
        })
        out.push({ tag: 'table', page_size: Math.max(5, body.length + 1), row_height: 'low', columns: colDefs, rows: body })
        i = j
        continue
      }
    }
    buf.push(line)
    i++
  }
  flush()
  if (!out.length) out.push({ tag: 'markdown', content: '…' })
  return out
}

/**
 * Per-tool collapsible panels. One panel per call: header = icon + name
 * (+ ⏳ while running / ✅ when done), body = parameters (native table when
 * args parse as a flat JSON object, code block otherwise) + optional result.
 */
export function toolPanels(tools, { showResult = false, max = 10 } = {}) {
  const TOOL_ICONS = { bash: '🖥️', read: '📄', write: '📝', edit: '✏️', grep: '🔎', glob: '🗂️', browser: '🌐', deepsearch: '🔍' }
  const shown = tools.slice(-max)
  const panels = shown.map((t, i) => {
    const icon = TOOL_ICONS[t.name] || '🔧'
    const running = t.result === undefined && i === shown.length - 1
    const title = `${icon} ${t.name}${running ? ' ⏳' : ''}`
    const body = []
    // parameters: flat JSON object → native table; anything else → code block
    let parsed = null
    if (typeof t.args === 'string') {
      const s = t.args.trim()
      if (s.startsWith('{') && s.endsWith('}')) { try { parsed = JSON.parse(s) } catch { /* not JSON */ } }
    } else if (t.args && typeof t.args === 'object') {
      parsed = t.args
    }
    const flat = parsed && Object.values(parsed).every((v) => typeof v !== 'object' || v === null)
    if (flat && Object.keys(parsed).length) {
      const columns = [
        { name: '参数', display_name: '参数', data_type: 'text', width: 'auto' },
        { name: '值', display_name: '值', data_type: 'text', width: 'auto' },
      ]
      const rows = Object.entries(parsed).map(([k, v]) => ({ 参数: k, 值: String(v ?? '') }))
      body.push({ tag: 'table', page_size: Math.max(5, rows.length + 1), row_height: 'low', columns, rows })
    } else {
      const argsText = String(t.args ?? '').trim()
      body.push({ tag: 'markdown', content: '```\n' + (argsText || '(无参数)') + '\n```' })
    }
    if (showResult && t.result !== undefined) {
      body.push({ tag: 'markdown', content: '**结果**\n```\n' + String(t.result).slice(0, 400) + '\n```' })
    }
    return {
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: title }, icon_tag: 'down_small_with_lefthalf_fill' },
      border: { color: running ? 'yellow' : 'blue' },
      background_color: 'default',
      elements: body,
    }
  })
  if (tools.length > max) {
    panels.unshift({ tag: 'markdown', content: `*…更早的 ${tools.length - max} 次调用已省略*` })
  }
  return panels
}

/**
 * Thinking card: no header. Collapsible panel EXPANDED with spinner + live
 * reasoning streaming inside; collapse happens when answer tokens arrive.
 */
export function buildThinkingCard({ reasoning = '', frame = 0, elapsed } = {}) {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
  const panelTitle = reasoning.trim()
    ? `💡 已思考 ${fmtSmartSec(Math.max(1, elapsed ?? 0))}`
    : `💡 思考中…`
  const panelBody = reasoning.trim()
    ? clip(reasoning)
    : `${spinner} 正在推理…`
  return {
    config: { update_multi: true },
    elements: [
      {
        tag: 'collapsible_panel',
        expanded: true,
        header: { title: { tag: 'plain_text', content: panelTitle }, icon_tag: 'down_small_with_lefthalf_fill' },
        border: { color: 'yellow' },
        background_color: 'default',
        elements: [
          { tag: 'markdown', content: panelBody },
        ],
      },
    ],
  }
}

/**
 * Answering card: collapsed reasoning panel (with total thinking duration)
 * + streaming answer text below it + live tool-activity list.
 */
export function buildStreamingCard(text, { elapsed, reasoning = '', thinkSecs, tools = [] } = {}) {
  const elements = []
  if (reasoning.trim()) {
    const t = thinkSecs != null ? thinkSecs : ''
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: `💡 思考过程${t !== '' ? ` · ${fmtSmartSec(t)}` : ''}` }, icon_tag: 'down_small_with_lefthalf_fill' },
      border: { color: 'yellow' },
      background_color: 'default',
      elements: [
        { tag: 'markdown', content: clip(reasoning) },
      ],
    })
  }
  // per-tool collapsible panels: header = icon + name (+ live status), body = args (+ result)
  if (tools.length) {
    elements.push(...toolPanels(tools))
  }
  elements.push(...markdownElements(text))
  // live footer: elapsed counter keeps ticking during long tool executions (heartbeat)
  if (elapsed != null) {
    elements.push({ tag: 'note', elements: [
      { tag: 'plain_text', content: `⏳ 进行中 · ${fmtSmartSec(elapsed)}` },
    ] })
  }
  return {
    config: { update_multi: true },
    elements,
  }
}

/** Final card: collapsed reasoning panel + full answer + tool summary, footer model + duration.
 *  `continued: true` marks a card sealed early because an approval card was inserted
 *  after it — the rest of the turn streams into a fresh card. */
export function buildDoneCard(text, { elapsed, model, reasoning = '', thinkSecs, tools = [], tokenUsage, contextPressure, continued = false } = {}) {
  const parts = []
  if (continued) parts.push('↪ 待续（见下一条）')
  parts.push(model || '模型 —')
  if (elapsed != null) parts.push(fmtSmartSec(elapsed))
  const elements = []
  if (reasoning.trim()) {
    const t = thinkSecs != null ? thinkSecs : ''
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: `💡 思考过程${t !== '' ? ` · ${fmtSmartSec(t)}` : ''}` }, icon_tag: 'down_small_with_lefthalf_fill' },
      border: { color: 'yellow' },
      background_color: 'default',
      elements: [
        { tag: 'markdown', content: clip(reasoning) },
      ],
    })
  }
  if (tools.length) {
    elements.push(...toolPanels(tools, { showResult: true }))
  }
  elements.push(...markdownElements(text))
if (parts.length) {
    // Echo-v8-style footer panel: title one-liner, expanded = model heading +
    // context donut + token bar + cache-hit line
    const inputT = tokenUsage ? (tokenUsage.uncachedInputTokens || 0) : 0
    const cacheT = tokenUsage ? (tokenUsage.cacheReadTokens || 0) : 0
    const cachePct = inputT > 0 && cacheT > 0 ? Math.min(100, Math.round(cacheT * 100 / (cacheT + inputT))) : 0
    const context = contextOccupancy(contextPressure)
    const inner = []
    inner.push({ tag: 'markdown', content: `**${model || '模型 —'}**` })
    if (context) {
      inner.push({ tag: 'markdown', content: `**上下文占用 ${context.percent}%** · ${fmtCount(context.usedTokens)} / ${fmtCount(context.contextWindow)} tokens` })
      const donut = buildContextDonutChart(contextPressure)
      if (donut) inner.push(donut)
    }
    if (tokenUsage) {
      inner.push({ tag: 'markdown', content: `**本轮 token** · 缓存命中 ${cachePct ? cachePct + '%' : '—'}` })
      const bar = buildTokenBarChart(tokenUsage)
      if (bar) inner.push(bar)
    }
    inner.push({ tag: 'markdown', content: `- **工具调用**：${tools.length} 次
- **整体时长**：${elapsed != null ? fmtSmartSec(elapsed) : '—'}${continued ? '\n- **分段**：本卡为前半段，后续见下一条' : ''}` })
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: `📊 ${parts.join(' · ')}`.slice(0, 80) } },
      border: { color: 'grey' },
      background_color: 'default',
      elements: inner,
    })
  }
  return {
    config: { update_multi: true },
    elements,
  }
}

/** Error card. */
export function buildErrorCard(message) {
  return {
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '⚠️ 出错了' },
      template: 'red',
    },
    elements: [
      { tag: 'markdown', content: '```\n' + String(message).slice(0, MAX_CARD_TEXT) + '\n```' },
    ],
  }
}

/**
 * Generic command-result card (slash commands).
 * Simple 1.0 card with blue header + markdown body — no streaming involved.
 */
export function buildCommandCard(title, markdownBody) {
  return {
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content: clip(markdownBody) },
    ],
  }
    if (tokenUsage) {
      inner.push({ tag: 'markdown', content: `**本轮 token** · 缓存命中 ${cachePct ? cachePct + '%' : '—'}` })
      const bar = buildTokenBarChart(tokenUsage)
      if (bar) inner.push(bar)
    }
    inner.push({ tag: 'markdown', content: `- **工具调用**：${tools.length} 次
- **整体时长**：${elapsed != null ? fmtSmartSec(elapsed) : '—'}${continued ? '\n- **分段**：本卡为前半段，后续见下一条' : ''}` })
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: `📊 ${parts.join(' · ')}`.slice(0, 80) } },
      border: { color: 'grey' },
      background_color: 'default',
      elements: inner,
    })
  }

