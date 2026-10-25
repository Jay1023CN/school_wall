'use strict';

const assert = require('assert');
const Module = require('module');
const express = require('express');
const path = require('path');

const settings = { anon_post: 'false', anon_comment: 'false', post_review: 'false' };
let existingPostAnonymous = 0;
let profilePostCountFilterChecked = false;
let profileCommentCountFilterChecked = false;
let profileLikesFilterChecked = false;
let publicProfilePostsFilterChecked = false;
const writes = [];
const pool = {
  async getConnection() {
    let writeCheckpoint = writes.length;
    return {
      async beginTransaction() { writeCheckpoint = writes.length; },
      async commit() {},
      async rollback() { writes.splice(writeCheckpoint); },
      release() {},
      execute: (...args) => pool.execute(...args)
    };
  },
  async execute(sql, params) {
    if (sql.includes('FROM settings WHERE config_key = ?')) {
      const value = settings[params[0]];
      return [value === undefined ? [] : [{ config_value: value }]];
    }
    if (sql.includes('SELECT user_id, title, content') && sql.includes('FROM posts')) {
      return [[{ user_id: 7, title: '原帖', content: '正文', is_anonymous: existingPostAnonymous, is_deleted: 0 }]];
    }
    if (sql.includes('SELECT id FROM posts WHERE id = ? AND status = "approved"')) return [[{ id: 3 }]];
    if (sql.includes('SELECT c.id, c.user_id')) return [[{ id: 5, user_id: 7 }]];
    if (sql.includes('SELECT nickname, username FROM users')) return [[{ nickname: '测试用户' }]];
    if (sql.includes('SELECT id, username, nickname, avatar, role, created_at FROM users WHERE id = ?')) {
      return [[{ id: 8, username: 'public-user', nickname: '公开用户', avatar: '/avatar.png', role: 'user', created_at: new Date('2026-01-01') }]];
    }
    if (sql.includes('AS post_count') && sql.includes('AS comment_count')) {
      profilePostCountFilterChecked = sql.includes('p.is_anonymous = 0');
      profileCommentCountFilterChecked = sql.includes('c.is_anonymous = 0');
      profileLikesFilterChecked = sql.includes('p.is_anonymous = 0');
      return [[{ post_count: 2, comment_count: 3, likes_count: 4 }]];
    }
    if (sql.includes('SELECT COUNT(*) as total FROM posts WHERE user_id = ?')) {
      profilePostCountFilterChecked = sql.includes('is_anonymous = 0');
      return [[{ total: 2 }]];
    }
    if (sql.includes('SELECT COUNT(*) as total FROM comments WHERE user_id = ?')) {
      profileCommentCountFilterChecked = sql.includes('is_anonymous = 0');
      return [[{ total: 3 }]];
    }
    if (sql.includes('COALESCE(SUM(likes_count), 0) as total FROM posts')) {
      profileLikesFilterChecked = sql.includes('is_anonymous = 0');
      return [[{ total: 4 }]];
    }
    if (sql.includes('SELECT t.icon, t.title_name, t.title_color, t.title_bg')) return [[]];
    if (sql.includes('SELECT COUNT(*) as count FROM follows')) return [[{ count: 0 }]];
    if (sql.includes('SELECT p.id, p.title') && sql.includes('FROM posts p')) {
      publicProfilePostsFilterChecked = sql.includes('p.is_anonymous = 0');
      return [[]];
    }
    if (sql.includes('SELECT COUNT(*) as total FROM posts p WHERE')) return [[{ total: 0 }]];
    if (sql.includes('FROM favorites f') && sql.includes('JOIN posts p')) {
      return [[{ id: 44, user_id: 99, is_anonymous: 1, title: '匿名帖', content: '正文', images: null, video_url: null, video_poster: null, ip_region: null }]];
    }
    if (sql.includes('SELECT COUNT(*) as total FROM favorites f')) return [[{ total: 1 }]];
    if (sql.includes('SELECT post_id FROM likes WHERE user_id = ?')) return [[]];
    if (sql.includes('FROM follows f JOIN users u')) return [[]];
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
      writes.push({ sql, params });
      return [{ affectedRows: 1, insertId: 9 }];
    }
    throw new Error('Unexpected SQL: ' + sql);
  }
};

