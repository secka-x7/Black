// Black — 47 Revenue Streams
// ZERO fake ticks. ZERO simulation.
// creditStream() is called ONLY from real external network events.
import { creditTreasury, getConfig, setConfig, recordEvent } from './treasury.js'

let _broadcast = null
export function setBroadcast(fn) { _broadcast = fn }

// Stream registry
const S = {
  S1: { name:'Transaction Base Fee',       cat:'transaction',    total:0, count:0 },
  S2: { name:'Volume Fee',                 cat:'transaction',    total:0, count:0 },
  S3: { name:'FX Spread',                  cat:'transaction',    total:0, count:0 },
  S4: { name:'Premium Routing Fee',        cat:'transaction',    total:0, count:0 },
  S5: { name:'Compliance Certificate',     cat:'transaction',    total:0, count:0 },
  S6: { name:'Confirmation Fee',           cat:'transaction',    total:0, count:0 },
  S7: { name:'XRPL DEX Offer Spread',      cat:'liquidity',      total:0, count:0 },
  S8: { name:'Stellar DEX Spread',         cat:'liquidity',      total:0, count:0 },
  S9: { name:'AMM Liquidity Fees',         cat:'liquidity',      total:0, count:0 },
  S10:{ name:'Cross-Network Arbitrage',    cat:'liquidity',      total:0, count:0 },
  S11:{ name:'CBDC Corridor FX',           cat:'liquidity',      total:0, count:0 },
  S12:{ name:'Intraday Liquidity Premium', cat:'liquidity',      total:0, count:0 },
  S13:{ name:'Prefunded Float',            cat:'liquidity',      total:0, count:0 },
  S14:{ name:'Settlement Guarantee',       cat:'liquidity',      total:0, count:0 },
  S15:{ name:'Stellar USDC Pool Yield',    cat:'yield',          total:0, count:0 },
  S16:{ name:'XRPL AMM Pool Yield',        cat:'yield',          total:0, count:0 },
  S17:{ name:'Hedera Staking',             cat:'yield',          total:0, count:0 },
  S18:{ name:'Algorand Governance',        cat:'yield',          total:0, count:0 },
  S19:{ name:'Tokenized Treasury Yield',   cat:'yield',          total:0, count:0 },
  S20:{ name:'LP Token Accumulation',      cat:'yield',          total:0, count:0 },
  S21:{ name:'Payment Flow Data',          cat:'data',           total:0, count:0 },
  S22:{ name:'Corridor Intelligence',      cat:'data',           total:0, count:0 },
  S23:{ name:'Network Health Data',        cat:'data',           total:0, count:0 },
  S24:{ name:'FX Rate Data Feed',          cat:'data',           total:0, count:0 },
  S25:{ name:'Compliance Intelligence',    cat:'data',           total:0, count:0 },
  S26:{ name:'Fraud Pattern Database',     cat:'data',           total:0, count:0 },
  S27:{ name:'Settlement Prediction API',  cat:'data',           total:0, count:0 },
  S28:{ name:'API Access Tiers',           cat:'infrastructure', total:0, count:0 },
  S29:{ name:'White-Label Licensing',      cat:'infrastructure', total:0, count:0 },
  S30:{ name:'Webhook Delivery',           cat:'infrastructure', total:0, count:0 },
  S31:{ name:'Batch Processing',           cat:'infrastructure', total:0, count:0 },
  S32:{ name:'ISO 20022 Translation',      cat:'infrastructure', total:0, count:0 },
  S33:{ name:'Audit Trail Export',         cat:'infrastructure', total:0, count:0 },
  S34:{ name:'Regulatory Report Gen',      cat:'infrastructure', total:0, count:0 },
  S35:{ name:'Payment Insurance',          cat:'advanced',       total:0, count:0 },
  S36:{ name:'Escrow Service Fee',         cat:'advanced',       total:0, count:0 },
  S37:{ name:'Netting Service',            cat:'advanced',       total:0, count:0 },
  S38:{ name:'Trade Finance Processing',   cat:'advanced',       total:0, count:0 },
  S39:{ name:'Payroll Processing',         cat:'advanced',       total:0, count:0 },
  S40:{ name:'Remittance Aggregation',     cat:'advanced',       total:0, count:0 },
  S41:{ name:'DeFi-TradFi Bridge',         cat:'advanced',       total:0, count:0 },
  S42:{ name:'CBDC Pilot Platform',        cat:'institutional',  total:0, count:0 },
  S43:{ name:'Network Stress Test',        cat:'institutional',  total:0, count:0 },
  S44:{ name:'ISO 20022 Certification',    cat:'institutional',  total:0, count:0 },
  S45:{ name:'Interoperability Testing',   cat:'institutional',  total:0, count:0 },
  S46:{ name:'Custom Integration',         cat:'institutional',  total:0, count:0 },
  S47:{ name:'Sovereign Routing Premium',  cat:'institutional',  total:0, count:0 },
}

export function restoreStreams() {
  let restored = 0
  for (const id of Object.keys(S)) {
    const v = getConfig('stream_' + id)
    if (v) { S[id].total = parseFloat(v) || 0; restored++ }
  }
  if (restored > 0) console.log(`[STREAMS] Restored ${restored} stream totals`)
}

// The only function that creates revenue
// Called exclusively from real external events — XRPL tx, Stellar tx, Hedera tx, Algo tx, ModemPay webhook
export function creditStream(id, amount, source) {
  if (!S[id] || !amount || amount <= 0 || !isFinite(amount)) return
  S[id].total  += amount
  S[id].count  += 1
  // Persist every 10 credits
  if (S[id].count % 10 === 0) setConfig('stream_' + id, S[id].total.toFixed(6))
  // Feed treasury
  creditTreasury(amount, id, source)
  // Broadcast to dashboard
  if (_broadcast) _broadcast('credit', { id, name: S[id].name, amount, source, total: S[id].total })
}

export function getStreamStats() {
  const byCategory = {}, streams = {}
  let grandTotal = 0
  for (const [id, s] of Object.entries(S)) {
    if (!byCategory[s.cat]) byCategory[s.cat] = { total:0, streams:{} }
    byCategory[s.cat].total += s.total
    byCategory[s.cat].streams[id] = { name:s.name, total:s.total, count:s.count }
    streams[id] = { name:s.name, total:s.total, count:s.count, cat:s.cat }
    grandTotal += s.total
  }
  const top = Object.entries(streams).filter(([,v])=>v.total>0).sort((a,b)=>b[1].total-a[1].total).slice(0,10).map(([id,v])=>({id,...v}))
  return { byCategory, grandTotal, streams, top, activeCount: Object.values(S).filter(v=>v.total>0).length }
}
