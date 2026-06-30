// Operation Singularity — 45 seconds
// Connects all 10 parent networks in parallel. Establishes routing depth.
import { setConfig, recordEvent } from '../db.js'
import { broadcast } from '../index.js'
import { connectXRPL }     from '../parents/xrpl.js'
import { connectStellar }  from '../parents/stellar.js'
import { connectEthereum } from '../parents/ethereum.js'
import { connectSolana }   from '../parents/solana.js'
import { connectBNB }      from '../parents/bnb.js'
import { connectCosmos }   from '../parents/cosmos.js'
import { connectPolkadot } from '../parents/polkadot.js'
import { connectAvalanche} from '../parents/avalanche.js'
import { connectCBDC }     from '../parents/cbdc.js'
import { connectSWIFT }    from '../parents/swift.js'

let _done = false
export const isSingularityDone = () => _done

export async function runSingularity() {
  const start = Date.now()
  broadcast('operation', { name: 'SINGULARITY', phase: 'start', message: 'Connecting 10 parent networks' })
  console.log('[SINGULARITY] Initiating — connecting 10 parents in parallel')

  const connectors = [
    ['xrpl', connectXRPL], ['stellar', connectStellar], ['ethereum', connectEthereum],
    ['solana', connectSolana], ['bnb', connectBNB], ['cosmos', connectCosmos],
    ['polkadot', connectPolkadot], ['avalanche', connectAvalanche],
    ['cbdc', connectCBDC], ['swift', connectSWIFT],
  ]

  const results = await Promise.allSettled(
    connectors.map(([name, fn]) => fn().then(r => ({ name, ok: true, ...r })).catch(e => ({ name, ok: false, error: e.message })))
  )

  const summary = results.map(r => r.value || { ok: false })
  const connected = summary.filter(s => s.ok).length

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`[SINGULARITY] Complete — ${connected}/10 parents connected in ${elapsed}s`)
  broadcast('operation', { name: 'SINGULARITY', phase: 'complete', connected, total: 10, elapsed })

  setConfig('singularity_done', '1')
  setConfig('singularity_elapsed', elapsed)
  setConfig('singularity_connected', String(connected))
  recordEvent('singularity_complete', { connected, elapsed, summary })
  _done = true
  return { connected, elapsed }
}
