// Black Treasury — wraps db.js, handles yield tiers, withdrawals
// Revenue survives deployments because db.js persists to Railway volume
import {
  initDB as _initDB, setConfig, getConfig, recordCredit,
  recordWithdrawal, updateWithdrawalStatus, recordEvent,
  getRevenue, getStreamTotals, getRecentCredits, getTreasuryState as _getTreasuryState
} from './db.js'

// Re-export db functions directly so other modules can import from treasury
export { setConfig, getConfig, recordEvent, getRevenue, getRecentCredits }
export { getTreasuryState } from './db.js'

// Yield tier debounce — only update once per 60s
let _lastTierCheck = 0

export async function initDB() {
  const ok = await _initDB()
  if (ok) {
    // Restore yield tier from persisted total
    _checkYieldTier()
  }
  return ok
}

function _checkYieldTier() {
  const now = Date.now()
  if (now - _lastTierCheck < 60000) return
  _lastTierCheck = now
  const rev   = getRevenue()
  const total = rev.total
  const tier  =
    total >= 50_000_000 ? 'diversified'  :
    total >=  5_000_000 ? 'algo_gov'     :
    total >=    500_000 ? 'hedera_stake' :
    total >=     50_000 ? 'xrpl_amm'    :
    total >=      5_000 ? 'stellar_usdc' : 'liquid'
  const prev = getConfig('yield_tier')
  if (prev !== tier) {
    const apy = { liquid:0, stellar_usdc:3.5, xrpl_amm:10, hedera_stake:7, algo_gov:8.5, diversified:8 }[tier] || 0
    setConfig('yield_tier', tier)
    setConfig('yield_apy',  String(apy))
    console.log(`[TREASURY] Yield tier: ${tier} (${apy}% APY)`)
  }
}

// Core credit function — the ONLY way revenue enters the system
export function creditTreasury(amount, stream, source) {
  if (!amount || amount <= 0 || !isFinite(amount)) return
  recordCredit(stream, amount, source)
  _checkYieldTier()
}

// Withdrawal via ModemPay
export async function withdraw(amount, destination) {
  if (!amount || amount <= 0) throw new Error('Invalid amount')
  const rev = getRevenue()
  if (amount > rev.withdrawable) throw new Error(`$${rev.withdrawable.toFixed(2)} available, $${amount} requested`)
  const key = (process.env.MODEMPAY_SECRET_KEY || process.env.MODEMPAY_API_KEY || process.env.MODEMPAY_KEY || '').trim().replace(/[\r\n\t]/g,'')
  if (!key) throw new Error('ModemPay key not configured')
  const ref = 'BLK-' + Date.now() + '-' + Math.random().toString(36).slice(2,6).toUpperCase()
  console.log(`[TREASURY] Withdraw $${amount} → ${destination} ref:${ref}`)
  recordWithdrawal(amount, destination, ref, 'pending')
  const fetch = (await import('node-fetch')).default
  const r = await fetch('https://api.modempay.com/v1/transfers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
      'Idempotency-Key': ref
    },
    body: JSON.stringify({
      amount:           amount.toFixed(2),
      currency:         'GMD',
      network:          'wave',
      account_number:   destination,
      beneficiary_name: 'Black',
      narration:        'Black treasury withdrawal'
    }),
    signal: AbortSignal.timeout(20000)
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    updateWithdrawalStatus(ref, 'failed')
    throw new Error(data.message || data.error || `ModemPay ${r.status}`)
  }
  updateWithdrawalStatus(ref, 'completed')
  recordEvent('withdrawal', { amount, destination, ref, status: 'completed' })
  return { ok:true, ref, amount, destination, status:'completed' }
}
