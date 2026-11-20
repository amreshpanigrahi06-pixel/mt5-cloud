// routes/history.js - Trade History
const express = require('express');
const router = express.Router();
const { authRequired } = require('../auth');
const { stmt, db } = require('../database');

router.use(authRequired);

// GET /api/history/:accountId - Get deals/trades
router.get('/:accountId', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const from = req.query.from ? parseInt(req.query.from) : null;
    const to = req.query.to ? parseInt(req.query.to) : null;
    const symbol = req.query.symbol || null;
    const type = req.query.type ? parseInt(req.query.type) : null; // 0=buy, 1=sell
    
    let query = 'SELECT * FROM deals WHERE account_id = ?';
    const params = [req.params.accountId];
    
    if (from) {
      query += ' AND time >= ?';
      params.push(from);
    }
    if (to) {
      query += ' AND time <= ?';
      params.push(to);
    }
    if (symbol) {
      query += ' AND symbol = ?';
      params.push(symbol);
    }
    if (type !== null) {
      query += ' AND type = ?';
      params.push(type);
    }
    
    query += ' ORDER BY time DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const deals = db.prepare(query).all(...params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) as c FROM deals WHERE account_id = ?';
    const countParams = [req.params.accountId];
    if (from) { countQuery += ' AND time >= ?'; countParams.push(from); }
    if (to) { countQuery += ' AND time <= ?'; countParams.push(to); }
    if (symbol) { countQuery += ' AND symbol = ?'; countParams.push(symbol); }
    if (type !== null) { countQuery += ' AND type = ?'; countParams.push(type); }
    
    const total = db.prepare(countQuery).get(...countParams).c;
    
    // Enrich deals
    const enriched = deals.map(d => ({
      ...d,
      typeStr: d.type === 0 ? 'BUY' : 'SELL',
      entryStr: d.entry === 0 ? 'IN' : d.entry === 1 ? 'OUT' : d.entry === 2 ? 'INOUT' : 'UNKNOWN',
      netProfit: (d.profit || 0) + (d.swap || 0) + (d.commission || 0) + (d.fee || 0)
    }));
    
    res.json({ deals: enriched, total, limit, offset });
  } catch (e) {
    console.error('GET /history error:', e);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/history/:accountId/stats - Performance statistics
router.get('/:accountId/stats', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const from = req.query.from ? parseInt(req.query.from) : Math.floor(Date.now() / 1000) - 30 * 86400;
    const to = req.query.to ? parseInt(req.query.to) : Math.floor(Date.now() / 1000);
    
    // Overall stats
    const overall = db.prepare(`
      SELECT 
        COUNT(*) as totalTrades,
        SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN profit < 0 THEN 1 ELSE 0 END) as losses,
        SUM(profit) as grossProfit,
        SUM(swap) as totalSwap,
        SUM(commission) as totalCommission,
        AVG(profit) as avgProfit,
        MAX(profit) as bestTrade,
        MIN(profit) as worstTrade,
        SUM(volume) as totalVolume
      FROM deals 
      WHERE account_id = ? AND time BETWEEN ? AND ? AND entry IN (1, 2)
    `).get(req.params.accountId, from, to);
    
    // By symbol
    const bySymbol = db.prepare(`
      SELECT 
        symbol,
        COUNT(*) as trades,
        SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as wins,
        SUM(profit) as profit,
        SUM(swap) as swap,
        SUM(volume) as volume
      FROM deals 
      WHERE account_id = ? AND time BETWEEN ? AND ? AND entry IN (1, 2)
      GROUP BY symbol
      ORDER BY profit DESC
    `).all(req.params.accountId, from, to);
    
    // By day
    const byDay = db.prepare(`
      SELECT 
        date(time, 'unixepoch') as day,
        COUNT(*) as trades,
        SUM(profit) as profit
      FROM deals 
      WHERE account_id = ? AND time BETWEEN ? AND ? AND entry IN (1, 2)
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `).all(req.params.accountId, from, to);
    
    // Win rate
    const winRate = overall.totalTrades > 0 ? (overall.wins / overall.totalTrades * 100).toFixed(2) : 0;
    const netProfit = (overall.grossProfit || 0) + (overall.totalSwap || 0) + (overall.totalCommission || 0);
    const profitFactor = overall.losses > 0 ? Math.abs(overall.grossProfit / overall.losses) : null;
    
    res.json({
      period: { from, to },
      overall: {
        ...overall,
        winRate: parseFloat(winRate),
        netProfit,
        profitFactor
      },
      bySymbol,
      byDay: byDay.reverse()
    });
  } catch (e) {
    console.error('GET /history/stats error:', e);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/history/:accountId/equity-curve - Equity curve data
router.get('/:accountId/equity-curve', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const from = Math.floor(Date.now() / 1000) - days * 86400;
    
    // Get daily equity from snapshots
    const snapshots = db.prepare(`
      SELECT 
        date(timestamp, 'unixepoch') as day,
        MAX(equity) as equity,
        MAX(balance) as balance
      FROM account_snapshots 
      WHERE account_id = ? AND timestamp >= ?
      GROUP BY day
      ORDER BY day
    `).all(req.params.accountId, from);
    
    res.json({ equityCurve: snapshots });
  } catch (e) {
    console.error('GET /history/equity-curve error:', e);
    res.status(500).json({ error: 'Failed to fetch equity curve' });
  }
});

module.exports = router;