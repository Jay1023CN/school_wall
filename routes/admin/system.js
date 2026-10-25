const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { getReleaseNotes } = require('../../services/release-notes');
const { getErrorDetail } = require('../../services/async-utils');
const { getIpRegion, normalizeIp } = require('../../services/ip-lookup');

const router = express.Router();
const DEPLOY_STATUS_FILE = path.resolve(
  process.env.DEPLOY_STATUS_FILE || path.join(__dirname, '..', '..', 'logs', 'deploy-status.json')
);
const APP_VERSION = require('../../package.json').version;

router.get('/my-permissions', (req, res) => {
  res.json({
    code: 200,
    data: {
      role: req.user.role,
      roleName: req.user.roleName,
      permissions: req.user.permissions
    }
  });
});

router.get('/deployment-status', requirePermission('settings:view'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const raw = JSON.parse(fs.readFileSync(DEPLOY_STATUS_FILE, 'utf8'));
    const status = {
      state: ['starting', 'running', 'success', 'failed', 'unknown'].includes(raw.state) ? raw.state : 'unknown',
      revision: typeof raw.revision === 'string' && /^[a-f0-9]{7,40}$/i.test(raw.revision) ? raw.revision : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
      appVersion: APP_VERSION
    };
    res.json({ code: 200, data: status });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return res.json({ code: 200, data: { state: 'unknown', revision: '', updatedAt: '', exitCode: null, appVersion: APP_VERSION } });
    }
    console.error('[admin] deployment status read failed:', getErrorDetail(err));
    res.status(500).json({ code: 500, message: '部署状态读取失败' });
  }
});

router.get('/release-notes', requirePermission('settings:view'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ code: 200, data: { notes: await getReleaseNotes() } });
  } catch (err) {
    console.error('[admin] release notes read failed:', getErrorDetail(err));
    res.status(500).json({ code: 500, message: '更新记录读取失败' });
  }
});

router.get('/editors', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, username, nickname, role FROM users WHERE role IN ('admin', 'super_admin') ORDER BY role DESC, id ASC`
    );
    res.json({ code: 200, data: rows || [] });
  } catch (err) {
    console.error('获取编辑列表失败:', getErrorDetail(err));
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

router.get('/badges', async (req, res) => {
  const can = permission => req.user.role === 'super_admin' || (req.user.permissions || []).includes(permission);
  const data = { pendingPosts: 0, pendingSongs: 0, pendingFeedbacks: 0 };
  const queries = [
    ['posts:review', 'pendingPosts', 'SELECT COUNT(*) as total FROM posts WHERE status = "pending" AND is_deleted = 0'],
    ['songs:review', 'pendingSongs', 'SELECT COUNT(*) as total FROM song_requests WHERE status = "pending" AND deleted_at IS NULL'],
    ['feedbacks:manage', 'pendingFeedbacks', 'SELECT COUNT(*) as total FROM feedbacks WHERE status = "pending"']
  ];
  try {
    await Promise.all(queries.filter(item => can(item[0])).map(async function(item) {
      const [rows] = await pool.execute(item[2]);
      data[item[1]] = Number(rows[0].total) || 0;
    }));
    res.json({ code: 200, data });
  } catch (error) {
    res.status(503).json({ code: 503, message: '待办数量暂时无法加载' });
  }
});

router.get('/stats', requirePermission('stats:view'), async (req, res) => {
  try {
    const [users, posts, songs, views, feedbacks] = await Promise.all([
      pool.execute('SELECT COUNT(*) as total, COALESCE(SUM(role = "user"), 0) as regular FROM users'),
      pool.execute('SELECT COUNT(*) as total, COALESCE(SUM(status = "pending"), 0) as pending, COALESCE(SUM(created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)), 0) as today FROM posts WHERE is_deleted = 0'),
      pool.execute('SELECT COUNT(*) as total, COALESCE(SUM(status = "pending"), 0) as pending, COALESCE(SUM(created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)), 0) as today FROM song_requests WHERE deleted_at IS NULL'),
      pool.execute('SELECT COUNT(*) as total FROM post_views WHERE viewed_at >= CURDATE() AND viewed_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)'),
      pool.execute('SELECT COUNT(*) as total FROM feedbacks WHERE status = "pending"').catch(() => [[{ total: 0 }]])
    ]);
    res.json({ code: 200, data: {
      totalUsers: Number(users[0][0].total) || 0,
      regularUsers: Number(users[0][0].regular) || 0,
      totalPosts: Number(posts[0][0].total) || 0,
      pendingPosts: Number(posts[0][0].pending) || 0,
      totalSongs: Number(songs[0][0].total) || 0,
      pendingSongs: Number(songs[0][0].pending) || 0,
      todayPosts: Number(posts[0][0].today) || 0,
      todaySongs: Number(songs[0][0].today) || 0,
      todayPostViews: Number(views[0][0].total) || 0,
      pendingFeedbacks: Number(feedbacks[0][0].total) || 0
    } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/lookup-ip', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!normalizeIp(ip)) return res.json({ code: 400, message: '请提供有效的 IP 地址' });
    const region = await getIpRegion(ip);
    res.json({ code: 200, data: { region: region || '未知' } });
  } catch (err) {
    console.error('[Admin] IP查询失败:', err.message);
    res.json({ code: 500, message: '查询失败，请稍后重试' });
  }
});

module.exports = router;
