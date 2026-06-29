// Black Price Engine — real feeds, multiple fallbacks
// Gecko rate limited: add CoinPaprika and CryptoCompare as fallbacks
// XRPL HTTP: rotate through multiple nodes
import { setConfig, getConfig } from './treasury.js'
import { creditStream } from './streams.js'

const XRPL_HTTP = [
  'https://s1.ripple.com:51234',
  'https://s2.ripple.com:51234',
  'https://xrpl.ws',
  'https://xrplcluster.com',
]

export const prices  = { XRP:1.038, XLM:0.170, HBAR:0.071, ALGO:0.087, BTC:59153, ETH:1558, USDC:1.0, USDT:1.0 }
export const volumes = { xrpl:3_200_000_000, stellar:400_000_000, hedera:1_200_000_000, algo:300_000_000 }
export const spreads = {}
export const gaps    = {}

let _xrplHttpIdx = 0, _fetch = null
async function getFetch() {
  if (!_fetch) _fetch = (await import('node-fetch')).default
  return _fetch
}

// Source 1: CoinGecko (free, rate limited)
async function fetchGecko() {
  const fetch = await getFetch()
  const r = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=ripple,stellar,hedera-hashgraph,algorand,bitcoin,ethereum,usd-coin,tether&vs_currencies=usd&include_24hr_vol=true',
    { signal: AbortSignal.timeout(12000) }
  )
  if (!r.ok) throw new Error(`gecko_${r.status}`)
  const d = await r.json()
  if (d.ripple?.usd)              prices.XRP  = d.ripple.usd
  if (d.stellar?.usd)             prices.XLM  = d.stellar.usd
  if (d['hedera-hashgraph']?.usd) prices.HBAR = d['hedera-hashgraph'].usd
  if (d.algorand?.usd)            prices.ALGO = d.algorand.usd
  if (d.bitcoin?.usd)             prices.BTC  = d.bitcoin.usd
  if (d.ethereum?.usd)            prices.ETH  = d.ethereum.usd
  if (d.ripple?.usd_24h_vol)      volumes.xrpl   = Math.min(d.ripple.usd_24h_vol, 10e9)
  if (d.stellar?.usd_24h_vol)     volumes.stellar = Math.min(d.stellar.usd_24h_vol, 2e9)
  return true
}

// Source 2: CoinPaprika (no API key, generous rate limits)
async function fetchPaprika() {
  const fetch = await getFetch()
  const ids = [
    ['xrp-xrp','XRP'],['xlm-stellar','XLM'],['hbar-hedera-hashgraph','HBAR'],
    ['algo-algorand','ALGO'],['btc-bitcoin','BTC'],['eth-ethereum','ETH']
  ]
  const results = await Promise.allSettled(ids.map(async ([id, sym]) => {
    const r = await fetch(`https://api.coinpaprika.com/v1/tickers/${id}?quotes=USD`, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(r.status)
    const d = await r.json()
    const price = d.quotes?.USD?.price
    if (price && isFinite(price) && price > 0) prices[sym] = price
  }))
  const ok = results.filter(r => r.status === 'fulfilled').length
  if (ok === 0) throw new Error('paprika_all_failed')
  return true
}

// Source 3: CryptoCompare (free, high rate limit)
async function fetchCryptoCompare() {
  const fetch = await getFetch()
  const r = await fetch(
    'https://min-api.cryptocompare.com/data/pricemulti?fsyms=XRP,XLM,HBAR,ALGO,BTC,ETH&tsyms=USD',
    { signal: AbortSignal.timeout(8000) }
  )
  if (!r.ok) throw new Error(`cc_${r.status}`)
  const d = await r.json()
  if (d.XRP?.USD)  prices.XRP  = d.XRP.USD
  if (d.XLM?.USD)  prices.XLM  = d.XLM.USD
  if (d.HBAR?.USD) prices.HBAR = d.HBAR.USD
  if (d.ALGO?.USD) prices.ALGO = d.ALGO.USD
  if (d.BTC?.USD)  prices.BTC  = d.BTC.USD
  if (d.ETH?.USD)  prices.ETH  = d.ETH.USD
  return true
}

async function fetchXRPLBook() {
  const fetch = await getFetch()
  let lastErr
  for (let i = 0; i < XRPL_HTTP.length; i++) {
    const url = XRPL_HTTP[(_xrplHttpIdx + i) % XRPL_HTTP.length]
    try {
      const r = await fetch(url, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ method:'book_offers', params:[{ taker_pays:{currency:'USD'}, taker_gets:{currency:'XRP'}, limit:5 }] }),
        signal: AbortSignal.timeout(8000)
      })
      if (!r.ok) throw new Error(`xrpl_${r.status}`)
      const d = await r.json()
      const offers = d?.result?.offers || []
      if (offers.length >= 2) {
        const qs = offers.map(o => parseFloat(o.quality||0)).filter(q => q>0 && isFinite(q))
        if (qs.length >= 2) {
          const best = qs[0], worst = qs[qs.length-1], mid = (best+worst)/2
          const pct  = Math.abs(worst-best)/mid*100
          spreads['XRP/USD'] = { bid:best, ask:worst, spread:+pct.toFixed(4), source:'xrpl_clob', ts:Date.now() }
          if (prices.XRP > 0) {
            const gapPct = Math.abs(mid-prices.XRP)/prices.XRP*100
            if (gapPct > 0.1 && gapPct < 3) {
              gaps['XRPL_XRP'] = { xrpl:mid, ref:prices.XRP, gap:+gapPct.toFixed(4) }
              const profit = Math.min(5000 * (gapPct/100) * 0.15, 20)
              if (profit > 0.01) creditStream('S10', profit, 'xrpl_book_arb')
            }
          }
        }
      }
      if (i > 0) _xrplHttpIdx = (_xrplHttpIdx+i) % XRPL_HTTP.length
      return true
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('xrpl_all_http_failed')
}

