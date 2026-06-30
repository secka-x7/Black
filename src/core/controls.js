// Black Omega — Dashboard Controls
// Persists every dashboard slider/toggle. Read by propeller, fee, and network layers.
import { setConfig, getConfig } from '../db.js'

const DEFAULTS = {
  global_fee: 0.05,
  fee_xrpl: 0.05, fee_stellar: 0.04, fee_ethereum: 0.06, fee_solana: 0.03,
  fee_bnb: 0.04, fee_cosmos: 0.05, fee_polkadot: 0.05, fee_avalanche: 0.05,
  fee_cbdc: 0.08, fee_swift: 0.07,
  gp1: 10, gp2: 10, gp3: 10, gp4: 10, gp5: 10, gp6: 10, gp7: 10, gp8: 10, gp9: 10, gp10: 10,
  dominion_sensitivity: 'high',
  min_tx_size: 0,
  fortress_mode: 'auto',
  auto_withdraw_threshold: 0,
}

export function initControls() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (getConfig('ctl_' + k) === null) setConfig('ctl_' + k, String(v))
  }
}

export function getControls() {
  const out = {}
  for (const k of Object.keys(DEFAULTS)) {
    const raw = getConfig('ctl_' + k)
    out[k] = raw !== null ? (isNaN(raw) ? raw : parseFloat(raw)) : DEFAULTS[k]
  }
  return out
}

export function setControl(key, value) {
  if (!(key in DEFAULTS)) throw new Error('Unknown control: ' + key)
  setConfig('ctl_' + key, String(value))
  // Sync propeller intensity object for propeller.js consumption
  if (key.startsWith('gp')) {
    const intensity = JSON.parse(getConfig('propeller_intensity') || '{}')
    intensity[key] = value
    setConfig('propeller_intensity', JSON.stringify(intensity))
  }
  return getControls()
}
