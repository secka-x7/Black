// Black — Boot sequence
// Correct order. Zero simulation. Real revenue from real events only.
import express    from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

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

// ── WEBSOCKET ─────────────────────────────────────────────────────────────
const clients = new Set()

export function broadcast(type, data) {
  if (!clients.size) return
  const m = JSON.stringify({ type, data, ts:Date.now() })
  clients.forEach(ws => { try { if(ws.readyState===1) ws.send(m) } catch {} })
}

wss.on('connection', ws => {
  clients.add(ws)
  ws.on('close', ()=>clients.delete(ws))
  ws.on('error', ()=>{ try{ws.close()}catch{} })
  // Send current state immediately on connect
  buildState().then(d => { if(ws.readyState===1) ws.send(JSON.stringify({type:'tick',data:d})) }).catch(()=>{})
})

// Pass broadcast to all modules
function initBroadcasts() {
  streamsBroadcast(broadcast)
  networksBroadcast(broadcast)
  singBroadcast(broadcast)
  fortBroadcast(broadcast)
}

// ── ROUTES ────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok:true, uptime:process.uptime()|0 }))

app.get('/api/state', async (_, res) => {
  try { res.json(await buildState()) }
  catch { res.json({ booting:true }) }
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

// ModemPay webhook
app.post('/webhook/modempay', async (req, res) => {
  res.json({ ok:true })
  try { await handleModemWebhook(req.body) }
  catch (e) { console.error('[WEBHOOK]', e.message) }
})

// Dashboard
app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || ''
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua)
  const file = isMobile ? 'black-mobile.html' : 'black.html'
  const path = join(__dir, '../dashboard', file)
  if (existsSync(path)) res.send(readFileSync(path,'utf8'))
  else res.send('<h1>BLACK</h1><p>Dashboard loading...</p>')
})
app.get('/desktop', (_, res) => {
  const path = join(__dir,'../dashboard/black.html')
  if (existsSync(path)) res.send(readFileSync(path,'utf8'))
  else res.status(404).send('Not found')
})
app.get('/mobile', (_, res) => {
  const path = join(__dir,'../dashboard/black-mobile.html')
  if (existsSync(path)) res.send(readFileSync(path,'utf8'))
  else res.status(404).send('Not found')
})

async function buildState() {
  const rev   = getRevenue()
  const ts    = getTreasuryState()
  const nets  = { status:getNetworkStatus(), stats:getNetworkStats() }
  const fort  = getFortressStatus()
  const props = getPropellerStatus()
  const strms = getStreamStats()
  return {
    revenue:   rev,
    treasury:  ts,
    networks:  nets,
    fortress:  fort,
    propellers:props,
    streams:   strms,
    prices:    { prices, volumes },
    uptime:    process.uptime()|0,
    memory:    Math.round(process.memoryUsage().heapUsed/1024/1024),
    recent:    getRecentCredits(20),
  }
}

// ── BOOT ──────────────────────────────────────────────────────────────────
async function boot() {
  console.log('[BLACK] Booting...')

  // 1. Database first — everything reads from DB
  await initDB()

  // 2. Restore stream totals from DB
  restoreStreams()

  // 3. Init broadcast connections to all modules
  initBroadcasts()

  // 4. Start HTTP server immediately (Railway health check)
  await new Promise(r => server.listen(PORT, r))
  console.log(`[BLACK] Live on :${PORT}`)

  // 5. Price engine — must be before networks and singularity
  await initPriceEngine()

  // 6. Networks — real WebSocket + polling
  await initNetworks(broadcast)

  // 7. Dashboard tick every 4s — real data only
  setInterval(async () => {
    try { broadcast('tick', await buildState()) } catch {}
  }, 4000)

  // 8. Singularity
  console.log('[BLACK] Starting Operation Singularity...')
  await runSingularity(broadcast)
  console.log('[BLACK] Singularity complete → Starting Operation Fortress...')

  // 9. Fortress
  runFortress(broadcast).then(() => {
    console.log('[BLACK] Fortress complete → 73% capture locked')
    broadcast('system', { message:'Fortress complete — 73% capture locked', ts:Date.now() })
  }).catch(e => console.error('[FORTRESS ERROR]', e.message))
}

boot().catch(e => {
  console.error('[BOOT FATAL]', e.message)
  setTimeout(()=>boot().catch(()=>{}), 5000)
})

process.on('uncaughtException',  e => console.error('[UNCAUGHT]',  e.message?.slice(0,150)))
process.on('unhandledRejection', r => console.error('[REJECTION]', String(r).slice(0,150)))
process.on('SIGTERM', () => { console.log('[BLACK] SIGTERM — shutting down'); process.exit(0) })
