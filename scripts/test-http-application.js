'use strict';

const assert = require('assert');
const jwt = require('jsonwebtoken');

async function main() {
  process.env.JWT_SECRET = 'example-http-only';
  process.env.WECHAT_SECRET = 'example-http-only';
  const roles = ['user', 'reviewer', 'radio_admin', 'admin', 'super_admin'];
  let unavailable = false;
  const postSearchQueries = [];
  let postOwnerId = 2;
  require.cache[require.resolve('../config/database')] = { loaded: true, exports: {
    initDB() { assert.fail('HTTP construction must not initialize the database'); },
    pool: { async execute(sql, params) {
      if (sql.includes('p.title LIKE ?')) postSearchQueries.push({ sql, params });
      if (unavailable) throw Object.assign(new Error('Fixture unavailable'), { code: 'FIXTURE' });
      if (sql === 'SELECT COUNT(*) as total FROM posts WHERE status = "pending" AND is_deleted = 0') return [[{ total: 7 }]];
      if (sql === 'SELECT COUNT(*) as total FROM song_requests WHERE status = "pending" AND deleted_at IS NULL') return [[{ total: 11 }]];
      if (sql === 'SELECT COUNT(*) as total FROM feedbacks WHERE status = "pending"') return [[{ total: 3 }]];
      if (sql.includes('COALESCE(SUM(role = "user")')) return [[{ total: '40', regular: '35' }]];
      if (sql.includes('as today FROM posts WHERE is_deleted = 0')) return [[{ total: '20', pending: '7', today: '2' }]];
      if (sql.includes('as today FROM song_requests WHERE deleted_at IS NULL')) return [[{ total: '30', pending: '11', today: '3' }]];
      if (sql.includes('SELECT COUNT(*) as total FROM post_views WHERE viewed_at')) return [[{ total: '15' }]];
      if (sql.includes('SELECT 1')) return [[{ ok: 1 }]];
      if (sql.includes('SELECT COUNT(*) as total FROM posts p')) return [[{ total: 1 }]];
      if (sql.includes('SELECT COUNT(*) as total FROM posts WHERE user_id = ?')) return [[{ total: 1 }]];
      if (sql.includes('SELECT COUNT(*) as total FROM favorites')) return [[{ total: 1 }]];
      if (sql.includes('FROM favorites f') && sql.includes('JOIN posts p')) return [[{
        id: 43, user_id: 2, title: 'favorite fixture', content: 'fixture', images: null,
        video_url: null, video_poster: null, created_at: new Date(), ip_region: '另一座城市', ip_address: '203.0.113.8'
      }]];
      if (sql.includes('SELECT post_id FROM favorites')) return [[{ post_id: 42 }]];
      if (sql.includes('FROM posts p') && sql.includes('WHERE p.user_id = ?')) return [[{
        id: 42, user_id: postOwnerId, title: 'fixture post', content: 'fixture', images: null,
        video_url: null, video_poster: null, is_anonymous: 0, category: '全部', likes_count: 0,
        comments_count: 1, views: 1, created_at: new Date(), ip_region: '示例市', ip_address: '203.0.113.2'
      }]];
      if (sql.includes('FROM posts p') && sql.includes('LIMIT ? OFFSET ?')) return [[{
        id: 42, title: 'fixture post', content: 'fixture', images: null, video_url: null, video_poster: null,
        is_anonymous: 0, category: '全部', likes_count: 0, comments_count: 1, views: 1,
        created_at: new Date(), ip_region: '示例市', ip_region_owner_id: postOwnerId, is_pinned: 0, poll_type: null,
        author_name: 'fixture', author_avatar: null, author_id: 2, author_role: 'user'
      }]];
      if (sql.includes('SELECT c.id, c.post_id') && (sql.includes('FROM comments c') || sql.includes('JOIN comments c'))) return [[{
        id: 11, post_id: 42, content: 'fixture comment', is_anonymous: 0, created_at: new Date(),
        ip_region: '另一座城市', ip_region_owner_id: 3, author_name: 'fixture comment author',
        author_avatar: null, author_id: 3, author_role: 'user'
      }]];
      if (sql.includes('FROM likes') && sql.includes('FROM favorites')) return [[{ post_id: 42, relation_type: 'favorite' }]];
      if (sql.includes('FROM favorites f') && sql.includes('JOIN posts p')) return [[{
        id: 42, user_id: 2, title: 'fixture favorite', content: 'fixture', images: null,
        video_url: null, video_poster: null, is_anonymous: 0, category: '全部', likes_count: 0,
        comments_count: 1, views: 1, created_at: new Date(), ip_region: '示例市', ip_address: '203.0.113.2',
        author_name: 'fixture', author_avatar: null, author_id: 2, author_role: 'user'
      }]];
      if (sql.includes('FROM user_title_relations') || sql.includes('FROM likes') || sql.includes('FROM favorites')) return [[]];
      if (sql.includes('FROM users WHERE id = ?')) {
        const id = Number(params[0]);
        return [[{ id, username: 'fixture', role: roles[id - 1], status: 1 }]];
      }
      throw new Error('Unexpected fixture SQL');
    } }
  } };
  const signalListeners = process.listenerCount('SIGTERM');
  const errorListeners = process.listenerCount('uncaughtException');
  const { createApp } = require('../app');
  const { API_ROUTES, registerApiRoutes } = require('../http/routes');
  const registered = [];
  registerApiRoutes({ use(prefix, router) { registered.push([prefix, router]); } }, { resolveRouter: path => path });
  assert.deepEqual(registered, API_ROUTES);
  assert.equal(API_ROUTES.length, 19);
  assert.equal(API_ROUTES[0][0], '/api/auth');
  assert.equal(API_ROUTES[API_ROUTES.length - 1][1], '../routes/deploy');
  const app = createApp({ middleware: { logging: false, allowedOrigins: ['https://example.invalid'] } });
  assert.equal(process.listenerCount('SIGTERM'), signalListeners);
  assert.equal(process.listenerCount('uncaughtException'), errorListeners);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (url, options) => fetch(base + url, options);
  try {
    for (const url of ['/radio', '/messages', '/post/42', '/admin/mp-draft']) {
      const response = await request(url);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get('cache-control'), /no-cache/);
      assert.match(response.headers.get('content-type'), /text\/html/);
      await response.arrayBuffer();
    }
    const adminPage = await request('/admin/');
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.headers.get('cache-control'), /public, max-age=300/);
    assert.match(adminPage.headers.get('content-type'), /text\/html/);
    await adminPage.arrayBuffer();
    const publicCss = await request('/css/style.css');
    assert.match(publicCss.headers.get('cache-control'), /max-age=300/);
    await publicCss.arrayBuffer();
    const adminCss = await request('/admin/css/admin.css');
    assert.match(adminCss.headers.get('cache-control'), /public, max-age=300/);
    await adminCss.arrayBuffer();

    assert.equal((await request('/api/health')).status, 200);
    const previousWeather = ['WEATHER_CITY', 'WEATHER_LATITUDE', 'WEATHER_LONGITUDE'].map(key => [key, process.env[key]]);
    try {
      for (const [key] of previousWeather) delete process.env[key];
      const noWeather = await request('/api/weather');
      assert.equal(noWeather.status, 503, '未配置位置时不能查询原站点天气');
      assert.equal((await noWeather.json()).error, true);
      process.env.WEATHER_CITY = '示例城市';
      process.env.WEATHER_LATITUDE = '100';
      process.env.WEATHER_LONGITUDE = '0';
      assert.equal((await request('/api/weather')).status, 503, '非法经纬度不得传给天气服务');
      assert.equal(await require('../services/mp-draft').getWeather(''), null, '公众号未配置城市时不请求第三方天气');
    } finally {
      for (const [key, value] of previousWeather) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }

    const publicPosts = await (await request('/api/posts?limit=1')).json();
    assert.equal(publicPosts.data.posts[0].author_id, 2, '公开作者 ID 继续用于公开主页卡片导航');
    assert.equal(Object.hasOwn(publicPosts.data.posts[0], 'ip_region'), false, '匿名访客不得读取其他作者的城市归属地');
    assert.equal(publicPosts.data.posts[0].preview_comments[0].ip_region, null, '匿名访客不得读取其他评论作者的城市归属地');
    postOwnerId = 1;
    const ownerPosts = await (await request('/api/posts?limit=1', {
      headers: { authorization: 'Bearer ' + jwt.sign({ id: 1 }, process.env.JWT_SECRET) }
    })).json();
    assert.equal(ownerPosts.data.posts[0].ip_region, '示例市', '作者本人仍可读取自己的城市归属地');
    assert.equal(ownerPosts.data.posts[0].preview_comments[0].ip_region, null, '作者不能读取其他评论者的城市归属地');
    const myPosts = await (await request('/api/posts/user/my?limit=1', {
      headers: { authorization: 'Bearer ' + jwt.sign({ id: 1 }, process.env.JWT_SECRET) }
    })).json();
    assert.equal(myPosts.data.posts[0].is_favorited, true, '我的帖子仍应返回真实收藏状态');
    assert.equal(myPosts.data.posts[0].ip_region, '示例市', '作者仍可查看自己帖子的城市归属地');
    assert.equal(Object.hasOwn(myPosts.data.posts[0], 'ip_address'), false, '我的帖子不得返回原始 IP');
    const favorites = await (await request('/api/posts/user/favorites', {
      headers: { authorization: 'Bearer ' + jwt.sign({ id: 1 }, process.env.JWT_SECRET) }
    })).json();
    assert.equal(Object.hasOwn(favorites.data.posts[0], 'ip_region'), false, '收藏列表不得泄漏其他作者的城市归属地');
    assert.equal(Object.hasOwn(favorites.data.posts[0], 'ip_address'), false, '收藏列表不得泄漏其他作者的原始 IP');
    const unauthorizedAdminApi = await request('/api/admin/my-permissions');
    assert.equal(unauthorizedAdminApi.status, 401);
    assert.match(unauthorizedAdminApi.headers.get('cache-control'), /no-store/);
    assert.equal((await request('/api/mp/extra-info')).status, 401);
    assert.equal((await request('/api/admin/login-as-user', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 2 }) })).status, 401);
    for (let id = 1; id <= roles.length; id++) {
      const headers = { authorization: 'Bearer ' + jwt.sign({ id }, process.env.JWT_SECRET) };
      const permissions = await request('/api/admin/my-permissions', { headers });
      assert.equal(permissions.status, id === 1 ? 403 : 200);
      if (id === 1 || id === 4) {
        const impersonation = await request('/api/admin/login-as-user', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ user_id: 2 })
        });
        assert.equal(impersonation.status, 403, '普通用户和普通管理员不得使用超级管理员代登录接口');
      }
      if (id > 1) assert.equal((await permissions.json()).data.role, roles[id - 1]);
      const overview = await request('/api/admin/stats', { headers });
      if (id === 3 || id === 5) {
        assert.equal(overview.status, 200);
        assert.deepEqual((await overview.json()).data, { totalUsers: 40, regularUsers: 35, totalPosts: 20, pendingPosts: 7, totalSongs: 30, pendingSongs: 11, todayPosts: 2, todaySongs: 3, todayPostViews: 15, pendingFeedbacks: 3 }, '合并统计仍应返回完整数字字段');
      } else assert.equal(overview.status, 403);
      const badges = await request('/api/admin/badges', { headers });
      assert.equal(badges.status, id === 1 ? 403 : 200);
      if (id > 1) {
        const counts = (await badges.json()).data;
        assert.equal(counts.pendingPosts, id === 3 ? 0 : 7, '广播管理员不得读取帖子审核数量');
        assert.equal(counts.pendingSongs, id === 2 ? 0 : 11, '审核员不得读取点歌审核数量');
        assert.equal(counts.pendingFeedbacks, id >= 4 ? 3 : 0, '只允许反馈管理员读取反馈数量');
      }
      if (id < 5) assert.equal((await request('/api/mp/extra-info', { headers })).status, 403);
    }

    const reviewerHeaders = { authorization: 'Bearer ' + jwt.sign({ id: 2 }, process.env.JWT_SECRET) };
    const searched = await request('/api/admin/posts?status=approved&keyword=42&page=2&limit=1', { headers: reviewerHeaders });
    assert.equal((await searched.json()).code, 200);
    assert.equal(postSearchQueries.length, 2, '搜索列表与总数都要使用相同条件');
    assert.deepEqual(postSearchQueries[0].params.slice(0, -2), postSearchQueries[1].params);
    assert.deepEqual(postSearchQueries[1].params, ['approved', '%42%', '%42%', '%42%', 42]);
    assert(postSearchQueries.every(item => item.sql.includes('LEFT JOIN users u') && item.sql.includes('p.is_deleted = 0') && item.sql.includes('p.id = ?')));
    assert.equal((await request('/api/admin/posts?keyword=' + 'a'.repeat(101), { headers: reviewerHeaders })).status, 400);
    assert.equal((await request('/api/admin/posts?keyword[x]=1', { headers: reviewerHeaders })).status, 400);

    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 200, '登录限流阈值内应交给登录校验处理');
    }
    const throttledLogin = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(throttledLogin.status, 429, '超过登录限流阈值必须返回真正的 HTTP 429');

    const captchaRouteResponse = await request('/api/auth/captcha');
    const captchaRouteBody = await captchaRouteResponse.json();
    assert.equal(captchaRouteResponse.status, 200);
    assert.deepEqual(Buffer.from(captchaRouteBody.data.captcha, 'base64').subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'HTTP 验证码必须以 PNG 栅格图返回');
    for (let attempt = 1; attempt < 30; attempt++) {
      const captchaResponse = await request('/api/auth/captcha');
      assert.equal(captchaResponse.status, 200, '验证码限流阈值内应允许取图');
      await captchaResponse.arrayBuffer();
    }
    assert.equal((await request('/api/auth/captcha')).status, 429, '超过验证码限流阈值必须返回真正的 HTTP 429');
    const cors = await request('/radio', { headers: { origin: 'https://example.invalid' } });
    assert.equal(cors.headers.get('access-control-allow-origin'), 'https://example.invalid');
    await cors.arrayBuffer();
    unavailable = true;
    assert.equal((await request('/api/health')).status, 503);
    const headers = { authorization: 'Bearer ' + jwt.sign({ id: 2 }, process.env.JWT_SECRET) };
    assert.equal((await request('/api/admin/my-permissions', { headers })).status, 503);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if (server.closeIdleConnections) server.closeIdleConnections();
    });
  }
  console.log('[http-application] 通过：19 个挂载项、页面别名、缓存头、跨域及匿名/五种角色/数据库错误状态');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
