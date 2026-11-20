// index.js - Main Server Entry Point
require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const { initDatabase } = require('./database');
const authRoutes = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const positionsRoutes = require('./routes/positions');
const historyRoutes = require('./routes/history');
const webhookRoutes = require('./routes/webhook');
const notificationsRoutes = require('./routes/notifications');
const { verifyAccessToken, JWT_SECRET } = require('./auth');

// Initialize database
initDatabase();

const app = express();
const server = http.createServer(app);

//--- WebSocket Server ---
const wss = new WebSocket.Server({ server, path: '/ws' });

// Store connected clients: Map<userId, Set<WebSocket>>
const clients = new Map();

wss.on('connection', (ws, req) => {
  // Extract token from query string
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  
  if (!token) {
    ws.close(4001, 'Authentication required');
    return;
  }
  
  const decoded = verifyAccessToken(token);
  if (!decoded) {
    ws.close(4001, 'Invalid token');
    return;
  }
  
  const userId = decoded.sub;
  
  // Register client
  if (!clients.has(userId)) {
    clients.set(userId, new Set());
  }
  clients.get(userId).add(ws);
  
  ws.userId = userId;
  ws.isAlive = true;
  
  ws.on('pong', () => { ws.isAlive = true; });
  
  ws.on('close', () => {
    const userClients = clients.get(userId);
    if (userClients) {
      userClients.delete(ws);
      if (userClients.size === 0) {
        clients.delete(userId);
      }
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
  
  // Send welcome
  ws.send(JSON.stringify({ type: 'connected', userId }));
});

// Heartbeat interval
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

//--- Broadcast Functions ---
function broadcastToUser(userId, message) {
  const userClients = clients.get(userId);
  if (!userClients) return;
  
  const data = JSON.stringify(message);
  for (const ws of userClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function broadcastToAll(message) {
  const data = JSON.stringify(message);
  for (const [_, userClients] of clients) {
    for (const ws of userClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}

// Make broadcast available globally
global.broadcastToUser = broadcastToUser;
global.broadcastToAll = broadcastToAll;

//--- Middleware ---
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for simple dashboard
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// Stricter limit for auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, please try again later' }
});
app.use('/api/auth/', authLimiter);

//--- Routes ---
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Math.floor(Date.now() / 1000),
    uptime: process.uptime(),
    clients: clients.size
  });
});

// Auth routes (no authRequired middleware)
app.use('/api/auth', authRoutes);

// Protected routes
app.use('/api/accounts', accountsRoutes);
app.use('/api/positions', positionsRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/notifications', notificationsRoutes);

// Webhook routes (API key auth)
app.use('/api/webhook', webhookRoutes);

//--- Serve Static Dashboard ---
const clientPath = path.join(__dirname, '../client');
if (fs.existsSync(clientPath)) {
  app.use(express.static(clientPath));
  
  // SPA fallback
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return;
    res.sendFile(path.join(clientPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.json({ 
      message: 'MT5 Monitor API', 
      docs: '/api/health',
      dashboard: 'Build client in ../client/'
    });
  });
}

//--- Error Handling ---
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

//--- Start Server ---
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  MT5 Monitor Server                                      ║
║  HTTP:  http://${HOST}:${PORT}                                ║
║  WS:    ws://${HOST}:${PORT}/ws                             ║
║  API:   http://${HOST}:${PORT}/api/health                     ║
╚══════════════════════════════════════════════════════════╝
  `);
});

//--- Graceful Shutdown ---
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server, wss, broadcastToUser, broadcastToAll };