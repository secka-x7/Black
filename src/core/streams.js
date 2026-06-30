// Black Omega — 100 Revenue Streams
// Streams categorize WHERE real revenue came from. No fake credits here —
// creditStream() is only ever called by real parent network event handlers.
import { recordLedger } from '../db.js'
import { broadcast } from '../index.js'
import { calculatePropelledFee, getPropellerIntensity } from './propeller.js'

const NAMES = {
  S1:'XRPL CLOB Spread', S2:'XRPL AMM Fees', S3:'XRPL ODL Routing', S4:'Stellar Anchor Fee',
  S5:'Stellar AMM Fees', S6:'Stellar Path Routing', S7:'Ethereum Uniswap V3', S8:'Arbitrum L2 Spread',
  S9:'Base L2 Spread', S10:'Optimism L2 Spread', S11:'BNB PancakeSwap', S12:'BNB Venus Lending',
  S13:'Solana Jupiter Routing', S14:'Solana Raydium CLOB', S15:'Solana Orca Concentrated',
  S16:'Cosmos IBC Relay', S17:'Osmosis DEX Fees', S18:'Polkadot XCM Routing', S19:'Avalanche Trader Joe',
  S20:'Avalanche Subnet Routing', S21:'CBDC Bridge Premium', S22:'SWIFT ISO20022 Routing',
  S23:'Cross-Parent Arbitrage', S24:'ModemPay Charge Fee', S25:'Institutional Corridor Premium',
  S26:'Speed Settlement Premium', S27:'Volume Velocity Bonus', S28:'Corridor Monopoly Premium',
  S29:'Multi-Parent Routing Premium', S30:'CBDC Multi-Rail Conversion',
}
for (let i = 31; i <= 100; i++) NAMES['S' + i] = 'Corridor Stream ' + i

const _stats = {}
for (const id of Object.keys(NAMES)) _stats[id] = { total: 0, count: 0 }

export function restoreStreams(saved) {
  if (!saved) return
  try {
    const obj = JSON.parse(saved)
    for (const [id, v] of Object.entries(obj)) if (_stats[id]) _stats[id] = v
  } catch {}
}

// THE ONLY WAY REVENUE ENTERS THE SYSTEM:
// called exclusively by real parent network handlers on real confirmed events
export function creditStream(id, amountUSD, { parent, source, txRef, feeContext } = {}) {
  if (!NAMES[id] || !amountUSD || amountUSD <= 0 || !isFinite(amountUSD)) return

  let finalAmount = amountUSD
  if (feeContext) {
    const intensity = getPropellerIntensity()
    const { fee } = calculatePropelledFee(feeContext.baseFeeRate || 0.05, { ...feeContext, intensity })
    finalAmount = (feeContext.txAmountUSD || amountUSD) * fee
  }

  _stats[id].total += finalAmount
  _stats[id].count++

  recordLedger({ parent: parent || '', stream: id, amount: finalAmount, source: source || '', txRef: txRef || '' })
  broadcast('ledger_credit', { id, name: NAMES[id], amount: finalAmount, parent, source, ts: Date.now() })
}

export function getStreamStats() {
  return Object.entries(_stats).map(([id, s]) => ({ id, name: NAMES[id], ...s })).sort((a, b) => b.total - a.total)
}

export function getActiveStreamCount() {
  return Object.values(_stats).filter(s => s.total > 0).length
}

export function serializeStreams() { return JSON.stringify(_stats) }
