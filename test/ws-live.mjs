import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk'
const appId = process.env.LARK_APP_ID
const appSecret = process.env.LARK_APP_SECRET
if (!appId || !appSecret) throw new Error('set LARK_APP_ID and LARK_APP_SECRET before running this manual test')
const client = new WSClient({
  appId,
  appSecret,
  domain: 'https://open.feishu.cn',
  loggerLevel: 'info',
})
const dispatcher = new EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    console.log('<<< INBOUND MESSAGE:', JSON.stringify(data).slice(0, 500))
  },
})
console.log('connecting...')
client.start({ eventDispatcher: dispatcher }).then(() => {
  console.log('WS STARTED OK — long connection mode is ENABLED')
}).catch((e) => {
  console.log('WS START FAILED:', e?.message || e)
})
setTimeout(() => {
  client.close({ force: true })
  console.log('60s window over, exiting')
  process.exit(0)
}, 60000)
