// auth.js - Authentication & Authorization
const jwt = require('jsonwebtoken');
const { verifyPassword, hashPassword, generateId, now, db, stmt } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-super-secret-jwt-key-1234567890';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d'; // 7 days
const API_KEY_PREFIX = 'mt5mon_';

//--- Generate Tokens ---
function generateAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, type: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function generateApiKey() {
  const randomPart = require('crypto').randomBytes(24).toString('hex');
  return API_KEY_PREFIX + randomPart;
}

//--- Verify Tokens ---
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

//--- Middleware ---
function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  
  const token = authHeader.slice(7);
  const decoded = verifyAccessToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  
  // Attach user to request
  const user = stmt.getUserById.get(decoded.sub);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  
  req.user = user;
  req.token = decoded;
  next();
}

function apiKeyRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  
  const apiKey = authHeader.slice(7);
  const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex');
  
  const result = stmt.verifyApiKey.get(keyHash);
  if (!result) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  req.apiAccountId = result.account_id;
  next();
}

//--- User Management ---
function registerUser(email, password) {
  const existing = stmt.getUserByEmail.get(email);
  if (existing) {
    throw new Error('Email already registered');
  }
  
  const id = generateId();
  const passwordHash = hashPassword(password);
  
  stmt.createUser.run(id, email, passwordHash);
  
  return { id, email };
}

function loginUser(email, password) {
  const user = stmt.getUserByEmail.get(email);
  if (!user) {
    throw new Error('Invalid credentials');
  }
  
  if (!verifyPassword(password, user.password_hash)) {
    throw new Error('Invalid credentials');
  }
  
  const token = generateAccessToken(user);
  return { user: { id: user.id, email: user.email }, token };
}

//--- MT5 Account Management ---
function createMt5Account(userId, { name, login, server, password }) {
  const { encrypt, generateId } = require('./database');
  const id = generateId();
  const passwordEncrypted = encrypt(password);
  
  stmt.createAccount.run(id, userId, name, login, server, passwordEncrypted);
  
  // Generate API key for this account
  const apiKey = generateApiKey();
  const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex');
  stmt.createApiKey.run(generateId(), id, keyHash, 'Default');
  
  return { id, name, login, server, apiKey };
}

function getUserAccounts(userId) {
  return stmt.getAccountsByUser.all(userId);
}

function getAccountById(accountId, userId) {
  const account = stmt.getAccountById.get(accountId);
  if (!account || account.user_id !== userId) {
    return null;
  }
  // Don't return encrypted password
  const { password_encrypted, ...safe } = account;
  return safe;
}

function updateAccount(accountId, userId, updates) {
  const account = stmt.getAccountById.get(accountId);
  if (!account || account.user_id !== userId) {
    return null;
  }
  
  if (updates.name) {
    stmt.updateAccount.run(updates.name, now(), accountId);
  }
  
  return getAccountById(accountId, userId);
}

function deleteAccount(accountId, userId) {
  const account = stmt.getAccountById.get(accountId);
  if (!account || account.user_id !== userId) {
    return false;
  }
  
  stmt.deleteAccount.run(now(), accountId);
  return true;
}

function getAccountCredentials(accountId) {
  const { decrypt } = require('./database');
  const account = stmt.getAccountById.get(accountId);
  if (!account) return null;
  
  return {
    login: account.login,
    server: account.server,
    password: decrypt(account.password_encrypted)
  };
}

//--- API Key Management ---
function createApiKey(accountId, name = 'Custom') {
  const { generateId } = require('./database');
  const apiKey = generateApiKey();
  const keyHash = require('crypto').createHash('sha256').update(apiKey).digest('hex');
  
  stmt.createApiKey.run(generateId(), accountId, keyHash, name);
  return apiKey;
}

function getApiKeys(accountId) {
  // Return only names and last_used, not hashes
  return db.prepare('SELECT id, name, last_used, created_at FROM api_keys WHERE account_id = ?').all(accountId);
}

function revokeApiKey(keyId, accountId) {
  return db.prepare('DELETE FROM api_keys WHERE id = ? AND account_id = ?').run(keyId, accountId).changes > 0;
}

//--- Notifications ---
function createNotification(userId, { accountId, type, title, message, data }) {
  const { generateId, now } = require('./database');
  const id = generateId();
  
  stmt.createNotification.run(id, userId, accountId || null, type, title, message, data ? JSON.stringify(data) : null);
  return id;
}

function getUserNotifications(userId, limit = 50) {
  const rows = stmt.getNotifications.all(userId);
  return rows.map(r => ({
    ...r,
    data: r.data ? JSON.parse(r.data) : null
  }));
}

function markNotificationRead(notificationId, userId) {
  // Verify ownership
  const notif = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(notificationId, userId);
  if (!notif) return false;
  
  stmt.markNotificationRead.run(notificationId);
  return true;
}

module.exports = {
  // Tokens
  generateAccessToken,
  verifyAccessToken,
  generateApiKey,
  
  // Middleware
  authRequired,
  apiKeyRequired,
  
  // Users
  registerUser,
  loginUser,
  
  // MT5 Accounts
  createMt5Account,
  getUserAccounts,
  getAccountById,
  updateAccount,
  deleteAccount,
  getAccountCredentials,
  
  // API Keys
  createApiKey,
  getApiKeys,
  revokeApiKey,
  
  // Notifications
  createNotification,
  getUserNotifications,
  markNotificationRead,
  
  // Constants
  JWT_SECRET
};