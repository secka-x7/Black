// src/propeller.js — fix P8 cap and stack cap

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
}

export function getPropellerConfig() {
  const saved = getConfig('propeller_config')
  if (saved) { try { Object.assign(_cfg, JSON.parse(saved)) } catch {} }
  return { ..._cfg }
}

export function getPropellerStatus() {
  return {
    config: getPropellerConfig(),
    gapCount: _gapCount,
    fortressPhase: parseInt(getConfig('fortress_phase') || '0'),
    captureRate: parseFloat(getConfig('capture_rate') || '0'),
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
  const p1  = 1 + (cfg.p1_intensity - 1) * 0.04  // reduced: 1.0-1.36×
  const p8  = Math.min(1 + (parseInt(getConfig('fortress_phase') || '0') * 0.05), 1.5) // max 1.5×
  return Math.min(p1 * p8, 3.0) // hard cap 3×
}

export function applyPropellers(amount, opts = {}) {
  if (!_cfg.master_enable || !amount || amount <= 0) return amount
  const cfg = getPropellerConfig()
  const {
    usdAmount = amount,
    network = 'xrpl',
    corridor = '',
    settlementMs = 5000,
    crossNetworks = 1,
    isArb = false
  } = opts

  let mult = 1.0

  // P1 — intensity 1-10 → 1.0-1.36× (was 1.0-1.72×)
  mult *= 1 + (cfg.p1_intensity - 1) * 0.04

  // P2 — corridor monopoly (only if actually dominated)
  const dominated = JSON.parse(getConfig('dominated_corridors') || '[]')
  if (corridor && dominated.includes(corridor)) {
    mult *= cfg.p2_mode === 'maximum' ? 1.4 : cfg.p2_mode === 'aggressive' ? 1.2 : 1.1
  }

  // P3 — speed premium (real settlement time only)
  if (cfg.p3_speed) {
    const p3 = settlementMs < 500 ? 1.3 : settlementMs < 1000 ? 1.2 : settlementMs < 2000 ? 1.1 : 1.0
    mult *= p3
  }

  // P4 — size (real transaction size)
  if (usdAmount >= cfg.p4_min_size && usdAmount >= 1000) {
    const p4 = usdAmount >= 10000000 ? 1.5
             : usdAmount >= 1000000  ? 1.3
             : usdAmount >= 100000   ? 1.2
             : usdAmount >= 10000    ? 1.1 : 1.0
    mult *= p4
  }

  // P5 — cross-network (only when genuinely crossing networks)
  if (crossNetworks >= 2 && crossNetworks >= cfg.p5_cross_nets) {
    mult *= crossNetworks >= 5 ? 1.3 : 1.15
  }

  // P6 — time of day
  if (cfg.p6_time_mode === 'always_peak') {
    mult *= 1.15
  } else {
    const hour = new Date().getUTCHours()
    mult *= hour >= 8 && hour <= 18 ? 1.15 : hour >= 2 && hour < 8 ? 0.9 : 1.0
  }

  // P7 — AMM depth (only meaningful once real positions exist)
  const ammPos = parseFloat(getConfig('xrpl_amm_position') || '0')
               + parseFloat(getConfig('stellar_amm_position') || '0')
  if (ammPos >= 100000) mult *= Math.min(1 + ammPos / 10000000, 1.3)

  // P8 — Fortress compound: max 1.5× at phase 10 (was 2.5×)
  if (cfg.p8_fortress === 'auto') {
    const phase = parseInt(getConfig('fortress_phase') || '0')
    mult *= Math.min(1 + phase * 0.05, 1.5)
  }

  // P9 — Arb frequency (only for arb events)
  if (isArb && _gapCount >= 3) {
    mult *= _gapCount >= 10 ? 1.3 : _gapCount >= 5 ? 1.2 : 1.1
  }

  // P10 — Claude multiplier (set by actual API response)
  const claudeMult = parseFloat(getConfig('claude_multiplier') || '1.0')
  mult *= Math.min(claudeMult, 1.5) // cap Claude boost at 1.5×

  // HARD CAP: 3× maximum — real revenue amplified, not fabricated
  return amount * Math.min(mult, 3.0)
}
