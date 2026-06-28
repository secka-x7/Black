import express    from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readFileSync } from 'fs'

import { initDB, getRevenue, getTreasuryState, getRecentCredits, getConfig, setConfig, withdraw } from './treasury.js'
import { restoreStreams, getStreamStats, setBroadcast as streamsBroadcast } from './streams.js'
import { initPriceEngine, prices, volumes, spreads, gaps } from './price.js'
import { initNetworks, getNetworkStatus, getNetworkStats, handleModemWebhook, setBroadcast as networksBroadcast } from './networks.js'
import { runSingularity, setBroadcast as singBroadcast } from './singularity.js'
import { runFortress, getFortressStatus, setBroadcast as fortBroadcast } from './fortress.js'
import { getPropellerStatus, setPropellerConfig, getPropellerConfig } from './propeller.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
const PORT   = process.env.PORT || 3000

app.use(express.json())

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
const clients = new Set()

export function broadcast(type, data) {
  if (!clients.size) return
  const m = JSON.stringify({ type, data, ts: Date.now() })
  clients.forEach(ws => { try { if (ws.readyState === 1) ws.send(m) } catch {} })
}

wss.on('connection', ws => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => { try { ws.close() } catch {} })
  buildState().then(d => { if (ws.readyState === 1) ws.send(JSON.stringify({ type:'tick', data:d })) }).catch(() => {})
})

