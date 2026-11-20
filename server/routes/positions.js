// routes/positions.js - Position Data
const express = require('express');
const router = express.Router();
const { authRequired } = require('../auth');
const { stmt, db } = require('../database');

// All routes require authentication
router.use(authRequired);

// GET /api/positions/:accountId - Get open positions
router.get('/:accountId', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const positions = stmt.getPositions.all(req.params.accountId);
    
    // Enrich with current price info if needed
    const enriched = positions.map(p => ({
      ...p,
      typeStr: p.type === 0 ? 'BUY' : 'SELL',
      durationSec: Math.floor(Date.now() / 1000) - p.time_open
    }));
    
    res.json({ positions: enriched });
  } catch (e) {
    console.error('GET /positions error:', e);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

// GET /api/positions/:accountId/history - Get closed positions
router.get('/:accountId/history', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    const positions = db.prepare(`
      SELECT * FROM positions 
      WHERE account_id = ? AND is_closed = 1 
      ORDER BY closed_at DESC 
      LIMIT ? OFFSET ?
    `).all(req.params.accountId, limit, offset);
    
    const total = db.prepare('SELECT COUNT(*) as c FROM positions WHERE account_id = ? AND is_closed = 1').get(req.params.accountId).c;
    
    res.json({ positions, total, limit, offset });
  } catch (e) {
    console.error('GET /positions/history error:', e);
    res.status(500).json({ error: 'Failed to fetch position history' });
  }
});

// GET /api/positions/:accountId/summary - Position summary stats
router.get('/:accountId/summary', (req, res) => {
  try {
    const account = require('../auth').getAccountById(req.params.accountId, req.user.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    const openPositions = stmt.getPositions.all(req.params.accountId);
    
    let totalVolume = 0, totalProfit = 0, totalSwap = 0;
    let buyCount = 0, sellCount = 0;
    let buyVolume = 0, sellVolume = 0;
    
    for (const p of openPositions) {
      totalVolume += p.volume;
      totalProfit += p.profit;
      totalSwap += p.swap;
      
      if (p.type === 0) {
        buyCount++;
        buyVolume += p.volume;
      } else {
        sellCount++;
        sellVolume += p.volume;
      }
    }
    
    res.json({
      openPositions: openPositions.length,
      totalVolume,
      totalProfit,
      totalSwap,
      netProfit: totalProfit + totalSwap,
      buyCount,
      sellCount,
      buyVolume,
      sellVolume,
      netVolume: buyVolume - sellVolume
    });
  } catch (e) {
    console.error('GET /positions/summary error:', e);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

module.exports = router;