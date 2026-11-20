// routes/accounts.js - MT5 Account CRUD
const express = require('express');
const router = express.Router();
const { authRequired } = require('../auth');
const { getAccountCredentials } = require('../auth');
const { stmt, db, generateId, now, encrypt } = require('../database');

// All routes require authentication
router.use(authRequired);

// GET /api/accounts - List user's MT5 accounts
router.get('/', (req, res) => {
  try {
    const accounts = require('../auth').getUserAccounts(req.user.id);
    // Remove sensitive data
    const safeAccounts = accounts.map(({ password_encrypted, ...a }) => a);
    res.json({ accounts: safeAccounts });
  } catch (e) {
    console.error('GET /accounts error:', e);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// POST /api/accounts - Add new MT5 account
router.post('/', (req, res) => {
  try {
    const { name, login, server, password } = req.body;
    
    if (!name || !login || !server || !password) {
      return res.status(400).json({ error: 'Missing required fields: name, login, server, password' });
    }
    
    const loginNum = parseInt(login);
    if (isNaN(loginNum)) {
      return res.status(400).json({ error: 'Login must be a number' });
    }
    
    const account = require('../auth').createMt5Account(req.user.id, { name, login: loginNum, server, password });
    res.status(201).json({ account });
  } catch (e) {
    console.error('POST /accounts error:', e);
    if (e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Account already exists' });
    }
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// GET /api/accounts/:id - Get account details
router.get('/:id', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.id, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    res.json({ account });
  } catch (e) {
    console.error('GET /accounts/:id error:', e);
    res.status(500).json({ error: 'Failed to fetch account' });
  }
});

// PUT /api/accounts/:id - Update account
router.put('/:id', (req, res) => {
  try {
    const { name } = req.body;
    const account = require('../auth').updateAccount(req.params.id, req.user.id, { name });
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    res.json({ account });
  } catch (e) {
    console.error('PUT /accounts/:id error:', e);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

// DELETE /api/accounts/:id - Delete account (soft)
router.delete('/:id', (req, res) => {
  try {
    const success = require('../auth').deleteAccount(req.params.id, req.user.id);
    if (!success) {
      return res.status(404).json({ error: 'Account not found' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /accounts/:id error:', e);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// GET /api/accounts/:id/credentials - Get decrypted credentials (for EA config)
router.get('/:id/credentials', (req, res) => {
  try {
    const creds = getAccountCredentials(req.params.id);
    if (!creds) {
      return res.status(404).json({ error: 'Account not found' });
    }
    // Verify ownership
    const account = require('../auth').getAccountById(req.params.id, req.user.id);
    if (!account) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ credentials: creds });
  } catch (e) {
    console.error('GET /accounts/:id/credentials error:', e);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// POST /api/accounts/:id/api-keys - Generate new API key for EA
router.post('/:id/api-keys', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.id, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const { name } = req.body;
    const apiKey = require('../auth').createApiKey(req.params.id, name || 'EA Key');
    res.status(201).json({ apiKey });
  } catch (e) {
    console.error('POST /accounts/:id/api-keys error:', e);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// GET /api/accounts/:id/api-keys - List API keys
router.get('/:id/api-keys', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.id, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const keys = require('../auth').getApiKeys(req.params.id);
    res.json({ keys });
  } catch (e) {
    console.error('GET /accounts/:id/api-keys error:', e);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// DELETE /api/accounts/:id/api-keys/:keyId - Revoke API key
router.delete('/:id/api-keys/:keyId', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.id, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const success = require('../auth').revokeApiKey(req.params.keyId, req.params.id);
    if (!success) {
      return res.status(404).json({ error: 'API key not found' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /accounts/:id/api-keys/:keyId error:', e);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

module.exports = router;