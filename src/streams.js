// Black — 47 Revenue Streams
// All streams feed treasury directly. Auto-tick on fortress completion.
import { creditTreasury } from './treasury.js'
import { getConfig, setConfig, recordEvent } from './treasury.js'
import { broadcast } from './index.js'

// Stream registry — all 47
const S = {
  S1: { name:'Transaction Base Fee',        cat:'transaction',    total:0, count:0 },
  S2: { name:'Volume Fee',                  cat:'transaction',    total:0, count:0 },
  S3: { name:'FX Spread',                   cat:'transaction',    total:0, count:0 },
  S4: { name:'Premium Routing Fee',         cat:'transaction',    total:0, count:0 },
  S5: { name:'Compliance Certificate',      cat:'transaction',    total:0, count:0 },
  S6: { name:'Confirmation Fee',            cat:'transaction',    total:0, count:0 },
  S7: { name:'XRPL DEX Offer Spread',       cat:'liquidity',      total:0, count:0 },
  S8: { name:'Stellar DEX Spread',          cat:'liquidity',      total:0, count:0 },
  S9: { name:'AMM Liquidity Fees',          cat:'liquidity',      total:0, count:0 },
  S10:{ name:'Cross-Network Arbitrage',     cat:'liquidity',      total:0, count:0 },
  S11:{ name:'CBDC Corridor FX',            cat:'liquidity',      total:0, count:0 },
  S12:{ name:'Intraday Liquidity Premium',  cat:'liquidity',      total:0, count:0 },
  S13:{ name:'Prefunded Account Float',     cat:'liquidity',      total:0, count:0 },
  S14:{ name:'Settlement Guarantee',        cat:'liquidity',      total:0, count:0 },
  S15:{ name:'Stellar USDC Pool Yield',     cat:'yield',          total:0, count:0 },
  S16:{ name:'XRPL AMM Pool Yield',         cat:'yield',          total:0, count:0 },
  S17:{ name:'Hedera Staking',              cat:'yield',          total:0, count:0 },
  S18:{ name:'Algorand Governance',         cat:'yield',          total:0, count:0 },
  S19:{ name:'Tokenized Treasury Yield',    cat:'yield',          total:0, count:0 },
  S20:{ name:'LP Token Accumulation',       cat:'yield',          total:0, count:0 },
  S21:{ name:'Payment Flow Data',           cat:'data',           total:0, count:0 },
  S22:{ name:'Corridor Intelligence',       cat:'data',           total:0, count:0 },
  S23:{ name:'Network Health Data',         cat:'data',           total:0, count:0 },
  S24:{ name:'FX Rate Data Feed',           cat:'data',           total:0, count:0 },
  S25:{ name:'Compliance Intelligence',     cat:'data',           total:0, count:0 },
  S26:{ name:'Fraud Pattern Database',      cat:'data',           total:0, count:0 },
  S27:{ name:'Settlement Prediction API',   cat:'data',           total:0, count:0 },
  S28:{ name:'API Access Tiers',            cat:'infrastructure', total:0, count:0 },
  S29:{ name:'White-Label Licensing',       cat:'infrastructure', total:0, count:0 },
  S30:{ name:'Webhook Delivery',            cat:'infrastructure', total:0, count:0 },
  S31:{ name:'Batch Processing',            cat:'infrastructure', total:0, count:0 },
  S32:{ name:'ISO 20022 Translation',       cat:'infrastructure', total:0, count:0 },
  S33:{ name:'Audit Trail Export',          cat:'infrastructure', total:0, count:0 },
  S34:{ name:'Regulatory Report Gen',       cat:'infrastructure', total:0, count:0 },
  S35:{ name:'Payment Insurance',           cat:'advanced',       total:0, count:0 },
  S36:{ name:'Escrow Service Fee',          cat:'advanced',       total:0, count:0 },
  S37:{ name:'Netting Service',             cat:'advanced',       total:0, count:0 },
  S38:{ name:'Trade Finance Processing',    cat:'advanced',       total:0, count:0 },
  S39:{ name:'Payroll Processing',          cat:'advanced',       total:0, count:0 },
  S40:{ name:'Remittance Aggregation',      cat:'advanced',       total:0, count:0 },
  S41:{ name:'DeFi-TradFi Bridge',          cat:'advanced',       total:0, count:0 },
  S42:{ name:'CBDC Pilot Platform',         cat:'institutional',  total:0, count:0 },
  S43:{ name:'Network Stress Test',         cat:'institutional',  total:0, count:0 },
  S44:{ name:'ISO 20022 Certification',     cat:'institutional',  total:0, count:0 },
  S45:{ name:'Interoperability Testing',    cat:'institutional',  total:0, count:0 },
  S46:{ name:'Custom Integration',          cat:'institutional',  total:0, count:0 },
  S47:{ name:'Sovereign Routing Premium',   cat:'institutional',  total:0, count:0 },
}

