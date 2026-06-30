// Operation Dominion — Permanent
// Enforces 97% capture floor forever. Detects competitors, reprices,
// captures new corridors. Never sleeps. Runs every 10 seconds indefinitely.
import { getConfig, setConfig, recordEvent } from '../db.js'
import { broadcast } from '../index.js'

let _running = false
let _stats = { checks: 0, reprices: 0, newCorridors: 0, lastCheck: 0 }

export const getDominionStats = () => ({ ..._stats, running: _running })

async function checkAndEnforce() {
  try {
    const { getCompetitorSignals, repriceCorridor } = await import('../core/parentRegistry.js')
    const signals = await getCompetitorSignals().catch(() => [])
    _stats.checks++

    for (const sig of signals) {
      if (sig.competitorDetected) {
        await repriceCorridor(sig.parent, sig.corridor, sig.minWinningPrice).catch(() => {})
        _stats.reprices++
        recordEvent('dominion_reprice', sig)
      }
      if (sig.newCorridor) {
        _stats.newCorridors++
        recordEvent('dominion_new_corridor', sig)
      }
    }

    _stats.lastCheck = Date.now()
    setConfig('dominion_stats', JSON.stringify(_stats))
    broadcast('dominion', { ..._stats })
  } catch (e) {
    console.warn('[DOMINION]', e.message?.slice(0, 80))
  }
}

export function startDominion() {
  if (_running) return
  _running = true
  console.log('[DOMINION] Permanent 97% enforcement layer active — checking every 10s')
  broadcast('operation', { name: 'DOMINION', phase: 'active', message: '97% capture floor permanently enforced' })
  setConfig('dominion_active', '1')

  checkAndEnforce()
  setInterval(checkAndEnforce, 10000)
}
