// Black Treasury — real accounting only
// 100% of revenue goes here. 100% withdrawable. No allocations. No fake ticks.
import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'

const require = createRequire(import.meta.url)
const DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
const PATH = DIR + '/black.db'
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })

let _db, _SQL

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT, ts INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS credits(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT, amount REAL, source TEXT, ts INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS withdrawals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL, destination TEXT, ref TEXT, status TEXT, ts INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, data TEXT, ts INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_credits_ts ON credits(ts);
  CREATE INDEX IF NOT EXISTS idx_credits_stream ON credits(stream);
`

// In-memory totals — rebuilt from DB on boot
let _total = 0, _withdrawn = 0, _hourStart = Date.now(), _hourTotal = 0, _dayStart = Date.now(), _dayTotal = 0
// Yield tier debounce — max once per 60s
let _lastTierCheck = 0

export async function initDB() {
  _SQL = await require('sql.js')()
  _db  = existsSync(PATH)
    ? new _SQL.Database(readFileSync(PATH))
    : new _SQL.Database()
  _db.run(SCHEMA)
  _save()

  // Restore totals from DB
  try {
    const r = _db.exec('SELECT COALESCE(SUM(amount),0) FROM credits')[0]?.values[0]?.[0]
    _total = parseFloat(r) || 0
    const w = _db.exec('SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status="completed"')[0]?.values[0]?.[0]
    _withdrawn = parseFloat(w) || 0
    const h = _db.exec(`SELECT COALESCE(SUM(amount),0) FROM credits WHERE ts>${(Date.now()/1000|0)-3600}`)[0]?.values[0]?.[0]
    _hourTotal = parseFloat(h) || 0
    const d = _db.exec(`SELECT COALESCE(SUM(amount),0) FROM credits WHERE ts>${(Date.now()/1000|0)-86400}`)[0]?.values[0]?.[0]
    _dayTotal = parseFloat(d) || 0
    console.log(`[TREASURY] Restored — total: $${_total.toFixed(2)} withdrawn: $${_withdrawn.toFixed(2)}`)
  } catch (e) { console.warn('[TREASURY] Restore error:', e.message) }

  setInterval(_save, 5000)
}

function _save() {
  if (!_db) return
  try { writeFileSync(PATH, Buffer.from(_db.export())) } catch {}
}

const _q = []; let _t = null
function _flush() {
  _t = null; if (!_q.length || !_db) return
  try { _db.run('BEGIN'); _q.splice(0).forEach(({s,p}) => _db.run(s,p)); _db.run('COMMIT') }
  catch (e) {
    try { _db.run('ROLLBACK') } catch {}
    if (!e.message || e.message.includes('memory')) {
      try { _db = new _SQL.Database(); _db.run(SCHEMA) } catch {}
    }
  }
}
function _w(s, p) { _q.push({s,p}); if (!_t) _t = setTimeout(_flush, 80) }

export function setConfig(k, v) {
  _w('INSERT OR REPLACE INTO config(key,value,ts) VALUES(?,?,?)', [k, String(v), Date.now()/1000|0])
}
export function getConfig(k) {
  try { return _db?.exec(`SELECT value FROM config WHERE key='${k.replace(/'/g,"''")}'`)[0]?.values[0]?.[0] ?? null }
  catch { return null }
}

// Credit real revenue — called only from real external events
export function creditTreasury(amount, stream, source) {
  if (!amount || amount <= 0 || !isFinite(amount)) return
  const ts = Date.now() / 1000 | 0
  _total    += amount
  _hourTotal += amount
  _dayTotal  += amount
  // Reset hour/day windows
  if (Date.now() - _hourStart > 3600000) { _hourTotal = amount; _hourStart = Date.now() }
  if (Date.now() - _dayStart  > 86400000){ _dayTotal  = amount; _dayStart  = Date.now() }
  _w('INSERT INTO credits(stream,amount,source,ts) VALUES(?,?,?,?)', [stream||'', amount, source||'', ts])
  // Yield tier — max once per 60s to prevent log spam
  const now = Date.now()
  if (now - _lastTierCheck > 60000) {
    _lastTierCheck = now
    _updateYieldTier()
  }
}

