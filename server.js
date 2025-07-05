/*****************************************************************
 * Zappy AI — full‑featured server
 *  • PostgreSQL auth state (pgAuth.js)
 *  • Secure session‑based dashboard login
 *  • Bootstrap dashboard with real‑time QR / Pair code
 *  • Rate‑limited broadcast & send API
 *****************************************************************/

import 'dotenv/config'
import express              from 'express'
import session              from 'express-session'
import pgSession            from 'connect-pg-simple'
import rateLimit            from 'express-rate-limit'
import bcrypt               from 'bcrypt'
import fs                   from 'fs'
import axios                from 'axios'
import pkg                  from '@whiskeysockets/baileys'
const  { makeWASocket, DisconnectReason, Browsers } = pkg
import { Boom }             from '@hapi/boom'
import qrcode               from 'qrcode-terminal'
import { usePostgresAuthState } from './pgAuth.js'
import { Pool }             from 'pg'

/* ───── constants ───────────────────────── */
const TAG = '_Zappy AI – Smart Chats. Instant Replies by Vik Tree_'
const DATA_DIR   = fs.existsSync('/data') ? '/data' : '.'
const LOG_FILE   = `${DATA_DIR}/logs.json`
const BCRYPT_PIN = process.env.DASH_BCRYPT_PIN // ≈ $2b$10$...
const PORT       = process.env.PORT || 4000
const RATE       = { windowMs: 60_000, max: 3 }      // 3 req / min

/* ───── globals ─────────────────────────── */
let sock=null, qrCurrent=null, pairCurrent=null
const mem = {}      // chat memory per‑JID
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized:false } })

/* ───── Baileys + Postgres auth ─────────── */
const { state, saveCreds } = await usePostgresAuthState()

/* ───── Express app + middleware ────────── */
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended:true }))
app.use('/assets', express.static('assets'))
app.use(express.static('public'))        // serves index/login HTML

/* sessions (stored in PG) */
const PgStore  = pgSession(session)
app.use(session({
  store: new PgStore({ pool }),
  secret: process.env.SESSION_SECRET || 'zappy‑secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12*60*60*1000 }   // 12 h
}))

/* ───── auth‑guard middleware ───────────── */
function mustLogin (req,res,next) {
  if (req.session.ok) return next()
  res.redirect('/login.html')
}

/* ───── RATE LIMITERS ───────────────────── */
const slow     = rateLimit(RATE)
const protect  = [mustLogin, slow]

/* ───── WhatsApp BOT start/stop ─────────── */
async function startBot () {
  if (sock) return sock
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: !process.env.PHONE_NUMBER,
    browser: Browsers.macOS('Zappy‑AI')
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr, pairingCode }) => {
    if (qr)          { qrCurrent=qr; pairCurrent=null; showQR(qr) }
    if (pairingCode) { pairCurrent=pairingCode; qrCurrent=null; console.log('📲 Pair:',pairingCode) }

    if (connection==='open')  { console.log('✅ Connected'); qrCurrent=pairCurrent=null }
    if (connection==='close') {
      const reason = new Boom(lastDisconnect?.error).output.statusCode
      sock=null; qrCurrent=pairCurrent=null
      if (reason!==DisconnectReason.loggedOut) { console.log('⟳ Reconnect'); startBot() }
    }
  })

  /* handle chats */
  sock.ev.on('messages.upsert', async ({ messages })=>{
    const m=messages[0]
    if (!m.message||m.key.fromMe) return
    const group = m.key.remoteJid.endsWith('@g.us')
    const tagged = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.includes(sock.user.id)
    if (group && !tagged) return

    const jid=m.key.remoteJid
    const txt=m.message.conversation ?? m.message.extendedTextMessage?.text ?? ''
    log(jid,'user',txt)
    await react(jid,m.key.id,'⏳')

    if (txt.startsWith('!')) return cmd(jid,txt)

    mem[jid] ??=[]
    mem[jid].push({role:'user',content:txt})
    const ai=await askAI(mem[jid])
    mem[jid].push({role:'assistant',content:ai})
    await send(jid,`${ai}\n\n${TAG}`); log(jid,'bot',ai)
  })

  /* auto‑welcome */
  sock.ev.on('group-participants.update', async ({ id, participants, action })=>{
    if (action==='add' && participants.includes(sock.user.id)) {
      await send(id,`👋 Hi everyone, I'm Zappy AI! Mention me or use *!help* to begin.`)
    }
  })

  return sock
}

