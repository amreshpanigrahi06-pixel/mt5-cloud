// routes/notifications.js - User Notifications
const express = require('express');
const router = express.Router();
const { authRequired } = require('../auth');
const { stmt } = require('../database');

router.use(authRequired);

// GET /api/notifications - Get user notifications
router.get('/', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const unreadOnly = req.query.unread === 'true';
    
    let query = 'SELECT * FROM notifications WHERE user_id = ?';
    const params = [req.user.id];
    
    if (unreadOnly) {
      query += ' AND is_read = 0';
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    
    const notifications = stmt.db.prepare(query).all(...params);
    
    const enriched = notifications.map(n => ({
      ...n,
      data: n.data ? JSON.parse(n.data) : null
    }));
    
    res.json({ notifications: enriched });
  } catch (e) {
    console.error('GET /notifications error:', e);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// GET /api/notifications/unread-count - Get unread count
router.get('/unread-count', (req, res) => {
  try {
    const count = stmt.db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).c;
    res.json({ count });
  } catch (e) {
    console.error('GET /notifications/unread-count error:', e);
    res.status(500).json({ error: 'Failed to fetch count' });
  }
});

// PUT /api/notifications/:id/read - Mark as read
router.put('/:id/read', (req, res) => {
  try {
    const success = require('../auth').markNotificationRead(req.params.id, req.user.id);
    if (!success) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('PUT /notifications/:id/read error:', e);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// PUT /api/notifications/read-all - Mark all as read
router.put('/read-all', (req, res) => {
  try {
    const result = stmt.db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.user.id);
    res.json({ success: true, updated: result.changes });
  } catch (e) {
    console.error('PUT /notifications/read-all error:', e);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// DELETE /api/notifications/:id - Delete notification
router.delete('/:id', (req, res) => {
  try {
    const result = stmt.db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /notifications/:id error:', e);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

module.exports = router;