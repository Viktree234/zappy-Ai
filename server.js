/*****************************************************************
 * Zappy AI — full‑featured server   (login first!)
 *****************************************************************/

import 'dotenv/config'
import express              from 'express'
import session              from 'express-session'
import pgSession            from 'connect-pg-simple'
import rateLimit            from 'express-rate-limit'
import bcrypt               from 'bcrypt'
import fs                   from 'fs'
import path                 from 'path'
import { fileURLToPath }    from 'url'
import axios                from 'axios'
import pkg                  from '@whiskeysockets/baileys'
const  { makeWASocket, DisconnectReason, Browsers } = pkg
import { Boom }             from '@hapi/boom'
import qrcode               from 'qrcode-terminal'
import { usePostgresAuthState } from './pgAuth.js'
import { Pool }             from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/* ───── constants ───────────────────────── */
const TAG = '_Zappy AI – Smart Chats. Instant Replies by Vik Tree_'
const DATA_DIR   = fs.existsSync('/data') ? '/data' : '.'
const LOG_FILE   = `${DATA_DIR}/logs.json`
const BCRYPT_PIN = process.env.DASH_BCRYPT_PIN           // hash of your PIN
const PORT       = process.env.PORT || 4000
const RATE       = { windowMs: 60_000, max: 3 }          // 3 req/min

/* ───── globals ─────────────────────────── */
let sock=null, qrCurrent=null, pairCurrent=null
const mem  = {}                                         // per‑JID memory
const pool = new Pool({ connectionString: process.env.DATABASE_URL,
                        ssl:{ rejectUnauthorized:false } })

/* ───── Baileys auth via Postgres ───────── */
const { state, saveCreds } = await usePostgresAuthState()

/* ───── Express app + middleware ────────── */
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended:true }))

app.use('/assets', express.static('assets'))

/* static files (login.html, index.html, JS, CSS …) — 
   *index:false* keeps “/” free so we can guard it */
app.use(express.static('public', { index:false }))

/* sessions in PG */
const PgStore  = pgSession(session)
app.use(session({
  store: new PgStore({ pool }),
  secret: process.env.SESSION_SECRET || 'zappy‑secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12*60*60*1000 }   // 12 h
}))

/* ───── auth guard ───────── */
function mustLogin (req,res,next){
  if(req.session.ok) return next()
  res.redirect('/login.html')
}

/* ───── rate‑limit helpers ─ */
const slow    = rateLimit(RATE)
const protect = [mustLogin, slow]

/* ───── root DASHBOARD (now protected) ─ */
app.get('/', mustLogin, (_,res)=>
  res.sendFile(path.join(__dirname,'public','index.html')))

/* ───── login & logout ─── */
app.post('/login',express.urlencoded({extended:true}),async(req,res)=>{
  const ok = await bcrypt.compare(req.body.pin||'',BCRYPT_PIN||'')
  if(ok){ req.session.ok=true; return res.redirect('/') }
  res.redirect('/login.html?bad=1')
})
app.get('/logout',(r,s)=>{ r.session.destroy(()=>s.redirect('/login.html')) })

/* ───── WhatsApp BOT start/stop ─────────── */
async function startBot(){
  if(sock) return sock
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: !process.env.PHONE_NUMBER,
    browser: Browsers.macOS('Zappy‑AI')
  })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({connection,lastDisconnect,qr,pairingCode})=>{
    if(qr){ qrCurrent=qr; pairCurrent=null; showQR(qr) }
    if(pairingCode){ pairCurrent=pairingCode; qrCurrent=null; console.log('📲 Pair:',pairingCode) }
    if(connection==='open'){ console.log('✅ Connected'); qrCurrent=pairCurrent=null }
    if(connection==='close'){
      const reason=new Boom(lastDisconnect?.error).output.statusCode
      sock=null; qrCurrent=pairCurrent=null
      if(reason!==DisconnectReason.loggedOut){ console.log('⟳ Reconnect'); startBot() }
    }
  })

  sock.ev.on('messages.upsert', async ({messages})=>{
    const m=messages[0]
    if(!m.message||m.key.fromMe) return
    const group=m.key.remoteJid.endsWith('@g.us')
    const tagged=m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.includes(sock.user.id)
    if(group&&!tagged) return
    const jid=m.key.remoteJid
    const txt=m.message.conversation ?? m.message.extendedTextMessage?.text ?? ''
    log(jid,'user',txt); await react(jid,m.key.id,'⏳')

    if(txt.startsWith('!')) return cmd(jid,txt)

    mem[jid]??=[]
    mem[jid].push({role:'user',content:txt})
    const ai=await askAI(mem[jid])
    mem[jid].push({role:'assistant',content:ai})
    await send(jid,`${ai}\n\n${TAG}`); log(jid,'bot',ai)
  })

  sock.ev.on('group-participants.update', async ({id,participants,action})=>{
    if(action==='add'&&participants.includes(sock.user.id))
      await send(id,'👋 Hi everyone! Mention me or type *!help* to begin.')
  })

  return sock
}
const send =(j,t)=>sock?.sendMessage(j,{text:t})
const react=(j,i,e)=>sock?.sendMessage(j,{react:{text:e,key:{id:i,remoteJid:j,fromMe:false}}})
function showQR(q){ try{qrcode.generate(q,{small:true})}catch{console.log(q)} }

/* AI, image, quote helpers (unchanged) */
async function askAI(hist){ /* … same as earlier … */ }
async function img(p){ /* … */ }
async function quote(){ /* … */ }
async function cmd(jid,txt){ /* … commands … */ }
function help(){ /* … */ }
function log(jid,who,msg){ /* … write to LOG_FILE … */ }

/* ───── dashboard JSON API (unchanged) ─ */
app.get('/status',(_,r)=>r.json({running:!!sock,qr:qrCurrent,pairingCode:pairCurrent}))
app.get('/start', mustLogin, async(_,r)=>{await startBot();r.redirect('/')})
app.get('/stop' , mustLogin, (_ ,r)=>{sock?.end();sock=null;r.redirect('/')})
app.get('/logs' , protect , (_ ,r)=>{let l=[];try{l=JSON.parse(fs.readFileSync(LOG_FILE,'utf8'))}catch{} r.json(l.slice(-100))})
app.post('/broadcast',protect,async(req,res)=>{ /* … */ })
app.post('/send',protect,async(req,res)=>{ /* … */ })

app.listen(PORT,()=>console.log('🚀 Zappy on',PORT))
