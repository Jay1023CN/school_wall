const express = require('express');
const { createIntervalTask } = require('../../services/task-lifecycle');
const { pool } = require('../../config/database');
const { auth, optionalAuth } = require('../../middleware/auth');
const { getIpRegion, getClientIp } = require('../../services/ip-lookup');
const { notifyNewLike } = require('../../services/email');
const { createNotification } = require('../../services/notification');
const { getPagination } = require('../../services/pagination');
const { adjustUserPoints } = require('../../services/gamification');
const { runBackgroundTask } = require('../../services/async-utils');

const router = express.Router();

const likeDebounce = new Map();
const MAX_DEBOUNCE_ENTRIES = 5000;
const likeDebounceCleanupTask = createIntervalTask(function() {
  if (likeDebounce.size > MAX_DEBOUNCE_ENTRIES) {
    const keys = [...likeDebounce.keys()].slice(0, likeDebounce.size - MAX_DEBOUNCE_ENTRIES);
    keys.forEach(k => likeDebounce.delete(k));
  } else {
    likeDebounce.clear();
  }
}, 5000);

router.post('/:id/like', auth, async (req, res) => {
  const key = req.user.id + ':' + req.params.id;
  var now = Date.now();
  if (likeDebounce.has(key) && now - likeDebounce.get(key) < 1000) {
    return res.json({ code: 200, message: 'ok', data: {} });
  }
  likeDebounce.set(key, now);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const postId = req.params.id;

    const [targetPosts] = await connection.execute(
      'SELECT id FROM posts WHERE id = ? AND status = "approved" AND is_deleted = 0 FOR UPDATE',
      [postId]
    );
    if (targetPosts.length === 0) {
      await connection.rollback();
      return res.json({ code: 404, message: '帖子不存在' });
    }

    const [existing] = await connection.execute(
      'SELECT id FROM likes WHERE user_id = ? AND post_id = ? FOR UPDATE',
      [req.user.id, postId]
    );

    if (existing.length > 0) {
      await connection.execute('DELETE FROM likes WHERE user_id = ? AND post_id = ?', [req.user.id, postId]);
      await connection.execute('UPDATE posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = ?', [postId]);

      await connection.commit();

      const [updated] = await connection.execute('SELECT likes_count FROM posts WHERE id = ?', [postId]);

      res.json({
        code: 200,
        message: '取消点赞',
        data: {
          liked: false,
          likes_count: updated[0]?.likes_count || 0
        }
      });
    } else {
      try {
        await connection.execute('INSERT INTO likes (user_id, post_id) VALUES (?, ?)', [req.user.id, postId]);
      } catch (insertErr) {
        if (insertErr.code === 'ER_DUP_ENTRY') {
          await connection.rollback();
          return res.json({ code: 500, message: '操作失败，请稍后重试' });
        }
        throw insertErr;
      }

      await connection.execute('UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?', [postId]);

      await connection.commit();

      const [updated] = await connection.execute('SELECT likes_count FROM posts WHERE id = ?', [postId]);

      runBackgroundTask('点赞积分发放失败', async () => {
        const [authors] = await pool.execute('SELECT p.user_id FROM posts p WHERE p.id = ?', [postId]);
        if (authors.length > 0 && authors[0].user_id !== req.user.id) {
          await adjustUserPoints(
            authors[0].user_id,
            1,
            'like',
            { relatedId: postId, includeLogs: false }
          );
        }
      });

      setImmediate(async () => {
        try {
          const [posts] = await pool.execute('SELECT p.user_id, p.title, u.email, u.nickname, u.username FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ?', [postId]);
          const [users] = await pool.execute('SELECT nickname, username FROM users WHERE id = ?', [req.user.id]);
          if (posts.length > 0 && users.length > 0 && posts[0].user_id !== req.user.id) {
            const liker = users[0];
            const likerName = liker.nickname || liker.username || '某用户';
            await createNotification(
              posts[0].user_id,
              'like',
              '收到点赞',
              likerName + ' 点赞了你的帖子: ' + (posts[0].title || '无标题').substring(0, 30),
              postId,
              'post'
            );
            if (posts[0].email) {
              await notifyNewLike(
                posts[0].email,
                posts[0].nickname || posts[0].username || '用户',
                likerName,
                posts[0].title || '无标题',
                posts[0].user_id
              );
            }
          }
        } catch (err) {
          console.error('发送点赞通知失败:', err.message);
        }
      });

      res.json({
        code: 200,
        message: '点赞成功',
        data: {
          liked: true,
          likes_count: updated[0]?.likes_count || 0
        }
      });
    }
  } catch (err) {
    await connection.rollback();
    console.error('点赞错误:', err.message);
    console.error('点赞错误堆栈:', err.stack);
    res.json({ code: 500, message: '服务器错误' });
  } finally {
    connection.release();
  }
});

