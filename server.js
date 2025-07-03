import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import axios from 'axios'
import path from 'path'
import { Client } from 'pg'
import {
  makeWASocket,
  useSingleFileAuthState,
  usePostgresAuthState,
  Browsers,
  DisconnectReason
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'

/* ─────── PostgreSQL Setup ─────── */
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
await db.query(`
  CREATE TABLE IF NOT EXISTS auth_state (
    id TEXT PRIMARY KEY,
    data JSONB
  )
`)

/* ─────── Express Setup ─────── */
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use('/assets', express.static('assets'))

const TAG = '_Zappy AI – Smart Chats. Instant Replies by Vik Tree_'
const chatMemory = {}
const AUTH_ID = 'zappy_auth'

/* ─────── Auth using PostgreSQL ─────── */
const { state, saveCreds } = await usePostgresAuthState({ db, tableName: 'auth_state', id: AUTH_ID })

/* ========== WhatsApp Bot ========== */
startBot()

let sock = null
async function startBot () {
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: !process.env.PHONE_NUMBER,
    browser: Browsers.macOS('Zappy‑AI‑Bot')
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr, pairingCode }) => {
    if (qr) {
      console.log('Scan this QR to login:')
      try { qrcode.generate(qr, { small: true }) } catch {}
    }

    if (pairingCode) console.log('📲 Pair Code:', pairingCode)

    if (connection === 'open') console.log('✅ Zappy AI connected')
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) {
        console.log('⟳ Reconnecting…')
        startBot()
      } else console.log('❌ Logged out.')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return
    const jid = m.key.remoteJid
    const text = m.message.conversation ?? m.message.extendedTextMessage?.text ?? ''
    logChat(jid, 'user', text)

    await react(jid, m.key.id, '⏳')

    if (text.startsWith('!')) return handleCommand(jid, text)

    if (!chatMemory[jid]) chatMemory[jid] = []
    chatMemory[jid].push({ role: 'user', content: text })

    const ai = await callTogetherChat(chatMemory[jid])
    chatMemory[jid].push({ role: 'assistant', content: ai })

    await sock.sendMessage(jid, { text: `${ai}\n\n${TAG}` })
    logChat(jid, 'bot', ai)
  })
}

/* ─────── Commands ─────── */
async function handleCommand (jid, text) {
  const cmd = text.trim().toLowerCase()
  if (cmd === '!help') return send(jid, helpMsg())
  if (cmd === '!quote') return send(jid, `💡 ${await fetchQuote()}\n\n${TAG}`)
  if (cmd === '!reset') {
    delete chatMemory[jid]
    return send(jid, `🔄 Memory cleared.\n\n${TAG}`)
  }
  if (cmd.startsWith('!img ')) {
    const prompt = text.slice(5).trim()
    const url = await genImage(prompt)
    return sock.sendMessage(jid, { image: { url }, caption: `🖼️ “${prompt}”\n\n${TAG}` })
  }
  return send(jid, `❓ Unknown command. Type *!help*\n\n${TAG}`)
}

/* ─────── Utilities ─────── */
const send = (jid, text) => sock.sendMessage(jid, { text })
const react = async (jid, msgId, emoji) =>
  sock.sendMessage(jid, { react: { text: emoji, key: { id: msgId, remoteJid: jid, fromMe: false } } })

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
  } catch {
    return 'https://via.placeholder.com/512?text=Image+Error'
  }
}

async function fetchQuote () {
  try {
    const { data } = await axios.get('https://api.quotable.io/random')
    return `"${data.content}" — ${data.author}`
  } catch {
    return 'Keep going. You are amazing!'
  }
}

const LOG_FILE = fs.existsSync('/data') ? '/data/logs.json' : 'logs.json'
function logChat (jid, who, msg) {
  const entry = { time: new Date().toISOString(), jid, who, msg }
  let logs = []
  try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) } catch {}
  logs.push(entry)
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2))
}

function helpMsg () {
  return `🧠 *Zappy AI Commands*\n\n• *!help* – Show this menu\n• *!quote* – Get a motivational quote\n• *!img [prompt]* – Generate an image\n• *!reset* – Clear memory\n• Chat freely – Talk to AI\n\n${TAG}`
}

/* ========== DASHBOARD & API ========== */
const DASH_PIN = process.env.BROADCAST_PASSWORD || 'admin123'
const bannerUrl = '/assets/banner.png'

const html = body => `<!DOCTYPE html><html><head><title>Zappy AI Dashboard</title>
<style>
body{font-family:sans-serif;background:#f5f5f5;text-align:center;padding:20px}
h1{color:#d62828}.cn{max-width:700px;margin:auto;background:#fff;padding:20px;border-radius:10px;box-shadow:0 0 10px #ccc}
textarea{width:100%;padding:10px}input{padding:6px}button{background:#d62828;color:#fff;border:none;padding:10px 20px;border-radius:5px}
ul{padding:0}li{list-style:none;margin:10px 0}
</style></head><body><div class="cn">
<img src="${bannerUrl}" alt="logo" style="width:200px;margin-bottom:20px"/>
${body}<hr><p><i>${TAG}</i></p></div></body></html>`

app.get('/', (_, res) => res.send(html(`
<h1>🤖 Zappy AI Dashboard</h1>
<ul><li><a href="/logs">📜 View Logs</a></li><li><a href="/clear">♻️ Clear Logs</a></li></ul>
<form method="POST" action="/broadcast">
  <h3>📣 Broadcast</h3>
  <input name="password" type="password" placeholder="PIN" required><br><br>
  <textarea name="message" rows="5" placeholder="Type message…"></textarea><br><br>
  <button type="submit">Send</button>
</form>`)))

app.get('/logs', (_, res) => {
  let logs = []
  try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) } catch {}
  res.send(html(`<pre>${JSON.stringify(logs, null, 2)}</pre>`))
})

app.get('/clear', (_, res) => {
  fs.writeFileSync(LOG_FILE, '[]')
  res.send(html('<p>✅ Logs cleared.</p><a href="/">Back</a>'))
})

app.post('/broadcast', async (req, res) => {
  const { password, message } = req.body
  if (password !== DASH_PIN) return res.send(html('<p style="color:red">❌ Wrong PIN.</p><a href="/">Back</a>'))
  const users = [...new Set(JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')).map(l => l.jid))]
  const finalMsg = `${message.trim()}\n\n${TAG}`
  let sent = 0
  for (const jid of users) {
    try { await sock.sendMessage(jid, { text: finalMsg }); sent++ } catch {}
  }
  res.send(html(`<p>✅ Broadcast sent to ${sent} user(s).</p><a href="/">Back</a>`))
})

app.post('/send', async (req, res) => {
  const { to, text } = req.body
  if (!sock) return res.status(503).send('Bot not ready')
  try { await sock.sendMessage(to, { text }); res.send('ok') }
  catch { res.status(500).send('fail') }
})

/* ========== Start Server ========== */
const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`🚀 Zappy server on ${PORT}`))
