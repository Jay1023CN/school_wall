const express = require('express');
const { pool } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');

const router = express.Router();
router.get('/logs', requirePermission('logs:view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });

    const [logs] = await pool.execute(
      `SELECT al.*, u.username, u.nickname
       FROM admin_logs al
       LEFT JOIN users u ON al.admin_id = u.id
       ORDER BY al.id DESC LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM admin_logs');

    res.json({
      code: 200,
      data: {
        logs,
        total: countResult[0].total,
        page: parseInt(page),
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/logs', async (req, res) => {
  try {
    const { action, detail, level = 'info' } = req.body || {};
    if (typeof action !== 'string' || !action.trim() || action.length > 80 ||
      (detail !== undefined && detail !== null && (typeof detail !== 'string' || detail.length > 1000))) {
      return res.status(400).json({ code: 400, message: '日志内容格式不正确' });
    }
    const normalizedLevel = level === 'warn' ? 'warning' : (['info', 'warning', 'error'].includes(level) ? level : 'info');
    await pool.execute(
      'INSERT INTO admin_logs (admin_id, action, detail, level) VALUES (?, ?, ?, ?)',
      [req.user.id, action, detail, normalizedLevel]
    );
    res.json({ code: 200, message: '记录成功' });
  } catch (err) {
    console.error('[Admin] 记录日志失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/logs/all', requirePermission('logs:view'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM admin_logs');
    res.json({ code: 200, message: '已清空所有日志', data: { deleted: result.affectedRows } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/logs/old', requirePermission('logs:view'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const daysNum = parseInt(days) || 30;
    const [result] = await pool.execute(
      'DELETE FROM admin_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [daysNum]
    );
    res.json({ code: 200, message: `已删除 ${daysNum} 天前的日志`, data: { deleted: result.affectedRows } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/logs/:id', requirePermission('logs:view'), async (req, res) => {
  try {
    const logId = parseInt(req.params.id);
    if (isNaN(logId)) {
      return res.json({ code: 400, message: '无效的日志ID' });
    }
    const [result] = await pool.execute('DELETE FROM admin_logs WHERE id = ?', [logId]);
    if (result.affectedRows === 0) {
      return res.json({ code: 404, message: '日志不存在' });
    }
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});



module.exports = router;
