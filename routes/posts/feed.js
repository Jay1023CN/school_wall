const express = require('express');
const { pool } = require('../../config/database');
const { optionalAuth } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');
const { canViewIpRegion, getTimeAgo, normalizePostVideoPosterUrl, normalizePostVideoUrl, ORDER_BY_MAP } = require('./shared');

const router = express.Router();

router.get('/', optionalAuth, async (req, res) => {
  try {
    const { offset, category, sort = 'latest', keyword, user_id } = req.query;
    const pagination = getPagination(req.query, { defaultLimit: 10, maxLimit: 50 });
    const requestedOffset = Number.parseInt(offset, 10);
    const finalOffset = Number.isFinite(requestedOffset) && requestedOffset >= 0
      ? Math.min(requestedOffset, 100000)
      : pagination.offset;
    const finalLimit = pagination.limit;

    let whereClause = 'p.status = "approved" AND p.is_deleted = 0';
    const params = [];

    if (category && category !== '全部') {
      whereClause += ' AND p.category = ?';
      params.push(category);
    }

    if (keyword && keyword.trim()) {
      whereClause += ' AND (p.title LIKE ? OR p.content LIKE ?)';
      params.push('%' + keyword.trim() + '%', '%' + keyword.trim() + '%');
    }

    if (user_id) {
      whereClause += ' AND p.user_id = ?';
      params.push(parseInt(user_id));
      whereClause += ' AND p.is_anonymous = 0';
    }

    let orderBy = ORDER_BY_MAP.latest;
    if (ORDER_BY_MAP[sort]) orderBy = ORDER_BY_MAP[sort];

    const [[posts], [countResult]] = await Promise.all([
      pool.execute(`
        SELECT p.id, p.title, p.content, p.images, p.video_url, p.video_poster, p.is_anonymous, p.category,
               p.likes_count, p.comments_count, p.views, p.created_at, p.ip_region, p.user_id as ip_region_owner_id, p.is_pinned,
               p.poll_type,
               CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
               CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar,
               CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.id END as author_id,
               CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.role END as author_role
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `, [...params, finalLimit, finalOffset]),
      pool.execute(`SELECT COUNT(*) as total FROM posts p WHERE ${whereClause}`, params)
    ]);

    if (posts.length > 0) {
      const postIds = posts.map(p => p.id);
      // MySQL 5.7 has no window functions, so fetch only three indexed comments per post.
      const latestCommentQueries = postIds.map(() => `(
        SELECT id, post_id
        FROM comments
        WHERE post_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 3
      )`).join(' UNION ALL ');
      const [comments] = await pool.execute(`
        SELECT c.id, c.post_id, c.content, c.is_anonymous, c.created_at, c.ip_region, c.user_id as ip_region_owner_id,
               CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cu.nickname END as author_name,
               CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cu.avatar END as author_avatar,
               CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cu.id END as author_id,
               CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cu.role END as author_role
        FROM (${latestCommentQueries}) latest
        JOIN comments c ON c.id = latest.id
        LEFT JOIN users cu ON c.user_id = cu.id
        ORDER BY c.post_id, c.created_at DESC, c.id DESC
      `, postIds);

      const titleUserIds = [...new Set([
        ...posts.filter(post => post.author_id).map(post => post.author_id),
        ...comments.filter(comment => comment.author_id).map(comment => comment.author_id)
      ])];
      const titlesByUser = {};
      if (titleUserIds.length > 0) {
        const titlePlaceholders = titleUserIds.map(() => '?').join(',');
        const [commentTitles] = await pool.execute(`
          SELECT utr.user_id, ut.id as title_id, ut.title_name, ut.title_color, ut.title_bg, ut.icon
          FROM user_title_relations utr
          JOIN user_titles ut ON utr.title_id = ut.id
          WHERE utr.user_id IN (${titlePlaceholders})
          ORDER BY ut.sort_order DESC, ut.id ASC
        `, titleUserIds);

        commentTitles.forEach(ct => {
          if (!titlesByUser[ct.user_id]) {
            titlesByUser[ct.user_id] = [];
          }
          titlesByUser[ct.user_id].push({
            id: ct.title_id,
            title_name: ct.title_name,
            title_color: ct.title_color,
            title_bg: ct.title_bg,
            icon: ct.icon
          });
        });
      }

      posts.forEach(post => {
        if (post.author_id) post.author_titles = titlesByUser[post.author_id] || [];
      });
      comments.forEach(comment => {
        if (comment.author_id) comment.author_titles = titlesByUser[comment.author_id] || [];
      });

      const commentsByPost = {};
      comments.forEach(comment => {
        if (!commentsByPost[comment.post_id]) {
          commentsByPost[comment.post_id] = [];
        }
        if (commentsByPost[comment.post_id].length < 3) {
          commentsByPost[comment.post_id].push({
            id: comment.id,
            content: comment.content,
            is_anonymous: comment.is_anonymous,
            author_name: comment.author_name,
            author_avatar: comment.author_avatar,
            author_id: comment.author_id,
            author_role: comment.author_role,
            author_titles: comment.author_titles || [],
            time_ago: getTimeAgo(comment.created_at),
            ip_region: canViewIpRegion(req, comment.ip_region_owner_id) ? comment.ip_region : null
          });
        }
      });

      posts.forEach(post => {
        post.preview_comments = commentsByPost[post.id] || [];
      });
    }

    let userLikes = new Set();
    let userFavorites = new Set();
    if (req.user && posts.length > 0) {
      const postIds = posts.map(p => p.id);
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
    }

    const processedPosts = posts.map(post => {
      const processedPost = {
        ...post,
        images: post.images ? JSON.parse(post.images) : [],
        video_url: normalizePostVideoUrl(post.video_url),
        video_poster: normalizePostVideoPosterUrl(post.video_poster),
        is_liked: userLikes.has(post.id),
        is_favorited: userFavorites.has(post.id),
        time_ago: getTimeAgo(post.created_at)
      };
      if (!canViewIpRegion(req, post.ip_region_owner_id)) delete processedPost.ip_region;
      delete processedPost.ip_region_owner_id;
      return processedPost;
    });

    res.json({
      code: 200,
      data: {
        posts: processedPosts,
        total: countResult[0].total,
        page: Math.floor(finalOffset / finalLimit) + 1,
        totalPages: Math.ceil(countResult[0].total / finalLimit)
      }
    });
  } catch (err) {
    console.error('获取帖子列表错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const [posts] = await pool.execute(`
      SELECT p.*,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.id END as author_id,
             CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.role END as author_role,
             p.user_id as actual_user_id
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.status = 'approved' AND p.is_deleted = 0
    `, [req.params.id]);

    if (posts.length === 0) {
      return res.json({ code: 404, message: '帖子不存在' });
    }

    const post = posts[0];
    const actualPostUserId = post.actual_user_id;
    const isPostAuthor = !!(req.user && req.user.id === actualPostUserId);
    if (!canViewIpRegion(req, actualPostUserId)) delete post.ip_region;
    delete post.user_id;
    delete post.ip_address;
    if (!isPostAuthor) delete post.actual_user_id;
    post.images = post.images ? JSON.parse(post.images) : [];
    post.video_url = normalizePostVideoUrl(post.video_url);
    post.video_poster = normalizePostVideoPosterUrl(post.video_poster);
    post.time_ago = getTimeAgo(post.created_at);

    const [comments] = await pool.execute(`
      SELECT c.*,
             CASE WHEN c.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_name,
             CASE WHEN c.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar,
             CASE WHEN c.is_anonymous = 1 THEN NULL ELSE u.role END as author_role,
             c.user_id as actual_user_id
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC
    `, [req.params.id]);

    post.comments = comments.map(function(c) {
      var comment = Object.assign({}, c, { time_ago: getTimeAgo(c.created_at) });
      var isCommentAuthor = !!(req.user && req.user.id === c.actual_user_id);
      if (!canViewIpRegion(req, c.actual_user_id)) delete comment.ip_region;
      comment.can_delete = !!(req.user && (isCommentAuthor || isPostAuthor || isStaffRole(req.user.role)));
      delete comment.user_id;
      delete comment.ip_address;
      if (isPostAuthor && c.is_anonymous && c.actual_user_id) {
        comment.author_name = '匿名同学（仅作者可见）';
        comment.is_anonymous_revealed = true;
      }
      if (c.is_anonymous) {
        if (!isPostAuthor) delete comment.actual_user_id;
      } else {
        comment.author_id = c.actual_user_id;
        delete comment.actual_user_id;
      }
      return comment;
    });

    if (req.user) {
      const [likes] = await pool.execute('SELECT id FROM likes WHERE user_id = ? AND post_id = ?', [req.user.id, req.params.id]);
      const [favorites] = await pool.execute('SELECT id FROM favorites WHERE user_id = ? AND post_id = ?', [req.user.id, req.params.id]);
      post.is_liked = likes.length > 0;
      post.is_favorited = favorites.length > 0;
    } else {
      post.is_liked = false;
      post.is_favorited = false;
    }

    const [likesList] = await pool.execute(`
      SELECT u.id, u.nickname, u.avatar, l.created_at
      FROM likes l
      JOIN users u ON l.user_id = u.id
      WHERE l.post_id = ?
      ORDER BY l.created_at DESC
      LIMIT 20
    `, [req.params.id]);
    post.likes_list = likesList;

    if (!post.is_anonymous && post.author_id) {
      try {
        const [titles] = await pool.execute(`
          SELECT t.icon, t.title_name, t.title_color, t.title_bg
          FROM user_titles t
          JOIN user_title_relations r ON t.id = r.title_id
          WHERE r.user_id = ?
          ORDER BY t.sort_order DESC, t.id ASC
          LIMIT 5
        `, [post.author_id]);
        post.author_titles = titles;
      } catch (e) {
        post.author_titles = [];
      }
    } else {
      post.author_titles = [];
    }

    if (post.poll_type) {
      try {
        var [pollOptions] = await pool.execute(
          'SELECT id, option_text, votes_count FROM poll_options WHERE post_id = ? ORDER BY id',
          [req.params.id]
        );
        post.poll_options = pollOptions;
        post.poll_total = pollOptions.reduce(function(s, o) { return s + o.votes_count; }, 0);
        if (req.user) {
          var [userVotes] = await pool.execute(
            'SELECT option_id FROM poll_votes v JOIN poll_options o ON v.option_id = o.id WHERE o.post_id = ? AND v.user_id = ?',
            [req.params.id, req.user.id]
          );
          post.poll_user_votes = userVotes.map(function(v) { return v.option_id; });
        } else {
          post.poll_user_votes = [];
        }
      } catch (e) {
        post.poll_options = [];
        post.poll_total = 0;
        post.poll_user_votes = [];
      }
    }

    res.json({ code: 200, data: post });
  } catch (err) {
    console.error('获取帖子详情错误:', err);
    res.json({ code: 500, message: '服务器错误' });
  }
});

module.exports = router;
