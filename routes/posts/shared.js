const { pool } = require('../../config/database');
const { isStaffRole } = require('../../middleware/auth');

function wantsAnonymous(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function canViewIpRegion(req, ownerId) {
  return !!(req.user && (isStaffRole(req.user.role) || Number(req.user.id) === Number(ownerId)));
}

async function anonymousEnabled(key, executor = pool) {
  const [rows] = await executor.execute('SELECT config_value FROM settings WHERE config_key = ?', [key]);
  return rows.length > 0 && rows[0].config_value === 'true';
}

function normalizePostVideoUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  const pathname = String(value).split('?')[0];
  return /^\/uploads\/videos\/video_[A-Za-z0-9_-]+\.(?:mp4|webm|ogv)$/i.test(pathname) ? pathname : null;
}

function normalizePostVideoPosterUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  const pathname = String(value).split('?')[0];
  return /^\/uploads\/posts\/post_[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(pathname) ? pathname : null;
}

const ORDER_BY_WHITELIST = {
  latest: 'p.is_pinned DESC, p.created_at DESC',
  hot: 'p.is_pinned DESC, p.likes_count DESC, p.created_at DESC',
};
const ORDER_BY_MAP = ORDER_BY_WHITELIST;

function getTimeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + '天前';
  return date.toLocaleDateString('zh-CN');
}

module.exports = {
  anonymousEnabled,
  canViewIpRegion,
  getTimeAgo,
  normalizePostVideoPosterUrl,
  normalizePostVideoUrl,
  ORDER_BY_MAP,
  wantsAnonymous
};