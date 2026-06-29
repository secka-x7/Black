// Black Propeller Layer — real multipliers, sane caps
// FIXED: P8 max 1.5× (was 2.5×). Stack cap 2.5× (was 8×).
// FIXED: All individual propellers reduced to realistic ranges
import { getConfig, setConfig } from './treasury.js'

const DEFAULTS = {
  p1_intensity:   5,
  p2_mode:        'auto',
  p3_speed:       true,
  p4_min_size:    0,
  p5_cross_nets:  1,
  p6_time_mode:   'auto',
  p7_reinvest:    50,
  p8_fortress:    'auto',
  p9_arb_sens:    'medium',
  p10_claude_int: 5,
  master_enable:  true,
}

let _cfg = { ...DEFAULTS }
let _gapCount = 0, _gapWindow = Date.now()

export function setPropellerConfig(updates) {
  Object.assign(_cfg, updates)
  setConfig('propeller_config', JSON.stringify(_cfg))
  setConfig('propeller_intensity', String(_cfg.p1_intensity))
  console.log('[PROPELLER] Updated:', JSON.stringify(updates))
}

export function getPropellerConfig() {
  const saved = getConfig('propeller_config')
  if (saved) { try { Object.assign(_cfg, JSON.parse(saved)) } catch {} }
  return { ..._cfg }
}

export function getPropellerStatus() {
  return {
    config:             getPropellerConfig(),
    gapCount:           _gapCount,
    fortressPhase:      parseInt(getConfig('fortress_phase') || '0'),
    captureRate:        parseFloat(getConfig('capture_rate') || '0'),
    multiplierEstimate: estimateTotalMultiplier(1000),
  }
}

export function registerArbGap() {
  const now = Date.now()
  if (now - _gapWindow > 60000) { _gapCount = 0; _gapWindow = now }
  _gapCount++
}

export function estimateTotalMultiplier(usdAmount) {
  if (!_cfg.master_enable) return 1.0
  const cfg = getPropellerConfig()
  // P1: 1.0-1.36×, P8: max 1.5× → combined estimate
  const p1 = 1 + (cfg.p1_intensity - 1) * 0.04
  const p8 = Math.min(1 + (parseInt(getConfig('fortress_phase') || '0') * 0.05), 1.5)
  return Math.min(p1 * p8, 2.5)
}

export function applyPropellers(amount, opts = {}) {
  if (!_cfg.master_enable || !amount || amount <= 0) return amount
  const cfg = getPropellerConfig()
  const {
    usdAmount    = amount,
    network      = 'xrpl',
    corridor     = '',
    settlementMs = 5000,
    crossNetworks= 1,
    isArb        = false,
  } = opts

  let mult = 1.0

  // P1 — Volume intensity (1-10 → 1.0-1.36×)
  mult *= 1 + (cfg.p1_intensity - 1) * 0.04

  // P2 — Corridor monopoly (only real dominated corridors)
  const dominated = JSON.parse(getConfig('dominated_corridors') || '[]')
  if (corridor && dominated.includes(corridor)) {
    mult *= cfg.p2_mode === 'maximum' ? 1.25 : cfg.p2_mode === 'aggressive' ? 1.15 : 1.08
  }

  // P3 — Speed premium (capped at 1.2×)
  if (cfg.p3_speed) {
    mult *= settlementMs < 1000 ? 1.15 : settlementMs < 3000 ? 1.08 : 1.0
  }

  // P4 — Size (real transaction tiers, capped at 1.3×)
  if (usdAmount >= 1000) {
    const p4 = usdAmount >= 10000000 ? 1.30
             : usdAmount >= 1000000  ? 1.20
             : usdAmount >= 100000   ? 1.15
             : usdAmount >= 10000    ? 1.08 : 1.0
    mult *= p4
  }

  // P5 — Cross-network (only genuine multi-network events)
  if (crossNetworks >= 2) {
    mult *= crossNetworks >= 5 ? 1.15 : 1.08
  }

  // P6 — Time of day (capped at 1.12×)
  if (cfg.p6_time_mode === 'always_peak') {
    mult *= 1.12
  } else {
    const hour = new Date().getUTCHours()
    mult *= hour >= 8 && hour <= 18 ? 1.08 : hour >= 2 && hour < 8 ? 0.92 : 1.0
  }

  // P7 — AMM depth (only after real positions are funded)
  const ammPos = parseFloat(getConfig('xrpl_amm_position') || '0')
               + parseFloat(getConfig('stellar_amm_position') || '0')
  if (ammPos >= 10000) {
    // Max 1.2× at $1M+ AMM position
    mult *= Math.min(1 + (ammPos / 5000000), 1.20)
  }

  // P8 — Fortress compound: 0.05× per phase, max 1.5× at phase 10
  if (cfg.p8_fortress === 'auto') {
    const phase = parseInt(getConfig('fortress_phase') || '0')
    mult *= Math.min(1 + phase * 0.05, 1.50)
  }

  // P9 — Arb frequency (only for arb events, capped at 1.2×)
  if (isArb && _gapCount >= 3) {
    mult *= Math.min(1 + (_gapCount * 0.02), 1.20)
  }

  // P10 — Claude optimizer (capped at 1.3×)
  const claudeMult = Math.min(parseFloat(getConfig('claude_multiplier') || '1.0'), 1.30)
  mult *= claudeMult

  // ABSOLUTE HARD CAP: 2.5× maximum
  // This means Black can never credit more than 2.5× the base fee
  // Base fee is already capped at 12% by calcFee()
  // Total maximum: 12% × 2.5× = 30% of transaction — impossible in practice
  // but mathematically bounded
  return amount * Math.min(mult, 2.5)
}