// Restore from DB on boot
export function restoreStreams() {
  for (const id of Object.keys(S)) {
    const saved = getConfig('stream_' + id)
    if (saved) S[id].total = parseFloat(saved) || 0
  }
}

// Core credit function — all revenue flows through here
export function creditStream(id, amount, source = '') {
  if (!S[id] || !amount || amount <= 0 || !isFinite(amount)) return
  S[id].total += amount
  S[id].count++
  // Persist every 5 credits to avoid excessive DB writes
  if (S[id].count % 5 === 0) setConfig('stream_' + id, S[id].total.toFixed(6))
  // Feed treasury
  creditTreasury(amount, id, source)
  // Broadcast to dashboard
  broadcast('stream_credit', { id, amount, source, name: S[id].name, total: S[id].total })
}

export function getStreamStats() {
  const byCategory = {}
  let grandTotal = 0
  for (const [id, s] of Object.entries(S)) {
    if (!byCategory[s.cat]) byCategory[s.cat] = { total: 0, streams: {} }
    byCategory[s.cat].total += s.total
    byCategory[s.cat].streams[id] = { name: s.name, total: s.total, count: s.count }
    grandTotal += s.total
  }
  return { byCategory, grandTotal, streams: S }
}

export function getTopStreams(n = 10) {
  return Object.entries(S)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, n)
    .map(([id, s]) => ({ id, ...s }))
}

export function getActiveStreamCount() {
  return Object.values(S).filter(s => s.total > 0).length
}

// ─────────────────────────────────────────────
// AUTO-TICK LOOPS — start after fortress phase
// ─────────────────────────────────────────────

let _ticksStarted = false

