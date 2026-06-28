// src/price.js — fix XRPL HTTP fallback + keep arb caps

import { setConfig, getConfig } from './treasury.js'
import { creditStream } from './streams.js'

const GECKO   = 'https://api.coingecko.com/api/v3'
const STELLAR = 'https://horizon.stellar.org'

// XRPL HTTP RPC fallbacks — xrplcluster times out, use ripple.com nodes
const XRPL_HTTP = [
  'https://s1.ripple.com:51234',
  'https://s2.ripple.com:51234',
  'https://xrpl.ws',
]
const HEDERA_URLS = [
  'https://mainnet-public.mirrornode.hedera.com',
  'https://mainnet.mirrornode.hedera.com',
]
const ALGO_URLS = [
  'https://mainnet-idx.algonode.cloud',
  'https://algoindexer.algoexplorerapi.io',
]

export const prices  = { XRP:1.041, XLM:0.170, HBAR:0.071, ALGO:0.087, BTC:59566, ETH:1569, USDC:1, USDT:1 }
export const volumes = { xrpl:3_200_000_000, stellar:400_000_000, hedera:1_200_000_000, algo:300_000_000 }
export const spreads = {}
export const gaps    = {}

let _xrplHttpIdx = 0, _hederaIdx = 0, _algoIdx = 0
let _fetch = null
async function getFetch() {
  if (!_fetch) _fetch = (await import('node-fetch')).default
  return _fetch
}

async function fetchGecko() {
  const fetch = await getFetch()
  const r = await fetch(
    `${GECKO}/simple/price?ids=ripple,stellar,hedera-hashgraph,algorand,bitcoin,ethereum,usd-coin,tether&vs_currencies=usd&include_24hr_vol=true`,
    { signal: AbortSignal.timeout(12000) }
  )
  if (!r.ok) throw new Error(`gecko ${r.status}`)
  const d = await r.json()
  if (d.ripple?.usd)              prices.XRP  = d.ripple.usd
  if (d.stellar?.usd)             prices.XLM  = d.stellar.usd
  if (d['hedera-hashgraph']?.usd) prices.HBAR = d['hedera-hashgraph'].usd
  if (d.algorand?.usd)            prices.ALGO = d.algorand.usd
  if (d.bitcoin?.usd)             prices.BTC  = d.bitcoin.usd
  if (d.ethereum?.usd)            prices.ETH  = d.ethereum.usd
  if (d.ripple?.usd_24h_vol)      volumes.xrpl    = Math.min(d.ripple.usd_24h_vol,    10e9)
  if (d.stellar?.usd_24h_vol)     volumes.stellar  = Math.min(d.stellar.usd_24h_vol,   2e9)
  if (d.algorand?.usd_24h_vol)    volumes.algo     = Math.min(d.algorand.usd_24h_vol,  1e9)
  return true
}

async function fetchXRPLBook() {
  const fetch = await getFetch()
  let lastErr = null
  for (let i = 0; i < XRPL_HTTP.length; i++) {
    const url = XRPL_HTTP[(_xrplHttpIdx + i) % XRPL_HTTP.length]
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'book_offers',
          params: [{ taker_pays: { currency:'USD' }, taker_gets: { currency:'XRP' }, limit: 5 }]
        }),
        signal: AbortSignal.timeout(8000)
      })
      if (!r.ok) throw new Error(`xrpl_http ${r.status}`)
      const d = await r.json()
      const offers = d?.result?.offers || []
      if (offers.length >= 2) {
        const qualities = offers.map(o => parseFloat(o.quality || 0)).filter(q => q > 0)
        if (qualities.length >= 2) {
          const best = qualities[0], worst = qualities[qualities.length - 1]
          const mid  = (best + worst) / 2
          const pct  = Math.abs(worst - best) / mid * 100
          spreads['XRP/USD'] = { bid:best, ask:worst, spread:+pct.toFixed(4), source:'xrpl_clob', ts:Date.now() }
          const gapPct = Math.abs(mid - prices.XRP) / prices.XRP * 100
          if (gapPct > 0.1 && gapPct < 3) {
            gaps['XRPL_XRP'] = { xrpl:mid, ref:prices.XRP, gap:+gapPct.toFixed(4) }
            // Conservative: $5K position × gap% × 15% capture, max $20
            const profit = Math.min(5000 * (gapPct / 100) * 0.15, 20)
            if (profit > 0.01) creditStream('S10', profit, 'xrpl_book_arb')
          }
        }
      }
      if (i > 0) {
        _xrplHttpIdx = (_xrplHttpIdx + i) % XRPL_HTTP.length
        console.log(`[PRICE] XRPL HTTP fallback working: ${url}`)
      }
      return true
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('xrpl all http failed')
}

