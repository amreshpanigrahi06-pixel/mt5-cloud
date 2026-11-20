// database.js - SQLite Database Setup & Models
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './data/mt5monitor.db';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'change-this-32-char-key-1234567890ab'; // 32 chars

// Ensure data directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

//--- Encryption Helpers ---
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

//--- Schema ---
function initDatabase() {
  // Users (web dashboard login)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // MT5 Accounts (linked to user)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mt5_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      login INTEGER NOT NULL,
      server TEXT NOT NULL,
      password_encrypted TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      last_sync INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Account Info Snapshots
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_snapshots (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      balance REAL,
      equity REAL,
      margin REAL,
      free_margin REAL,
      margin_level REAL,
      leverage INTEGER,
      trade_mode INTEGER,
      timestamp INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE CASCADE
    )
  `);

  // Positions
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      ticket INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      type INTEGER NOT NULL, -- 0=buy, 1=sell
      volume REAL NOT NULL,
      price_open REAL NOT NULL,
      price_current REAL,
      sl REAL,
      tp REAL,
      swap REAL,
      profit REAL,
      pips REAL,
      magic INTEGER,
      comment TEXT,
      time_open INTEGER,
      time_update INTEGER,
      is_closed INTEGER DEFAULT 0,
      closed_at INTEGER,
      closed_profit REAL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE CASCADE
    )
  `);

  // Orders (pending)
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      ticket INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      type INTEGER NOT NULL,
      volume REAL NOT NULL,
      price_open REAL NOT NULL,
      sl REAL,
      tp REAL,
      magic INTEGER,
      comment TEXT,
      time_setup INTEGER,
      time_expiration INTEGER,
      state INTEGER,
      is_filled INTEGER DEFAULT 0,
      filled_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE CASCADE
    )
  `);

  // History Deals
  db.exec(`
    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      ticket INTEGER NOT NULL,
      order_ticket INTEGER,
      position_id INTEGER,
      symbol TEXT NOT NULL,
      type INTEGER NOT NULL,
      entry INTEGER NOT NULL,
      volume REAL NOT NULL,
      price REAL NOT NULL,
      profit REAL,
      swap REAL,
      commission REAL,
      fee REAL,
      magic INTEGER,
      comment TEXT,
      time INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE CASCADE
    )
  `);

  // API Keys for MT5 EA
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      name TEXT,
      last_used INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE CASCADE
    )
  `);

  // Notifications
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT,
      type TEXT NOT NULL, -- 'position_open', 'position_close', 'margin_call', etc.
      title TEXT NOT NULL,
      message TEXT,
      data TEXT, -- JSON
      is_read INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES mt5_accounts(id) ON DELETE SET NULL
    )
  `);

  // Indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_account ON positions(account_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_ticket ON positions(ticket)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deals_account_time ON deals(account_id, time)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_account_time ON account_snapshots(account_id, timestamp)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read)`);

  console.log('Database initialized at:', DB_PATH);
}

