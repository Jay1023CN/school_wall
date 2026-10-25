const express = require('express');
const { pool, ensureNotificationsTable } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');

const router = express.Router();
router.get('/init-notifications-table', requirePermission('notices:manage'), async (req, res) => {
  try {
    await ensureNotificationsTable(pool);
    res.json({ code: 200, message: '通知表创建成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/notifications', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { user_id, type } = req.query;

    let whereClause = '1=1';
    const params = [];

    if (user_id) {
      whereClause += ' AND n.user_id = ?';
      params.push(user_id);
    }
    if (type) {
      whereClause += ' AND n.type = ?';
      params.push(type);
    }

    const [notifications] = await pool.execute(`
      SELECT n.*, u.username, u.nickname
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      WHERE ${whereClause}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total FROM notifications n WHERE ${whereClause}
    `, params);

    res.json({
      code: 200,
      data: {
        notifications,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/notifications/send', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { user_id, type, title, content, related_id, related_type } = req.body;

    if (!user_id || !title) {
      return res.json({ code: 400, message: '用户ID和标题不能为空' });
    }

    await pool.execute(
      'INSERT INTO notifications (user_id, type, title, content, related_id, related_type) VALUES (?, ?, ?, ?, ?, ?)',
      [user_id, type || 'system', title, content || '', related_id || null, related_type || null]
    );

    res.json({ code: 200, message: '通知发送成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/notifications/send-batch', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { user_ids, type, title, content, related_id, related_type } = req.body;

    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0 || !title) {
      return res.json({ code: 400, message: '用户ID列表和标题不能为空' });
    }

    const notificationType = type || 'system';
    const notificationContent = content || '';
    const notificationRelatedId = related_id || null;
    const notificationRelatedType = related_type || null;
    const sharedValueBytes = [notificationType, title, notificationContent, notificationRelatedId, notificationRelatedType]
      .reduce((total, value) => total + Buffer.byteLength(String(value == null ? '' : value)), 0);
    const batchSize = Math.max(1, Math.min(500, Math.floor(262144 / Math.max(512, sharedValueBytes + 64))));

    for (let start = 0; start < user_ids.length; start += batchSize) {
      const batch = user_ids.slice(start, start + batchSize);
      const values = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
      const params = [];
      batch.forEach(userId => {
        params.push(userId, notificationType, title, notificationContent, notificationRelatedId, notificationRelatedType);
      });
      await pool.execute(
        `INSERT INTO notifications (user_id, type, title, content, related_id, related_type) VALUES ${values}`,
        params
      );
    }

    res.json({ code: 200, message: `成功发送${user_ids.length}条通知` });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/notifications/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM notifications WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/notifications', requirePermission('notices:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM notifications');
    res.json({ code: 200, message: '已清空所有通知' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});


module.exports = router;
