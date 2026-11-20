// routes/webhook.js - MT5 EA Data Ingestion
const express = require('express');
const router = express.Router();
const { apiKeyRequired } = require('../auth');
const { stmt, db, now } = require('../database');
const { createNotification } = require('../auth');

// All routes require API key (from MT5 EA)
router.use(apiKeyRequired);

// POST /api/webhook/account - Account info update
router.post('/account', (req, res) => {
  try {
    const { account_id, balance, equity, margin, free_margin, margin_level, leverage, trade_mode, timestamp } = req.body;
    
    if (!account_id || account_id !== req.apiAccountId) {
      return res.status(403).json({ error: 'Account ID mismatch' });
    }
    
    // Verify account exists
    const account = db.prepare('SELECT * FROM mt5_accounts WHERE id = ?').get(account_id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    // Insert snapshot
    const { generateId } = require('../database');
    stmt.insertSnapshot.run(
      generateId(), account_id, balance, equity, margin, free_margin, margin_level, leverage, trade_mode, timestamp || now()
    );
    
    // Update last_sync
    stmt.updateAccountSync.run(now(), now(), account_id);
    
    // Check for margin call
    if (margin_level > 0 && margin_level < 100) {
      createNotification(account.user_id, {
        accountId: account_id,
        type: 'margin_warning',
        title: 'Margin Level Warning',
        message: `Margin level is ${margin_level.toFixed(2)}%`,
        data: { marginLevel: margin_level }
      });
    }
    
    res.json({ success: true });
  } catch (e) {
    console.error('POST /webhook/account error:', e);
    res.status(500).json({ error: 'Failed to process account update' });
  }
});

// POST /api/webhook/positions - Position sync
router.post('/positions', (req, res) => {
  try {
    const { account_id, positions, timestamp } = req.body;
    
    if (!account_id || account_id !== req.apiAccountId) {
      return res.status(403).json({ error: 'Account ID mismatch' });
    }
    
    const account = db.prepare('SELECT * FROM mt5_accounts WHERE id = ?').get(account_id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const ts = timestamp || now();
    let newCount = 0, updatedCount = 0, closedCount = 0;
    
    // Get current open positions in DB
    const dbPositions = new Map();
    stmt.getPositions.all(account_id).forEach(p => dbPositions.set(p.ticket, p));
    
    const receivedTickets = new Set();
    
    // Process received positions
    for (const p of positions || []) {
      const { generateId } = require('../database');
      const id = `pos_${account_id}_${p.ticket}`;
      receivedTickets.add(p.ticket);
      
      if (dbPositions.has(p.ticket)) {
        // Update existing
        stmt.upsertPosition.run(
          id, account_id, p.ticket, p.symbol, p.type, p.volume, p.price_open,
          p.price_current, p.sl, p.tp, p.swap, p.profit, p.pips, p.magic, p.comment,
          p.time_open, p.time_update
        );
        updatedCount++;
      } else {
        // New position
        stmt.upsertPosition.run(
          id, account_id, p.ticket, p.symbol, p.type, p.volume, p.price_open,
          p.price_current, p.sl, p.tp, p.swap, p.profit, p.pips, p.magic, p.comment,
          p.time_open, p.time_update
        );
        newCount++;
        
        // Notify
        createNotification(account.user_id, {
          accountId: account_id,
          type: 'position_open',
          title: 'New Position Opened',
          message: `${p.type === 0 ? 'BUY' : 'SELL'} ${p.volume} ${p.symbol} @ ${p.price_open}`,
          data: { ticket: p.ticket, symbol: p.symbol, type: p.type, volume: p.volume, price: p.price_open, sl: p.sl, tp: p.tp }
        });
      }
    }
    
    // Check for closed positions
    for (const [ticket, dbPos] of dbPositions) {
      if (!receivedTickets.has(ticket)) {
        // Position closed
        stmt.closePosition.run(ts, dbPos.profit, ts, `pos_${account_id}_${ticket}`);
        closedCount++;
        
        createNotification(account.user_id, {
          accountId: account_id,
          type: 'position_close',
          title: 'Position Closed',
          message: `${dbPos.type === 0 ? 'BUY' : 'SELL'} ${dbPos.volume} ${dbPos.symbol} closed @ ${dbPos.price_current} | P/L: ${dbPos.profit.toFixed(2)}`,
          data: { ticket: dbPos.ticket, symbol: dbPos.symbol, profit: dbPos.profit, pips: dbPos.pips }
        });
      }
    }
    
    res.json({ success: true, new: newCount, updated: updatedCount, closed: closedCount });
  } catch (e) {
    console.error('POST /webhook/positions error:', e);
    res.status(500).json({ error: 'Failed to process positions' });
  }
});

// POST /api/webhook/orders - Pending orders sync
router.post('/orders', (req, res) => {
  try {
    const { account_id, orders, timestamp } = req.body;
    
    if (!account_id || account_id !== req.apiAccountId) {
      return res.status(403).json({ error: 'Account ID mismatch' });
    }
    
    const account = db.prepare('SELECT * FROM mt5_accounts WHERE id = ?').get(account_id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const ts = timestamp || now();
    let newCount = 0, updatedCount = 0, filledCount = 0;
    
    // Get current orders in DB
    const dbOrders = new Map();
    stmt.getOrders.all(account_id).forEach(o => dbOrders.set(o.ticket, o));
    
    const receivedTickets = new Set();
    
    for (const o of orders || []) {
      const { generateId } = require('../database');
      const id = `ord_${account_id}_${o.ticket}`;
      receivedTickets.add(o.ticket);
      
      if (dbOrders.has(o.ticket)) {
        stmt.upsertOrder.run(
          id, account_id, o.ticket, o.symbol, o.type, o.volume, o.price_open,
          o.sl, o.tp, o.magic, o.comment, o.time_setup, o.time_expiration, o.state
        );
        updatedCount++;
      } else {
        stmt.upsertOrder.run(
          id, account_id, o.ticket, o.symbol, o.type, o.volume, o.price_open,
          o.sl, o.tp, o.magic, o.comment, o.time_setup, o.time_expiration, o.state
        );
        newCount++;
      }
    }
    
    // Check for filled orders
    for (const [ticket, dbOrd] of dbOrders) {
      if (!receivedTickets.has(ticket)) {
        stmt.fillOrder.run(ts, ts, `ord_${account_id}_${ticket}`);
        filledCount++;
      }
    }
    
    res.json({ success: true, new: newCount, updated: updatedCount, filled: filledCount });
  } catch (e) {
    console.error('POST /webhook/orders error:', e);
    res.status(500).json({ error: 'Failed to process orders' });
  }
});

// POST /api/webhook/history - Deal history sync
router.post('/history', (req, res) => {
  try {
    const { account_id, deals, from, to, timestamp } = req.body;
    
    if (!account_id || account_id !== req.apiAccountId) {
      return res.status(403).json({ error: 'Account ID mismatch' });
    }
    
    const account = db.prepare('SELECT * FROM mt5_accounts WHERE id = ?').get(account_id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    let inserted = 0;
    const { generateId } = require('../database');
    
    for (const d of deals || []) {
      const id = `deal_${account_id}_${d.ticket}`;
      const result = stmt.insertDeal.run(
        id, account_id, d.ticket, d.order_ticket, d.position_id, d.symbol,
        d.type, d.entry, d.volume, d.price, d.profit, d.swap, d.commission, d.fee,
        d.magic, d.comment, d.time
      );
      if (result.changes > 0) inserted++;
    }
    
    res.json({ success: true, inserted });
  } catch (e) {
    console.error('POST /webhook/history error:', e);
    res.status(500).json({ error: 'Failed to process history' });
  }
});

// GET /api/webhook/ping - Health check for EA
router.get('/ping', (req, res) => {
  res.json({ 
    success: true, 
    serverTime: now(),
    accountId: req.apiAccountId 
  });
});

module.exports = router;