//--- Prepared Statements ---
const stmt = {
  // Users
  createUser: db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),

  // MT5 Accounts
  createAccount: db.prepare(`
    INSERT INTO mt5_accounts (id, user_id, name, login, server, password_encrypted)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getAccountsByUser: db.prepare('SELECT * FROM mt5_accounts WHERE user_id = ? AND is_active = 1'),
  getAccountById: db.prepare('SELECT * FROM mt5_accounts WHERE id = ?'),
  updateAccountSync: db.prepare('UPDATE mt5_accounts SET last_sync = ?, updated_at = ? WHERE id = ?'),
  updateAccount: db.prepare('UPDATE mt5_accounts SET name = ?, updated_at = ? WHERE id = ?'),
  deleteAccount: db.prepare('UPDATE mt5_accounts SET is_active = 0, updated_at = ? WHERE id = ?'),

  // Account Snapshots
  insertSnapshot: db.prepare(`
    INSERT INTO account_snapshots (id, account_id, balance, equity, margin, free_margin, margin_level, leverage, trade_mode, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getLatestSnapshot: db.prepare('SELECT * FROM account_snapshots WHERE account_id = ? ORDER BY timestamp DESC LIMIT 1'),
  getSnapshotsRange: db.prepare('SELECT * FROM account_snapshots WHERE account_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp'),

  // Positions
  upsertPosition: db.prepare(`
    INSERT INTO positions (id, account_id, ticket, symbol, type, volume, price_open, price_current, sl, tp, swap, profit, pips, magic, comment, time_open, time_update, is_closed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      price_current = excluded.price_current,
      sl = excluded.sl,
      tp = excluded.tp,
      swap = excluded.swap,
      profit = excluded.profit,
      pips = excluded.pips,
      comment = excluded.comment,
      time_update = excluded.time_update,
      updated_at = strftime('%s', 'now')
  `),
  closePosition: db.prepare(`
    UPDATE positions SET is_closed = 1, closed_at = ?, closed_profit = ?, updated_at = ?
    WHERE id = ?
  `),
  getPositions: db.prepare('SELECT * FROM positions WHERE account_id = ? AND is_closed = 0 ORDER BY time_open DESC'),
  getPositionByTicket: db.prepare('SELECT * FROM positions WHERE account_id = ? AND ticket = ?'),

  // Orders
  upsertOrder: db.prepare(`
    INSERT INTO orders (id, account_id, ticket, symbol, type, volume, price_open, sl, tp, magic, comment, time_setup, time_expiration, state, is_filled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      volume = excluded.volume,
      price_open = excluded.price_open,
      sl = excluded.sl,
      tp = excluded.tp,
      state = excluded.state,
      updated_at = strftime('%s', 'now')
  `),
  fillOrder: db.prepare('UPDATE orders SET is_filled = 1, filled_at = ?, updated_at = ? WHERE id = ?'),
  getOrders: db.prepare('SELECT * FROM orders WHERE account_id = ? AND is_filled = 0 ORDER BY time_setup DESC'),

  // Deals
  insertDeal: db.prepare(`
    INSERT INTO deals (id, account_id, ticket, order_ticket, position_id, symbol, type, entry, volume, price, profit, swap, commission, fee, magic, comment, time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `),
  getDeals: db.prepare('SELECT * FROM deals WHERE account_id = ? ORDER BY time DESC LIMIT ?'),
  getDealsRange: db.prepare('SELECT * FROM deals WHERE account_id = ? AND time BETWEEN ? AND ? ORDER BY time DESC'),

  // API Keys
  createApiKey: db.prepare('INSERT INTO api_keys (id, account_id, key_hash, name) VALUES (?, ?, ?, ?)'),
  getApiKey: db.prepare('SELECT * FROM api_keys WHERE account_id = ?'),
  verifyApiKey: db.prepare('SELECT account_id FROM api_keys WHERE key_hash = ?'),

  // Notifications
  createNotification: db.prepare(`
    INSERT INTO notifications (id, user_id, account_id, type, title, message, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getNotifications: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'),
  markNotificationRead: db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?'),
};

//--- Helpers ---
function generateId() {
  return crypto.randomUUID();
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function verifyPassword(password, hash) {
  const bcrypt = require('bcryptjs');
  return bcrypt.compareSync(password, hash);
}

function hashPassword(password) {
  const bcrypt = require('bcryptjs');
  return bcrypt.hashSync(password, 10);
}

//--- Export ---
module.exports = {
  db,
  stmt,
  initDatabase,
  encrypt,
  decrypt,
  generateId,
  now,
  hashApiKey,
  verifyPassword,
  hashPassword,
  ENCRYPTION_KEY
};

//--- CLI Init ---
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('init')) {
    initDatabase();
    console.log('Database initialized successfully');
    process.exit(0);
  }
}