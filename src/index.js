import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { initDB, getRevenue, getRecentTxs, setConfig, getConfig, recordEvent } from './treasury.js'
import { initPriceEngine } from './price.js'
import { restoreStreams, startStreamTicks, getStreamStats } from './streams.js'
import { runSingularity } from './singularity.js'
import { runFortress, getFortressStatus } from './fortress.js'
import { initNetworks, getNetworkStatus } from './networks.js'
import { getTreasuryState, withdraw } from './treasury.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DASH  = join(__dir, 'dashboard/black.html')   // src/dashboard/black.html

const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
const PORT   = process.env.PORT || 3000

app.use(express.json())

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.get('/', (_, res) => res.sendFile(DASH))

// ─── WebSocket clients ────────────────────────────────────────────────────────

const clients = new Set()

export function broadcast(type, data) {
  const m = JSON.stringify({ type, data, ts: Date.now() })
  clients.forEach(ws => { try { if (ws.readyState === 1) ws.send(m) } catch {} })
}

wss.on('connection', ws => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  buildState()
    .then(d => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'tick', data: d })))
    .catch(() => {})
})

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime() | 0 }))

app.get('/api/state', async (_, res) => {
  try { res.json(await buildState()) } catch { res.json({ booting: true }) }
})

app.get('/api/fortress', (_, res) => res.json(getFortressStatus()))
app.get('/api/networks', (_, res) => res.json(getNetworkStatus()))
app.get('/api/streams',  (_, res) => res.json(getStreamStats()))

app.post('/api/withdraw', async (req, res) => {
  const { amount, destination } = req.body
  if (!amount || !destination)
    return res.status(400).json({ error: 'amount and destination required' })
  try {
    const result = await withdraw(parseFloat(amount), destination)
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ─── ModemPay webhook ─────────────────────────────────────────────────────────

app.post('/webhook/modempay', async (req, res) => {
  res.json({ ok: true })
  try {
    const { data, event } = req.body
    if (event === 'charge.completed' && data?.amount) {
      const fee = parseFloat(data.amount) * 0.015
      const { creditStream } = await import('./streams.js')
      creditStream('S1', fee, 'modempay')
      recordEvent('modempay_charge', { amount: data.amount, fee, ref: data.reference })
      broadcast('revenue', { stream: 'S1', amount: fee, source: 'modempay' })
      const seeded = getConfig('xrpl_seeded')
      if (!seeded && fee >= 2.5) {
        setConfig('xrpl_seeded', '1')
        const { seedXRPL } = await import('./networks.js')
        seedXRPL(fee).catch(() => {})
      }
    }
  } catch (e) { console.error('[WEBHOOK]', e.message) }
})

// ─── State builder ────────────────────────────────────────────────────────────

async function buildState() {
  return {
    revenue:  getRevenue(),
    treasury: getTreasuryState(),
    networks: getNetworkStatus(),
    streams:  getStreamStats(),
    fortress: getFortressStatus(),
    uptime:   process.uptime() | 0,
    memory:   Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    recent:   getRecentTxs(15)
  }
}

// ─── Boot sequence ────────────────────────────────────────────────────────────

async function boot() {
  console.log('[BLACK] Booting...')

  await initDB()
  await initNetworks()
  await initPriceEngine()
  restoreStreams()

  server.listen(PORT, () => console.log(`[BLACK] Live on :${PORT}`))

  setInterval(async () => {
    try { broadcast('tick', await buildState()) } catch {}
  }, 3000)

  console.log('[BLACK] Starting Operation Singularity...')
  runSingularity()
    .then(() => {
      console.log('[BLACK] Singularity complete → Starting Operation Fortress...')
      return runFortress()
    })
    .then(() => {
      console.log('[BLACK] Fortress complete → 47% capture locked')
      startStreamTicks()
    })
    .catch(e => console.error('[BLACK OPS]', e.message))
}

boot().catch(e => {
  console.error('[BOOT FATAL]', e.message)
  setTimeout(() => boot(), 5000)
})

process.on('uncaughtException',  e => console.error('[UNCAUGHT]',  e.message?.slice(0, 120)))
process.on('unhandledRejection', r => console.error('[REJECTION]', String(r).slice(0, 120)))
process.on('SIGTERM', () => { console.log('[BLACK] Graceful shutdown'); process.exit(0) })
