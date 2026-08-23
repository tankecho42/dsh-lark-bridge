/**
 * Feishu card builders for slash commands (schema 2.0).
 * Native table component + interactive buttons (callbacks handled in feishu.js).
 *
 * 2.0 table cells are BARE STRINGS keyed by column name — not the 1.0
 * {paragraph:[{tag:lark_md}]} envelope.
 */

export function cmdCard(title, elements, { template = 'blue' } = {}) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements },
  }
}

export function md(content) {
  return { tag: 'markdown', content }
}

/** Native 2.0 table. rows: array of arrays; columns: strings or {name, display_name}. */
export function table({ columns, rows }) {
  const cols = columns.map((c) => ({
    name: typeof c === 'string' ? c : c.name,
    display_name: typeof c === 'string' ? c : (c.display_name ?? c.name),
    data_type: 'text',
    width: 'auto',
  }))
  const body = rows.map((r) => {
    const obj = {}
    cols.forEach((c, i) => { obj[c.name] = String(r[i] ?? '') })
    return obj
  })
  return { tag: 'table', page_size: Math.max(5, rows.length + 1), row_height: 'low', columns: cols, rows: body }
}

/** One button per row (full-width). value passed back in card action callback. */
export function buttonRows(buttons) {
  return buttons.map((b) => ({
    tag: 'column_set',
    columns: [{
      tag: 'column', width: 'weighted', weight: 1,
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: String(b.text).slice(0, 36) },
        type: b.primary ? 'primary' : 'default',
        disabled: !!b.disabled,
        value: b.value || {},
      }],
    }],
  }))
}

/** Footer hint line. */
export function hint(text) {
  return md(`*${text}*`)
}
