const express = require('express');
const { pool } = require('../../config/database');
const { auth, optionalAuth } = require('../../middleware/auth');
const { getIpRegion, getClientIp } = require('../../services/ip-lookup');
const { notifyNewComment, notifyMention } = require('../../services/email');
const { createNotification } = require('../../services/notification');
const { adjustUserPoints } = require('../../services/gamification');
const { runBackgroundTask } = require('../../services/async-utils');
const { runWriteTransaction } = require('../../services/write-transaction');
const { anonymousEnabled, canViewIpRegion, getTimeAgo, wantsAnonymous } = require('./shared');

const router = express.Router();

router.post('/:id/comments', auth, async (req, res) => {
  try {
    const { content, is_anonymous, client_ip, mentioned_users } = req.body;
    if (!content || content.trim() === '') {
      return res.json({ code: 400, message: '请输入评论内容' });
    }
    if (content.length > 500) {
      return res.json({ code: 400, message: '评论不能超过500字' });
    }

    const finalIsAnonymous = wantsAnonymous(is_anonymous) ? 1 : 0;

    var clientIp = getClientIp(req);

    var mentionedUsersJson = null;
    if (mentioned_users && Array.isArray(mentioned_users) && mentioned_users.length > 0) {
      mentionedUsersJson = JSON.stringify(mentioned_users);
    }

    let commentId;
    const writeResult = await runWriteTransaction(pool, req, 'posts.comment.create', async connection => {
      const [targetPosts] = await connection.execute(
        'SELECT id FROM posts WHERE id = ? AND status = "approved" AND is_deleted = 0 FOR UPDATE',
        [req.params.id]
      );
      if (targetPosts.length === 0) {
        return { status: 404, body: { code: 404, message: '帖子不存在或已不可评论' } };
      }
      if (finalIsAnonymous && !(await anonymousEnabled('anon_comment', connection))) {
        return { status: 400, body: { code: 400, message: '匿名评论已关闭，请取消匿名后再提交' } };
      }

      const [result] = await connection.execute(
        'INSERT INTO comments (post_id, user_id, content, is_anonymous, ip_address, mentioned_users) VALUES (?, ?, ?, ?, ?, ?)',
        [req.params.id, req.user.id, content.trim(), finalIsAnonymous, clientIp, mentionedUsersJson]
      );
      commentId = result.insertId;
      await connection.execute('UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?', [req.params.id]);
      return { status: 200, body: { code: 200, message: '评论成功' } };
    });
    if (writeResult.status >= 400 || Number(writeResult.body.code) >= 400) {
      return res.status(writeResult.status).json(writeResult.body);
    }

    if (!writeResult.replayed) {
      getIpRegion(clientIp).then(region => {
        pool.execute('UPDATE comments SET ip_region = ? WHERE id = ?', [region, commentId]).catch(() => {});
      });

    setImmediate(async () => {
      try {
        const [posts] = await pool.execute('SELECT p.user_id, p.title, u.email, u.nickname, u.username FROM posts p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ? AND p.status = "approved" AND p.is_deleted = 0', [req.params.id]);
        const [commenters] = await pool.execute('SELECT nickname, username FROM users WHERE id = ?', [req.user.id]);

        if (posts.length > 0) {
          const commenter = commenters[0] || {};
          const isOwnPost = String(posts[0].user_id) === String(req.user.id);
          if (!isOwnPost) {
            await createNotification(
              posts[0].user_id,
              'comment',
              '收到新评论',
              commenter.nickname || commenter.username + ' 评论了你的帖子: ' + content.trim().substring(0, 50),
              req.params.id,
              'post'
            );

            if (posts[0].email) {
              await notifyNewComment(
                posts[0].email,
                posts[0].nickname || posts[0].username || '用户',
                commenter.nickname || commenter.username || '某用户',
                posts[0].title || '无标题',
                finalIsAnonymous ? '（匿名评论）' : content.trim().substring(0, 100),
                posts[0].user_id
              );
            }
          }
        }
      } catch (err) {
        console.error('[Email] 发送评论通知失败:', err.message);
      }
    });

    if (mentioned_users && Array.isArray(mentioned_users) && mentioned_users.length > 0) {
      setImmediate(async () => {
        try {
          const [posts] = await pool.execute('SELECT p.title FROM posts p WHERE p.id = ? AND p.status = "approved" AND p.is_deleted = 0', [req.params.id]);
          const [commenter] = await pool.execute('SELECT nickname, username FROM users WHERE id = ?', [req.user.id]);
          const postTitle = posts[0] ? (posts[0].title || '无标题') : '无标题';
          const commenterName = finalIsAnonymous
            ? '匿名同学'
            : (commenter[0] ? (commenter[0].nickname || commenter[0].username) : '某用户');
          const visibleContent = finalIsAnonymous ? '（匿名评论）' : content.trim().substring(0, 100);

          const placeholders = mentioned_users.map(() => '?').join(',');
          const [mentionedUsers] = await pool.execute(
            `SELECT id, nickname, username, email FROM users WHERE id IN (${placeholders}) AND id != ?`,
            [...mentioned_users, req.user.id]
          );

          for (const mu of mentionedUsers) {
            await createNotification(
              mu.id,
              'mention',
              '有人提到了你',
              commenterName + ' 在评论中提到了你: ' + visibleContent,
              req.params.id,
              'post'
            );
            if (mu.email) {
              await notifyMention(mu.email, mu.nickname || mu.username, commenterName, postTitle, visibleContent, req.params.id, mu.id);
            }
          }
        } catch (err) {
          console.error('[Email] 发送@提及通知失败:', err.message);
        }
      });
    }

    runBackgroundTask('评论积分发放失败', () => adjustUserPoints(
              req.user.id,
      1,
      'comment',
      { relatedId: commentId, includeLogs: false }
    ));
    }

    res.status(writeResult.status).json(writeResult.body);
  } catch (err) {
    console.error('评论错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/:postId/comments/:commentId', auth, async (req, res) => {
  try {
    const writeResult = await runWriteTransaction(pool, req, 'posts.comment.delete', async connection => {
      const [posts] = await connection.execute(
        'SELECT id, user_id FROM posts WHERE id = ? AND status = "approved" AND is_deleted = 0 FOR UPDATE',
        [req.params.postId]
      );
      if (posts.length === 0) {
        return { status: 404, body: { code: 404, message: '评论不存在' } };
      }
      const [comments] = await connection.execute(
        'SELECT id, user_id FROM comments WHERE id = ? AND post_id = ? FOR UPDATE',
        [req.params.commentId, req.params.postId]
      );
      if (comments.length === 0) {
        return { status: 404, body: { code: 404, message: '评论不存在' } };
      }

      const comment = comments[0];
      const isCommentAuthor = String(comment.user_id) === String(req.user.id);
      const isPostAuthor = String(posts[0].user_id) === String(req.user.id);
      if (!isCommentAuthor && !isPostAuthor && !isStaffRole(req.user.role)) {
        return { status: 403, body: { code: 403, message: '无权删除此评论' } };
      }

      const [deleted] = await connection.execute(
        'DELETE FROM comments WHERE id = ? AND post_id = ?',
        [req.params.commentId, req.params.postId]
      );
      if (!deleted.affectedRows) {
        return { status: 404, body: { code: 404, message: '评论不存在' } };
      }
      await connection.execute(
        'UPDATE posts SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = ?',
        [req.params.postId]
      );
      return { status: 200, body: { code: 200, message: '删除成功' } };
    });
    res.status(writeResult.status).json(writeResult.body);
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/comments/:commentId/like', auth, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const commentId = req.params.commentId;
    const userId = req.user.id;

    await connection.beginTransaction();
    const [comments] = await connection.execute(
      `SELECT c.id, c.post_id
       FROM comments c
       JOIN posts p ON p.id = c.post_id
       WHERE c.id = ? AND p.status = "approved" AND p.is_deleted = 0
       FOR UPDATE`,
      [commentId]
    );
    if (comments.length === 0) {
      await connection.rollback();
      return res.json({ code: 404, message: '评论不存在' });
    }

    const [existing] = await connection.execute(
      'SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ? FOR UPDATE',
      [commentId, userId]
    );

    let liked = false;
    if (existing.length > 0) {
      await connection.execute('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?', [commentId, userId]);
      await connection.execute('UPDATE comments SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = ?', [commentId]);
    } else {
      await connection.execute('INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)', [commentId, userId]);
      await connection.execute('UPDATE comments SET likes_count = likes_count + 1 WHERE id = ?', [commentId]);
      liked = true;
    }

    const [updated] = await connection.execute('SELECT likes_count FROM comments WHERE id = ?', [commentId]);
    const likesCount = updated[0]?.likes_count || 0;

    await connection.commit();

    res.json({ code: 200, data: { liked, likes_count: likesCount } });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('评论点赞错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/:postId/comments/:commentId/replies', optionalAuth, async (req, res) => {
  try {
    const { commentId } = req.params;
    const { sort = 'latest' } = req.query;

    let orderBy = 'created_at DESC';
    if (sort === 'hot') {
      orderBy = 'likes_count DESC, created_at DESC';
    }
    if (!['created_at DESC', 'likes_count DESC, created_at DESC'].includes(orderBy)) {
      orderBy = 'created_at DESC';
    }

    const [replies] = await pool.execute(
      `SELECT r.*, u.nickname, u.username, u.avatar, u.role as author_role
       FROM comment_replies r
       JOIN comments c ON c.id = r.comment_id
       JOIN posts p ON p.id = c.post_id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.comment_id = ? AND c.post_id = ? AND p.status = "approved" AND p.is_deleted = 0
       ORDER BY ${orderBy}`,
      [commentId, req.params.postId]
    );

    const formattedReplies = replies.map(function(reply) {
      const isReplyOwner = !!(req.user && req.user.id === reply.user_id);
      return {
        id: reply.id,
        content: reply.content,
        is_anonymous: reply.is_anonymous,
        author_name: reply.is_anonymous ? '匿名用户' : (reply.nickname || reply.username || '用户'),
        author_avatar: reply.is_anonymous ? '/uploads/avatars/default.png' : (reply.avatar || '/uploads/avatars/default.png'),
        author_id: reply.is_anonymous && !isReplyOwner ? null : reply.user_id,
        author_role: reply.is_anonymous ? null : reply.author_role,
        can_delete: !!(req.user && (isReplyOwner || isStaffRole(req.user.role))),
        time_ago: getTimeAgo(reply.created_at),
        ip_region: canViewIpRegion(req, reply.user_id) ? reply.ip_region : null,
        likes_count: reply.likes_count || 0,
        created_at: reply.created_at
      };
    });

    res.json({ code: 200, data: { replies: formattedReplies, total: replies.length } });
  } catch (err) {
    console.error('获取回复列表错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/:postId/comments/:commentId/replies', auth, async (req, res) => {
  try {
    const { commentId, postId } = req.params;
    const { content, is_anonymous, client_ip } = req.body;

    if (!content || content.trim() === '') {
      return res.json({ code: 400, message: '请输入回复内容' });
    }
    if (content.length > 500) {
      return res.json({ code: 400, message: '回复不能超过500字' });
    }

    const [comments] = await pool.execute(
      `SELECT c.id, c.user_id
       FROM comments c
       JOIN posts p ON p.id = c.post_id
       WHERE c.id = ? AND c.post_id = ? AND p.status = "approved" AND p.is_deleted = 0`,
      [commentId, postId]
    );
    if (comments.length === 0) {
      return res.json({ code: 404, message: '评论不存在' });
    }

    const finalIsAnonymous = wantsAnonymous(is_anonymous) ? 1 : 0;
    if (finalIsAnonymous && !(await anonymousEnabled('anon_comment'))) {
      return res.json({ code: 400, message: '匿名评论已关闭，请取消匿名后再回复' });
    }

    var clientIp = getClientIp(req);

    const [result] = await pool.execute(
      'INSERT INTO comment_replies (comment_id, user_id, content, is_anonymous, ip_address) VALUES (?, ?, ?, ?, ?)',
      [commentId, req.user.id, content.trim(), finalIsAnonymous, clientIp]
    );

    getIpRegion(clientIp).then(region => {
      pool.execute('UPDATE comment_replies SET ip_region = ? WHERE id = ?', [region, result.insertId]).catch(() => {});
    });

    const [users] = await pool.execute('SELECT nickname, username FROM users WHERE id = ?', [req.user.id]);
    const commenter = users[0] || {};
    const commenterDisplayName = finalIsAnonymous
      ? '匿名同学'
      : (commenter.nickname || commenter.username || '某用户');

    const commentAuthorId = comments[0].user_id;
    if (commentAuthorId !== req.user.id) {
      createNotification(
        commentAuthorId,
        'comment_reply',
        '收到新回复',
        commenterDisplayName + ' 回复了你的评论: ' + (finalIsAnonymous ? '（匿名回复）' : content.trim().substring(0, 50)),
        postId,
        'post'
      ).catch(err => {
        console.error('[通知] 发送回复通知失败:', err.message);
      });
    }

    res.json({ code: 200, message: '回复成功' });
  } catch (err) {
    console.error('评论回复错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/:postId/comments/:commentId/replies/:replyId', auth, async (req, res) => {
  try {
    const { replyId, commentId } = req.params;

    const [replies] = await pool.execute(
      `SELECT r.user_id, r.comment_id
       FROM comment_replies r
       JOIN comments c ON c.id = r.comment_id
       JOIN posts p ON p.id = c.post_id
       WHERE r.id = ? AND r.comment_id = ? AND c.post_id = ? AND p.status = "approved" AND p.is_deleted = 0`,
      [replyId, commentId, req.params.postId]
    );
    if (replies.length === 0) {
      return res.json({ code: 404, message: '回复不存在' });
    }

    const reply = replies[0];
    const isReplyAuthor = reply.user_id === req.user.id;

    if (!isReplyAuthor && !isStaffRole(req.user.role)) {
      return res.json({ code: 403, message: '无权删除此回复' });
    }

    await pool.execute('DELETE FROM comment_replies WHERE id = ?', [replyId]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/:postId/comments/:commentId/replies/:replyId/like', auth, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const { postId, commentId, replyId } = req.params;
    const userId = req.user.id;

    await connection.beginTransaction();
    const [replies] = await connection.execute(
      `SELECT r.id
       FROM comment_replies r
       JOIN comments c ON c.id = r.comment_id
       JOIN posts p ON p.id = c.post_id
       WHERE r.id = ? AND r.comment_id = ? AND c.post_id = ? AND p.status = "approved" AND p.is_deleted = 0
       FOR UPDATE`,
      [replyId, commentId, postId]
    );
    if (replies.length === 0) {
      await connection.rollback();
      return res.json({ code: 404, message: '回复不存在' });
    }

    const [existing] = await connection.execute(
      'SELECT id FROM comment_reply_likes WHERE reply_id = ? AND user_id = ? FOR UPDATE',
      [replyId, userId]
    );

    let liked = false;
    if (existing.length > 0) {
      await connection.execute('DELETE FROM comment_reply_likes WHERE reply_id = ? AND user_id = ?', [replyId, userId]);
      await connection.execute('UPDATE comment_replies SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = ?', [replyId]);
    } else {
      await connection.execute('INSERT INTO comment_reply_likes (reply_id, user_id) VALUES (?, ?)', [replyId, userId]);
      await connection.execute('UPDATE comment_replies SET likes_count = likes_count + 1 WHERE id = ?', [replyId]);
      liked = true;
    }

    const [updated] = await connection.execute('SELECT likes_count FROM comment_replies WHERE id = ?', [replyId]);
    const likesCount = updated[0]?.likes_count || 0;

    await connection.commit();

    res.json({ code: 200, data: { liked, likes_count: likesCount } });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error('回复点赞错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
