import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  ls_customer_id TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  first_name TEXT,
  email TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  bonus_pending INTEGER NOT NULL DEFAULT 1,
  bonus_sale_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, ref)
);
CREATE TABLE IF NOT EXISTS sales (
  sale_id TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL,
  points_earned INTEGER NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ls_customers (
  id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  version INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lsc_phone ON ls_customers(phone);
CREATE INDEX IF NOT EXISTS idx_lsc_email ON ls_customers(email);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Lightweight migrations for columns added after the first release.
const memberCols = db.prepare('PRAGMA table_info(members)').all().map((c) => c.name);
if (!memberCols.includes('birth_month')) db.exec('ALTER TABLE members ADD COLUMN birth_month INTEGER');
if (!memberCols.includes('birth_day')) db.exec('ALTER TABLE members ADD COLUMN birth_day INTEGER');

export function kvGet(key) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}
export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Adds a ledger entry and updates the balance. Returns false if (kind, ref) already exists. Call inside tx(). */
export function addLedger(memberId, delta, kind, ref, note = null) {
  const exists = db.prepare('SELECT 1 FROM ledger WHERE kind = ? AND ref = ?').get(kind, String(ref));
  if (exists) return false;
  db.prepare('INSERT INTO ledger (member_id, delta, kind, ref, note) VALUES (?, ?, ?, ?, ?)')
    .run(memberId, delta, kind, String(ref), note);
  db.prepare('UPDATE members SET points = points + ? WHERE id = ?').run(delta, memberId);
  return true;
}

export function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}
