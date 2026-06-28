// Black Treasury — 6 dimensions, self-custodied, no ceiling, autonomous
import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import fetch from 'node-fetch'

const require = createRequire(import.meta.url)
const DIR     = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
const PATH    = DIR + '/black.db'
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })

let _db, _SQL

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT, ts INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS txs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT, amount REAL, source TEXT, stream TEXT, status TEXT, ts INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, data TEXT, ts INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_txs_ts  ON txs(ts);
  CREATE INDEX IF NOT EXISTS idx_evts_ts ON events(ts);
`

// Dimension 1 — Accumulation counters
const _acc = { total: 0, available: 0, reserve: 0, yield_pool: 0, hour: 0, today: 0, withdrawn: 0 }
let   _lastHour = Date.now(), _lastDay = Date.now()

export async function initDB() {
  _SQL = await require('sql.js')()
  _db  = existsSync(PATH)
    ? new _SQL.Database(readFileSync(PATH))
    : new _SQL.Database()
  _db.run(SCHEMA)
  _save()
  // Restore accumulated totals from DB
  const saved = getConfig('treasury_snapshot')
  if (saved) { try { Object.assign(_acc, JSON.parse(saved)) } catch {} }
  setInterval(_save, 5000)
  setInterval(_snapshot, 30000)
  console.log('[TREASURY] Ready — total:', _acc.total.toFixed(2))
}

function _save() {
  if (!_db) return
  try { writeFileSync(PATH, Buffer.from(_db.export())) } catch {}
}

function _snapshot() {
  setConfig('treasury_snapshot', JSON.stringify(_acc))
  setConfig('treasury_total', _acc.total.toFixed(2))
}

const _q = []; let _t = null
function _flush() {
  _t = null; if (!_q.length || !_db) return
  try { _db.run('BEGIN'); _q.splice(0).forEach(({s,p}) => _db.run(s,p)); _db.run('COMMIT') }
  catch(e) { try { _db.run('ROLLBACK') } catch {} }
}
function _w(s, p) { _q.push({s,p}); if (!_t) _t = setTimeout(_flush, 80) }

export function setConfig(k, v) {
  const ts = Date.now() / 1000 | 0
  _w('INSERT OR REPLACE INTO config(key,value,ts) VALUES(?,?,?)', [k, String(v), ts])
}

export function getConfig(k) {
  try { return _db?.exec(`SELECT value FROM config WHERE key='${k.replace(/'/g,"''")}'`)[0]?.values[0]?.[0] ?? null }
  catch { return null }
}

// Dimension 1 — Credit revenue into treasury
export function creditTreasury(amount, stream, source) {
  if (!amount || amount <= 0) return
  _acc.total     += amount
  _acc.hour      += amount
  _acc.today     += amount
  // Dimension 2 — Allocation (70/20/10)
  _acc.available  = _acc.total * 0.70
  _acc.reserve    = _acc.total * 0.20
  _acc.yield_pool = _acc.total * 0.10
  // Dimension 3 — Yield tier advancement
  advanceYieldTier()
  const ts = Date.now() / 1000 | 0
  _w('INSERT INTO txs(type,amount,source,stream,status,ts) VALUES(?,?,?,?,?,?)',
    ['credit', amount, source || '', stream || '', 'completed', ts])
  // Reset hour/day counters
  if (Date.now() - _lastHour > 3600000) { _acc.hour = 0; _lastHour = Date.now() }
  if (Date.now() - _lastDay  > 86400000){ _acc.today= 0; _lastDay  = Date.now() }
}

// Dimension 3 — Yield tier stack
function advanceYieldTier() {
  const t = _acc.total
  let tier = 'liquid'
  if (t >= 50000000)  tier = 'diversified'
  else if (t >= 5000000)  tier = 'algo_gov'
  else if (t >= 500000)   tier = 'hedera_stake'
  else if (t >= 50000)    tier = 'xrpl_amm'
  else if (t >= 5000)     tier = 'stellar_usdc'
  if (getConfig('yield_tier') !== tier) {
    setConfig('yield_tier', tier)
    console.log('[TREASURY] Yield tier advanced:', tier)
  }
}

