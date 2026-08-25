/**
 * Agent setup for bridge-created agents.
 *
 * Mounts the deployment default preset — WITHOUT this, tools/skills/prompt
 * sections all fall back to the empty global layer (dsh-agent-presets warns
 * "published without joining an agent preset"), so shell and the other
 * preset-provided tools are unavailable. Same fix the wechat bridge uses.
 *
 * Also registers a channel-behavior prompt section tuned for Feishu.
 */

/** Feishu channel prompt section name (scoped; does not affect global sections). */
export const LARK_CHANNEL_SECTION = 'lark-bridge-channel'

/** Feishu channel behavior constraints (order 150 → tool-guidance band 100–199). */
export const LARK_CHANNEL_PROMPT = [
  '你正在通过「飞书桥」与用户对话：用户在飞书手机/桌面端收发消息，适合短段落、结论先行的回复。',
  '不要使用交互式选项/提问工具（如 ask_user_question）：弹出的界面用户看不到也无法点击，调用后你会卡住。',
  '需要用户选择或确认时，直接用纯文本列出编号选项（1. 2. 3.），以问句结尾，等用户回复数字或文字再继续。',
  '你有完整的 shell 与工具能力（来自已挂载的 agent preset），可以正常执行命令、读写文件。',
].join('\n')

/**
 * @param {object} deps
 * @param {(msg: string, data?: object) => void} [deps.log]
 * @returns {(agentCtx: import('@deepseek-ai/cordis').Context) => Promise<void>}
 */
export function createLarkAgentSetup(deps = {}) {
  const log = deps.log ?? (() => {})
  const deniedTools = [...new Set((deps.deniedTools || []).map(String).filter(Boolean))]

  return async (agentCtx) => {
    // Mount the deployment default preset: gives the agent its tools
    // (shell, read/write, …), skills, and prompt sections.
    try {
      const presets = agentCtx.get('agentPresets')
      if (presets?.mount) {
        const mounted = await presets.mount(agentCtx)
        log('agent preset mounted', { preset: mounted?.id })
      } else {
        log('agentPresets service unavailable, agent stays on global layer', {})
      }
    } catch (err) {
      log('agent preset mount failed (agent falls back to global layer)', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Per-chat tool policy. tools.restrict() is intentionally agent-scoped;
    // applying it here avoids mutating the global host registry.
    if (deniedTools.length) {
      try {
        const tools = agentCtx.get('tools')
        const visible = tools?.view?.(undefined)?.visible
        const known = visible ? new Set(visible.keys()) : null
        const effective = deniedTools.filter((name) => name !== 'run_code' && (!known || known.has(name)))
        const ignored = deniedTools.filter((name) => !effective.includes(name))
        if (effective.length) tools?.restrict?.({ deny: effective })
        log('agent tool restrictions applied', { deny: effective, ignored })
      } catch (err) {
        log('agent tool restriction failed', {
          deny: deniedTools,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Channel behavior prompt section.
    try {
      const systemPrompt = agentCtx.get('systemPrompt')
      systemPrompt?.section?.({ name: LARK_CHANNEL_SECTION, order: 150, text: LARK_CHANNEL_PROMPT })
    } catch (err) {
      log('systemPrompt section registration failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
