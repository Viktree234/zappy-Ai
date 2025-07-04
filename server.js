/*****************************************************************
 * server.js — Zappy AI Bot + Dashboard
 * - PostgreSQL auth state   (pgAuth.js)
 * - Real‑time QR / pair‑code via /status   (polling from dashboard)
 * - Group messages only if @mentioned
 * - Emoji “⏳” reaction while thinking
 * - Broadcast, logs, start/stop from dashboard
 *****************************************************************/

import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import axios from 'axios'
import pkg from '@whiskeysockets/baileys'
const { makeWASocket, DisconnectReason, Browsers } = pkg
import { usePostgresAuthState } from './pgAuth.js'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'

/* ─── constants ─────────────────────────────────────────────── */
const TAG       = '_Zappy AI – Smart Chats. Instant Replies by Vik Tree_'
const DATA_DIR  = fs.existsSync('/data') ? '/data' : '.'
const LOG_FILE  = `${DATA_DIR}/logs.json`
const DASH_PIN  = process.env.BROADCAST_PASSWORD || 'admin123'
const bannerUrl = '/assets/banner.png'

/* ─── globals ───────────────────────────────────────────────── */
let sock               = null          // Baileys socket
let currentQR          = null          // last QR string
let currentPairCode    = null          // last pair code
const chatMemory       = {}            // per‑JID memory

/* ─── Express app ───────────────────────────────────────────── */
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use('/assets', express.static('assets'))
app.use(express.static('public'))           // (optional landing page)

/* ─── Baileys auth via Postgres ─────────────────────────────── */
const { state, saveCreds } = await usePostgresAuthState()

/* ─── WhatsApp bot lifecycle ───────────────────────────────── */
async function startBot () {
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: !process.env.PHONE_NUMBER,
    browser: Browsers.macOS('Zappy‑AI‑Bot')
  })

  sock.ev.on('creds.update', saveCreds)

  /* connection updates */
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr, pairingCode }) => {
    if (qr)          { currentQR = qr;     currentPairCode = null; showQR(qr) }
    if (pairingCode) { currentPairCode = pairingCode; currentQR = null; console.log('📲 Pair Code:', pairingCode) }

    if (connection === 'open') {
      console.log('✅ Zappy AI connected')
      currentQR = currentPairCode = null
    }
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      sock = null; currentQR = currentPairCode = null
      if (reason !== DisconnectReason.loggedOut) {
        console.log('⟳ Reconnecting…')
        await startBot()
      } else console.log('❌ Logged out.')
    }
  })

  /* messages */
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return

    const isGroup   = m.key.remoteJid.endsWith('@g.us')
    const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.includes(sock.user.id)
    if (isGroup && !mentioned) return                                     // ignore group noise

    const jid  = m.key.remoteJid
    const text = m.message.conversation ?? m.message.extendedTextMessage?.text ?? ''

    logChat(jid, 'user', text)
    await react(jid, m.key.id, '⏳')                                       // thinking…

    if (text.startsWith('!')) return handleCommand(jid, text)

    if (!chatMemory[jid]) chatMemory[jid] = []
    chatMemory[jid].push({ role: 'user', content: text })

    const ai = await callTogetherChat(chatMemory[jid])
    chatMemory[jid].push({ role: 'assistant', content: ai })

    await sock.sendMessage(jid, { text: `${ai}\n\n${TAG}` })
    logChat(jid, 'bot', ai)
  })
  return sock
}

/* ─── helper: pretty QR in terminal ─────────────────────────── */
function showQR (qr) {
  console.log('Scan this QR to login:')
  try { qrcode.generate(qr, { small: true }) } catch { console.log(qr) }
}

/* ─── commands ─────────────────────────────────────────────── */
async function handleCommand (jid, txt) {
  const cmd = txt.trim().toLowerCase()

  if (cmd === '!help')  return send(jid, helpMsg())
  if (cmd === '!quote') return send(jid, `💡 ${await fetchQuote()}\n\n${TAG}`)

  if (cmd === '!reset') {
    delete chatMemory[jid]
    return send(jid, `🔄 Memory cleared.\n\n${TAG}`)
  }

  if (cmd.startsWith('!img ')) {
    const prompt = txt.slice(5).trim()
    const url = await genImage(prompt)
    return sock.sendMessage(jid, { image: { url }, caption: `🖼️ “${prompt}”\n\n${TAG}` })
  }
  return send(jid, `❓ Unknown command. Type *!help*\n\n${TAG}`)
}

/* ─── wrappers ─────────────────────────────────────────────── */
const send  = (jid, text) => sock.sendMessage(jid, { text })
const react = (jid, id, emoji) =>
  sock.sendMessage(jid, { react: { text: emoji, key: { id, remoteJid: jid, fromMe: false } } })

/* ─── AI/chat + image + quote ──────────────────────────────── */
async function callTogetherChat (history) {
  try {
    const { data } = await axios.post(
      process.env.TOGETHER_CHAT_URL,
      { model: process.env.TOGETHER_MODEL, messages: history, max_tokens: 512 },
      { headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` } }
    )
    return data.choices[0].message.content.trim()
  } catch (e) {
    console.error('Together error:', e.message)
    return '⚠️ Sorry, I cannot think right now.'
  }
}
async function genImage (prompt) {
  try {
    const { data } = await axios.post(
      'https://api.together.xyz/v1/images/generations',
      { model: process.env.TOGETHER_IMAGE_MODEL, prompt, n: 1, size: '512x512' },
      { headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` } }
    )
    return data.data[0].url
  } catch { return 'https://via.placeholder.com/512?text=Image+Error' }
}
async function fetchQuote () {
  try {
    const { data } = await axios.get('https://api.quotable.io/random')
    return `"${data.content}" — ${data.author}`
  } catch { return 'Keep going. You are amazing!' }
}

