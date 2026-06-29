// Black — Persistent Database
// Survives Railway deployments via volume mount at /data
// All revenue, withdrawals, stream totals, config persisted here
// SQLite WASM — no native bindings, works on any Node.js 20+
import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

const require = createRequire(import.meta.url)

// Railway persistent volume — survives deployments
// If not on Railway, falls back to /data which you can mount locally
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
const DB_PATH = join(VOLUME, 'black_omega.db')

// Ensure directory exists
if (!existsSync(VOLUME)) {
  try { mkdirSync(VOLUME, { recursive: true }) }
  catch (e) { console.warn('[DB] Could not create data dir:', e.message) }
}

let _db = null, _SQL = null
const _queue = []
let _flushTimer = null
let _saveTimer  = null

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config(
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    ts    INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS credits(
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT    NOT NULL,
    amount REAL    NOT NULL,
    source TEXT    DEFAULT '',
    ts     INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS withdrawals(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    amount      REAL    NOT NULL,
    destination TEXT    NOT NULL,
    ref         TEXT    UNIQUE,
    status      TEXT    DEFAULT 'pending',
    ts          INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events(
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT DEFAULT '',
    data TEXT DEFAULT '{}',
    ts   INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_credits_ts     ON credits(ts);
  CREATE INDEX IF NOT EXISTS idx_credits_stream ON credits(stream);
  CREATE INDEX IF NOT EXISTS idx_credits_day    ON credits(ts, stream);
`

export async function initDB() {
  try {
    _SQL = await require('sql.js')()

    if (existsSync(DB_PATH)) {
      // Load existing database — revenue survives redeployment
      const buf = readFileSync(DB_PATH)
      _db = new _SQL.Database(buf)
      console.log(`[DB] Loaded existing database from ${DB_PATH}`)
    } else {
      _db = new _SQL.Database()
      console.log(`[DB] Created new database at ${DB_PATH}`)
    }

    _db.run(SCHEMA)
    _flush() // write schema immediately
    _scheduleSave()

    // Verify data survived
    const count = _db.exec('SELECT COUNT(*) FROM credits')[0]?.values[0]?.[0] || 0
    const total = _db.exec('SELECT COALESCE(SUM(amount),0) FROM credits')[0]?.values[0]?.[0] || 0
    console.log(`[DB] Ready — ${count} credits, $${parseFloat(total).toFixed(2)} total revenue persisted`)

    return true
  } catch (e) {
    console.error('[DB] Init failed:', e.message)
    // Create in-memory fallback so system still runs
    if (_SQL) _db = new _SQL.Database()
    return false
  }
}

// Scheduled disk save — every 10 seconds
function _scheduleSave() {
  if (_saveTimer) clearInterval(_saveTimer)
  _saveTimer = setInterval(_saveToDisk, 10000)
}

function _saveToDisk() {
  if (!_db) return
  try {
    const buf = Buffer.from(_db.export())
    writeFileSync(DB_PATH, buf)
  } catch (e) {
    // Don't spam logs — write failures are recoverable on next save
  }
}

// Batched write queue — prevents DB lock contention
function _flush() {
  _flushTimer = null
  if (!_queue.length || !_db) return
  const ops = _queue.splice(0)
  try {
    _db.run('BEGIN')
    for (const { sql, params } of ops) _db.run(sql, params)
    _db.run('COMMIT')
  } catch (e) {
    try { _db.run('ROLLBACK') } catch {}
    console.warn('[DB] Write batch failed:', e.message?.slice(0, 80))
    // Self-heal: if WASM memory issue, recreate
    if (e.message?.includes('memory') || !e.message) {
      try { _db = new _SQL.Database(); _db.run(SCHEMA) }
      catch {}
    }
  }
}

function _write(sql, params) {
  _queue.push({ sql, params })
  if (!_flushTimer) _flushTimer = setTimeout(_flush, 100)
}

// ── PUBLIC API ────────────────────────────────────────────────────────────

export function setConfig(key, value) {
  const ts = Date.now() / 1000 | 0
  _write('INSERT OR REPLACE INTO config(key,value,ts) VALUES(?,?,?)',
    [String(key), String(value), ts])
}

export function getConfig(key) {
  if (!_db) return null
  try {
    const safe = String(key).replace(/'/g, "''")
    const r = _db.exec(`SELECT value FROM config WHERE key='${safe}'`)
    return r[0]?.values[0]?.[0] ?? null
  } catch { return null }
}

export function recordCredit(stream, amount, source) {
  if (!amount || amount <= 0 || !isFinite(amount)) return
  _write('INSERT INTO credits(stream,amount,source,ts) VALUES(?,?,?,?)',
    [String(stream), amount, String(source || ''), Date.now() / 1000 | 0])
}

export function recordWithdrawal(amount, destination, ref, status) {
  _write('INSERT OR REPLACE INTO withdrawals(amount,destination,ref,status,ts) VALUES(?,?,?,?,?)',
    [amount, String(destination), String(ref), String(status), Date.now() / 1000 | 0])
}

export function updateWithdrawalStatus(ref, status) {
  _write('UPDATE withdrawals SET status=? WHERE ref=?', [String(status), String(ref)])
}

export function recordEvent(name, data) {
  _write('INSERT INTO events(name,data,ts) VALUES(?,?,?)',
    [String(name), JSON.stringify(data || {}), Date.now() / 1000 | 0])
}

export function getRevenue() {
  if (!_db) return { total:0, txs:0, hour:0, today:0, withdrawn:0, net:0 }
  try {
    const now = Date.now() / 1000 | 0
    const r = _db.exec(`
      SELECT
        COALESCE(SUM(amount), 0),
        COUNT(*),
        COALESCE(SUM(CASE WHEN ts > ${now - 3600}  THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN ts > ${now - 86400} THEN amount ELSE 0 END), 0)
      FROM credits
    `)[0]?.values[0] || [0,0,0,0]
    const w = _db.exec(`SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE status='completed'`)[0]?.values[0]?.[0] || 0
    const total = parseFloat(r[0]) || 0
    const withdrawn = parseFloat(w) || 0
    return {
      total,
      txs:       parseInt(r[1]) || 0,
      hour:      parseFloat(r[2]) || 0,
      today:     parseFloat(r[3]) || 0,
      withdrawn,
      net:       total - withdrawn,
      withdrawable: Math.max(0, total - withdrawn)
    }
  } catch { return { total:0, txs:0, hour:0, today:0, withdrawn:0, net:0, withdrawable:0 } }
}

export function getStreamTotals() {
  if (!_db) return {}
  try {
    const r = _db.exec('SELECT stream, SUM(amount), COUNT(*) FROM credits GROUP BY stream')
    const result = {}
    for (const row of (r[0]?.values || [])) {
      result[row[0]] = { total: parseFloat(row[1]) || 0, count: parseInt(row[2]) || 0 }
    }
    return result
  } catch { return {} }
}

export function getRecentCredits(limit = 20) {
  if (!_db) return []
  try {
    const s = _db.prepare('SELECT * FROM credits ORDER BY ts DESC LIMIT ?')
    s.bind([limit])
    const rows = []
    while (s.step()) rows.push(s.getAsObject())
    s.free()
    return rows
  } catch { return [] }
}

export function getTreasuryState() {
  const rev = getRevenue()
  const tier = getConfig('yield_tier') || 'liquid'
  const apy  = { liquid:0, stellar_usdc:3.5, xrpl_amm:10, hedera_stake:7, algo_gov:8.5, diversified:8 }[tier] || 0
  return {
    total:        rev.total,
    withdrawable: rev.withdrawable,
    withdrawn:    rev.withdrawn,
    net:          rev.net,
    hour:         rev.hour,
    today:        rev.today,
    txs:          rev.txs,
    yield_tier:   tier,
    apy,
    xrpl_amm:     parseFloat(getConfig('xrpl_amm_position')    || '0'),
    stellar_amm:  parseFloat(getConfig('stellar_amm_position') || '0'),
    capture_rate: parseFloat(getConfig('capture_rate')         || '0'),
    fortress_phase: parseInt(getConfig('fortress_phase')       || '0'),
  }
}

// Force save on shutdown
process.on('SIGTERM', () => { _flush(); _saveToDisk(); process.exit(0) })
process.on('exit',    () => { try { _saveToDisk() } catch {} })
