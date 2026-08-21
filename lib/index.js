/**
 * @tankecho42/dsh-lark-bridge — DSH 飞书桥接插件（M0 骨架）。
 *
 * Host 侧 Cordis 插件：
 *  - M0: 插件骨架加载进 web profile，注册 lark_bridge_status 工具 + 127.0.0.1
 *    内部 HTTP 状态端点（供 daemon 调用，M1 铺路）。
 *  - M1（规划）: 飞书长连接事件订阅（WS 客户端 daemon），DM 一人一会话、
 *    群聊 @触发 + 共享 workspace 会话，文本经 ctx.agents 进 DSH，回复发回飞书。
 *
 * 参考实现：@lanbaolu/dsh-wechat-bridge（hybrid host plugin + daemon）。
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

// Pull in Context augmentation for agents/session events (types only).
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-session'

export const name = '@tankecho42/dsh-lark-bridge'

/** Host services the plugin needs. */
export const inject = ['tools']

export const Config = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  dataDir: z.string().default(''),
  autoStart: z.boolean().default(true),
})

const PLUGIN_VERSION = '0.1.0'

export function apply(ctx, config) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = config.dataDir || join(dshHome, 'lark-bridge')

  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(dataDir, 'logs'), { recursive: true })

  const pluginLogPath = join(dataDir, 'logs', 'plugin.log')

  function debugLog(message, data) {
    try {
      mkdirSync(join(dataDir, 'logs'), { recursive: true })
      const line = `[${new Date().toISOString()}] [plugin] ${message}${data === undefined ? '' : ' ' + JSON.stringify(data)}\n`
      appendFileSync(pluginLogPath, line, 'utf8')
    } catch {
      // logging must never crash the plugin
    }
  }

  debugLog('plugin loaded', { version: PLUGIN_VERSION, dataDir })

  // -----------------------------------------------------------------------
  // Internal status API (loopback only; M1 daemon will call these)
  // -----------------------------------------------------------------------

  function statusPayload() {
    return {
      ok: true,
      plugin: name,
      version: PLUGIN_VERSION,
      configured: Boolean(config.appId && config.appSecret),
      autoStart: config.autoStart,
      dataDir,
      milestone: 'M0',
    }
  }

  function sendJson(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function startInternalServer() {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
      if (req.method === 'GET' && url.pathname === '/status') {
        sendJson(res, 200, statusPayload())
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      debugLog('internal api listening', { port })
      debugLog('internal api token', { token: randomBytes(8).toString('hex') })
    })

    return server
  }

  // -----------------------------------------------------------------------
  // Model-facing tools (M0: status only)
  // -----------------------------------------------------------------------

  function registerTools() {
    const simpleOutput = {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.message,
      }],
    }

    ctx.tools.register(defineTool({
      name: 'lark_bridge_status',
      description: '查看 DSH 飞书桥接状态：里程碑、配置是否就绪（appId/appSecret）、数据目录。M0 骨架阶段。',
      parameters: {},
      output: simpleOutput,
      execute: async () => {
        const p = statusPayload()
        return {
          ok: true,
          message: `M0 骨架已加载。配置: ${p.configured ? '已就绪' : '未配置（appId/appSecret 待填）'}。数据目录: ${p.dataDir}。版本 ${p.version}。`,
        }
      },
    }))
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ctx.effect(() => {
    const server = startInternalServer()
    registerTools()

    ctx.logger?.info?.('[dsh-lark-bridge] loaded', { dataDir })

    return () => {
      try {
        server.close()
      } catch {
        // ignore
      }
    }
  })
}
