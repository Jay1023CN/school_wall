const express = require('express');
const { pool } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { pushPost } = require('../../services/baidu-push');
const { notifyPostApproved, notifyPostRejected } = require('../../services/email');
const { getPagination } = require('../../services/pagination');
const { getErrorDetail } = require('../../services/async-utils');

const router = express.Router();
router.get('/posts', requirePermission('posts:review'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { status } = req.query;
    const rawKeyword = req.query.keyword;
    if (rawKeyword != null && (typeof rawKeyword !== 'string' || rawKeyword.length > 100)) {
      return res.status(400).json({ code: 400, message: '搜索内容不能超过100个字符' });
    }
    const keyword = (rawKeyword || '').trim();

    let whereClause = 'p.is_deleted = 0';
    const params = [];
    if (status) {
      whereClause += ' AND p.status = ?';
      params.push(status);
    }

    if (keyword) {
      const exactId = /^\d+$/.test(keyword) && Number.isSafeInteger(Number(keyword)) && Number(keyword) > 0;
      whereClause += ' AND (p.title LIKE ? OR u.nickname LIKE ? OR u.username LIKE ?' + (exactId ? ' OR p.id = ?)' : ')');
      const pattern = '%' + keyword + '%';
      params.push(pattern, pattern, pattern);
      if (exactId) params.push(Number(keyword));
    }

    const [[posts], [countResult]] = await Promise.all([
      pool.execute(`
      SELECT p.id, p.title, p.category, p.status, p.created_at, p.ip_region, p.is_pinned, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]),
      pool.execute(`SELECT COUNT(*) as total FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE ${whereClause}`, params)
    ]);

    res.json({
      code: 200,
      data: {
        posts: posts.map(p => ({ ...p, images: p.images ? JSON.parse(p.images) : [] })),
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/posts/:id/status', requirePermission('posts:review'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.json({ code: 400, message: '无效状态' });
    }
    const [updated] = await pool.execute(
      'UPDATE posts SET status = ? WHERE id = ? AND is_deleted = 0',
      [status, req.params.id]
    );
    if (!updated.affectedRows) {
      return res.json({ code: 404, message: '帖子不存在或已在回收站' });
    }

    setImmediate(async () => {
      try {
        const [posts] = await pool.execute('SELECT p.user_id, p.title, u.email, u.nickname, u.username FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ? AND p.is_deleted = 0', [req.params.id]);
        if (posts.length > 0 && posts[0].email) {
          const user = posts[0];
          if (status === 'approved') {
            await notifyPostApproved(user.email, user.nickname || user.username || '用户', user.title || '无标题', user.user_id);
          } else {
            await notifyPostRejected(user.email, user.nickname || user.username || '用户', user.title || '无标题', '', user.user_id);
          }
        }
      } catch (err) {
        console.error('[Email] 发送帖子审核通知失败:', getErrorDetail(err));
      }
    });

    if (status === 'approved') setImmediate(function() { pushPost(req.params.id); });

    res.json({ code: 200, message: '操作成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/posts/batch-status', requirePermission('posts:review'), async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !['approved', 'rejected'].includes(status)) {
      return res.json({ code: 400, message: '无效参数' });
    }
    const placeholders = ids.map(() => '?').join(',');
    await pool.execute(`UPDATE posts SET status = ? WHERE id IN (${placeholders}) AND is_deleted = 0`, [status, ...ids]);
    if (status === 'approved') setImmediate(function() {
      ids.forEach(id => pushPost(id));
    });
    res.json({ code: 200, message: `已批量${status === 'approved' ? '通过' : '拒绝'} ${ids.length} 条` });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/posts/:id', requirePermission('posts:review'), async (req, res) => {
  try {
    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.is_deleted = 0
    `, [req.params.id]);

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }

    const post = posts[0];
    post.images = post.images ? JSON.parse(post.images) : [];

    res.json({ code: 200, data: post });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/init-trash-column', requirePermission('admin:manage'), async (req, res) => {
  try {
    const [columns] = await pool.query('SHOW COLUMNS FROM posts WHERE Field IN (?, ?)', ['is_deleted', 'deleted_at']);
    const names = columns.map(column => column.Field);
    res.json({
      code: names.includes('is_deleted') && names.includes('deleted_at') ? 200 : 503,
      message: names.includes('is_deleted') && names.includes('deleted_at')
        ? '回收站字段已就绪'
        : '回收站字段尚未完成初始化，请重启服务执行数据库迁移'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/trash/posts', requirePermission('posts:delete'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });

    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.is_deleted = 1
      ORDER BY p.deleted_at DESC
      LIMIT ? OFFSET ?
    `, [parseInt(limit), offset]);

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE is_deleted = 1');

    res.json({
      code: 200,
      data: {
        posts: posts.map(p => ({ ...p, images: p.images ? JSON.parse(p.images) : [] })),
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/trash/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  try {
    const [posts] = await pool.execute(`
      SELECT p.*, u.username, u.nickname
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.is_deleted = 1
    `, [req.params.id]);

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在或已彻底删除' });
    }

    res.json({ code: 200, data: { ...posts[0], images: posts[0].images ? JSON.parse(posts[0].images) : [] } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/trash/posts/:id/restore', requirePermission('posts:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('UPDATE posts SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND is_deleted = 1', [req.params.id]);
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '恢复成功' : '帖子不在回收站或已被删除'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/trash/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM posts WHERE id = ? AND is_deleted = 1', [req.params.id]);
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '彻底删除成功' : '帖子不在回收站或已被删除'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/trash/posts', requirePermission('admin:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM posts WHERE is_deleted = 1');
    res.json({ code: 200, message: '清空成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/posts/:id', requirePermission('posts:delete'), async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (isNaN(postId)) {
      return res.json({ code: 400, message: '无效的帖子ID' });
    }

    const [posts] = await pool.execute('SELECT id, is_deleted FROM posts WHERE id = ?', [postId]);
    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }
    if (posts[0].is_deleted) {
      return res.json({ code: 404, message: '帖子已在回收站，请从回收站处理' });
    }

    try {
      const [result] = await pool.execute('UPDATE posts SET is_deleted = 1, deleted_at = NOW() WHERE id = ? AND is_deleted = 0', [postId]);
      if (!result.affectedRows) {
        return res.json({ code: 404, message: '帖子已被其他操作移入回收站' });
      }
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        await pool.execute('DELETE FROM posts WHERE id = ?', [postId]);
      } else {
        throw err;
      }
    }

    res.json({ code: 200, message: '已移入回收站' });
  } catch (err) {
    console.error('删除帖子错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/posts/:id/pin', requirePermission('posts:review'), async (req, res) => {
  try {
    const [post] = await pool.execute('SELECT id, is_pinned FROM posts WHERE id = ? AND is_deleted = 0', [req.params.id]);
    if (post.length === 0) return res.json({ code: 404, message: '帖子不存在' });
    const newPinned = post[0].is_pinned ? 0 : 1;
    await pool.execute('UPDATE posts SET is_pinned = ? WHERE id = ? AND is_deleted = 0', [newPinned, req.params.id]);
    res.json({ code: 200, message: newPinned ? '已置顶' : '已取消置顶', data: { is_pinned: newPinned } });
  } catch (err) {
    console.error('置顶操作错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});



module.exports = router;
