// Black Omega — Propeller Layer (10 GPs)
// Applies real, condition-based multipliers to every real transaction fee.
// Stack cap 10x. Hard cap 12% absolute max fee.
import { getConfig } from '../db.js'

function getRange(val, tiers) {
  for (const [threshold, mult] of tiers) if (val >= threshold) return mult
  return 1.0
}

// GP1 — Volume Velocity (real hourly volume)
function gp1(hourlyVolumeUSD) {
  return getRange(hourlyVolumeUSD, [[100_000_000, 3.0], [10_000_000, 2.3], [1_000_000, 1.8], [100_000, 1.4], [0, 1.0]])
}

// GP2 — Corridor Monopoly (real competitor count)
function gp2(competitorCount) {
  if (competitorCount === 0) return 2.5
  if (competitorCount <= 2) return 1.6
  if (competitorCount <= 5) return 1.2
  return 1.0
}

// GP3 — Settlement Speed (real measured ms)
function gp3(settlementMs) {
  if (settlementMs < 500)  return 1.8
  if (settlementMs < 2000) return 1.5
  if (settlementMs < 5000) return 1.3
  return 1.1
}

// GP4 — Transaction Size (real USD amount)
function gp4(amountUSD) {
  return getRange(amountUSD, [[100_000_000, 4.2], [10_000_000, 3.5], [1_000_000, 2.8], [100_000, 2.1], [10_000, 1.6], [1_000, 1.2], [0, 1.0]])
}

// GP5 — Multi-Parent Premium (real parent count in route)
function gp5(parentCount) {
  if (parentCount >= 10) return 4.0
  if (parentCount >= 5)  return 2.8
  if (parentCount >= 3)  return 2.0
  if (parentCount >= 2)  return 1.5
  return 1.0
}

// GP6 — Temporal Optimizer (real UTC clock)
function gp6() {
  const h = new Date().getUTCHours()
  if (h === 7)  return 1.5  // London open
  if (h === 13) return 1.4  // NY open
  if (h === 0)  return 1.3  // Tokyo open
  if (h >= 1 && h < 8)  return 1.2  // Asian session
  if (h >= 8 && h < 18) return 1.1  // standard hours
  return 1.0
}

// GP7 — AMM Depth Compounder (real position size)
function gp7(positionUSD) {
  return getRange(positionUSD, [[10_000_000, 3.0], [1_000_000, 2.2], [100_000, 1.7], [10_000, 1.3], [1_000, 1.1], [0, 1.0]])
}

// GP8 — Fortress Phase Bonus (real completed phases)
function gp8(phasesComplete) {
  return 1.0 + (Math.min(phasesComplete, 10) * 0.15)
}

// GP9 — Arb Gap Frequency (real detected gaps/min)
function gp9(gapsPerMin) {
  return getRange(gapsPerMin, [[20, 2.8], [10, 2.2], [5, 1.7], [3, 1.3], [0, 1.0]])
}

// GP10 — Parent Network Premium (real parent identity)
const PARENT_PREMIUM = { cbdc: 3.0, swift: 2.5, xrpl: 2.0, ethereum: 1.8, stellar: 1.5 }
function gp10(parentName) { return PARENT_PREMIUM[parentName] || 1.2 }

const STACK_CAP = 10.0
const FEE_HARD_CAP = 0.12

export function calculatePropelledFee(baseFee, context) {
  const {
    hourlyVolumeUSD = 0, competitorCount = 99, settlementMs = 5000,
    amountUSD = 0, parentCount = 1, positionUSD = 0,
    phasesComplete = 0, gapsPerMin = 0, parentName = '',
    intensity = {} // dashboard sliders 0-10 per GP
  } = context

  const scale = (gp, key) => 1 + (gp - 1) * ((intensity[key] ?? 10) / 10)

  let mult = 1.0
  mult *= scale(gp1(hourlyVolumeUSD), 'gp1')
  mult *= scale(gp2(competitorCount), 'gp2')
  mult *= scale(gp3(settlementMs), 'gp3')
  mult *= scale(gp4(amountUSD), 'gp4')
  mult *= scale(gp5(parentCount), 'gp5')
  mult *= scale(gp6(), 'gp6')
  mult *= scale(gp7(positionUSD), 'gp7')
  mult *= scale(gp8(phasesComplete), 'gp8')
  mult *= scale(gp9(gapsPerMin), 'gp9')
  mult *= scale(gp10(parentName), 'gp10')

  mult = Math.min(mult, STACK_CAP)
  const finalFee = Math.min(baseFee * mult, FEE_HARD_CAP)
  return { fee: finalFee, multiplier: mult }
}

export function getPropellerIntensity() {
  try { return JSON.parse(getConfig('propeller_intensity') || '{}') } catch { return {} }
}
