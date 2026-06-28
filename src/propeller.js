// Black Propeller Layer — real multipliers applied to real revenue events
// No simulation. Propellers amplify real credits from real network events.
import { getConfig, setConfig } from './treasury.js'

// Propeller config — defaults, overridable from dashboard controls
const DEFAULTS = {
  p1_intensity:   5,   // 1-10 — volume cascade multiplier strength
  p2_mode:        'auto',   // auto | aggressive | maximum
  p3_speed:       true,     // speed premium active
  p4_min_size:    0,        // minimum transaction size to apply P4
  p5_cross_nets:  1,        // minimum networks for cross-net premium
  p6_time_mode:   'auto',   // auto | always_peak
  p7_reinvest:    50,       // % of yield to reinvest
  p8_fortress:    'auto',   // auto | manual
  p9_arb_sens:    'medium', // low | medium | high | maximum
  p10_claude_int: 5,        // Claude interval in minutes
  master_enable:  true,
}

let _cfg = { ...DEFAULTS }
let _gapCount = 0, _gapWindow = Date.now()

export function setPropellerConfig(updates) {
  Object.assign(_cfg, updates)
  setConfig('propeller_config', JSON.stringify(_cfg))
  setConfig('propeller_intensity', String(_cfg.p1_intensity))
  console.log('[PROPELLER] Config updated:', JSON.stringify(updates))
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
    fortressPhase: parseInt(getConfig('fortress_phase')||'0'),
    captureRate: parseFloat(getConfig('capture_rate')||'0'),
    multiplierEstimate: estimateTotalMultiplier(1000),
  }
}

// Count arb gaps for P9
export function registerArbGap() {
  const now = Date.now()
  if (now - _gapWindow > 60000) { _gapCount = 0; _gapWindow = now }
  _gapCount++
}

// Estimate combined multiplier for display
export function estimateTotalMultiplier(usdAmount) {
  if (!_cfg.master_enable) return 1.0
  const cfg = getPropellerConfig()
  const p1 = 1 + (cfg.p1_intensity-1)*0.08
  const p4 = usdAmount>=100000?2.0 : usdAmount>=10000?1.6 : usdAmount>=1000?1.2 : 1.0
  const p8 = 1 + (parseInt(getConfig('fortress_phase')||'0')*0.15)
  const p9 = _gapCount>=10?2.2 : _gapCount>=5?1.7 : _gapCount>=3?1.3 : 1.0
  return Math.min(p1*p4*p8*p9, 8.0)
}

// Apply all propellers to a real credit event
// Returns the multiplied amount — this is the ONLY amplification
export function applyPropellers(amount, opts={}) {
  if (!_cfg.master_enable || !amount || amount <= 0) return amount
  const cfg = getPropellerConfig()
  const { usdAmount=amount, network='xrpl', corridor='', settlementMs=5000, crossNetworks=1, isArb=false } = opts
  let mult = 1.0

  // P1 — Volume cascade (intensity 1-10)
  const hourRev = parseFloat(getConfig('hour_rev')||'0')
  const p1base  = 1 + (cfg.p1_intensity-1) * 0.08
  const volBoost= hourRev>=10000000?3.5 : hourRev>=1000000?2.8 : hourRev>=100000?2.1 : hourRev>=10000?1.6 : 1.0
  mult *= cfg.p1_intensity >= 5 ? p1base * Math.min(volBoost, 2.0) : p1base

  // P2 — Corridor monopoly
  const dominated = JSON.parse(getConfig('dominated_corridors')||'[]')
  if (corridor && dominated.includes(corridor)) {
    const p2 = cfg.p2_mode==='maximum'?3.5 : cfg.p2_mode==='aggressive'?2.5 : 1.8
    mult *= p2
  } else if (dominated.length > 50) mult *= 1.3
  else if (dominated.length > 10)   mult *= 1.15

  // P3 — Speed premium (real settlement time)
  if (cfg.p3_speed) {
    const p3 = settlementMs<500?3.2 : settlementMs<1000?2.5 : settlementMs<2000?1.8 : settlementMs<5000?1.2 : 1.0
    mult *= p3
  }

  // P4 — Size amplifier
  if (usdAmount >= cfg.p4_min_size) {
    const p4 = usdAmount>=100000000?4.2 : usdAmount>=10000000?3.5 : usdAmount>=1000000?2.8 :
               usdAmount>=100000?2.1 : usdAmount>=10000?1.6 : usdAmount>=1000?1.2 : 1.0
    mult *= p4
  }

  // P5 — Cross-network premium
  if (crossNetworks >= cfg.p5_cross_nets && crossNetworks > 1) {
    const p5 = crossNetworks>=10?3.8 : crossNetworks>=5?2.8 : crossNetworks>=3?2.0 : 1.5
    mult *= p5
  }

  // P6 — Time of day
  if (cfg.p6_time_mode === 'always_peak') {
    mult *= 1.3
  } else {
    const hour = new Date().getUTCHours()
    const p6 = hour>=8&&hour<=18?1.3 : hour>=6&&hour<8?1.1 : hour>=18&&hour<22?1.1 : 0.85
    mult *= p6
  }

  // P7 — AMM depth compounder
  const ammPos = parseFloat(getConfig('xrpl_amm_position')||'0') + parseFloat(getConfig('stellar_amm_position')||'0')
  const p7 = ammPos>=100000000?4.0 : ammPos>=10000000?3.0 : ammPos>=1000000?2.2 :
             ammPos>=100000?1.6 : ammPos>=10000?1.2 : 1.0
  mult *= p7

  // P8 — Fortress compound (each phase = +0.15×)
  if (cfg.p8_fortress === 'auto') {
    const phase = parseInt(getConfig('fortress_phase')||'0')
    mult *= (1 + phase * 0.15)
  }

  // P9 — Arb frequency
  if (isArb) {
    const sens = cfg.p9_arb_sens
    const threshold = sens==='maximum'?1 : sens==='high'?2 : sens==='medium'?3 : 5
    if (_gapCount >= threshold) {
      const p9 = _gapCount>=20?2.8 : _gapCount>=10?2.2 : _gapCount>=5?1.7 : 1.3
      mult *= p9
    }
  }

  // P10 — Claude optimization multiplier (set by Claude API call in fortress)
  const claudeMult = parseFloat(getConfig('claude_multiplier')||'1.0')
  mult *= claudeMult

  // Hard cap: 8× maximum
  const finalMult = Math.min(mult, 8.0)
  return amount * finalMult
}
