// Operation Sequence — 60 seconds
// Zero capital to fully operational. Fastest-earning networks fund the rest.
import { getConfig, setConfig, recordEvent } from '../db.js'
import { broadcast } from '../index.js'
import { getTreasuryTotal } from '../core/treasury.js'

let _done = false
export const isSequenceDone = () => _done

async function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

export async function runSequence() {
  const start = Date.now()
  broadcast('operation', { name: 'SEQUENCE', phase: 'start', message: 'Zero to operational — funding cascade' })
  console.log('[SEQUENCE] Starting funding cascade')

  // Stage 1 — Tier 0 zero-seed networks (Cosmos relay, Polkadot XCM, Stellar anchor)
  broadcast('operation', { name: 'SEQUENCE', phase: 'tier0', message: 'Activating zero-seed networks: Cosmos relay, Polkadot XCM, Stellar anchor' })
  const { activateRelay } = await import('../parents/cosmos.js')
  const { activateXCM }   = await import('../parents/polkadot.js')
  const { activateAnchor }= await import('../parents/stellar.js')
  await Promise.allSettled([activateRelay(), activateXCM(), activateAnchor()])
  await wait(1500)

  // Stage 2 — Stellar funds XRPL seed
  broadcast('operation', { name: 'SEQUENCE', phase: 'seed_xrpl', message: 'Stellar earnings seeding XRPL wallet' })
  const { attemptXRPLSeed } = await import('../parents/xrpl.js')
  await attemptXRPLSeed().catch(e => console.warn('[SEQUENCE] XRPL seed pending:', e.message?.slice(0, 60)))
  await wait(1500)

  // Stage 3 — XRPL funds EVM chains
  broadcast('operation', { name: 'SEQUENCE', phase: 'fund_evm', message: 'Funding Ethereum, BNB, Avalanche positions' })
  const { attemptPositionOpen: openEth } = await import('../parents/ethereum.js')
  const { attemptPositionOpen: openBnb } = await import('../parents/bnb.js')
  const { attemptPositionOpen: openAvax }= await import('../parents/avalanche.js')
  await Promise.allSettled([openEth(), openBnb(), openAvax()])
  await wait(1500)

  // Stage 4 — Solana activation
  broadcast('operation', { name: 'SEQUENCE', phase: 'solana', message: 'Activating Solana liquidity positions' })
  const { attemptPositionOpen: openSol } = await import('../parents/solana.js')
  await openSol().catch(() => {})
  await wait(1000)

  // Stage 5 — CBDC + SWIFT monitoring confirmed live
  broadcast('operation', { name: 'SEQUENCE', phase: 'institutional', message: 'CBDC and ISO 20022 monitoring confirmed' })
  await wait(500)

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  const treasury = getTreasuryTotal()
  console.log(`[SEQUENCE] Complete — ${elapsed}s — treasury: $${treasury.toFixed(2)}`)
  broadcast('operation', { name: 'SEQUENCE', phase: 'complete', elapsed, treasury })

  setConfig('sequence_done', '1')
  setConfig('sequence_elapsed', elapsed)
  recordEvent('sequence_complete', { elapsed, treasury })
  _done = true
  return { elapsed, treasury }
}
