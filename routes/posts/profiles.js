const express = require('express');
const { pool } = require('../../config/database');
const { auth } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');
const { canViewIpRegion, getTimeAgo, normalizePostVideoPosterUrl, normalizePostVideoUrl } = require('./shared');

const router = express.Router();

router.get('/search-users', auth, async (req, res) => {
  try {
    const { q } = req.query;
    const { limit: userLimit } = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 });
    const currentUserId = req.user.id;

    let users;
    if (!q || q.trim().length < 1) {
      [users] = await pool.execute(
        'SELECT id, nickname, username, avatar, role FROM users WHERE status = 1 AND id != ? ORDER BY created_at DESC LIMIT ?',
        [currentUserId, userLimit]
      );
    } else {
      const searchTerm = '%' + q.trim() + '%';
      [users] = await pool.execute(
        'SELECT id, nickname, username, avatar, role FROM users WHERE (nickname LIKE ? OR username LIKE ?) AND status = 1 AND id != ? LIMIT ?',
        [searchTerm, searchTerm, currentUserId, userLimit]
      );
    }

    res.json({ code: 200, data: { users } });
  } catch (err) {
    console.error('搜索用户错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [users] = await pool.execute(
      'SELECT id, username, nickname, avatar, role, created_at FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    const user = users[0];

    let postCount = 0;
    let commentCount = 0;
    let likesCount = 0;
    try {
      const [stats] = await pool.execute(`
        SELECT
          (SELECT COUNT(*) FROM posts p
            WHERE p.user_id = ? AND p.status = 'approved' AND p.is_deleted = 0 AND p.is_anonymous = 0) AS post_count,
          (SELECT COUNT(*) FROM comments c
            WHERE c.user_id = ? AND c.is_anonymous = 0) AS comment_count,
          (SELECT COALESCE(SUM(p.likes_count), 0) FROM posts p
            WHERE p.user_id = ? AND p.status = 'approved' AND p.is_deleted = 0 AND p.is_anonymous = 0) AS likes_count
      `, [userId, userId, userId]);
      if (stats.length) {
        postCount = stats[0].post_count;
        commentCount = stats[0].comment_count;
        likesCount = stats[0].likes_count;
      }
    } catch (e) {
    }

    let titles = [];
    try {
      const [titleRows] = await pool.execute(`
        SELECT t.icon, t.title_name, t.title_color, t.title_bg
        FROM user_titles t
        JOIN user_title_relations r ON t.id = r.title_id
        WHERE r.user_id = ?
        ORDER BY t.sort_order DESC, t.id ASC
        LIMIT 5
      `, [userId]);
      titles = titleRows;
    } catch (e) {
    }

    let followersCount = 0;
    let followingCount = 0;
    try {
      const [followCounts] = await pool.execute(`
        SELECT 'followers' AS metric, COUNT(*) AS total FROM follows WHERE following_id = ?
        UNION ALL
        SELECT 'following' AS metric, COUNT(*) AS total FROM follows WHERE follower_id = ?
      `, [userId, userId]);
      const countsByMetric = new Map(followCounts.map(row => [row.metric, row.total]));
      followersCount = countsByMetric.get('followers') || 0;
      followingCount = countsByMetric.get('following') || 0;
    } catch (e) {
    }

    res.json({
      code: 200,
      data: {
        ...user,
        post_count: postCount,
        comment_count: commentCount,
        likes_count: likesCount,
        titles: titles,
        followers_count: followersCount,
        following_count: followingCount
      }
    });
  } catch (err) {
    console.error('获取用户资料错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/user/my', auth, async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 10, maxLimit: 50 });

    const [posts] = await pool.execute(`
      SELECT p.*,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ? AND p.is_deleted = 0 ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `, [req.user.id, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE user_id = ? AND is_deleted = 0', [req.user.id]);

    const postIds = posts.map(p => p.id);
    let userLikes = new Set();
    let userFavorites = new Set();
    if (postIds.length > 0) {
      const placeholders = postIds.map(() => '?').join(',');
      const [relations] = await pool.execute(`
        SELECT post_id, 'like' AS relation_type
        FROM likes
        WHERE user_id = ? AND post_id IN (${placeholders})
        UNION ALL
        SELECT post_id, 'favorite' AS relation_type
        FROM favorites
        WHERE user_id = ? AND post_id IN (${placeholders})
      `, [req.user.id, ...postIds, req.user.id, ...postIds]);
      relations.forEach(relation => {
        if (relation.relation_type === 'like') userLikes.add(relation.post_id);
        if (relation.relation_type === 'favorite') userFavorites.add(relation.post_id);
      });
    }

    const processedPosts = posts.map(post => {
      const processedPost = {
        ...post,
        images: post.images ? JSON.parse(post.images) : [],
        video_url: normalizePostVideoUrl(post.video_url),
        video_poster: normalizePostVideoPosterUrl(post.video_poster),
        time_ago: getTimeAgo(post.created_at),
        is_liked: userLikes.has(post.id),
        is_favorited: userFavorites.has(post.id)
      };
      if (!canViewIpRegion(req, post.user_id)) delete processedPost.ip_region;
      delete processedPost.ip_address;
      return processedPost;
    });

    res.json({
      code: 200,
      data: {
        posts: processedPosts,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/user/favorites', auth, async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 10, maxLimit: 50 });

    const [posts] = await pool.execute(`
      SELECT p.*,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar
      FROM favorites f
      JOIN posts p ON f.post_id = p.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE f.user_id = ? AND p.is_deleted = 0
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `, [req.user.id, parseInt(limit), parseInt(offset)]);

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM favorites f JOIN posts p ON f.post_id = p.id WHERE f.user_id = ? AND p.is_deleted = 0', [req.user.id]);

    const postIds = posts.map(p => p.id);
    let userLikes = new Set();
    if (postIds.length > 0) {
      const placeholders = postIds.map(() => '?').join(',');
      const [likes] = await pool.execute(
        `SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${placeholders})`,
        [req.user.id, ...postIds]
      );
      userLikes = new Set(likes.map(l => l.post_id));
    }

    const processedPosts = posts.map(post => {
      const processedPost = {
        ...post,
        images: post.images ? JSON.parse(post.images) : [],
        video_url: normalizePostVideoUrl(post.video_url),
        video_poster: normalizePostVideoPosterUrl(post.video_poster),
        time_ago: getTimeAgo(post.created_at),
        is_liked: userLikes.has(post.id),
        is_favorited: true
      };
      if (!canViewIpRegion(req, post.user_id)) delete processedPost.ip_region;
      delete processedPost.ip_address;
      if (post.is_anonymous) delete processedPost.user_id;
      return processedPost;
    });

    res.json({
      code: 200,
      data: {
        posts: processedPosts,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
