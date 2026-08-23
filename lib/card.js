/**
 * Streaming card builder.
 *
 * States: thinking (spinner, live reasoning) → streaming (answer) → done.
 * Thinking phase has NO header — content only, per product feedback.
 * The "animation" is a rotating pointer whose frame advances on every
 * throttled card PATCH (each tick re-renders the next frame).
 */

const MAX_CARD_TEXT = 3800

/** Spinner frames — advanced by the PATCH tick loop in index.js. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function clip(text) {
  return text.length > MAX_CARD_TEXT
    ? text.slice(0, MAX_CARD_TEXT) + '\n\n…(内容过长已截断)'
    : text
}

/**
 * Thinking card: no header. Collapsible panel EXPANDED with spinner + live
 * reasoning streaming inside; collapse happens when answer tokens arrive.
 */
export function buildThinkingCard({ reasoning = '', frame = 0, elapsed } = {}) {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
  const panelTitle = reasoning.trim()
    ? `💡 已思考 ${Math.max(1, Math.round(elapsed ?? 0))}s`
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
 * + streaming answer text below it.
 */
export function buildStreamingCard(text, { elapsed, reasoning = '', thinkSecs } = {}) {
  const elements = []
  if (reasoning.trim()) {
    const t = thinkSecs != null ? thinkSecs : ''
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: `💡 思考过程${t !== '' ? ` · ${t}s` : ''}` }, icon_tag: 'down_small_with_lefthalf_fill' },
      border: { color: 'yellow' },
      background_color: 'default',
      elements: [
        { tag: 'markdown', content: clip(reasoning) },
      ],
    })
  }
  elements.push({ tag: 'markdown', content: clip(text) || '…' })
  return {
    config: { update_multi: true },
    elements,
  }
}

/** Final card: collapsed reasoning panel + full answer, footer model + duration. */
export function buildDoneCard(text, { elapsed, model, reasoning = '', thinkSecs } = {}) {
  const parts = []
  if (model) parts.push(model)
  if (elapsed != null) parts.push(`${elapsed}s`)
  const elements = []
  if (reasoning.trim()) {
    const t = thinkSecs != null ? thinkSecs : ''
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: `💡 思考过程${t !== '' ? ` · ${t}s` : ''}` }, icon_tag: 'down_small_with_lefthalf_fill' },
      border: { color: 'yellow' },
      background_color: 'default',
      elements: [
        { tag: 'markdown', content: clip(reasoning) },
      ],
    })
  }
  elements.push({ tag: 'markdown', content: clip(text) || '(空回复)' })
  if (parts.length) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: parts.join(' · ') }],
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
}
