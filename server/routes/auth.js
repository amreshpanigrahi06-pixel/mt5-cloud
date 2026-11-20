// routes/auth.js - Authentication Routes
const express = require('express');
const router = express.Router();
const { registerUser, loginUser, generateAccessToken, verifyAccessToken, authRequired } = require('../auth');
const { stmt, db, now } = require('../database');

// POST /api/auth/register - Register new user
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    const user = registerUser(email, password);
    const token = generateAccessToken(user);
    
    res.status(201).json({ user: { id: user.id, email: user.email }, token });
  } catch (e) {
    console.error('POST /auth/register error:', e);
    if (e.message.includes('already registered')) {
      return res.status(400).json({ error: e.message });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login - Login
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const { user, token } = loginUser(email, password);
    res.json({ user, token });
  } catch (e) {
    console.error('POST /auth/login error:', e);
    if (e.message === 'Invalid credentials') {
      return res.status(401).json({ error: e.message });
    }
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me - Get current user
router.get('/me', authRequired, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// POST /api/auth/refresh - Refresh token
router.post('/refresh', authRequired, (req, res) => {
  const token = generateAccessToken(req.user);
  res.json({ token });
});

// POST /api/auth/verify - Verify token (for WS connection)
router.post('/verify', (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ valid: false, error: 'Token required' });
  }
  
  const decoded = verifyAccessToken(token);
  if (!decoded) {
    return res.json({ valid: false });
  }
  
  res.json({ valid: true, userId: decoded.sub });
});

module.exports = router;