import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import axios from 'axios';
import path from 'path';

const app = express();
const port = process.env.PORT || 4000;
const password = process.env.BROADCAST_PASSWORD || 'admin123';
const tag = '_Zappy AI – Smart Chats. Instant Replies by Vik Tree_';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/assets', express.static('assets'));

const bannerUrl = '/assets/banner.png'; // Place your banner in an /assets folder

/* ------------ HTML Template ------------ */
function htmlPage(body) {
  return `<!DOCTYPE html>
  <html>
  <head>
    <title>Zappy AI Dashboard</title>
    <style>
      body { font-family: sans-serif; background: #f5f5f5; text-align: center; padding: 20px; }
      h1 { color: #d62828; }
      .container { max-width: 700px; margin: auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 0 10px #ccc; }
      img.logo { width: 200px; margin-bottom: 20px; }
      textarea { width: 100%; padding: 10px; }
      input[type="password"] { padding: 6px; width: 200px; }
      button { background: #d62828; color: white; border: none; padding: 10px 20px; cursor: pointer; border-radius: 5px; }
      ul li { list-style: none; margin: 10px 0; }
    </style>
  </head>
  <body>
    <div class="container">
      <img class="logo" src="${bannerUrl}" alt="Zappy AI Logo"/>
      ${body}
      <hr />
      <p><i>${tag}</i></p>
    </div>
  </body>
  </html>`;
}

/* ------------ Routes ------------ */
app.get('/', (req, res) => {
  res.send(htmlPage(`
    <h1>🤖 Zappy AI Dashboard</h1>
    <ul>
      <li><a href="/logs">📜 View Logs</a></li>
      <li><a href="/clear">♻️ Clear Logs</a></li>
    </ul>
    <form method="POST" action="/broadcast">
      <h3>📣 Broadcast Message</h3>
      <input name="password" type="password" placeholder="Dashboard PIN" required />
      <br /><br />
      <textarea name="message" rows="5" placeholder="Type your message..."></textarea>
      <br /><br />
      <button type="submit">Send Broadcast</button>
    </form>
  `));
});

app.get('/logs', (req, res) => {
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync('logs.json', 'utf8')); } catch {}
  res.send(htmlPage(`<pre>${JSON.stringify(logs, null, 2)}</pre>`));
});

app.get('/clear', (req, res) => {
  fs.writeFileSync('logs.json', '[]');
  res.send(htmlPage(`<p>✅ Logs cleared.</p>`));
});

app.post('/broadcast', async (req, res) => {
  const msg = req.body.message;
  const pass = req.body.password;

  if (pass !== password) {
    return res.send(htmlPage(`<p style="color:red">❌ Incorrect PIN.</p><a href="/">Back</a>`));
  }

  const logs = JSON.parse(fs.readFileSync('logs.json', 'utf8'));
  const users = [...new Set(logs.map(l => l.jid))];
  const sent = [];

  const finalMsg = `${msg.trim()}\n\n${tag}`;

  for (const jid of users) {
    try {
      const r = await axios.post('http://localhost:4001/send', { to: jid, text: finalMsg });
      if (r.data === 'ok') sent.push(jid);
    } catch {}
  }

  res.send(htmlPage(`<p>✅ Broadcast sent to ${sent.length} user(s).</p><a href="/">Back</a>`));
});

/* ------------ Start Server ------------ */
app.listen(port, () => {
  console.log(`🎨 Zappy Dashboard → http://localhost:${port}`);
});