/* ─── logs file ────────────────────────────────────────────── */
function logChat (jid, who, msg) {
  const entry = { time: new Date().toISOString(), jid, who, msg }
  let logs = []
  try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) } catch {}
  logs.push(entry)
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2))
}

/* ─── static HTML builder ─────────────────────────────────── */
function html (body) {
  return `<!DOCTYPE html><html><head><title>Zappy AI Dashboard</title>
<style>
body{font-family:sans-serif;background:#f5f5f5;text-align:center;padding:20px}
h1{color:#d62828}.cn{max-width:700px;margin:auto;background:#fff;padding:20px;border-radius:10px;box-shadow:0 0 10px #ccc}
textarea{width:100%;padding:10px}input{padding:6px}button{background:#d62828;color:#fff;border:none;padding:10px 20px;border-radius:5px}
ul{padding:0}li{list-style:none;margin:10px 0}#qr img{width:200px;height:200px}
</style></head><body><div class="cn">
<img src="${bannerUrl}" alt="logo" style="width:200px;margin-bottom:20px"/>${body}
<hr><p><i>${TAG}</i></p></div>

<script>
async function poll(){
  const r = await fetch('/status'); const d = await r.json()
  document.getElementById('st').textContent = d.running ? '🟢 Bot running' : '🔴 Bot stopped'
  const box = document.getElementById('pair')
  if(d.qr)      box.innerHTML='<div id="qr"><img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data='+encodeURIComponent(d.qr)+'"/></div>'
  else if(d.pairingCode) box.innerHTML='<p><b>📲 Pair Code:</b> '+d.pairingCode+'</p>'
  else        box.innerHTML=''
}
setInterval(poll,3000); poll()
</script></body></html>`
}

/* ─── dashboard ------------------------------------------------ */
app.get('/', (_, res) => {
  res.send(html(`
<h1>🤖 Zappy AI Dashboard</h1>
<p id="st">${sock ? '🟢 Bot running' : '🔴 Bot stopped'}</p>
<div id="pair"></div>
<ul>
  <li><a href="/start">🚀 Start Bot</a></li>
  <li><a href="/logs">📜 View Logs</a></li>
  <li><a href="/clear">♻️ Clear Logs</a></li>
</ul>
<form method="POST" action="/broadcast">
  <h3>📣 Broadcast</h3>
  <input name="password" type="password" placeholder="PIN" required><br><br>
  <textarea name="message" rows="5" placeholder="Type message…"></textarea><br><br>
  <button type="submit">Send</button>
</form>`))
})

app.get('/start', async (_, res) => {
  if (sock) return res.send(html('<p>✅ Bot already running.</p><a href="/">Back</a>'))
  try { await startBot(); res.redirect('/') }
  catch { res.send(html('<p style="color:red">❌ Failed to start bot.</p><a href="/">Back</a>')) }
})
app.get('/status', (_, res) => res.json({ running: !!sock, qr: currentQR, pairingCode: currentPairCode }))
app.get('/logs',   (_, res) => { let l=[]; try{l=JSON.parse(fs.readFileSync(LOG_FILE,'utf8'))}catch{} res.send(html(`<pre>${JSON.stringify(l,null,2)}</pre>`))})
app.get('/clear',  (_, res) => { fs.writeFileSync(LOG_FILE,'[]'); res.redirect('/')})
app.post('/broadcast', async (req,res)=>{
  const { password, message } = req.body
  if(password!==DASH_PIN) return res.send(html('<p style="color:red">❌ Wrong PIN.</p><a href="/">Back</a>'))
  if(!sock) return res.send(html('<p style="color:red">❌ Bot not running.</p><a href="/">Back</a>'))
  const users=[...new Set(JSON.parse(fs.readFileSync(LOG_FILE,'utf8')).map(x=>x.jid))]
  let sent=0
  for(const jid of users){ try{ await sock.sendMessage(jid,{text:`${message.trim()}\n\n${TAG}`}); sent++ }catch{} }
  res.send(html(`<p>✅ Broadcast sent to ${sent} user(s).</p><a href="/">Back</a>`))
})

/* ─── /send API ─────────────────────────────────────────────── */
app.post('/send', async (req,res)=>{
  const { to, text } = req.body
  if(!sock) return res.status(503).send('Bot not ready')
  try{ await sock.sendMessage(to,{text}); res.send('ok') }catch{ res.status(500).send('fail') }
})

/* ─── launch server ─────────────────────────────────────────── */
const PORT = process.env.PORT || 4000
app.listen(PORT, ()=>console.log(`🚀 Zappy server running on ${PORT}`))

/* ─── help text for bot ─────────────────────────────────────── */
function helpMsg(){
  return `🧠 *Zappy AI Commands*\n\n• *!help* – Show this menu\n• *!quote* – Get a motivational quote\n• *!img [prompt]* – Generate an image\n• *!reset* – Clear memory\n• Chat freely – Talk to AI\n\n${TAG}`
}
