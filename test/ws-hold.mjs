// 常驻 WS 连接：供飞书后台「长连接验证」用，验证通过后 Ctrl 由外部 kill
import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk'
const client = new WSClient({
  appId: 'cli_aa0280b713b89be7',
  appSecret: 'VOUKsODEBTryL5EZSutRxbmlkuP6tpR6',
  domain: 'https://open.feishu.cn',
  loggerLevel: 'info',
})
const dispatcher = new EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    console.log('<<< INBOUND:', JSON.stringify(data).slice(0, 600))
  },
})
console.log('[ws-hold] connecting...')
client.start({ eventDispatcher: dispatcher }).then(() => {
  console.log('[ws-hold] CONNECTED — 去后台点验证吧，这条连接保持活着')
}).catch((e) => {
  console.log('[ws-hold] FAILED:', e?.message || e)
  process.exit(1)
})
setInterval(() => console.log(`[ws-hold] alive ${new Date().toLocaleTimeString()}`), 30000)
