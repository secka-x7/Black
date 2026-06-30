// Black Omega — Boot Sequence
// Never crashes. Self-heals. All operations run automatically on deploy.
import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { initDB, getRecentLedger } from './db.js'
import { initControls, getControls, setControl } from './core/controls.js'
import { getTreasuryState, withdraw } from './core/treasury.js'
import { getStreamStats, restoreStreams, serializeStreams } from './core/streams.js'
import { getParentStatus } from './core/parentRegistry.js'
import { initPriceEngine, getPrices } from './core/price.js'
import { getDominionStats } from './operations/dominion.js'
import { getFortressStatus, runFortress } from './operations/fortress.js'
import { runSingularity } from './operations/singularity.js'
import { runSequence } from './operations/sequence.js'
import { parseWebhook } from './modempay.js'
import { getConfig, setConfig } from './db.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
const PORT   = process.env.PORT || 3000

app.use(express.json())

const clients = new Set()
export function broadcast(type, data) {
  const m = JSON.stringify({ type, data, ts: Date.now() })
  clients.forEach(ws => { try { if (ws.readyState === 1) ws.send(m) } catch {} })
}

wss.on('connection', ws => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  buildState().then(d => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'tick', data: d }))).catch(() => {})
})

app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime() | 0 }))

app.get('/api/state', async (_, res) => { try { res.json(await buildState()) } catch { res.json({ booting: true }) } })

app.get('/api/controls', (_, res) => res.json(getControls()))
app.post('/api/controls', (req, res) => {
  try {
    const { key, value } = req.body
    res.json(setControl(key, value))
    broadcast('controls', getControls())
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/withdraw', async (req, res) => {
  const { amount, destination, network } = req.body
  if (!amount || !destination) return res.status(400).json({ error: 'amount and destination required' })
  try { res.json(await withdraw(parseFloat(amount), destination, network || 'wave')) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/webhook/modempay', async (req, res) => {
  res.json({ ok: true })
  try {
    const parsed = parseWebhook(req.body)
    if (parsed && parsed.type === 'charge') {
      const { creditStream } = await import('./core/streams.js')
      const fee = parsed.amount * 0.015 // ModemPay fee tier
      creditStream('S24', fee, { parent: 'modempay', source: 'charge_succeeded', txRef: parsed.reference })
      broadcast('charge', parsed)
    }
  } catch (e) { console.error('[WEBHOOK]', e.message) }
})

async function buildState() {
  const treasury = await getTreasuryState()
  return {
    treasury,
    streams:   getStreamStats(),
    parents:   getParentStatus(),
    prices:    getPrices(),
    fortress:  getFortressStatus(),
    dominion:  getDominionStats(),
    controls:  getControls(),
    recent:    getRecentLedger(20),
    uptime:    process.uptime() | 0,
    memory:    Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  }
}

// Dashboard serving
const desktopPath = join(__dir, '../dashboard/black.html')
const mobilePath   = join(__dir, '../dashboard/black-mobile.html')
app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || ''
  const isMobile = /Mobile|Android|iPhone|iPad/.test(ua)
  const p = isMobile && existsSync(mobilePath) ? mobilePath : desktopPath
  if (existsSync(p)) res.send(readFileSync(p, 'utf8'))
  else res.send('<h1>Black Omega</h1><p>Booting...</p>')
})
app.get('/mobile', (_, res) => existsSync(mobilePath) ? res.send(readFileSync(mobilePath, 'utf8')) : res.redirect('/'))

async function boot() {
  console.log('[OMEGA] Booting Black Omega...')
  await initDB()
  initControls()

  server.listen(PORT, () => console.log(`[OMEGA] Live on :${PORT}`))

  setInterval(async () => { try { broadcast('tick', await buildState()) } catch {} }, 3000)
  setInterval(() => setConfig('streams_snapshot', serializeStreams()), 15000)

  const saved = getConfig('streams_snapshot')
  if (saved) restoreStreams(saved)

  initPriceEngine()

  console.log('[OMEGA] Running Operation Singularity (target: 45s)')
  await runSingularity()

  console.log('[OMEGA] Running Operation Sequence (target: 60s)')
  await runSequence()

  console.log('[OMEGA] Running Operation Fortress (target: 90s)')
  await runFortress()

  console.log('[OMEGA] All operations complete. Dominion active. Black Omega operational.')
}

boot().catch(e => { console.error('[BOOT FATAL]', e.message); setTimeout(() => boot(), 5000) })
process.on('uncaughtException',  e => console.error('[UNCAUGHT]',  e.message?.slice(0, 150)))
process.on('unhandledRejection', r => console.error('[REJECTION]', String(r).slice(0, 150)))
process.on('SIGTERM', () => { console.log('[OMEGA] Graceful shutdown'); process.exit(0) })