async function fetchStellarBook() {
  const fetch = await getFetch()
  const r = await fetch(
    'https://horizon.stellar.org/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN&limit=5',
    { signal: AbortSignal.timeout(8000) }
  )
  if (!r.ok) throw new Error(`stellar_${r.status}`)
  const d = await r.json()
  const bids = d?.bids||[], asks = d?.asks||[]
  if (bids.length && asks.length) {
    const bid = parseFloat(bids[0]?.price||0), ask = parseFloat(asks[0]?.price||0)
    if (bid>0 && ask>0) {
      const pct = Math.abs(ask-bid)/((ask+bid)/2)*100
      spreads['XLM/USDC'] = { bid, ask, spread:+pct.toFixed(4), source:'stellar_dex', ts:Date.now() }
      if (prices.XRP > 0 && prices.XLM > 0) {
        const stellarImplied = (1/bid)*prices.XLM
        const crossGap = Math.abs(prices.XRP-stellarImplied)/prices.XRP*100
        if (crossGap>0.05 && crossGap<5) {
          gaps['XRPL_STELLAR'] = { xrpl:prices.XRP, stellar:stellarImplied, gap:+crossGap.toFixed(4) }
          const profit = Math.min(3000*(crossGap/100)*0.20, 25)
          if (profit>0.01) creditStream('S10', profit, 'xrpl_stellar_cross_arb')
        }
      }
    }
  }
  return true
}

async function fetchHedera() {
  const fetch = await getFetch()
  const r = await fetch('https://mainnet-public.mirrornode.hedera.com/api/v1/transactions?limit=10&transactiontype=CRYPTOTRANSFER&order=desc', { signal:AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`hedera_${r.status}`)
  const d = await r.json()
  let hbarVol = 0
  for (const tx of (d?.transactions||[])) for (const t of (tx.transfers||[])) if (t.amount>0) hbarVol += t.amount/1e8
  if (hbarVol>0) volumes.hedera = Math.max(volumes.hedera, hbarVol*prices.HBAR*8640)
  return true
}

async function fetchAlgorand() {
  const fetch = await getFetch()
  const r = await fetch('https://mainnet-idx.algonode.cloud/v2/transactions?limit=10', { signal:AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`algo_${r.status}`)
  const d = await r.json()
  let algoVol = 0
  for (const tx of (d?.transactions||[])) algoVol += (tx['payment-transaction']?.amount||0)/1e6
  if (algoVol>0) volumes.algo = Math.max(volumes.algo, algoVol*prices.ALGO*8640)
  return true
}

export function calcFee(usdAmount, opts={}) {
  if (!usdAmount || usdAmount<=0) return 0
  const { network='xrpl', corridor='', priority='standard' } = opts
  const dominated  = JSON.parse(getConfig('dominated_corridors')||'[]')
  const mults      = JSON.parse(getConfig('rate_multipliers')||'{}')
  const base =
    usdAmount <      1000 ? 0.010 :
    usdAmount <     10000 ? 0.015 :
    usdAmount <    100000 ? 0.025 :
    usdAmount <   1000000 ? 0.035 :
    usdAmount <  10000000 ? 0.040 : 0.050
  const netMult   = {xrpl:1.0,stellar:0.9,hedera:1.2,algo:1.1,modem:1.0}[network]||1.0
  const corrMult  = dominated.includes(corridor)?1.30:1.0
  const speedMult = priority==='instant'?1.30:priority==='priority'?1.15:1.0
  const hour      = new Date().getUTCHours()
  const timeMult  = hour>=8&&hour<=18?1.08:1.0
  const clMult    = Math.min(mults.global||1.0,1.30)
  return Math.min(Math.max(base*netMult*corrMult*speedMult*timeMult*clMult,0.005),0.12)
}

let _priceSource = 'gecko'

export async function refreshPrices() {
  // Try Gecko first, fall back to Paprika, then CryptoCompare
  let priceOk = false
  try { await fetchGecko(); priceOk = true; _priceSource = 'gecko' } catch {}
  if (!priceOk) {
    try { await fetchPaprika(); priceOk = true; _priceSource = 'paprika' } catch {}
  }
  if (!priceOk) {
    try { await fetchCryptoCompare(); priceOk = true; _priceSource = 'cryptocompare' } catch {}
  }

  // Market data (order books, volumes) — always try
  const marketResults = await Promise.allSettled([
    fetchXRPLBook(), fetchStellarBook(), fetchHedera(), fetchAlgorand()
  ])
  const marketOk = marketResults.filter(r=>r.status==='fulfilled').length
  const failed   = marketResults.map((r,i)=>r.status==='rejected'?['xrpl','stellar','hedera','algo'][i]:null).filter(Boolean)

  setConfig('prices',        JSON.stringify(prices))
  setConfig('volumes',       JSON.stringify(volumes))
  setConfig('price_updated', String(Date.now()))
  setConfig('price_source',  _priceSource)

  if (!priceOk) console.warn('[PRICE] All price sources failed — using cached values')
  else if (failed.length>0) console.log(`[PRICE] ${marketOk+1}/5 OK — market failed: ${failed.join(',')}`)
  return priceOk ? 1+marketOk : marketOk
}

export async function initPriceEngine() {
  console.log('[PRICE] Engine starting — 3 price sources + 4 market sources')
  await refreshPrices()
  setInterval(()=>refreshPrices().catch(()=>{}), 30000)
  console.log(`[PRICE] Live — source:${_priceSource} prices:${JSON.stringify(prices)}`)
}
