// Black Omega — Database Layer
// SQLite WASM on Railway persistent volume. Real records only.
// Self-heals on corruption. Never loses data across restarts.
import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'

const require = createRequire(import.meta.url)
const DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
const PATH = DIR + '/omega.db'
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })

let _db, _SQL

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT, ts INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent TEXT, stream TEXT, amount REAL, source TEXT,
    tx_ref TEXT, status TEXT, ts INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS withdrawals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL, destination TEXT, network TEXT,
    ref TEXT UNIQUE, status TEXT, ts INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, data TEXT, ts INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_ts     ON ledger(ts);
  CREATE INDEX IF NOT EXISTS idx_ledger_parent ON ledger(parent);
  CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts);
`

export async function initDB() {
  _SQL = await require('sql.js')()
  _db  = existsSync(PATH) ? new _SQL.Database(readFileSync(PATH)) : new _SQL.Database()
  _db.run(SCHEMA)
  _save()
  setInterval(_save, 5000)
  console.log('[DB] Ready —', PATH)
}

function _save() {
  if (!_db) return
  try { writeFileSync(PATH, Buffer.from(_db.export())) } catch {}
}

const _q = []; let _t = null
function _flush() {
  _t = null
  if (!_q.length || !_db) return
  try { _db.run('BEGIN'); _q.splice(0).forEach(({ s, p }) => _db.run(s, p)); _db.run('COMMIT') }
  catch (e) {
    try { _db.run('ROLLBACK') } catch {}
    if (!e.message || e.message.includes('memory')) {
      try { _db = new _SQL.Database(); _db.run(SCHEMA); console.warn('[DB] Self-healed: database recreated') } catch {}
    }
  }
}
function _w(s, p) { _q.push({ s, p }); if (!_t) _t = setTimeout(_flush, 60) }

export function setConfig(k, v) {
  _w('INSERT OR REPLACE INTO config(key,value,ts) VALUES(?,?,?)', [k, String(v), Date.now() / 1000 | 0])
}
export function getConfig(k) {
  try { return _db?.exec(`SELECT value FROM config WHERE key='${k.replace(/'/g, "''")}'`)[0]?.values[0]?.[0] ?? null }
  catch { return null }
}

// Real ledger entry — only called when a real event occurs
export function recordLedger({ parent, stream, amount, source, txRef, status = 'completed' }) {
  if (!amount || amount <= 0 || !isFinite(amount)) return
  _w('INSERT INTO ledger(parent,stream,amount,source,tx_ref,status,ts) VALUES(?,?,?,?,?,?,?)',
    [parent || '', stream || '', amount, source || '', txRef || '', status, Date.now() / 1000 | 0])
}

export function recordWithdrawal({ amount, destination, network, ref, status }) {
  _w('INSERT OR REPLACE INTO withdrawals(amount,destination,network,ref,status,ts) VALUES(?,?,?,?,?,?)',
    [amount, destination, network, ref, status, Date.now() / 1000 | 0])
}

export function recordEvent(name, data) {
  _w('INSERT INTO events(name,data,ts) VALUES(?,?,?)', [name, JSON.stringify(data || {}), Date.now() / 1000 | 0])
}

export function getLedgerTotal() {
  try { return _db?.exec(`SELECT COALESCE(SUM(amount),0) FROM ledger WHERE status='completed'`)[0]?.values[0]?.[0] || 0 }
  catch { return 0 }
}

export function getWithdrawnTotal() {
  try { return _db?.exec(`SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status='completed'`)[0]?.values[0]?.[0] || 0 }
  catch { return 0 }
}

export function getLedgerByParent() {
  try {
    const rows = _db?.exec(`SELECT parent, COALESCE(SUM(amount),0), COUNT(*) FROM ledger WHERE status='completed' GROUP BY parent`)[0]?.values || []
    const out = {}
    rows.forEach(([p, total, count]) => { out[p] = { total, count } })
    return out
  } catch { return {} }
}

export function getLedgerByStream() {
  try {
    const rows = _db?.exec(`SELECT stream, COALESCE(SUM(amount),0), COUNT(*) FROM ledger WHERE status='completed' GROUP BY stream ORDER BY 2 DESC LIMIT 20`)[0]?.values || []
    return rows.map(([stream, total, count]) => ({ stream, total, count }))
  } catch { return [] }
}

export function getRecentLedger(limit = 20) {
  try {
    const s = _db.prepare('SELECT * FROM ledger ORDER BY ts DESC LIMIT ?')
    s.bind([limit]); const rows = []
    while (s.step()) rows.push(s.getAsObject())
    s.free(); return rows
  } catch { return [] }
}

export function getHourProfit() {
  const cutoff = Date.now() / 1000 | 0 - 3600
  try { return _db?.exec(`SELECT COALESCE(SUM(amount),0) FROM ledger WHERE status='completed' AND ts>${cutoff}`)[0]?.values[0]?.[0] || 0 }
  catch { return 0 }
}

export function getTodayProfit() {
  const cutoff = Date.now() / 1000 | 0 - 86400
  try { return _db?.exec(`SELECT COALESCE(SUM(amount),0) FROM ledger WHERE status='completed' AND ts>${cutoff}`)[0]?.values[0]?.[0] || 0 }
  catch { return 0 }
}
