import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  DisconnectReason
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import axios from 'axios';
import fs from 'fs';
import express from 'express';

const { state, saveCreds } = await useMultiFileAuthState('./auth');
const chatMemory = {};
let socketInstance = null;

startBot();

/* ------------------- WhatsApp Bot ------------------- */
async function startBot () {
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Zappy-AI-Bot')
  });

  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered) {
    const code = await sock.requestPairingCode(process.env.PHONE_NUMBER);
    console.log(`🔐 Enter this on your phone ➜ ${code}`);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) startBot();
      else console.log('❌ Logged out from WhatsApp.');
    } else if (connection === 'open') {
      console.log('✅ Zappy AI connected & ready!');
    }
  });

  socketInstance = sock;

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text || '';
    const jid = m.key.remoteJid;

    await logChat(jid, 'user', text);

    if (text.startsWith('!')) {
      const cmd = text.trim().toLowerCase();

      if (cmd === '!help') return sock.sendMessage(jid, { text: helpMsg() });

      if (cmd === '!quote') {
        const quote = await fetchQuote();
        return sock.sendMessage(jid, {
          text: `💡 ${quote}\n\n_Zappy AI – Smart Chats. Instant Replies by Vik Tree_`
        });
      }

      if (cmd === '!reset') {
        delete chatMemory[jid];
        return sock.sendMessage(jid, {
          text: `🔄 Memory cleared.\n\n_Zappy AI – Smart Chats. Instant Replies by Vik Tree_`
        });
      }

      if (cmd.startsWith('!img ')) {
        const prompt = text.slice(5).trim();
        const url = await genImage(prompt);
        return sock.sendMessage(jid, {
          image: { url },
          caption: `🖼️ “${prompt}”\n\n_Zappy AI – Smart Chats. Instant Replies by Vik Tree_`
        });
      }

      return sock.sendMessage(jid, {
        text: '❓ Unknown command. Type *!help*\n\n_Zappy AI – Smart Chats. Instant Replies by Vik Tree_'
      });
    }

    if (!chatMemory[jid]) chatMemory[jid] = [];
    chatMemory[jid].push({ role: 'user', content: text });

    const ai = await deepSeekChat(chatMemory[jid]);
    chatMemory[jid].push({ role: 'assistant', content: ai });

    const branded = `${ai}\n\n_Zappy AI – Smart Chats. Instant Replies by Vik Tree_`;
    await sock.sendMessage(jid, { text: branded });
    await logChat(jid, 'bot', ai);
  });
}

/* ------------------- Internal Webhook ------------------- */
const api = express();
api.use(express.json());

api.post('/send', async (req, res) => {
  const { to, text } = req.body;
  if (!socketInstance) return res.status(503).send('bot not ready');
  try {
    await socketInstance.sendMessage(to, { text });
    res.send('ok');
  } catch {
    res.status(500).send('fail');
  }
});

api.listen(4001, () => console.log('📡 Internal API at http://localhost:4001/send'));

/* ------------------- Helpers ------------------- */
function helpMsg () {
  return `🧠 *Zappy AI Commands*

• *!help* – Show this menu  
• *!quote* – Get a motivational quote  
• *!img [prompt]* – Generate an image  
• *!reset* – Clear your memory context  
• *Chat* – Talk to Zappy AI (powered by DeepSeek)

_Zappy AI – Smart Chats. Instant Replies by Vik Tree_`;
}

async function deepSeekChat (history) {
  try {
    const { data } = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: process.env.DEEPSEEK_MODEL,
        messages: history,
        max_tokens: 512
      },
      {
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
      }
    );
    return data.choices[0].message.content.trim();
  } catch {
    return '⚠️ Sorry, I could not think right now.';
  }
}

async function fetchQuote () {
  try {
    const { data } = await axios.get('https://api.quotable.io/random');
    return `"${data.content}" — ${data.author}`;
  } catch {
    return 'Keep going. You are amazing!';
  }
}

async function genImage (prompt) {
  try {
    const { data } = await axios.post(
      'https://api.together.xyz/v1/images/generations',
      {
        model: 'stabilityai/stable-diffusion-xl-base-1.0',
        prompt,
        n: 1,
        size: '512x512'
      },
      { headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}` } }
    );
    return data.data[0].url;
  } catch {
    return 'https://via.placeholder.com/512?text=Image+Error';
  }
}

function logChat (jid, who, msg) {
  const entry = { time: new Date().toISOString(), jid, who, msg };
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync('logs.json', 'utf8')); } catch {}
  logs.push(entry);
  fs.writeFileSync('logs.json', JSON.stringify(logs, null, 2));
}
