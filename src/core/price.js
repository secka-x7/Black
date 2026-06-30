// Black Omega — Live Price + Order Book Engine
// Real data from public, keyless endpoints across all 10 parents.
import fetch from 'node-fetch'
import { setConfig, getConfig } from '../db.js'
import { broadcast } from '../index.js'
import { detectSpread, trackCorridor, recordHealth } from './intelligence.js'
import { creditStream } from './streams.js'

const _prices = { XRP: 2.5, XLM: 0.12, ETH: 3200, BNB: 600, SOL: 180, ATOM: 8, DOT: 6, AVAX: 35, USDC: 1, USDT: 1 }
const _books  = {}
const _gaps   = []

export const getPrices = () => ({ ..._prices })
export const getAllOrderBooks = async () => ({ ..._books })
export const getRecentGaps = () => [..._gaps]

async function fetchCoinGecko() {
  const start = Date.now()
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ripple,stellar,ethereum,binancecoin,solana,cosmos,polkadot,avalanche-2,usd-coin,tether&vs_currencies=usd',
      { signal: AbortSignal.timeout(10000) }
    )
    const d = await r.json()
    if (d.ripple?.usd)        _prices.XRP  = d.ripple.usd
    if (d.stellar?.usd)       _prices.XLM  = d.stellar.usd
    if (d.ethereum?.usd)      _prices.ETH  = d.ethereum.usd
    if (d.binancecoin?.usd)   _prices.BNB  = d.binancecoin.usd
    if (d.solana?.usd)        _prices.SOL  = d.solana.usd
    if (d.cosmos?.usd)        _prices.ATOM = d.cosmos.usd
    if (d.polkadot?.usd)      _prices.DOT  = d.polkadot.usd
    if (d['avalanche-2']?.usd)_prices.AVAX = d['avalanche-2'].usd
    recordHealth('coingecko', Date.now() - start, false)
  } catch (e) { recordHealth('coingecko', Date.now() - start, true) }
}

async function fetchXRPLBook() {
  const start = Date.now()
  try {
    const r = await fetch('https://xrplcluster.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'book_offers', params: [{ taker_pays: { currency: 'USD' }, taker_gets: { currency: 'XRP' }, limit: 10 }] }),
      signal: AbortSignal.timeout(8000)
    })
    const d = await r.json()
    const offers = d?.result?.offers || []
    if (offers.length >= 2) {
      const best  = parseFloat(offers[0]?.quality || 0)
      const worst = parseFloat(offers[offers.length - 1]?.quality || 0)
      _books['xrpl_XRP_USD'] = { bid: best, ask: worst, depth: offers.length }
      const { actionable, spread } = detectSpread(best, worst)
      if (actionable) {
        _gaps.unshift({ parent: 'xrpl', pair: 'XRP/USD', spread, ts: Date.now() })
        if (_gaps.length > 50) _gaps.pop()
      }
      trackCorridor('xrpl_XRP_USD', offers.length * 1000)
    }
    recordHealth('xrpl', Date.now() - start, false)
  } catch { recordHealth('xrpl', Date.now() - start, true) }
}

async function fetchStellarBook() {
  const start = Date.now()
  try {
    const r = await fetch(
      'https://horizon.stellar.org/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN&limit=10',
      { signal: AbortSignal.timeout(8000) }
    )
    const d = await r.json()
    const bids = d?.bids || [], asks = d?.asks || []
    if (bids.length && asks.length) {
      const bid = parseFloat(bids[0]?.price || 0), ask = parseFloat(asks[0]?.price || 0)
      _books['stellar_XLM_USDC'] = { bid, ask, depth: bids.length + asks.length }
      const { actionable, spread } = detectSpread(bid, ask)
      if (actionable) {
        _gaps.unshift({ parent: 'stellar', pair: 'XLM/USDC', spread, ts: Date.now() })
        if (_gaps.length > 50) _gaps.pop()
      }
      trackCorridor('stellar_XLM_USDC', (bids.length + asks.length) * 500)
    }
    recordHealth('stellar', Date.now() - start, false)
  } catch { recordHealth('stellar', Date.now() - start, true) }
}

export async function startArbEngine() {
  setInterval(async () => {
    const gaps = getRecentGaps().filter(g => Date.now() - g.ts < 60000)
    setConfig('gaps_per_min', String(gaps.length))
  }, 15000)
  return { started: true }
}

export async function refreshAll() {
  await Promise.allSettled([fetchCoinGecko(), fetchXRPLBook(), fetchStellarBook()])
  setConfig('prices', JSON.stringify(_prices))
  broadcast('prices', { prices: _prices, books: _books, gaps: _gaps.slice(0, 10) })
}

export function initPriceEngine() {
  console.log('[PRICE] Engine starting — real public endpoints, 20s refresh')
  refreshAll().catch(() => {})
  setInterval(() => refreshAll().catch(() => {}), 20000)
}