function _updateYieldTier() {
  const tier =
    _total >= 50000000  ? 'diversified'   :
    _total >= 5000000   ? 'algo_gov'      :
    _total >= 500000    ? 'hedera_stake'  :
    _total >= 50000     ? 'xrpl_amm'      :
    _total >= 5000      ? 'stellar_usdc'  : 'liquid'
  const prev = getConfig('yield_tier')
  if (prev !== tier) {
    setConfig('yield_tier', tier)
    const apy = {liquid:0,stellar_usdc:3.5,xrpl_amm:10,hedera_stake:7,algo_gov:8.5,diversified:8}[tier]||0
    setConfig('yield_apy', String(apy))
    console.log(`[TREASURY] Yield tier: ${tier} (${apy}% APY)`)
  }
}

export function recordEvent(name, data) {
  _w('INSERT INTO events(name,data,ts) VALUES(?,?,?)', [name, JSON.stringify(data||{}), Date.now()/1000|0])
}

export function getRevenue() {
  try {
    const now = Date.now()/1000|0
    const row = _db?.exec(`
      SELECT
        COALESCE(SUM(amount),0),
        COUNT(*),
        COALESCE(SUM(CASE WHEN ts>${now-3600}  THEN amount ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN ts>${now-86400} THEN amount ELSE 0 END),0)
      FROM credits
    `)[0]?.values[0] || [0,0,0,0]
    return {
      total:     parseFloat(row[0])||0,
      txs:       parseInt(row[1])||0,
      hour:      parseFloat(row[2])||0,
      today:     parseFloat(row[3])||0,
      withdrawn: _withdrawn,
      net:       (parseFloat(row[0])||0) - _withdrawn
    }
  } catch {
    return { total:_total, txs:0, hour:_hourTotal, today:_dayTotal, withdrawn:_withdrawn, net:_total-_withdrawn }
  }
}

export function getTreasuryState() {
  return {
    total:       _total,
    withdrawable: Math.max(0, _total - _withdrawn),
    withdrawn:   _withdrawn,
    net:         _total - _withdrawn,
    hour:        _hourTotal,
    today:       _dayTotal,
    yield_tier:  getConfig('yield_tier') || 'liquid',
    apy:         parseFloat(getConfig('yield_apy')||'0'),
    xrpl_amm:    parseFloat(getConfig('xrpl_amm_position')||'0'),
    stellar_amm: parseFloat(getConfig('stellar_amm_position')||'0'),
    capture_rate:parseFloat(getConfig('capture_rate')||'0'),
    fortress_phase: parseInt(getConfig('fortress_phase')||'0'),
  }
}

export function getRecentCredits(limit=20) {
  try {
    const s = _db.prepare('SELECT * FROM credits ORDER BY ts DESC LIMIT ?')
    s.bind([limit]); const rows=[]
    while(s.step()) rows.push(s.getAsObject())
    s.free(); return rows
  } catch { return [] }
}

export async function withdraw(amount, destination) {
  if (!amount || amount <= 0) throw new Error('Invalid amount')
  const withdrawable = Math.max(0, _total - _withdrawn)
  if (amount > withdrawable) throw new Error(`Only $${withdrawable.toFixed(2)} withdrawable`)
  if (!process.env.MODEMPAY_SECRET_KEY) throw new Error('MODEMPAY_SECRET_KEY not set')
  const ref = 'BLK-' + Date.now() + '-' + Math.random().toString(36).slice(2,6).toUpperCase()
  console.log(`[TREASURY] Withdraw $${amount} → ${destination} ref:${ref}`)
  const fetch = (await import('node-fetch')).default
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
      beneficiary_name: 'Black',
      narration:        'Black treasury withdrawal'
    }),
    signal: AbortSignal.timeout(20000)
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.message || data.error || `ModemPay HTTP ${r.status}`)
  _withdrawn += amount
  _w('INSERT INTO withdrawals(amount,destination,ref,status,ts) VALUES(?,?,?,?,?)',
    [amount, destination, ref, data.status||'completed', Date.now()/1000|0])
  recordEvent('withdrawal', { amount, destination, ref, status: data.status })
  return { ok:true, ref, amount, destination, status: data.status||'completed' }
}
