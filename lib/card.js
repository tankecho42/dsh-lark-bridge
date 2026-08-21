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
 * Thinking card: no header. Body = spinner line + streamed reasoning (dim quote).
 * @param {object} opts
 * @param {string} [opts.reasoning]  accumulated reasoning text so far
 * @param {number} [opts.frame]      spinner frame index
 * @param {number} [opts.elapsed]    seconds since turn start
 */
export function buildThinkingCard({ reasoning = '', frame = 0, elapsed } = {}) {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
  const elapsedTag = elapsed != null ? ` · ${elapsed}s` : ''
  const elements = []
  if (reasoning.trim()) {
    elements.push({ tag: 'markdown', content: `${spinner} 思考中${elapsedTag}\n> ${clip(reasoning).replace(/\n/g, '\n> ')}` })
  } else {
    elements.push({ tag: 'markdown', content: `${spinner} 思考中${elapsedTag}` })
  }
  return { config: { update_multi: true }, elements }
}

/**
 * Streaming card: answer text growing, with the last reasoning tail available
 * but normally dropped once answer tokens arrive (answer replaces thinking).
 */
export function buildStreamingCard(text, { elapsed } = {}) {
  const elapsedTag = elapsed != null ? ` · ${elapsed}s` : ''
  return {
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `⚙️ 回复生成中${elapsedTag}` },
      template: 'blue',
    },
    elements: [
      { tag: 'markdown', content: clip(text) || '…' },
    ],
  }
}

/** Final card: header ✅, body full text, footer model + duration. */
export function buildDoneCard(text, { elapsed, model } = {}) {
  const parts = []
  if (model) parts.push(model)
  if (elapsed != null) parts.push(`${elapsed}s`)
  const elements = [{ tag: 'markdown', content: clip(text) || '(空回复)' }]
  if (parts.length) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: parts.join(' · ') }],
    })
  }
  return {
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '✅ Echo-DSH' },
      template: 'green',
    },
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
