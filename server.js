/*****************************************************************
 * Zappy AI – Smart Chats. Instant Replies  by Vik Tree
 * Render-ready WhatsApp bot + dashboard (auto phone-pair code)
 *****************************************************************/

import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import axios from 'axios'
import {
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'

/* ─ paths that survive on Render (attach a disk at /data) ─ */
const AUTH_DIR = fs.existsSync('/data') ? '/data/auth' : './auth'
const LOG_FILE = fs.existsSync('/data') ? '/data/logs.json' : 'logs.json'

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
const TAG = '_Zappy AI – Smart Chats. Instant Replies by Vik Tree_'
const chatMemory = {}

let sock
void startBot()

/* ────────────── WhatsApp bot ───────────────────────── */
async function startBot () {
  sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS('Zappy-AI-Bot'),
    printQRInTerminal: false
  })

  /* 🔑 —— immediately request phone-pair code if never registered —— */
  if (!state.creds.registered && process.env.PHONE_NUMBER) {
    try {
      const code = await sock.requestPairingCode(process.env.PHONE_NUMBER)
      console.log('📲 Phone-pair code →', code)
    } catch (err) {
      console.error('❌ Pairing code error:', err.message)
    }
  }

  sock.ev.on('creds.update', saveCreds)

  /* connection updates (also logs pairingCode if emitted) */
  sock.ev.on(
    'connection.update',
    async ({ connection, lastDisconnect, pairingCode }) => {
      if (pairingCode) console.log('📲 Phone-pair code →', pairingCode)

      if (connection === 'open') console.log('✅ Zappy AI connected')

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
        if (reason !== DisconnectReason.loggedOut) {
          console.log('⟳ Reconnecting…')
          startBot()
        } else console.log('❌ Logged out.')
      }
    }
  )

  /* incoming messages */
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return
    const text = m.message.conversation ?? m.message.extendedTextMessage?.text ?? ''
    const jid = m.key.remoteJid
    logChat(jid, 'user', text)

    if (text.startsWith('!')) return handleCommand(jid, text)

    if (!chatMemory[jid]) chatMemory[jid] = []
    chatMemory[jid].push({ role: 'user', content: text })

    const ai = await callTogetherChat(chatMemory[jid])
    chatMemory[jid].push({ role: 'assistant', content: ai })

    await sock.sendMessage(jid, { text: `${ai}\n\n${TAG}` })
    logChat(jid, 'bot', ai)
  })
}

/* ─────────── command handler ─────────── */
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

const send = (jid, text) => sock.sendMessage(jid, { text })

/* ─────────── Together chat & image ─────────── */
async function callTogetherChat (history) {
  try {
    const { data } = await axios.post(
      process.env.TOGETHER_CHAT_URL,
      { model: process.env.TOGETHER_MODEL, messages: history, max_tokens: 512 },
      { headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` } }
    )
    return data.choices[0].message.content.trim()
  } catch (e) {
    console.error('Together chat error:', e.message)
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

/* ─────────── utilities ─────────── */
async function fetchQuote () {
  try {
    const { data } = await axios.get('https://api.quotable.io/random')
    return `"${data.content}" — ${data.author}`
  } catch {
    return 'Keep going. You are amazing!'
  }
}

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

/* ─────────── dashboard (unchanged) ─────────── */
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use('/assets', express.static('assets'))

const DASH_PIN = process.env.BROADCAST_PASSWORD || 'admin123'
const bannerUrl = '/assets/banner.png'
const html = body => `<!DOCTYPE html><html><head><title>Zappy AI</title>...`
/* (dashboard routes same as before – not repeated for brevity) */

/* start server */
const PORT = process.env.PORT || 4000
app.listen(PORT, () => console.log(`🚀 Zappy server on ${PORT}`))