router.post('/:id/favorite', auth, async (req, res) => {
  try {
    const postId = req.params.id;
    const [targetPosts] = await pool.execute(
      'SELECT id FROM posts WHERE id = ? AND status = "approved" AND is_deleted = 0',
      [postId]
    );
    if (targetPosts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }
    const [existing] = await pool.execute('SELECT id FROM favorites WHERE user_id = ? AND post_id = ?', [req.user.id, postId]);

    if (existing.length > 0) {
      await pool.execute('DELETE FROM favorites WHERE user_id = ? AND post_id = ?', [req.user.id, postId]);
      res.json({ code: 200, message: '取消收藏', data: { favorited: false } });
    } else {
      await pool.execute('INSERT INTO favorites (user_id, post_id) VALUES (?, ?)', [req.user.id, postId]);
      res.json({ code: 200, message: '收藏成功', data: { favorited: true } });
    }
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/:id/vote', auth, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    var postId = req.params.id;
    var userId = req.user.id;
    var { option_id } = req.body;

    if (!option_id) return res.json({ code: 400, message: '请选择投票选项' });

    await connection.beginTransaction();
    var [posts] = await connection.execute('SELECT id, poll_type, poll_expires_at, user_id FROM posts WHERE id = ? AND status = "approved" AND is_deleted = 0 FOR UPDATE', [postId]);
    if (posts.length === 0) {
      await connection.rollback();
      return res.json({ code: 404, message: '帖子不存在' });
    }
    var post = posts[0];
    if (!post.poll_type) {
      await connection.rollback();
      return res.json({ code: 400, message: '此帖不是投票帖' });
    }

    if (post.poll_expires_at && new Date(post.poll_expires_at) < new Date()) {
      await connection.rollback();
      return res.json({ code: 400, message: '投票已结束' });
    }

    var [options] = await connection.execute('SELECT id FROM poll_options WHERE id = ? AND post_id = ?', [option_id, postId]);
    if (options.length === 0) {
      await connection.rollback();
      return res.json({ code: 400, message: '投票选项不存在' });
    }

    if (post.poll_type === 'single') {
      var [existing] = await connection.execute('SELECT id FROM poll_votes WHERE option_id IN (SELECT id FROM poll_options WHERE post_id = ?) AND user_id = ? FOR UPDATE', [postId, userId]);
      if (existing.length > 0) {
        await connection.rollback();
        return res.json({ code: 400, message: '你已经投过票了' });
      }
    } else if (post.poll_type === 'multiple') {
      var [existing] = await connection.execute('SELECT id FROM poll_votes WHERE option_id = ? AND user_id = ? FOR UPDATE', [option_id, userId]);
      if (existing.length > 0) {
        await connection.rollback();
        return res.json({ code: 400, message: '你已经投过该选项了' });
      }
    } else {
      await connection.rollback();
      return res.json({ code: 400, message: '不支持的投票类型' });
    }

    await connection.execute('INSERT INTO poll_votes (option_id, user_id) VALUES (?, ?)', [option_id, userId]);
    await connection.execute('UPDATE poll_options SET votes_count = votes_count + 1 WHERE id = ?', [option_id]);
    await connection.commit();

    return res.json({ code: 200, message: '投票成功', data: { hasVoted: true } });

  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    if (err.code === 'ER_DUP_ENTRY') return res.json({ code: 400, message: '你已经投过票了' });
    console.error('投票错误:', err);
    res.json({ code: 500, message: '投票失败' });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/:id/poll', optionalAuth, async (req, res) => {
  try {
    var postId = req.params.id;
    var [posts] = await pool.execute('SELECT id FROM posts WHERE id = ? AND status = "approved" AND is_deleted = 0', [postId]);
    if (posts.length === 0) return res.json({ code: 404, message: '帖子不存在' });
    var [options] = await pool.execute('SELECT * FROM poll_options WHERE post_id = ? ORDER BY id', [postId]);
    if (options.length === 0) return res.json({ code: 404, message: '此帖无投票' });

    var totalVotes = options.reduce(function(sum, o) { return sum + o.votes_count; }, 0);
    var userVote = null;
    if (req.user) {
      var [votes] = await pool.execute(
        'SELECT option_id FROM poll_votes v JOIN poll_options o ON v.option_id = o.id WHERE o.post_id = ? AND v.user_id = ? LIMIT 1',
        [postId, req.user.id]
      );
      if (votes.length > 0) userVote = votes[0].option_id;
    }

    res.json({ code: 200, data: { options: options, totalVotes: totalVotes, userVote: userVote } });
  } catch (err) {
    res.json({ code: 500, message: '获取投票失败' });
  }
});

router.post('/:id/view', optionalAuth, async (req, res) => {
  try {
    const viewerIp = getClientIp(req);
    const viewerNickname = req.user ? (req.user.nickname || req.user.username) : null;
    const userId = req.user ? req.user.id : null;
    const postId = req.params.id;

    const [targetPosts] = await pool.execute(
      'SELECT id FROM posts WHERE id = ? AND status = "approved" AND is_deleted = 0',
      [postId]
    );
    if (targetPosts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }

    let hasRecentView = false;
    if (userId) {
      const [recent] = await pool.execute(
        'SELECT id FROM post_views WHERE post_id = ? AND user_id = ? AND viewed_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE) LIMIT 1',
        [postId, userId]
      );
      hasRecentView = recent.length > 0;
    } else {
      const [recent] = await pool.execute(
        'SELECT id FROM post_views WHERE post_id = ? AND viewer_ip = ? AND viewed_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE) LIMIT 1',
        [postId, viewerIp]
      );
      hasRecentView = recent.length > 0;
    }

    if (hasRecentView) {
      return res.json({ code: 200, message: 'duplicate' });
    }

    setImmediate(async () => {
      let connection;
      try {
        const ipRegion = await getIpRegion(viewerIp);
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [lockedPosts] = await connection.execute(
          'SELECT id FROM posts WHERE id = ? AND status = "approved" AND is_deleted = 0 FOR UPDATE',
          [postId]
        );
        if (lockedPosts.length === 0) {
          await connection.rollback();
          return;
        }

        const [recent] = userId
          ? await connection.execute(
              'SELECT id FROM post_views WHERE post_id = ? AND user_id = ? AND viewed_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE) LIMIT 1',
              [postId, userId]
            )
          : await connection.execute(
              'SELECT id FROM post_views WHERE post_id = ? AND viewer_ip = ? AND viewed_at > DATE_SUB(NOW(), INTERVAL 1 MINUTE) LIMIT 1',
              [postId, viewerIp]
            );
        if (recent.length > 0) {
          await connection.rollback();
          return;
        }

        await connection.execute(
          'INSERT INTO post_views (post_id, user_id, viewer_ip, ip_region, viewer_nickname) VALUES (?, ?, ?, ?, ?)',
          [postId, userId, viewerIp, ipRegion, viewerNickname]
        );
        await connection.execute(
          'UPDATE posts SET view_count = view_count + 1, views = views + 1 WHERE id = ?',
          [postId]
        );
        await connection.commit();
      } catch (err) {
        if (connection) {
          try { await connection.rollback(); } catch (_) {}
        }
        console.error('增加浏览次数失败:', err.message);
      } finally {
        if (connection) connection.release();
      }
    });

    res.json({ code: 200, message: 'ok' });
  } catch (err) {
    console.error('增加浏览量错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/:id/views', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.json({ code: 403, message: '无权限访问' });
    }

    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 50, maxLimit: 100 });

    const [records] = await pool.execute(`
      SELECT pv.id, pv.post_id, pv.user_id, pv.viewer_ip, pv.viewer_nickname, pv.viewed_at,
             p.title as post_title, p.content as post_content
      FROM post_views pv
      LEFT JOIN posts p ON pv.post_id = p.id
      WHERE pv.post_id = ?
      ORDER BY pv.viewed_at DESC
      LIMIT ? OFFSET ?
      `, [req.params.id, limit, offset]);

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM post_views WHERE post_id = ?', [req.params.id]);

    res.json({
      code: 200,
      data: {
        records: records,
        total: countResult[0].total,
        page,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取浏览记录错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.startLikeDebounceCleanup = likeDebounceCleanupTask.start;

module.exports = router;