function initBroadcasts() {
  streamsBroadcast(broadcast)
  networksBroadcast(broadcast)
  singBroadcast(broadcast)
  fortBroadcast(broadcast)
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
// Resolve dashboard — file is at src/dashboard/black.html
// __dir = /app/src on Railway, so dashboard is at __dir/dashboard/black.html
const DASH_CANDIDATES = [
  join(__dir, 'dashboard/black.html'),          // src/dashboard/black.html  ← correct for this repo
  join(__dir, '../dashboard/black.html'),        // root/dashboard/black.html
  join(__dir, 'black.html'),                     // src/black.html (flat)
]
const DASH_MOBILE_CANDIDATES = [
  join(__dir, 'dashboard/black-mobile.html'),
  join(__dir, '../dashboard/black-mobile.html'),
]

const DASH        = DASH_CANDIDATES.find(p => existsSync(p))
const DASH_MOBILE = DASH_MOBILE_CANDIDATES.find(p => existsSync(p))

console.log('[BLACK] Dashboard:', DASH || 'NOT FOUND — checked: ' + DASH_CANDIDATES.join(', '))
console.log('[BLACK] Mobile:   ', DASH_MOBILE || 'not found')

app.get('/', (req, res) => {
  const ua       = req.headers['user-agent'] || ''
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua)
  const file     = isMobile && DASH_MOBILE ? DASH_MOBILE : (DASH || null)
  if (file) {
    res.setHeader('Content-Type', 'text/html')
    res.send(readFileSync(file, 'utf8'))
  } else {
    // Inline fallback — never shows "loading" without info
    res.status(200).setHeader('Content-Type', 'text/html').send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>BLACK</title>
<style>body{background:#060608;color:#3b82f6;font-family:monospace;padding:40px;margin:0}
a{color:#3b82f6}.ok{color:#16a34a}.err{color:#dc2626}</style></head>
<body>
<h2>BLACK — LIVE</h2>
<p class="ok">Server running on port ${PORT}</p>
<p class="err">Dashboard HTML not found.</p>
<p>Checked:</p><ul>${DASH_CANDIDATES.map(p=>`<li>${p} — ${existsSync(p)?'✓ exists':'✗ missing'}</li>`).join('')}</ul>
<p>Place <code>black.html</code> at <code>src/dashboard/black.html</code> and redeploy.</p>
<hr>
<p><a href="/health">/health</a> &nbsp; <a href="/api/state">/api/state</a> &nbsp; <a href="/api/fortress">/api/fortress</a></p>
</body></html>`)
  }
})

app.get('/desktop', (_, res) => {
  if (DASH) { res.setHeader('Content-Type','text/html'); res.send(readFileSync(DASH,'utf8')) }
  else res.status(404).send('black.html not found')
})
app.get('/mobile', (_, res) => {
  if (DASH_MOBILE) { res.setHeader('Content-Type','text/html'); res.send(readFileSync(DASH_MOBILE,'utf8')) }
  else res.status(404).send('black-mobile.html not found')
})

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok:true, uptime:process.uptime()|0, dashboard: !!DASH }))

app.get('/api/state', async (_, res) => {
  try { res.json(await buildState()) } catch { res.json({ booting:true }) }
})

app.get('/api/fortress',   (_, res) => res.json(getFortressStatus()))
app.get('/api/networks',   (_, res) => res.json({ status:getNetworkStatus(), stats:getNetworkStats() }))
app.get('/api/streams',    (_, res) => res.json(getStreamStats()))
app.get('/api/propellers', (_, res) => res.json(getPropellerStatus()))
app.get('/api/prices',     (_, res) => res.json({ prices, volumes, spreads, gaps }))

app.post('/api/withdraw', async (req, res) => {
  const { amount, destination } = req.body || {}
  if (!amount || !destination) return res.status(400).json({ error:'amount and destination required' })
  try { res.json(await withdraw(parseFloat(amount), String(destination))) }
  catch (e) { res.status(400).json({ error:e.message }) }
})

app.post('/api/propellers', (req, res) => {
  const updates = req.body || {}
  setPropellerConfig(updates)
  broadcast('propeller_update', getPropellerConfig())
  res.json({ ok:true, config:getPropellerConfig() })
})

app.post('/webhook/modempay', async (req, res) => {
  res.json({ ok:true })
  try { await handleModemWebhook(req.body) }
  catch (e) { console.error('[WEBHOOK]', e.message) }
})

// ── STATE BUILDER ─────────────────────────────────────────────────────────────
async function buildState() {
  return {
    revenue:    getRevenue(),
    treasury:   getTreasuryState(),
    networks:   { status:getNetworkStatus(), stats:getNetworkStats() },
    fortress:   getFortressStatus(),
    propellers: getPropellerStatus(),
    streams:    getStreamStats(),
    prices:     { prices, volumes, spreads, gaps },
    uptime:     process.uptime()|0,
    memory:     Math.round(process.memoryUsage().heapUsed/1024/1024),
    recent:     getRecentCredits(20),
  }
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
async function boot() {
  console.log('[BLACK] Booting...')

  await initDB()
  restoreStreams()
  initBroadcasts()

  // Server up first — Railway health check needs it
  await new Promise(r => server.listen(PORT, r))
  console.log(`[BLACK] Live on :${PORT}`)

  // Price engine
  await initPriceEngine()

  // Networks
  await initNetworks(broadcast)

  // Dashboard tick every 4s
  setInterval(async () => {
    try { broadcast('tick', await buildState()) } catch {}
  }, 4000)

  // Singularity (awaited — Fortress waits for it)
  console.log('[BLACK] Starting Operation Singularity...')
  await runSingularity(broadcast)
  console.log('[BLACK] Singularity complete → Starting Operation Fortress...')

  // Fortress (non-blocking — runs in background)
  runFortress(broadcast)
    .then(() => {
      console.log('[BLACK] Fortress complete → 73% capture locked')
      broadcast('system', { message:'Fortress complete — 73% capture locked', ts:Date.now() })
    })
    .catch(e => console.error('[FORTRESS ERROR]', e.message))
}

boot().catch(e => {
  console.error('[BOOT FATAL]', e.message)
  setTimeout(() => boot().catch(() => {}), 5000)
})

process.on('uncaughtException',  e => console.error('[UNCAUGHT]',  e.message?.slice(0, 150)))
process.on('unhandledRejection', r => console.error('[REJECTION]', String(r).slice(0, 150)))
process.on('SIGTERM', () => { console.log('[BLACK] SIGTERM'); process.exit(0) })
