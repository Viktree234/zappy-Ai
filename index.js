const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const { Pool } = require('pg');
require('dotenv').config();

// 🛠️ PostgreSQL Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 🧱 Ensure messages table exists
const ensureTableExists = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

const startBot = async () => {
  await ensureTableExists();

  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const sock = makeWASocket({ auth: state, logger: P({ level: 'silent' }) });

  // 🔄 QR / Connection Updates
  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      global.latestQR = qr;
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Disconnected. Reconnecting?', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot connected to WhatsApp.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // 💬 Message Handling
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const isGroup = sender.endsWith('@g.us');

    // ❌ Ignore group messages unless tagged
    if (isGroup) {
      const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      if (!mentions.includes(botId)) return;
    }

    const name = msg.pushName || 'Unknown';
    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!text) {
      console.warn('⚠️ Could not decrypt or read message content.');
      return;
    }

    console.log(`📩 Message from ${name}: ${text}`);

    // 🌱 First time user = Show Menu
    const { rows } = await pool.query('SELECT COUNT(*) FROM messages WHERE user_id = $1', [sender]);
    const isFirstMessage = parseInt(rows[0].count) === 0;

    if (isFirstMessage) {
      const welcome = `👋 Hi ${name}! I'm *Zappy AI*.

I can chat, teach, explain and help you think smarter.  
Here are some commands to try:

📌 */menu* – Show features  
♻️ */reset* – Reset memory  
ℹ️ */help* – Chat tips  
🎲 */fun* – Random fun fact`;

      await sock.sendMessage(sender, { text: welcome });
      await pool.query('INSERT INTO messages (user_id, message, direction) VALUES ($1, $2, $3)', [sender, text, 'in']);
      return;
    }

    // ⚡ COMMAND TRIGGERS
    const lower = text.toLowerCase();
    if (lower === '/menu') {
      const menu = `📋 *Zappy AI Commands:*
/menu – Show this menu  
/reset – Clear your chat memory  
/help – Chat tips  
/fun – Fun fact or joke`;
      await sock.sendMessage(sender, { text: menu });
      return;
    }

    if (lower === '/reset') {
      await pool.query('DELETE FROM messages WHERE user_id = $1', [sender]);
      await sock.sendMessage(sender, { text: '🧹 Chat memory reset. Start fresh!' });
      return;
    }

    if (lower === '/help') {
      const help = `💡 *Help Tips:*
– Ask questions like a friend  
– You can say things like:
"Explain gravity", "Teach me Python", "I feel sad"  
– I'm smart, emotional, and funny.`;
      await sock.sendMessage(sender, { text: help });
      return;
    }

    if (lower === '/fun') {
      const facts = [
        '🤣 Fun fact: A group of flamingos is called a "flamboyance".',
        '🌍 Earth is the only planet not named after a god.',
        '🐶 Dogs can smell your mood!',
        '🍯 Honey never spoils!',
        '🧠 The human brain has 86 billion neurons.'
      ];
      const fun = facts[Math.floor(Math.random() * facts.length)];
      await sock.sendMessage(sender, { text: fun });
      return;
    }

    // 🧠 Save incoming message
    await pool.query('INSERT INTO messages (user_id, message, direction) VALUES ($1, $2, $3)', [sender, text, 'in']);

    // 📜 Get recent user messages for context
    const contextRows = await pool.query(
      `SELECT message FROM messages WHERE user_id = $1 AND direction = 'in' ORDER BY timestamp DESC LIMIT 5`,
      [sender]
    );
    const context = contextRows.rows.map(r => r.message).reverse().join('\n');

    // 🌐 Forward to n8n for AI response
    try {
      const res = await axios.post(process.env.N8N_WEBHOOK, {
        from: sender,
        name,
        text: `${context}\n${text}`,
        timestamp: msg.messageTimestamp
      });

      const reply = res.data?.reply || '🤖 Thanks for your message!';
      const branded = `${reply}\n\n🧠 Zappy AI – Smart Chats. Instant Replies by Vik Tree`;

      await pool.query('INSERT INTO messages (user_id, message, direction) VALUES ($1, $2, $3)', [sender, reply, 'out']);
      await sock.sendMessage(sender, { text: branded });

    } catch (err) {
      console.error('❌ Failed to process via n8n:', err.message);
      await sock.sendMessage(sender, { text: '⚠️ Error processing your message. Please try again.' });
    }
  });

  return sock;
};

module.exports = startBot;
