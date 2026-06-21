// lib/db.js
// قاعدة بيانات SQLite محلية (ملف واحد) لتسجيل المستخدمين، مفاتيحهم المشفّرة،
// إعداداتهم، صفقاتهم، ومحافظهم — كل مستخدم له بياناته الخاصة المعزولة.

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "app.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exchange_keys (
  user_id INTEGER PRIMARY KEY,
  api_key_enc TEXT NOT NULL,
  api_secret_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY,
  execution TEXT NOT NULL DEFAULT 'off',        -- off | paper | live
  decision_mode TEXT NOT NULL DEFAULT 'recommend_only', -- recommend_only | auto
  pairs TEXT NOT NULL DEFAULT 'BTC_USDT,ETH_USDT'
);

CREATE TABLE IF NOT EXISTS strategy_weights (
  user_id INTEGER PRIMARY KEY,
  weights TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_wallets (
  user_id INTEGER PRIMARY KEY,
  cash REAL NOT NULL,
  positions TEXT NOT NULL DEFAULT '{}',
  realized_pnl REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_positions (
  user_id INTEGER NOT NULL,
  pair TEXT NOT NULL,
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  stop_loss_price REAL,
  take_profit_price REAL,
  votes TEXT,
  opened_at TEXT NOT NULL,
  PRIMARY KEY (user_id, pair)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pair TEXT NOT NULL,
  qty REAL NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  pnl_pct REAL NOT NULL,
  reason TEXT,
  mode TEXT NOT NULL,
  votes TEXT,
  opened_at TEXT,
  closed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pair TEXT NOT NULL,
  action TEXT NOT NULL,
  score REAL,
  price REAL,
  atr REAL,
  votes TEXT,
  engine TEXT,
  ai_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | executed | dismissed | expired
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_state (
  user_id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  start_equity REAL,
  breaker INTEGER NOT NULL DEFAULT 0
);
`);

// ترقية: إضافة عمود "معطّل" لحسابات المستخدمين (لوحة الأدمن) دون كسر القواعد القائمة
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes("disabled")) {
  db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
}

export default db;