// Dimension 6 — Withdrawal (ModemPay → Wave)
export async function withdraw(amount, destination) {
  const available = _acc.available
  if (amount > available) throw new Error(`Insufficient available balance: $${available.toFixed(2)} available, $${amount} requested`)
  if (!process.env.MODEMPAY_SECRET_KEY) throw new Error('ModemPay not configured')
  const ref = 'BF-' + Date.now() + '-' + Math.random().toString(36).slice(2,8).toUpperCase()
  console.log(`[TREASURY] Withdrawing $${amount} to ${destination} ref:${ref}`)
  const r = await fetch('https://api.modempay.com/v1/transfers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MODEMPAY_SECRET_KEY}`,
      'Content-Type':  'application/json',
      'Idempotency-Key': ref
    },
    body: JSON.stringify({
      amount:           amount.toFixed(2),
      currency:         'GMD',
      network:          'wave',
      account_number:   destination,
      beneficiary_name: 'Black Treasury',
      narration:        'Black treasury withdrawal'
    }),
    signal: AbortSignal.timeout(15000)
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data.message || data.error || `ModemPay error ${r.status}`)
  _acc.total     -= amount
  _acc.available  = _acc.total * 0.70
  _acc.withdrawn += amount
  _w('INSERT INTO txs(type,amount,source,stream,status,ts) VALUES(?,?,?,?,?,?)',
    ['withdrawal', amount, destination, 'withdrawal', data.status || 'completed', Date.now() / 1000 | 0])
  setConfig('total_withdrawn', _acc.withdrawn.toFixed(2))
  return { ok: true, ref, amount, destination, status: data.status || 'completed' }
}

export function recordEvent(name, data) {
  _w('INSERT INTO events(name,data,ts) VALUES(?,?,?)', [name, JSON.stringify(data), Date.now() / 1000 | 0])
}

export function getRevenue() {
  const now = Date.now() / 1000 | 0
  try {
    const r = _db?.exec(`SELECT COALESCE(SUM(amount),0),COUNT(*),COALESCE(SUM(CASE WHEN ts>${now-3600} THEN amount ELSE 0 END),0),COALESCE(SUM(CASE WHEN ts>${now-86400} THEN amount ELSE 0 END),0) FROM txs WHERE type='credit'`)[0]?.values[0]||[0,0,0,0]
    return { total: r[0]||0, txs: r[1]||0, hour: r[2]||0, today: r[3]||0 }
  } catch { return { total: _acc.total, txs: 0, hour: _acc.hour, today: _acc.today } }
}

export function getRecentTxs(limit = 15) {
  try {
    const s = _db.prepare('SELECT * FROM txs ORDER BY ts DESC LIMIT ?')
    s.bind([limit]); const rows = []
    while (s.step()) rows.push(s.getAsObject())
    s.free(); return rows
  } catch { return [] }
}

// Dimension 4+5 — Full treasury state
export function getTreasuryState() {
  const tier = getConfig('yield_tier') || 'liquid'
  const apy  = { liquid:0, stellar_usdc:3.5, xrpl_amm:10, hedera_stake:7, algo_gov:8.5, diversified:8 }[tier] || 0
  return {
    total:      _acc.total,
    available:  _acc.available,
    reserve:    _acc.reserve,
    yield_pool: _acc.yield_pool,
    withdrawn:  _acc.withdrawn,
    hour:       _acc.hour,
    today:      _acc.today,
    yield_tier: tier,
    apy,
    xrpl_amm:   parseFloat(getConfig('xrpl_amm_position')    || '0'),
    stellar_amm: parseFloat(getConfig('stellar_amm_position') || '0'),
    capture_rate: parseFloat(getConfig('capture_rate')        || '0'),
  }
}

// streams.js calls this to register revenue
export { creditTreasury as creditStream_internal }
