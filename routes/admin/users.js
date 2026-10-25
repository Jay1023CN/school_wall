const express = require('express');
const { pool } = require('../../config/database');
const { requirePermission, superAdminOnly } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');
const jwt = require('jsonwebtoken');
const JWT_SECRET = require('../../config/jwt-secret');

const router = express.Router();
router.get('/users', requirePermission('users:view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 50, maxLimit: 100 });
    const { search = '', keyword = '', role = '' } = req.query;
    const query = String(search || keyword || '').trim();
    const roleFilter = String(role || '').trim();
    const validRoles = ['user', 'reviewer', 'radio_admin', 'admin', 'super_admin'];
    if (roleFilter && roleFilter !== 'all' && !validRoles.includes(roleFilter)) {
      return res.json({ code: 400, message: '无效角色筛选条件' });
    }

    const conditions = ['1=1'];
    const params = [];
    if (query) {
      conditions.push('(username LIKE ? OR nickname LIKE ? OR email LIKE ?)');
      const wildcardQuery = `%${query}%`;
      params.push(wildcardQuery, wildcardQuery, wildcardQuery);
    }
    if (roleFilter && roleFilter !== 'all') {
      conditions.push('role = ?');
      params.push(roleFilter);
    }
    const whereClause = conditions.join(' AND ');

    const [[users], [countResult]] = await Promise.all([
      pool.execute(`
      SELECT id, username, nickname, avatar, email, role, status, points, created_at,
             last_login_at, last_login_ip, last_login_region,
             ban_reason, ban_attempt_ip, ban_attempt_count FROM users
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]),
      pool.execute(`SELECT COUNT(*) as total FROM users WHERE ${whereClause}`, params)
    ]);

    res.json({
      code: 200,
      data: {
        users,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取用户列表错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/users/:id/status', requirePermission('users:status'), async (req, res) => {
  try {
    const { status, ban_reason } = req.body;
    const targetId = parseInt(req.params.id);

    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '不能禁用自己的账号' });
    }

    const [target] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target.length > 0 && target[0].role === 'super_admin') {
      return res.json({ code: 403, message: '不能禁用超级管理员' });
    }

    if (status === 0) {
      await pool.execute('UPDATE users SET status = 0, ban_reason = ? WHERE id = ?', [ban_reason || null, targetId]);
    } else {
      await pool.execute('UPDATE users SET status = 1, ban_reason = NULL WHERE id = ?', [targetId]);
    }
    res.json({ code: 200, message: status === 0 ? '已封禁' : '已解封' });
  } catch (err) {
    console.error('修改用户状态错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/users/:id/role', superAdminOnly, async (req, res) => {
  try {
    const { role } = req.body;
    const targetId = parseInt(req.params.id);

    const validRoles = ['user', 'reviewer', 'radio_admin', 'admin', 'super_admin'];
    if (!validRoles.includes(role)) {
      return res.json({ code: 400, message: '无效角色' });
    }

    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '不能修改自己的角色' });
    }

    const [target] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    if (target[0].role === 'super_admin') {
      return res.json({ code: 403, message: '不能修改超级管理员的角色' });
    }

    await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, targetId]);
    res.json({ code: 200, message: '角色修改成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/users/:id', superAdminOnly, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);

    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '不能删除自己' });
    }

    const [target] = await pool.execute('SELECT role FROM users WHERE id = ?', [targetId]);
    if (target.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    if (target[0].role === 'super_admin') {
      return res.json({ code: 403, message: '不能删除超级管理员' });
    }

    await pool.execute('DELETE FROM song_requests WHERE user_id = ?', [targetId]);
    await pool.execute('DELETE FROM posts WHERE user_id = ?', [targetId]);
    await pool.execute('DELETE FROM users WHERE id = ?', [targetId]);
    res.json({ code: 200, message: '用户已删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/users/:id/password', superAdminOnly, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const { new_password } = req.body;

    if (!new_password || new_password.length < 6) {
      return res.json({ code: 400, message: '密码至少6位' });
    }

    if (targetId === req.user.id) {
      return res.json({ code: 400, message: '请使用个人设置修改自己的密码' });
    }

    const [target] = await pool.execute('SELECT id FROM users WHERE id = ?', [targetId]);
    if (target.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, targetId]);
    res.json({ code: 200, message: '密码已重置' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});



router.get('/users/:id/profile', requirePermission('users:view'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [users] = await pool.execute(`
      SELECT id, username, nickname, avatar, email, role, status, created_at,
             ban_reason, ban_attempt_ip, ban_attempt_count
      FROM users WHERE id = ?
    `, [userId]);

    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }

    const user = users[0];

    let postCount = 0;
    try {
      const [posts] = await pool.execute('SELECT COUNT(*) as total FROM posts WHERE user_id = ?', [userId]);
      postCount = posts[0].total;
    } catch (e) {
    }
    user.post_count = postCount;

    let viewCount = 0;
    try {
      const [views] = await pool.execute('SELECT COUNT(*) as total FROM post_views WHERE user_id = ?', [userId]);
      viewCount = views[0].total;
    } catch (e) {
    }
    user.view_count = viewCount;

    res.json({ code: 200, data: user });
  } catch (err) {
    console.error('获取用户资料错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/login-as-user', superAdminOnly, async (req, res) => {
  try {
    var userId = parseInt(req.body.user_id);
    if (!userId) return res.json({ code: 400, message: '请提供用户ID' });
    var [users] = await pool.execute('SELECT id, username, nickname, role, avatar FROM users WHERE id = ?', [userId]);
    if (users.length === 0) return res.json({ code: 404, message: '用户不存在' });
    var user = users[0];
    var token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      code: 200,
      data: {
        token: token,
        user: {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          role: user.role,
          avatar: user.avatar
        }
      },
      message: '✅ 已登录到 ' + (user.nickname || user.username) + ' 的账号'
    });
  } catch (err) {
    console.error('[Admin] 登录用户账号失败:', err.message);
    res.json({ code: 500, message: '操作失败，请稍后重试' });
  }
});



module.exports = router;