function showQR(q){ try{qrcode.generate(q,{small:true})}catch{console.log(q)} }
const send  =(j,t)=> sock?.sendMessage(j,{text:t})
const react =(j,i,e)=> sock?.sendMessage(j,{react:{text:e,key:{id:i,remoteJid:j,fromMe:false}}})

/* ───── helpers: AI, img, quote ─────────── */
async function askAI(hist){ try{
  const {data}=await axios.post(process.env.TOGETHER_CHAT_URL,
    {model:process.env.TOGETHER_MODEL,messages:hist,max_tokens:512},
    {headers:{Authorization:`Bearer ${process.env.TOGETHER_API_KEY}`}})
  return data.choices[0].message.content.trim()
}catch(e){console.error('AI',e.message);return'⚠️ error'}}

async function img(prompt){ try{
  const {data}=await axios.post('https://api.together.xyz/v1/images/generations',
    {model:process.env.TOGETHER_IMAGE_MODEL,prompt,n:1,size:'512x512'},
    {headers:{Authorization:`Bearer ${process.env.TOGETHER_API_KEY}`}})
  return data.data[0].url
}catch{return'https://via.placeholder.com/512?text=error'}}

async function quote(){ try{
  const{data}=await axios.get('https://api.quotable.io/random')
  return `"${data.content}" — ${data.author}`
}catch{return'Keep going. You are amazing!'}}

/* commands */
async function cmd(jid,txt){
  const c=txt.trim().toLowerCase()
  if(c==='!help')  return send(jid,help())
  if(c==='!quote') return send(jid,`💡 ${await quote()}\n\n${TAG}`)
  if(c==='!reset'){delete mem[jid]; return send(jid,'🔄 Memory cleared.')}
  if(c.startsWith('!img ')){ const url=await img(txt.slice(5)); return sock.sendMessage(jid,{image:{url},caption:`🖼️ …\n\n${TAG}`})}
  return send(jid,'❓ Unknown. *!help*')
}

function help(){return`🧠 *Zappy AI Commands*\n• !help\n• !quote\n• !img prompt\n• !reset\n${TAG}`}

/* logging */
function log(jid,who,msg){
  let arr=[]; try{arr=JSON.parse(fs.readFileSync(LOG_FILE,'utf8'))}catch{}
  arr.push({time:new Date().toISOString(),jid,who,msg})
  fs.writeFileSync(LOG_FILE,JSON.stringify(arr,null,2))
}

/* ───── sessions routes ───── */
app.post('/login', express.urlencoded({extended:true}), async (req,res)=>{
  const ok = await bcrypt.compare(req.body.pin||'',BCRYPT_PIN||'')
  if(ok){ req.session.ok=true; return res.redirect('/') }
  res.redirect('/login.html?bad=1')
})
app.get ('/logout',   (r,s)=>{r.session.destroy(()=>s.redirect('/login.html'))})

/* ───── dashboard API ───── */
app.get ('/status', (_,res)=> res.json({running:!!sock,qr:qrCurrent,pairingCode:pairCurrent}))
app.get ('/start',  mustLogin, async(_,res)=>{ await startBot(); res.redirect('/') })
app.get ('/stop',   mustLogin, (_,res)=>{ sock?.end(); sock=null; res.redirect('/') })
app.get ('/logs',   protect,  (_,r)=>{let l=[];try{l=JSON.parse(fs.readFileSync(LOG_FILE,'utf8'))}catch{} r.json(l.slice(-100))})
app.post('/broadcast',protect, async(req,res)=>{
  const users=[...new Set(JSON.parse(fs.readFileSync(LOG_FILE,'utf8')).map(x=>x.jid))]
  let sent=0
  for(const j of users){ try{ await send(j,`${req.body.message.trim()}\n\n${TAG}`); sent++ }catch{} }
  res.json({ok:true,sent})
})
app.post('/send',protect, async(req,res)=>{
  try{ await send(req.body.to,req.body.text); res.json({ok:true}) }catch{res.status(500).json({ok:false})}
})

app.listen(PORT,()=>console.log('🚀 Zappy on',PORT))
