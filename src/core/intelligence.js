// Black Omega — Rule-Based Intelligence Engine
// 8 deterministic modules. No external AI calls. No cost. No latency.
import { getConfig, setConfig } from '../db.js'

// Module 1 — Spread Detector
export function detectSpread(bid, ask) {
  if (!bid || !ask || bid <= 0) return { actionable: false, spread: 0 }
  const mid = (bid + ask) / 2
  const spread = Math.abs(ask - bid) / mid * 100
  return { actionable: spread > 0.15, spread }
}

// Module 2 — Flow Router
export function routeFlow(amountUSD, networkLatencies = {}) {
  if (amountUSD < 100)   return { route: 'stellar', reason: 'lowest fee for small amount' }
  if (amountUSD < 10000) return { route: 'xrpl', reason: 'best spread for mid amount' }
  const healthy = Object.entries(networkLatencies).filter(([, ms]) => ms < 10000).map(([n]) => n)
  if (healthy.length >= 2) return { route: 'split', networks: healthy.slice(0, 2), reason: 'large amount split across networks' }
  return { route: healthy[0] || 'xrpl', reason: 'fallback single network' }
}

// Module 3 — Fee Optimizer
export function optimizeFee(amountUSD, corridorCompetitors, hour) {
  const sizeTier =
    amountUSD < 1000 ? 0.01 : amountUSD < 10000 ? 0.015 :
    amountUSD < 100000 ? 0.025 : amountUSD < 1000000 ? 0.035 :
    amountUSD < 10000000 ? 0.04 : 0.05
  const corridorMult = corridorCompetitors === 0 ? 2.0 : corridorCompetitors <= 2 ? 1.3 : 1.0
  const timeMult = hour >= 7 && hour <= 14 ? 1.2 : 1.0
  return sizeTier * corridorMult * timeMult
}

// Module 5 — Risk Assessor
export function assessRisk(amountUSD, frequencyPerMin, accountAgeSec) {
  if (amountUSD > 100000) return { risk: 'review', action: 'two_step_confirm' }
  if (frequencyPerMin > 10) return { risk: 'high', action: 'rate_limit' }
  if (amountUSD > 1000000) return { risk: 'flag', action: 'manual_review' }
  return { risk: 'low', action: 'proceed' }
}

// Module 6 — Position Manager
export function recommendRebalance(positions) {
  const sorted = Object.entries(positions).sort((a, b) => (b[1].yield || 0) - (a[1].yield || 0))
  return { increaseAllocation: sorted[0]?.[0], decreaseAllocation: sorted[sorted.length - 1]?.[0] }
}

// Module 7 — Corridor Intelligence
const _corridorVolume = {}
export function trackCorridor(corridor, volumeUSD) {
  if (!_corridorVolume[corridor]) _corridorVolume[corridor] = { total: 0, samples: [] }
  _corridorVolume[corridor].total += volumeUSD
  _corridorVolume[corridor].samples.push({ v: volumeUSD, ts: Date.now() })
  if (_corridorVolume[corridor].samples.length > 100) _corridorVolume[corridor].samples.shift()
}
export function getTopCorridors(n = 20) {
  return Object.entries(_corridorVolume).sort((a, b) => b[1].total - a[1].total).slice(0, n).map(([c, d]) => ({ corridor: c, total: d.total }))
}

// Module 8 — Network Health Monitor
const _health = {}
export function recordHealth(network, latencyMs, errored) {
  _health[network] = { latencyMs, errored, ts: Date.now() }
}
export function getHealthyNetworks() {
  return Object.entries(_health).filter(([, h]) => !h.errored && h.latencyMs < 8000).map(([n]) => n)
}

// Module 4 — Propeller calculator is in propeller.js (kept separate for clarity)

// Rate optimization — called by Fortress phase 7
export async function optimizeRates() {
  const corridors = getTopCorridors(20)
  const healthy = getHealthyNetworks()
  setConfig('top_corridors', JSON.stringify(corridors))
  setConfig('healthy_networks', JSON.stringify(healthy))
  return { corridors: corridors.length, healthy: healthy.length }
}
