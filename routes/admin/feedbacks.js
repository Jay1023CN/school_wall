const express = require('express');
const { pool, ensureFeedbackTable } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');
const { applyPointDelta } = require('../../services/gamification');
const { rollbackOrDiscard, releaseConnection } = require('../../services/database-transaction');
const { getErrorDetail } = require('../../services/async-utils');
const { notifyFeedbackReply } = require('../../services/email');

const router = express.Router();
router.get('/init-feedback-table', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    await ensureFeedbackTable(pool);
    res.json({ code: 200, message: '反馈表创建成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/feedbacks', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { status } = req.query;

    let whereClause = '1=1';
    const params = [];
    if (status) {
      whereClause += ' AND f.status = ?';
      params.push(status);
    }

    const [feedbacks] = await pool.execute(`
      SELECT f.*, u.username, u.nickname
      FROM feedbacks f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE ${whereClause}
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute(`SELECT COUNT(*) as total FROM feedbacks f WHERE ${whereClause}`, params);

    res.json({
      code: 200,
      data: {
        feedbacks,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/feedbacks/:id', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    const [feedbacks] = await pool.execute(`
      SELECT f.*, u.username, u.nickname
      FROM feedbacks f
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.id = ?
    `, [req.params.id]);

    if (feedbacks.length === 0) {
      return res.json({ code: 404, message: '反馈不存在' });
    }

    res.json({ code: 200, data: feedbacks[0] });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/feedbacks/:id/reply', requirePermission('feedbacks:manage'), async (req, res) => {
  const reply = typeof req.body.reply === 'string' ? req.body.reply.trim() : '';
  const status = typeof req.body.status === 'string' ? req.body.status : 'resolved';
  const allowedStatuses = new Set(['pending', 'processing', 'resolved', 'closed', 'accepted']);
  if (!allowedStatuses.has(status)) {
    return res.json({ code: 400, message: '反馈状态无效' });
  }

  let connection;
  try {
    await ensureFeedbackTable(pool);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT id, user_id, reward_points_awarded FROM feedbacks WHERE id = ? FOR UPDATE',
      [req.params.id]
    );
    if (rows.length === 0) {
      if (!await rollbackOrDiscard(connection, new Error('feedback does not exist'))) {
        throw new Error('事务回滚失败');
      }
      return res.json({ code: 404, message: '反馈不存在' });
    }

    let rewardGranted = false;
    if (status === 'accepted' && !Number(rows[0].reward_points_awarded) && rows[0].user_id) {
      await applyPointDelta(connection, {
        userId: rows[0].user_id,
        delta: 20,
        reason: 'feedback_reward',
        relatedId: rows[0].id
      });
      await connection.execute('UPDATE feedbacks SET reward_points_awarded = 1 WHERE id = ?', [rows[0].id]);
      rewardGranted = true;
    }
    await connection.execute(
      'UPDATE feedbacks SET reply = ?, status = ? WHERE id = ?',
      [reply, status, rows[0].id]
    );
    await connection.commit();

    setImmediate(async () => {
      try {
        const [feedbacks] = await pool.execute(`
          SELECT f.*, u.email, u.nickname, u.username
          FROM feedbacks f
          LEFT JOIN users u ON f.user_id = u.id
          WHERE f.id = ?
        `, [req.params.id]);

        if (feedbacks.length > 0 && feedbacks[0].email) {
          const feedback = feedbacks[0];
          const userNickname = feedback.nickname || feedback.username || '用户';
                    await notifyFeedbackReply(
            feedback.email,
            userNickname,
            feedback.title,
            reply || (rewardGranted ? '感谢你的有效反馈，已奖励 20 积分。' : '管理员已处理您的反馈'),
            feedback.user_id
          );
        }
      } catch (err) {
        console.error('[Email] 发送反馈回复通知失败:', getErrorDetail(err));
      }
    });

    res.json({ code: 200, message: rewardGranted ? '回复已保存，已奖励用户 20 积分' : '回复成功', data: { rewardGranted } });
  } catch (err) {
    if (connection) {
      await rollbackOrDiscard(connection, err);
    }
    res.json({ code: 500, message: '服务器错误' });
  } finally {
    if (connection) releaseConnection(connection);
  }
});

router.delete('/feedbacks/:id', requirePermission('feedbacks:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM feedbacks WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});



module.exports = router;