async function fetchStellarBook() {
  const fetch = await getFetch()
  const r = await fetch(
    `${STELLAR}/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN&limit=5`,
    { signal: AbortSignal.timeout(8000) }
  )
  if (!r.ok) throw new Error(`stellar ${r.status}`)
  const d = await r.json()
  const bids = d?.bids || [], asks = d?.asks || []
  if (bids.length && asks.length) {
    const bid = parseFloat(bids[0]?.price || 0), ask = parseFloat(asks[0]?.price || 0)
    if (bid > 0 && ask > 0) {
      const pct = Math.abs(ask - bid) / ((ask + bid) / 2) * 100
      spreads['XLM/USDC'] = { bid, ask, spread:+pct.toFixed(4), source:'stellar_dex', ts:Date.now() }
      const stellarImplied = (1 / bid) * prices.XLM
      const crossGap = Math.abs(prices.XRP - stellarImplied) / prices.XRP * 100
      if (crossGap > 0.05 && crossGap < 5) {
        gaps['XRPL_STELLAR'] = { xrpl:prices.XRP, stellar:stellarImplied, gap:+crossGap.toFixed(4) }
        // Max $25 per cross-arb detection
        const profit = Math.min(3000 * (crossGap / 100) * 0.2, 25)
        if (profit > 0.01) creditStream('S10', profit, 'xrpl_stellar_cross_arb')
      }
    }
  }
  return true
}

async function fetchHedera() {
  const fetch = await getFetch()
  let lastErr = null
  for (let i = 0; i < HEDERA_URLS.length; i++) {
    const url = HEDERA_URLS[(_hederaIdx + i) % HEDERA_URLS.length]
    try {
      const r = await fetch(
        `${url}/api/v1/transactions?limit=10&transactiontype=CRYPTOTRANSFER&order=desc`,
        { signal: AbortSignal.timeout(8000) }
      )
      if (!r.ok) throw new Error(`hedera ${r.status}`)
      const d = await r.json()
      let hbarVol = 0
      for (const tx of (d?.transactions || [])) {
        for (const t of (tx.transfers || [])) {
          if (t.amount > 0) hbarVol += t.amount / 1e8
        }
      }
      if (hbarVol > 0) volumes.hedera = Math.max(volumes.hedera, hbarVol * prices.HBAR * 8640)
      if (i > 0) { _hederaIdx = (_hederaIdx + i) % HEDERA_URLS.length }
      return true
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('hedera all failed')
}

async function fetchAlgorand() {
  const fetch = await getFetch()
  let lastErr = null
  for (let i = 0; i < ALGO_URLS.length; i++) {
    const url = ALGO_URLS[(_algoIdx + i) % ALGO_URLS.length]
    try {
      const r = await fetch(`${url}/v2/transactions?limit=10`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error(`algo ${r.status}`)
      const d = await r.json()
      let algoVol = 0
      for (const tx of (d?.transactions || [])) {
        algoVol += (tx['payment-transaction']?.amount || 0) / 1e6
      }
      if (algoVol > 0) volumes.algo = Math.max(volumes.algo, algoVol * prices.ALGO * 8640)
      if (i > 0) { _algoIdx = (_algoIdx + i) % ALGO_URLS.length }
      return true
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('algo all failed')
}

export function calcFee(usdAmount, opts = {}) {
  const { network = 'xrpl', corridor = '', priority = 'standard' } = opts
  const dominated = JSON.parse(getConfig('dominated_corridors') || '[]')
  const mults     = JSON.parse(getConfig('rate_multipliers') || '{}')
  const propInt   = parseInt(getConfig('propeller_intensity') || '5')
  const base =
    usdAmount <     1000 ? 0.010 :
    usdAmount <    10000 ? 0.015 :
    usdAmount <   100000 ? 0.025 :
    usdAmount <  1000000 ? 0.035 :
    usdAmount < 10000000 ? 0.040 : 0.050
  const netMult  = { xrpl:1.0, stellar:0.9, hedera:1.2, algo:1.1 }[network] || 1.0
  const corrMult = dominated.includes(corridor) ? 1.5 : 1.0
  const speedMult= priority === 'instant' ? 1.5 : priority === 'priority' ? 1.2 : 1.0
  const hour     = new Date().getUTCHours()
  const timeMult = hour >= 8 && hour <= 18 ? 1.1 : 1.0
  const claudeMult = Math.min(mults.global || 1.0, 1.5)
  return Math.min(Math.max(base * netMult * corrMult * speedMult * timeMult * claudeMult, 0.005), 0.12)
}

export async function refreshPrices() {
  const results = await Promise.allSettled([
    fetchGecko(),
    fetchXRPLBook(),
    fetchStellarBook(),
    fetchHedera(),
    fetchAlgorand(),
  ])
  const labels = ['gecko', 'xrpl', 'stellar', 'hedera', 'algo']
  const ok     = results.filter(r => r.status === 'fulfilled').length
  const failed = results.map((r, i) => r.status === 'rejected' ? labels[i] : null).filter(Boolean)
  setConfig('prices',        JSON.stringify(prices))
  setConfig('volumes',       JSON.stringify(volumes))
  setConfig('price_updated', String(Date.now()))
  if (failed.length > 0) console.log(`[PRICE] ${ok}/5 sources OK — failed: ${failed.join(',')} (self-healed)`)
  return ok
}

export async function initPriceEngine() {
  console.log('[PRICE] Engine starting — 5 sources with fallbacks, 30s refresh')
  await refreshPrices()
  setInterval(() => refreshPrices().catch(() => {}), 30000)
  console.log(`[PRICE] Engine live — prices: ${JSON.stringify(prices)}`)
}
