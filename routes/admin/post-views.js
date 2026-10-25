const express = require('express');
const { pool } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');
const { getErrorDetail } = require('../../services/async-utils');

const router = express.Router();
router.get('/post-views', requirePermission('post-views:view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { post_id, keyword } = req.query;

    let whereClause = '1=1';
    const params = [];

    if (post_id) {
      whereClause += ' AND pv.post_id = ?';
      params.push(parseInt(post_id));
    }

    if (keyword) {
      whereClause += ' AND (p.title LIKE ? OR p.content LIKE ?)';
      params.push('%' + keyword.trim() + '%', '%' + keyword.trim() + '%');
    }

    const [records] = await pool.execute(`
      SELECT pv.id, pv.post_id, pv.user_id, pv.viewer_ip, pv.ip_region, pv.viewer_nickname, pv.viewed_at,
             p.title as post_title, p.content as post_content,
             u.email as user_email
      FROM post_views pv
      LEFT JOIN posts p ON pv.post_id = p.id
      LEFT JOIN users u ON pv.user_id = u.id
      WHERE ${whereClause}
      ORDER BY pv.viewed_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    const [countResult] = await pool.execute(`
      SELECT COUNT(*) as total FROM post_views pv
      LEFT JOIN posts p ON pv.post_id = p.id
      WHERE ${whereClause}
    `, params);

    res.json({
      code: 200,
      data: {
        records: records,
        total: countResult[0].total,
        page: parseInt(page),
        totalPages: Math.ceil(countResult[0].total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('获取浏览记录错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/post-views/old', requirePermission('post-views:view'), async (req, res) => {
  try {
    const days = String(req.query.days || '');
    if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 36500) {
      return res.json({ code: 400, message: '请输入 1 到 36500 之间的天数' });
    }
    const daysNum = Number(days);
    const [result] = await pool.execute(
      'DELETE FROM post_views WHERE viewed_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [daysNum]
    );
    res.json({ code: 200, message: '清空成功', data: { deleted: result.affectedRows } });
  } catch (err) {
    console.error('清空浏览记录错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});



router.delete('/post-views/all', requirePermission('post-views:view'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM post_views');
    res.json({ code: 200, message: '已清空所有浏览记录', data: { deleted: result.affectedRows } });
  } catch (err) {
    console.error('清空浏览记录错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});


module.exports = router;
