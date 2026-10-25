const express = require('express');
const { pool } = require('../../config/database');
const { superAdminOnly } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');
const { getErrorDetail } = require('../../services/async-utils');
const { adjustUserPoints, awardTitle } = require('../../services/gamification');

const router = express.Router();
router.get('/titles', superAdminOnly, async (req, res) => {
  try {
    const [titles] = await pool.execute('SELECT * FROM user_titles ORDER BY sort_order DESC, id ASC');
    res.json({ code: 200, data: titles });
  } catch (err) {
    console.error('获取头衔列表错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/titles', superAdminOnly, async (req, res) => {
  try {
    const { title_name, title_color, title_bg, icon, sort_order } = req.body;
    if (!title_name || !title_name.trim()) {
      return res.json({ code: 400, message: '头衔名称不能为空' });
    }
    const [result] = await pool.execute(
      'INSERT INTO user_titles (title_name, title_color, title_bg, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
      [title_name.trim(), title_color || '#FF6B9D', title_bg || 'rgba(255,107,157,0.1)', icon || '⭐', sort_order || 0]
    );
    res.json({ code: 200, message: '添加成功', data: { id: result.insertId } });
  } catch (err) {
    console.error('添加头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/titles/:id', superAdminOnly, async (req, res) => {
  try {
    const { title_name, title_color, title_bg, icon, sort_order } = req.body;
    const titleId = parseInt(req.params.id);
    if (!title_name || !title_name.trim()) {
      return res.json({ code: 400, message: '头衔名称不能为空' });
    }
    await pool.execute(
      'UPDATE user_titles SET title_name = ?, title_color = ?, title_bg = ?, icon = ?, sort_order = ? WHERE id = ?',
      [title_name.trim(), title_color || '#FF6B9D', title_bg || 'rgba(255,107,157,0.1)', icon || '⭐', sort_order || 0, titleId]
    );
    res.json({ code: 200, message: '修改成功' });
  } catch (err) {
    console.error('编辑头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/titles/:id', superAdminOnly, async (req, res) => {
  try {
    const titleId = parseInt(req.params.id);
    const [result] = await pool.execute('DELETE FROM user_titles WHERE id = ?', [titleId]);
    if (result.affectedRows === 0) {
      return res.json({ code: 404, message: '头衔不存在' });
    }
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    console.error('删除头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/users/:id/titles', superAdminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [titles] = await pool.execute(`
      SELECT t.* FROM user_titles t
      JOIN user_title_relations r ON t.id = r.title_id
      WHERE r.user_id = ?
      ORDER BY t.sort_order DESC, t.id ASC
    `, [userId]);
    res.json({ code: 200, data: titles });
  } catch (err) {
    console.error('获取用户头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/users/:id/titles', superAdminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { title_id } = req.body;
    if (!title_id) {
      return res.json({ code: 400, message: '请选择头衔' });
    }
    const [user] = await pool.execute('SELECT id FROM users WHERE id = ?', [userId]);
    if (user.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    const [title] = await pool.execute('SELECT id FROM user_titles WHERE id = ?', [title_id]);
    if (title.length === 0) {
      return res.json({ code: 404, message: '头衔不存在' });
    }
    await pool.execute('INSERT IGNORE INTO user_title_relations (user_id, title_id) VALUES (?, ?)', [userId, title_id]);
    res.json({ code: 200, message: '添加成功' });
  } catch (err) {
    console.error('添加用户头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/users/:userId/titles/:titleId', superAdminOnly, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const titleId = parseInt(req.params.titleId);
    await pool.execute('DELETE FROM user_title_relations WHERE user_id = ? AND title_id = ?', [userId, titleId]);
    res.json({ code: 200, message: '移除成功' });
  } catch (err) {
    console.error('移除用户头衔错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});


router.get('/gamification', superAdminOnly, async (req, res) => {
  try {
    var today = new Date().toISOString().slice(0, 10);
    var [todayCheckins] = await pool.execute('SELECT COUNT(*) as total FROM checkins WHERE checkin_date = ?', [today]);
    var [totalCheckins] = await pool.execute('SELECT COUNT(*) as total FROM checkins');
    var [activeUsers] = await pool.execute('SELECT COUNT(DISTINCT user_id) as total FROM checkins WHERE checkin_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)');
    var [topPoints] = await pool.execute('SELECT u.id, u.nickname, u.username, u.avatar, u.points FROM users u WHERE u.points > 0 ORDER BY u.points DESC LIMIT 10');
    var [topStreak] = await pool.execute('SELECT c.user_id, u.nickname, u.username, MAX(c.streak) as max_streak FROM checkins c JOIN users u ON c.user_id = u.id GROUP BY c.user_id ORDER BY max_streak DESC LIMIT 10');
    var weeklyStar = null;
    try {
      var [ws] = await pool.execute(
        "SELECT utr.user_id, u.nickname, u.username, ut.title_name FROM user_title_relations utr JOIN users u ON utr.user_id = u.id JOIN user_titles ut ON utr.title_id = ut.id WHERE ut.title_name = '本周之星🏆' LIMIT 1"
      );
      if (ws.length > 0) weeklyStar = ws[0];
    } catch (e) {}

    res.json({
      code: 200,
      data: {
        today_checkins: todayCheckins[0].total,
        total_checkins: totalCheckins[0].total,
        active_users_7d: activeUsers[0].total,
        top_points: topPoints,
        top_streak: topStreak,
        weekly_star: weeklyStar
      }
    });
  } catch (err) {
    console.error('[Admin] 获取运营数据失败:', err.message);
    res.json({ code: 500, message: '查询失败' });
  }
});

router.post('/points', superAdminOnly, async (req, res) => {
  try {
    var { user_id, points, reason } = req.body;
    if (!user_id || points === undefined) {
      return res.json({ code: 400, message: '缺少 user_id 或 points' });
    }
    points = parseInt(points);
    if (isNaN(points) || points === 0) {
      return res.json({ code: 400, message: '积分值无效' });
    }
    if (Math.abs(points) > 1000) {
      return res.json({ code: 400, message: '单次操作不能超过 1000 积分' });
    }
    var result = await adjustUserPoints(user_id, points, reason);
    res.json({ code: 200, message: (points > 0 ? '发放' : '扣除') + '成功', data: result });
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND' || err.code === 'INSUFFICIENT_POINTS') {
      return res.json({ code: 400, message: err.message });
    }
    console.error('[Admin] 积分操作失败:', err.message);
    res.json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

router.get('/points', superAdminOnly, async (req, res) => {
  try {
    var userId = parseInt(req.query.user_id) || null;
    var pointsPagination = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    var limit = pointsPagination.limit;
    var page = pointsPagination.page;
    var offset = pointsPagination.offset;

    if (userId) {
      var [logs] = await pool.execute(
        'SELECT pl.*, u.nickname, u.username FROM points_log pl JOIN users u ON pl.user_id = u.id WHERE pl.user_id = ? ORDER BY pl.created_at DESC LIMIT ? OFFSET ?',
        [userId, limit, offset]
      );
      var [total] = await pool.execute('SELECT COUNT(*) as total FROM points_log WHERE user_id = ?', [userId]);
      var [user] = await pool.execute('SELECT id, nickname, username, points FROM users WHERE id = ?', [userId]);
      return res.json({
        code: 200,
        data: { logs: logs, total: total[0].total, user: user[0] || null }
      });
    }

    var [logs] = await pool.execute(
      'SELECT pl.*, u.nickname, u.username FROM points_log pl JOIN users u ON pl.user_id = u.id ORDER BY pl.created_at DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    var [total] = await pool.execute('SELECT COUNT(*) as total FROM points_log');
    res.json({ code: 200, data: { logs: logs, total: total[0].total } });
  } catch (err) {
    console.error('[Admin] 查询积分日志失败:', err.message);
    res.json({ code: 500, message: '查询失败' });
  }
});

router.delete('/points/cleanup', superAdminOnly, async (req, res) => {
  try {
    var days = Math.max(parseInt(req.query.days) || 7, 1);
    var [result] = await pool.execute(
      'DELETE FROM points_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    res.json({ code: 200, message: `已删除 ${days} 天前的积分记录`, data: { deleted: result.affectedRows } });
  } catch (err) {
    console.error('[Admin] 清理积分日志失败:', err.message);
    res.json({ code: 500, message: '清理失败' });
  }
});

const TITLE_CONFIG = {
  weekly_star:  { name: '本周之星🏆', color: '#FF6B9D', bg: 'rgba(255,107,157,0.15)', icon: '🏆', points: 10, reason: 'weekly_star' },
  checkin_star: { name: '签到之星⭐', color: '#16a34a', bg: 'rgba(22,163,74,0.15)', icon: '⭐', points: 8, reason: 'checkin_star' },
  popular_star: { name: '人气之星🔥', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)', icon: '🔥', points: 8, reason: 'popular_star' }
};

router.get('/award-title/candidates', superAdminOnly, async (req, res) => {
  try {
    const { type } = req.query;
    if (!type || !TITLE_CONFIG[type]) {
      return res.json({ code: 400, message: '无效的称号类型' });
    }
    var oneWeekAgo = new Date(); oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    var since = oneWeekAgo.toISOString().slice(0, 19).replace('T', ' ');
    var candidates = [];

    if (type === 'weekly_star') {
      [candidates] = await pool.execute(`
        SELECT p.id, p.user_id, u.nickname, u.username, u.avatar,
               p.likes_count, p.title as post_title, p.content
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.created_at >= ? AND p.is_deleted = 0 AND p.status = 'approved'
        ORDER BY p.likes_count DESC LIMIT 10
      `, [since]);
      candidates = candidates.map(c => ({
        user_id: c.user_id, nickname: c.nickname, username: c.username, avatar: c.avatar,
        score: c.likes_count, desc: '👍 ' + c.likes_count + ' 赞 · ' + (c.post_title || c.content?.slice(0,30) || '无标题')
      }));
    } else if (type === 'checkin_star') {
      [candidates] = await pool.execute(`
        SELECT c.user_id, u.nickname, u.username, u.avatar, COUNT(*) as cnt
        FROM checkins c JOIN users u ON c.user_id = u.id
        WHERE c.checkin_date >= ? AND u.role != 'banned'
        GROUP BY c.user_id ORDER BY cnt DESC LIMIT 10
      `, [since.slice(0,10)]);
      candidates = candidates.map(c => ({
        user_id: c.user_id, nickname: c.nickname, username: c.username, avatar: c.avatar,
        score: c.cnt, desc: '📅 签到 ' + c.cnt + ' 天'
      }));
    } else if (type === 'popular_star') {
      [candidates] = await pool.execute(`
        SELECT p.user_id, u.nickname, u.username, u.avatar, SUM(p.likes_count) as total_likes
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.created_at >= ? AND p.is_deleted = 0 AND p.status = 'approved'
        GROUP BY p.user_id ORDER BY total_likes DESC LIMIT 10
      `, [since]);
      candidates = candidates.map(c => ({
        user_id: c.user_id, nickname: c.nickname, username: c.username, avatar: c.avatar,
        score: c.total_likes, desc: '👍 收到 ' + c.total_likes + ' 赞'
      }));
    }

    res.json({ code: 200, data: candidates });
  } catch (err) {
    console.error('[Admin] 获取候选人失败:', err.message);
    res.json({ code: 500, message: '获取失败' });
  }
});

router.post('/award-title', superAdminOnly, async (req, res) => {
  try {
    const { type, user_id } = req.body;
    if (!type || !user_id) {
      return res.json({ code: 400, message: '缺少参数' });
    }

    var titleConfig;
    if (type === 'custom') {
      var customName = req.body.title_name;
      if (!customName || customName.length > 30) {
        return res.json({ code: 400, message: '请输入有效的称号名称（最多30字）' });
      }
      titleConfig = { name: customName, color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)', icon: '🎖️', points: 5, reason: 'custom_title' };
    } else {
      titleConfig = TITLE_CONFIG[type];
      if (!titleConfig) return res.json({ code: 400, message: '无效的称号类型' });
    }

    var targetId = parseInt(user_id);
    var result = await awardTitle(targetId, type, titleConfig);
    res.json({
      code: 200,
      message: '✅ 已颁发「' + result.title_name + '」给 ' + result.nickname,
      data: result
    });
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND') {
      return res.json({ code: 400, message: err.message });
    }
    console.error('[Admin] 颁发称号失败:', err.message);
    res.json({ code: 500, message: '操作失败' });
  }
});


module.exports = router;