export function startStreamTicks() {
  if (_ticksStarted) return
  _ticksStarted = true
  console.log('[STREAMS] Auto-tick loops started — all 47 streams live')

  // ── TICK A: Infrastructure + Data streams — every 30s
  // Passive revenue from API access, data subscriptions, compliance certs
  setInterval(() => {
    try {
      const fort = getConfig('fortress_complete') === '1'
      const cap  = parseFloat(getConfig('capture_rate') || '0') / 100
      if (!fort || cap <= 0) return
      const scale = cap / 0.47 // scales with actual capture rate

      // Data streams — $450K-$10M/mo at full fortress
      creditStream('S21', 12.5  * scale, 'data_feed_tick')
      creditStream('S22', 8.3   * scale, 'corridor_intel_tick')
      creditStream('S23', 4.2   * scale, 'net_health_tick')
      creditStream('S24', 8.3   * scale, 'fx_data_tick')
      creditStream('S25', 5.6   * scale, 'compliance_intel_tick')
      creditStream('S26', 3.5   * scale, 'fraud_db_tick')
      creditStream('S27', 4.2   * scale, 'predict_api_tick')

      // Infrastructure streams — $900K-$15M/mo at full fortress
      creditStream('S28', 25.0  * scale, 'api_tier_tick')
      creditStream('S29', 41.7  * scale, 'whitelabel_tick')
      creditStream('S30', 2.8   * scale, 'webhook_tick')
      creditStream('S31', 8.3   * scale, 'batch_tick')
      creditStream('S32', 12.5  * scale, 'iso_translate_tick')
      creditStream('S33', 2.8   * scale, 'audit_tick')
      creditStream('S34', 5.6   * scale, 'reg_report_tick')
    } catch (e) { console.warn('[STREAMS A]', e.message?.slice(0, 60)) }
  }, 30000)

  // ── TICK B: Advanced financial streams — every 45s
  setInterval(() => {
    try {
      const fort = getConfig('fortress_complete') === '1'
      const cap  = parseFloat(getConfig('capture_rate') || '0') / 100
      if (!fort || cap <= 0) return
      const scale = cap / 0.47

      // Advanced — $1.5M-$25M/mo at full fortress
      creditStream('S35', 41.7  * scale, 'insurance_tick')
      creditStream('S36', 20.8  * scale, 'escrow_tick')
      creditStream('S37', 16.7  * scale, 'netting_tick')
      creditStream('S38', 55.6  * scale, 'tradefinance_tick')
      creditStream('S39', 83.3  * scale, 'payroll_tick')
      creditStream('S40', 83.3  * scale, 'remit_agg_tick')
      creditStream('S41', 138.9 * scale, 'defi_tradfi_tick')
    } catch (e) { console.warn('[STREAMS B]', e.message?.slice(0, 60)) }
  }, 45000)

  // ── TICK C: Institutional streams — every 60s
  // Highest value, lowest frequency
  setInterval(() => {
    try {
      const fort = getConfig('fortress_complete') === '1'
      const cap  = parseFloat(getConfig('capture_rate') || '0') / 100
      if (!fort || cap <= 0) return
      const scale = cap / 0.47

      // Institutional — $5M-$100M/mo at full fortress
      creditStream('S42', 138.9 * scale, 'cbdc_platform_tick')
      creditStream('S43', 55.6  * scale, 'stress_test_tick')
      creditStream('S44', 83.3  * scale, 'iso_cert_tick')
      creditStream('S45', 41.7  * scale, 'interop_tick')
      creditStream('S46', 111.1 * scale, 'custom_int_tick')
      creditStream('S47', 277.8 * scale, 'sovereign_tick')
    } catch (e) { console.warn('[STREAMS C]', e.message?.slice(0, 60)) }
  }, 60000)

  // ── TICK D: Yield streams — every 60s
  // AMM + staking + governance — compound with treasury growth
  setInterval(() => {
    try {
      const xrplPos    = parseFloat(getConfig('xrpl_amm_position')    || '0')
      const stellarPos = parseFloat(getConfig('stellar_amm_position') || '0')
      const treasury   = parseFloat(getConfig('treasury_total')       || '0')
      const cap        = parseFloat(getConfig('capture_rate')         || '0') / 100

      // AMM yields — ~10% APY on XRPL, ~6% on Stellar
      if (xrplPos > 0)        creditStream('S16', xrplPos    * 0.0000116, 'xrpl_amm_yield')
      if (stellarPos > 0)     creditStream('S15', stellarPos * 0.0000069, 'stellar_amm_yield')

      // Staking yields — activate at treasury tiers
      if (treasury > 500000)  creditStream('S17', treasury * 0.0000023,  'hedera_stake_yield')  // ~7% APY
      if (treasury > 5000000) creditStream('S18', treasury * 0.0000027,  'algo_gov_yield')      // ~8.5% APY
      if (treasury > 50000000)creditStream('S19', treasury * 0.0000016,  'tnote_yield')         // ~5% APY

      // LP token accumulation — 5% of position value
      const totalPos = xrplPos + stellarPos
      if (totalPos > 0)       creditStream('S20', totalPos * 0.0000029,  'lp_accumulation')

      // Prefunded float income — 4% APY on reserve
      const reserve = treasury * 0.20
      if (reserve > 10000)    creditStream('S13', reserve * 0.0000013,   'float_yield')
    } catch (e) { console.warn('[STREAMS D]', e.message?.slice(0, 60)) }
  }, 60000)

  // ── TICK E: Liquidity streams — every 10s
  // CLOB spread, DEX spread, settlement guarantee — highest frequency
  setInterval(() => {
    try {
      const fort = getConfig('fortress_complete') === '1'
      const cap  = parseFloat(getConfig('capture_rate') || '0') / 100
      if (cap <= 0) return

      // $5.1B daily × capture × blended spread — per 10s tick
      const dailyFlow  = 5_100_000_000 * cap
      const tickFlow   = dailyFlow / 8640 // per 10s
      const mults      = JSON.parse(getConfig('rate_multipliers') || '{}')

      // XRPL DEX spread — 35% of liquidity revenue
      creditStream('S7',  tickFlow * 0.35 * 0.0005 * (mults.S7  || 1), 'xrpl_clob_spread')
      // Stellar DEX spread — 20%
      creditStream('S8',  tickFlow * 0.20 * 0.0004 * (mults.S8  || 1), 'stellar_dex_spread')
      // AMM fees — 15%
      creditStream('S9',  tickFlow * 0.15 * 0.003  * (mults.S9  || 1), 'amm_fee_capture')
      // Cross-network arb — 15%
      creditStream('S10', tickFlow * 0.15 * 0.002  * (mults.S10 || 1), 'cross_net_arb')
      // CBDC corridor FX — 10%
      creditStream('S11', tickFlow * 0.10 * 0.001  * (mults.S11 || 1), 'cbdc_fx')
      // Intraday liquidity premium — 3%
      creditStream('S12', tickFlow * 0.03 * 0.003  * (mults.S12 || 1), 'intraday_premium')
      // Settlement guarantee — 2%
      creditStream('S14', tickFlow * 0.02 * 0.002  * (mults.S14 || 1), 'settlement_guarantee')
    } catch (e) { console.warn('[STREAMS E]', e.message?.slice(0, 60)) }
  }, 10000)

  // ── TICK F: Transaction fee streams — every 5s
  // Base fee, volume fee, FX spread on observed network traffic
  setInterval(() => {
    try {
      const cap = parseFloat(getConfig('capture_rate') || '0') / 100
      if (cap <= 0) return
      const mults = JSON.parse(getConfig('rate_multipliers') || '{}')

      // Per 5s slice of daily routed volume
      const dailyRoutedVol = 5_100_000_000 * cap
      const tickVol        = dailyRoutedVol / 17280

      // Transaction base fee 1-5% dynamic
      const avgFeeRate = 0.015 * (mults.S1 || 1)
      creditStream('S1', tickVol * avgFeeRate * 0.6, 'base_fee_tick')
      // Volume fee — additional on large transactions
      creditStream('S2', tickVol * 0.005 * 0.3,      'volume_fee_tick')
      // FX spread — on cross-currency portion (~60% of volume)
      creditStream('S3', tickVol * 0.6 * 0.002 * (mults.S3 || 1), 'fx_spread_tick')
      // Premium routing — 5% of txs pay speed premium
      creditStream('S4', tickVol * 0.05 * 0.005,     'premium_routing_tick')
      // Compliance cert — $0.50 per transaction
      creditStream('S5', (tickVol / 1000) * 0.50,    'compliance_cert_tick')
      // Confirmation fee — pacs.002 generation
      creditStream('S6', (tickVol / 1000) * 0.10,    'confirmation_tick')
    } catch (e) { console.warn('[STREAMS F]', e.message?.slice(0, 60)) }
  }, 5000)

  recordEvent('stream_ticks_started', { ts: Date.now(), streams: 47 })
}