const routePath = require.resolve('../routes/posts');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && (parent.filename === routePath || parent.filename.includes(path.join('routes', 'posts')))) {
    if (request.endsWith('config/database')) return { pool };
    if (request.endsWith('middleware/auth')) {
      return { auth: (req, res, next) => { req.user = { id: 7, nickname: '测试用户' }; next(); }, optionalAuth: (req, res, next) => next(), isStaffRole: () => false };
    }
    if (request.endsWith('services/task-lifecycle')) return { createIntervalTask: () => ({ start() {}, stop() {} }) };
    if (request.endsWith('services/ip-lookup')) return { getIpRegion: async () => '', getClientIp: () => '127.0.0.1' };
    if (request.endsWith('services/email')) return { notifyNewComment() {}, notifyNewLike() {}, notifyMention() {}, notifyFollowPost() {}, notifyAdminNewPostPending() {} };
    if (request.endsWith('services/notification')) return { createNotification: async () => {} };
    if (request.endsWith('services/baidu-push')) return { pushPost() {} };
    if (request.endsWith('services/gamification')) return { adjustUserPoints: async () => {} };
    if (request.endsWith('services/async-utils')) return { runBackgroundTask() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let router;
try {
  router = require('../routes/posts');
} finally {
  Module._load = originalLoad;
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/posts', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, method, body) {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  }
  try {
    const postBody = { title: '新帖', content: '正文', is_anonymous: true };
    assert.equal((await request('/posts', 'POST', postBody)).code, 400, '关闭匿名时新帖必须被拒绝');
    assert.equal(writes.length, 0, '拒绝匿名发帖前不得写库');
    assert.equal((await request('/posts/3/comments', 'POST', { content: '评论', is_anonymous: true })).code, 400);
    assert.equal((await request('/posts/3/comments/5/replies', 'POST', { content: '回复', is_anonymous: true })).code, 400);
    assert.equal((await request('/posts/3', 'PUT', { is_anonymous: true })).code, 400, '编辑署名帖不得绕过匿名开关');
    assert.equal(writes.length, 0, '所有被拒绝的匿名请求均不得写库');

    existingPostAnonymous = 1;
    assert.equal((await request('/posts/3', 'PUT', { is_anonymous: true })).code, 200, '旧匿名帖编辑时应保留原有匿名身份');
    existingPostAnonymous = 0;
    assert.equal((await request('/posts', 'POST', { title: '署名帖', content: '正文', is_anonymous: false })).code, 200);
    assert(writes.some(item => item.sql.includes('INSERT INTO posts') && item.params[6] === 0), '署名发帖仍应正常写入');

    settings.anon_post = 'true';
    assert.equal((await request('/posts', 'POST', postBody)).code, 200, '开启匿名后应可正常发匿名帖');
    assert(writes.some(item => item.sql.includes('INSERT INTO posts') && item.params[6] === 1));
    delete settings.anon_post;
    assert.equal((await request('/posts', 'POST', postBody)).code, 400, '缺少匿名设置时应默认拒绝');

    const publicProfile = await request('/posts/users/8');
    assert.equal(publicProfile.data.post_count, 2);
    assert.equal(publicProfile.data.comment_count, 3);
    assert.equal(publicProfile.data.likes_count, 4);
    assert(profilePostCountFilterChecked && profileCommentCountFilterChecked && profileLikesFilterChecked,
      '公开资料统计不得把匿名帖子或评论归到用户身上');

    const publicPosts = await request('/posts?user_id=8');
    assert(publicProfilePostsFilterChecked, '按用户筛选的公开帖子查询必须排除匿名帖子');
    assert.equal(publicPosts.data.posts.length, 0, '个人主页列表不得返回该用户的匿名帖');

    const favorites = await request('/posts/user/favorites');
    assert.equal(favorites.data.posts[0].is_anonymous, 1);
    assert.equal(Object.hasOwn(favorites.data.posts[0], 'user_id'), false,
      '收藏列表不得向收藏者泄露匿名作者 ID');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('[anonymous-policy] 通过：匿名发布策略、公开个人主页隔离和匿名收藏作者 ID 保护');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
