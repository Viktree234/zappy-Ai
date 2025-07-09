const express = require('express')
const qrcode = require('qrcode')
const app = express()
const PORT = process.env.PORT || 5000

app.use(express.json())
// Route: status
app.get('/status', (req, res) => {
  res.json({ status: getBotStatus() })
})
// ✅ QR preview route
app.get('/qr', async (req, res) => {
  if (!global.latestQR) return res.send('⚠️ QR not generated yet.')
  try {
    const qrImage = await qrcode.toDataURL(global.latestQR)
    res.send(`
      <meta http-equiv="refresh" content="10">
      <h2>📱 Scan this QR with WhatsApp</h2>
      <img src="${qrImage}" />
    `)
  } catch (err) {
    res.status(500).send('Error generating QR code.')
  }
})

// ✅ Start the bot + API
let sockInstance = null
require('./index')().then(sock => {
  sockInstance = sock

})

app.listen(PORT, () => console.log(`🚀 API ready at http://localhost:${PORT}`))
