// Black Omega — ModemPay Integration
// All endpoints confirmed from official documentation.
// Role: fiat withdrawal gateway + West Africa fiat on-ramp.
import fetch from 'node-fetch'

const BASE   = 'https://api.modempay.com/v1'
const SECRET = process.env.MODEMPAY_SECRET_KEY

function headers(idempotencyKey) {
  const h = { 'Authorization': `Bearer ${SECRET}`, 'Content-Type': 'application/json' }
  if (idempotencyKey) h['Idempotency-Key'] = idempotencyKey
  return h
}

export const isConfigured = () => !!SECRET

// Confirmed endpoint: GET /v1/balances → { payout_balance, available_balance }
export async function getBalances() {
  if (!SECRET) return { payout_balance: 0, available_balance: 0, configured: false }
  try {
    const r = await fetch(`${BASE}/balances`, { headers: headers(), signal: AbortSignal.timeout(10000) })
    if (!r.ok) {
      console.warn('[MODEMPAY] Balance check failed:', r.status)
      return { payout_balance: 0, available_balance: 0, configured: true, error: `HTTP ${r.status}` }
    }
    const d = await r.json()
    return { payout_balance: d.payout_balance || 0, available_balance: d.available_balance || 0, configured: true }
  } catch (e) {
    console.warn('[MODEMPAY] Balance error:', e.message?.slice(0, 80))
    return { payout_balance: 0, available_balance: 0, configured: true, error: e.message }
  }
}

// Confirmed endpoint: POST /v1/transfers — withdrawal to Wave/Afrimoney
export async function transfer({ amount, currency = 'GMD', network, accountNumber, beneficiaryName, narration }) {
  if (!SECRET) throw new Error('ModemPay not configured')
  const ref = 'OMEGA-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase()
  const r = await fetch(`${BASE}/transfers`, {
    method: 'POST',
    headers: headers(ref),
    body: JSON.stringify({
      amount: Number(amount).toFixed(2),
      currency, network,
      account_number: accountNumber,
      beneficiary_name: beneficiaryName || 'Black Omega Treasury',
      narration: narration || 'Black Omega withdrawal'
    }),
    signal: AbortSignal.timeout(15000)
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data.message || data.error || `ModemPay error ${r.status}`)
  return { ok: true, ref, status: data.status || 'pending', raw: data }
}

// Confirmed webhook event name: charge.succeeded, field: payload
export function parseWebhook(body) {
  const event   = body?.event
  const payload = body?.payload
  if (event === 'charge.succeeded' && payload?.amount) {
    return { type: 'charge', amount: parseFloat(payload.amount), currency: payload.currency || 'GMD', reference: payload.reference || payload.id || '' }
  }
  if (event === 'transfer.succeeded' && payload?.amount) {
    return { type: 'transfer', amount: parseFloat(payload.amount), currency: payload.currency || 'GMD', reference: payload.reference || payload.id || '' }
  }
  return null
}
