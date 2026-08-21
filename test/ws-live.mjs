import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk'
const client = new WSClient({
  appId: 'cli_aa0280b713b89be7',
  appSecret: 'VOUKsODEBTryL5EZSutRxbmlkuP6tpR6',
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
setTimeout(() => { console.log('60s window over, exiting'); process.exit(0) }, 60000)
