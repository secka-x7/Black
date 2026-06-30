// Black Omega — Treasury
// 100% real. 100% withdrawable. No allocations, no locks.
// Treasury = sum of real ledger credits across all 10 parents + ModemPay balance.
import { getLedgerTotal, getWithdrawnTotal, getLedgerByParent, getHourProfit, getTodayProfit, recordWithdrawal, setConfig, getConfig } from '../db.js'
import { getBalances, transfer, isConfigured } from '../modempay.js'
import { broadcast } from '../index.js'

export function getTreasuryTotal() {
  // Real ledger total — every credit here came from a confirmed real event
  return getLedgerTotal()
}

export async function getTreasuryState() {
  const ledgerTotal  = getLedgerTotal()
  const withdrawn    = getWithdrawnTotal()
  const byParent      = getLedgerByParent()
  const hour          = getHourProfit()
  const today          = getTodayProfit()
  const modem          = await getBalances()

  // Total = real ledger (all parent earnings) + whatever sits in ModemPay payout_balance
  const total        = ledgerTotal + (modem.payout_balance || 0)
  const withdrawable = Math.max(0, total - withdrawn)

  return {
    total,
    withdrawable,
    withdrawn,
    byParent,
    hour,
    today,
    modempay: { payoutBalance: modem.payout_balance || 0, configured: modem.configured },
  }
}

export async function withdraw(amount, destination, network = 'wave') {
  if (!isConfigured()) throw new Error('ModemPay not configured — set MODEMPAY_SECRET_KEY')
  const state = await getTreasuryState()
  if (amount > state.withdrawable) throw new Error(`Insufficient funds: $${state.withdrawable.toFixed(2)} withdrawable, $${amount} requested`)

  const result = await transfer({
    amount, currency: 'GMD', network,
    accountNumber: destination,
    beneficiaryName: 'Black Omega Treasury',
    narration: 'Treasury withdrawal'
  })

  recordWithdrawal({ amount, destination, network, ref: result.ref, status: result.status })
  broadcast('withdrawal', { amount, destination, network, ref: result.ref, status: result.status })
  return result
}
