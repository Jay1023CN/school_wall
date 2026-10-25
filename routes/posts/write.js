const express = require('express');
const { pool } = require('../../config/database');
const { auth } = require('../../middleware/auth');
const { getIpRegion, getClientIp } = require('../../services/ip-lookup');
const { notifyFollowPost, notifyAdminNewPostPending } = require('../../services/email');
const { pushPost } = require('../../services/baidu-push');
const { adjustUserPoints } = require('../../services/gamification');
const { runBackgroundTask } = require('../../services/async-utils');
const { runWriteTransaction } = require('../../services/write-transaction');
const { anonymousEnabled, normalizePostVideoPosterUrl, normalizePostVideoUrl, wantsAnonymous } = require('./shared');

const router = express.Router();

router.post('/', auth, async (req, res) => {
  try {
    const { title, content, images, video_url, video_poster, is_anonymous, category, contact, pollOptions, pollType, pollExpiresAt, client_ip } = req.body;
    const titleValue = typeof title === 'string' ? title.trim() : '';
    const contentValue = typeof content === 'string' ? content.trim() : '';
    if (!titleValue) {
      return res.json({ code: 400, message: '请输入标题' });
    }
    if (contentValue.length > 5000) {
      return res.json({ code: 400, message: '内容不能超过5000字' });
    }
    if (titleValue.length > 100) {
      return res.json({ code: 400, message: '标题不能超过100字' });
    }

    let normalizedPollOptions = null;
    let normalizedPollType = 'single';
    if (pollOptions !== undefined && pollOptions !== null) {
      if (!Array.isArray(pollOptions)) return res.status(400).json({ code: 400, message: '投票选项格式不正确' });
      if (pollOptions.length > 0) {
        if (pollOptions.some(option => typeof option !== 'string')) {
          return res.status(400).json({ code: 400, message: '投票选项格式不正确' });
        }
        normalizedPollOptions = pollOptions.map(option => option.trim()).filter(Boolean);
        if (normalizedPollOptions.length < 2) {
          return res.status(400).json({ code: 400, message: '投票选项至少需要2项' });
        }
        if (normalizedPollOptions.some(option => option.length > 100)) {
          return res.status(400).json({ code: 400, message: '投票选项不能超过100字' });
        }
        normalizedPollType = pollType || 'single';
        if (!['single', 'multiple'].includes(normalizedPollType)) {
          return res.status(400).json({ code: 400, message: '投票类型无效' });
        }
      }
    }

    var clientIp = getClientIp(req);

    const imagesJson = images ? JSON.stringify(images) : null;
    const videoUrl = normalizePostVideoUrl(video_url);
    if (video_url && !videoUrl) {
      return res.json({ code: 400, message: '视频地址无效，请重新上传' });
    }
    const videoPoster = normalizePostVideoPosterUrl(video_poster);
    if (video_poster && !videoPoster) {
      return res.json({ code: 400, message: '视频封面地址无效，请重新上传' });
    }
    const contactValue = (category === 'lost_found' && contact) ? contact.trim() : '';

    let finalIsAnonymous = wantsAnonymous(is_anonymous) ? 1 : 0;
    let needReview = false;
    let postStatus = 'approved';
    const writeResult = await runWriteTransaction(pool, req, 'posts.create', async connection => {
      if (finalIsAnonymous && !(await anonymousEnabled('anon_post', connection))) {
        return { status: 400, body: { code: 400, message: '匿名发帖已关闭，请取消匿名后再提交' } };
      }

      const [settingRows] = await connection.execute('SELECT config_value FROM settings WHERE config_key = ?', ['post_review']);
      needReview = settingRows.length > 0 && settingRows[0].config_value === 'true';
      postStatus = needReview ? 'pending' : 'approved';

      const [result] = await connection.execute(
        'INSERT INTO posts (user_id, title, content, images, video_url, video_poster, is_anonymous, category, contact, ip_address, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [req.user.id, titleValue, contentValue, imagesJson, videoUrl, videoPoster, finalIsAnonymous, category || '日常', contactValue, clientIp, postStatus]
      );

      if (normalizedPollOptions) {
        for (const option of normalizedPollOptions) {
          await connection.execute('INSERT INTO poll_options (post_id, option_text) VALUES (?, ?)', [result.insertId, option]);
        }
        await connection.execute('UPDATE posts SET poll_type = ?, poll_expires_at = ? WHERE id = ?', [
          normalizedPollType,
          pollExpiresAt || null,
          result.insertId
        ]);
      }

      return {
        status: 200,
        body: { code: 200, message: needReview ? '发布成功，等待审核' : '发布成功', data: { id: result.insertId } }
      };
    });
    if (writeResult.status >= 400 || Number(writeResult.body.code) >= 400) {
      return res.status(writeResult.status).json(writeResult.body);
    }

    const createdPostId = writeResult.body.data.id;
    if (!writeResult.replayed) {
      getIpRegion(clientIp).then(region => {
        pool.execute('UPDATE posts SET ip_region = ? WHERE id = ?', [region, createdPostId]).catch(() => {});
      });

    if (needReview) {
      var postId = createdPostId;
      var posterNickname = req.user.nickname || req.user.username;
      var postTitle = titleValue;
      var postContent = contentValue;
      setImmediate(function() {
        notifyAdminNewPostPending(postId, postTitle, posterNickname, postContent).catch(function(e) {
          console.error('通知管理员审核失败:', e.message);
        });
      });
    }

    if (!finalIsAnonymous && postStatus !== 'rejected') {
      var postId = createdPostId;
      var posterId = req.user.id;
      var posterNickname = req.user.nickname || req.user.username;
      var postTitle = titleValue;
      (async function() {
        try {
          const batchSize = 100;
          const sendConcurrency = 3;
          let lastFollowerId = 0;
          while (true) {
            const [followers] = await pool.execute(
              'SELECT u.id, u.email, u.nickname, u.username FROM follows f JOIN users u ON f.follower_id = u.id LEFT JOIN user_notify_settings ns ON ns.user_id = u.id WHERE f.following_id = ? AND u.id > ? AND u.email IS NOT NULL AND u.email != "" AND COALESCE(ns.notify_follow_post, 1) <> 0 ORDER BY u.id ASC LIMIT ?',
              [posterId, lastFollowerId, batchSize]
            );
            if (followers.length === 0) break;
            lastFollowerId = Number(followers[followers.length - 1].id);

            for (let start = 0; start < followers.length; start += sendConcurrency) {
              const batch = followers.slice(start, start + sendConcurrency);
              await Promise.all(batch.map(follower => notifyFollowPost(
                follower.email,
                follower.nickname || follower.username,
                posterNickname,
                postTitle,
                postId,
                follower.id,
                true
              )));
            }
            if (followers.length < batchSize) break;
          }
        } catch (e) {
          console.error('通知关注者失败:', e.message);
        }
      })();
    }

    if (postStatus === 'approved') {
      var pid = createdPostId;
      runBackgroundTask('发帖积分发放失败', () => adjustUserPoints(
        req.user.id,
        2,
        'post',
        { relatedId: pid, includeLogs: false }
      ));
    }

    if (postStatus === 'approved') {
      setImmediate(function() { pushPost(createdPostId); });
    }
    }

    res.status(writeResult.status).json(writeResult.body);
  } catch (err) {
    console.error('发布帖子错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const [posts] = await pool.execute('SELECT user_id, is_deleted FROM posts WHERE id = ?', [req.params.id]);
    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }
    if (posts[0].user_id !== req.user.id && !isStaffRole(req.user.role)) {
      return res.json({ code: 403, message: '无权删除' });
    }
    if (posts[0].is_deleted) {
      return res.json({ code: 404, message: '帖子已在回收站' });
    }
    const [result] = await pool.execute(
      'UPDATE posts SET is_deleted = 1, deleted_at = NOW() WHERE id = ? AND is_deleted = 0',
      [req.params.id]
    );
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '已移入回收站' : '帖子已被其他操作删除'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { title, content, category, images, video_url, video_poster, is_anonymous, pollOptions, pollType } = req.body;
    const writeResult = await runWriteTransaction(pool, req, 'posts.update', async connection => {
      const [posts] = await connection.execute(
        'SELECT user_id, title, content, is_anonymous, is_deleted, poll_type FROM posts WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      if (posts.length === 0) return { status: 404, body: { code: 404, message: '帖子不存在' } };
      const post = posts[0];
      if (post.is_deleted) return { status: 404, body: { code: 404, message: '帖子已在回收站，无法编辑' } };
      if (String(post.user_id) !== String(req.user.id)) {
        return { status: 403, body: { code: 403, message: '无权编辑此帖子' } };
      }

      const titleValue = title === undefined ? String(post.title || '').trim() : (typeof title === 'string' ? title.trim() : '');
      const contentValue = content === undefined ? String(post.content || '').trim() : (typeof content === 'string' ? content.trim() : '');
      if (!titleValue) return { status: 400, body: { code: 400, message: '请输入标题' } };
      if (titleValue.length > 100) return { status: 400, body: { code: 400, message: '标题不能超过100字' } };
      if (contentValue.length > 5000) return { status: 400, body: { code: 400, message: '内容不能超过5000字' } };

      const nextVideoUrl = video_url === undefined ? undefined : normalizePostVideoUrl(video_url);
      if (video_url && !nextVideoUrl) return { status: 400, body: { code: 400, message: '视频地址无效，请重新上传' } };
      const nextVideoPoster = video_poster === undefined ? undefined : normalizePostVideoPosterUrl(video_poster);
      if (video_poster && !nextVideoPoster) return { status: 400, body: { code: 400, message: '视频封面地址无效，请重新上传' } };
      if (is_anonymous !== undefined && wantsAnonymous(is_anonymous) && !post.is_anonymous && !(await anonymousEnabled('anon_post', connection))) {
        return { status: 400, body: { code: 400, message: '匿名发帖已关闭，无法将帖子改为匿名' } };
      }

      let nextPollOptions = null;
      let nextPollType = pollType || 'single';
      const replacePoll = Array.isArray(pollOptions) && pollOptions.length > 0;
      const clearPoll = !pollOptions && post.poll_type;
      if (pollOptions !== undefined && pollOptions !== null && !Array.isArray(pollOptions)) {
        return { status: 400, body: { code: 400, message: '投票选项格式不正确' } };
      }
      if (replacePoll) {
        if (pollOptions.some(option => typeof option !== 'string')) {
          return { status: 400, body: { code: 400, message: '投票选项格式不正确' } };
        }
        nextPollOptions = pollOptions.map(option => option.trim()).filter(Boolean);
        if (nextPollOptions.length < 2) {
          return { status: 400, body: { code: 400, message: '投票选项至少需要2项' } };
        }
        if (nextPollOptions.some(option => option.length > 100)) {
          return { status: 400, body: { code: 400, message: '投票选项不能超过100字' } };
        }
        if (!['single', 'multiple'].includes(nextPollType)) {
          return { status: 400, body: { code: 400, message: '投票类型无效' } };
        }
      }

      const [settingRows] = await connection.execute('SELECT config_value FROM settings WHERE config_key = ?', ['post_review']);
      const needReview = settingRows.length > 0 && settingRows[0].config_value === 'true';
      const postStatus = needReview ? 'pending' : 'approved';
      const updateFields = [];
      const updateValues = [];
      if (title !== undefined) { updateFields.push('title = ?'); updateValues.push(titleValue); }
      if (content !== undefined) { updateFields.push('content = ?'); updateValues.push(contentValue); }
      if (category !== undefined) { updateFields.push('category = ?'); updateValues.push(category); }
      if (images !== undefined) { updateFields.push('images = ?'); updateValues.push(images ? JSON.stringify(images) : null); }
      if (video_url !== undefined) {
        updateFields.push('video_url = ?');
        updateValues.push(nextVideoUrl);
        if (video_poster === undefined && !nextVideoUrl) { updateFields.push('video_poster = ?'); updateValues.push(null); }
      }
      if (video_poster !== undefined) { updateFields.push('video_poster = ?'); updateValues.push(nextVideoPoster); }
      if (is_anonymous !== undefined) { updateFields.push('is_anonymous = ?'); updateValues.push(wantsAnonymous(is_anonymous) ? 1 : 0); }
      updateFields.push('status = ?', 'updated_at = ?');
      updateValues.push(postStatus, new Date(), req.params.id);
      const [updated] = await connection.execute(
        `UPDATE posts SET ${updateFields.join(', ')} WHERE id = ? AND is_deleted = 0`,
        updateValues
      );
      if (!updated.affectedRows) return { status: 404, body: { code: 404, message: '帖子已被其他操作删除' } };

      if (replacePoll) {
        await connection.execute('DELETE FROM poll_votes WHERE option_id IN (SELECT id FROM poll_options WHERE post_id = ?)', [req.params.id]);
        await connection.execute('DELETE FROM poll_options WHERE post_id = ?', [req.params.id]);
        for (const option of nextPollOptions) {
          await connection.execute('INSERT INTO poll_options (post_id, option_text) VALUES (?, ?)', [req.params.id, option]);
        }
        await connection.execute('UPDATE posts SET poll_type = ? WHERE id = ?', [nextPollType, req.params.id]);
      } else if (clearPoll) {
        await connection.execute('DELETE FROM poll_votes WHERE option_id IN (SELECT id FROM poll_options WHERE post_id = ?)', [req.params.id]);
        await connection.execute('DELETE FROM poll_options WHERE post_id = ?', [req.params.id]);
        await connection.execute('UPDATE posts SET poll_type = NULL WHERE id = ?', [req.params.id]);
      }

      return {
        status: 200,
        body: {
          code: 200,
          message: needReview ? '编辑成功，帖子正在等待审核' : '编辑成功',
          data: { status: postStatus }
        }
      };
    });
    res.status(writeResult.status).json(writeResult.body);
  } catch (err) {
    console.error('编辑帖子错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/:id/edit', auth, async (req, res) => {
  try {
    const [posts] = await pool.execute(
      'SELECT id, title, content, category, images, video_url, video_poster, is_anonymous, user_id, poll_type, poll_expires_at FROM posts WHERE id = ? AND is_deleted = 0',
      [req.params.id]
    );

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }

    const post = posts[0];
    if (post.user_id !== req.user.id) {
      return res.json({ code: 403, message: '无权编辑此帖子' });
    }

    let pollOptions = [];
    if (post.poll_type) {
      const [options] = await pool.execute(
        'SELECT id, option_text FROM poll_options WHERE post_id = ? ORDER BY id',
        [req.params.id]
      );
      pollOptions = options.map(function(o) { return { id: o.id, text: o.option_text }; });
    }

    res.json({
      code: 200,
      data: {
        id: post.id,
        title: post.title,
        content: post.content,
        category: post.category,
        images: post.images ? JSON.parse(post.images) : [],
        video_url: normalizePostVideoUrl(post.video_url),
        video_poster: normalizePostVideoPosterUrl(post.video_poster),
        is_anonymous: post.is_anonymous === 1,
        poll_options: pollOptions,
        poll_type: post.poll_type || 'single'
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
