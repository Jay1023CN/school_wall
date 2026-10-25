const express = require('express');
const https = require('https');
const { pool } = require('../config/database');
const { getChinaDate, toChinaDate } = require('../services/date');

const router = express.Router();
const SITE_URL = (process.env.SITE_URL || 'https://campus.example.com').replace(/\/+$/, '');
const WEATHER_CACHE_MS = 3 * 60 * 1000;
const HISTORY_CACHE_MS = 5 * 60 * 1000;
let weatherCache = null;
let weatherCacheTime = 0;
let weatherRequest = null;
let historyCache = null;
let historyCacheTime = 0;
let historyRequest = null;
const SITE_INFO_CACHE_MS = 15 * 1000;
let siteInfoCache = null;
let siteInfoCacheTime = 0;
let siteInfoRequest = null;

const FESTIVAL_THEMES = new Set(['teachers_day', '520']);

function normalizeFestivalTheme(value) {
  if (value === 'back_to_school') return 'teachers_day';
  return FESTIVAL_THEMES.has(value) ? value : 'teachers_day';
}

function invalidateSiteInfoCache() {
  siteInfoCache = null;
  siteInfoCacheTime = 0;
  siteInfoRequest = null;
}

router.get('/site-info', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
  res.set('Vary', 'Accept-Encoding');

  if (siteInfoCache && Date.now() - siteInfoCacheTime < SITE_INFO_CACHE_MS) {
    return res.json(siteInfoCache);
  }

  if (siteInfoRequest) {
    try {
      return res.json(await siteInfoRequest);
    } catch (err) {
    }
  }

  siteInfoRequest = (async () => {
    const settingKeys = ['site_name', 'site_description', 'anon_post', 'anon_comment', 'anon_song', 'festival_theme', 'festival_enabled', 'special_mode_520'];
    const placeholders = settingKeys.map(() => '?').join(', ');
    const [rows] = await pool.execute(
      `SELECT config_key, config_value FROM settings WHERE config_key IN (${placeholders})`,
      settingKeys
    );
    const settings = {};
    rows.forEach(row => {
      settings[row.config_key] = row.config_value;
    });
    const festivalEnabled = Object.prototype.hasOwnProperty.call(settings, 'festival_enabled')
      ? settings.festival_enabled === 'true'
      : settings.special_mode_520 === 'true';
    const festivalTheme = Object.prototype.hasOwnProperty.call(settings, 'festival_theme')
      ? normalizeFestivalTheme(settings.festival_theme)
      : (settings.special_mode_520 === 'true' ? '520' : 'teachers_day');
    return {
      code: 200,
      data: {
        site_name: settings.site_name || '校园墙',
        site_description: settings.site_description || '',
        anon_post: settings.anon_post === 'true',
        anon_comment: settings.anon_comment === 'true',
        anon_song: settings.anon_song === 'true',
        festival_theme: festivalTheme,
        festival_mode: festivalEnabled,
        festival_enabled: festivalEnabled
      }
    };
  })();

  try {
    const payload = await siteInfoRequest;
    siteInfoCache = payload;
    siteInfoCacheTime = Date.now();
    return res.json(payload);
  } catch (err) {
    return res.json({
      code: 200,
      data: {
        site_name: '校园墙',
        site_description: '',
        anon_post: false,
        anon_comment: false,
        anon_song: false,
        festival_theme: 'teachers_day',
        festival_mode: false,
        festival_enabled: false
      }
    });
  } finally {
    siteInfoRequest = null;
  }
});

router.get('/profile/:id', async (req, res) => {
  try {
    const buildProfileQuery = (includeFollowCounts) => `
      SELECT
        u.id, u.username, u.nickname, u.avatar, u.role, u.created_at,
        u.gender, u.mbti, u.birthday, u.hobbies,
        (SELECT COUNT(*) FROM posts p
          WHERE p.user_id = u.id AND p.is_deleted = 0 AND p.status = 'approved') AS post_count,
        (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) AS comment_count,
        (SELECT COUNT(*) FROM likes l
          JOIN posts p ON p.id = l.post_id
          WHERE p.user_id = u.id AND p.is_deleted = 0) AS likes_count,
        (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) AS favorite_count,
        ${includeFollowCounts
          ? `(SELECT COUNT(*) FROM follows fw WHERE fw.following_id = u.id) AS followers_count,
        (SELECT COUNT(*) FROM follows fw WHERE fw.follower_id = u.id) AS following_count`
          : '0 AS followers_count, 0 AS following_count'}
      FROM users u
      WHERE u.id = ?
    `;

    let users;
    try {
      [users] = await pool.execute(buildProfileQuery(true), [req.params.id]);
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
      // Older schemas may not have follows yet; keep the legacy zero-count fallback.
      [users] = await pool.execute(buildProfileQuery(false), [req.params.id]);
    }
    if (users.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    const user = users[0];
    if (user.birthday) {
      const birthday = String(user.birthday);
      user.birthday = birthday.split('T')[0].split(' ')[0];
    }
    res.json({ code: 200, data: user });
  } catch (err) {
    console.error('获取用户信息错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/hotsearch', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.set('Vary', 'Accept-Encoding');

  const now = Date.now();
  if (historyCache && now - historyCacheTime < HISTORY_CACHE_MS) {
    return res.json(historyCache);
  }

  if (!historyRequest) {
    historyRequest = fetchJson('https://v2.xxapi.cn/api/history', 5000)
      .then(json => {
        if (json.code !== 200 || !Array.isArray(json.data) || json.data.length === 0) {
          throw new Error('历史数据格式错误');
        }
        return { code: 200, data: json.data.map(title => ({ title })) };
      })
      .catch(err => {
        console.error('历史上的今天 API 错误:', err.message);
        return buildFallbackHistory();
      })
      .then(payload => {
        historyCache = payload;
        historyCacheTime = Date.now();
        return payload;
      })
      .finally(() => {
        historyRequest = null;
      });
  }

  return res.json(await historyRequest);
});

function buildFallbackHistory() {
  const today = getChinaDate();
  const month = today.slice(5, 7);
  const day = today.slice(8, 10);
  const events = [
    `2023年${month}月${day}日 中国海军完成苏丹撤侨任务`,
    `2021年${month}月${day}日 中国空间站天和核心舱成功发射`,
    `2008年${month}月${day}日 北京奥运圣火在香港传递`
  ];
  return { code: 200, data: events.map(title => ({ title })) };
}

router.get('/weather', async (req, res) => {
  const latitudeText = String(process.env.WEATHER_LATITUDE || '').trim();
  const longitudeText = String(process.env.WEATHER_LONGITUDE || '').trim();
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  const city = String(process.env.WEATHER_CITY || '').trim();
  if (!city || !latitudeText || !longitudeText || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(503).json({ error: true, message: '天气位置尚未配置' });
  }
  const now = Date.now();
  if (weatherCache && now - weatherCacheTime < WEATHER_CACHE_MS) {
    return res.json(weatherCache);
  }
  if (!weatherRequest) {
    const apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto&forecast_days=1`;
    weatherRequest = fetchJson(apiUrl, 5000).then(data => {
      if (!data.current) throw new Error('天气数据格式错误');
      const temperature = Number(data.current.temperature_2m);
      const humidity = Number(data.current.relative_humidity_2m);
      const weatherCode = Number(data.current.weather_code);
      const windSpeed = Number(data.current.wind_speed_10m);
      if (![temperature, humidity, weatherCode, windSpeed].every(Number.isFinite)) {
        throw new Error('天气数据格式错误');
      }
      weatherCache = {
        current: {
          temperature_2m: Math.round(temperature),
          relative_humidity_2m: Math.round(humidity),
          weather_code: weatherCode,
          wind_speed_10m: Math.round(windSpeed)
        },
        city
      };
      weatherCacheTime = Date.now();
      return weatherCache;
    }).finally(() => {
      weatherRequest = null;
    });
  }
  try {
    return res.json(await weatherRequest);
  } catch (err) {
    if (weatherCache) return res.json(weatherCache);
    res.status(503).json({ error: true, message: '天气服务暂时不可用' });
  }
});

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('请求超时')));
    request.once('error', reject);
  });
}

router.get('/ip', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] || req.socket?.remoteAddress || req.ip || '';
  res.json({ ip: ip.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1') });
});

router.get('/sitemap.xml', async (req, res) => {
  try {
    const staticPages = [
      { loc: `${SITE_URL}/`, priority: 1.0, changefreq: 'daily' },
      { loc: `${SITE_URL}/radio`, priority: 0.9, changefreq: 'daily' },
      { loc: `${SITE_URL}/feedback`, priority: 0.7, changefreq: 'monthly' },
      { loc: `${SITE_URL}/agreement`, priority: 0.6, changefreq: 'monthly' },
      { loc: `${SITE_URL}/privacy`, priority: 0.6, changefreq: 'monthly' }
    ];
    const [posts] = await pool.execute(
      'SELECT id, updated_at FROM posts WHERE status = "approved" AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT 50000'
    );
    const date = getChinaDate();
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    staticPages.forEach(page => {
      xml += `  <url>\n    <loc>${escapeXml(page.loc)}</loc>\n    <lastmod>${date}</lastmod>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>\n`;
    });
    posts.forEach(post => {
      const mod = toChinaDate(post.updated_at) || date;
      xml += `  <url>\n    <loc>${escapeXml(`${SITE_URL}/post-detail.html?id=${post.id}`)}</loc>\n    <lastmod>${mod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
    });
    res.type('application/xml').send(`${xml}</urlset>`);
  } catch (err) {
    console.error('生成 sitemap 失败:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

function escapeXml(value) {
  return String(value).replace(/[<>&'\"]/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[char]));
}

router.invalidateSiteInfoCache = invalidateSiteInfoCache;

module.exports = router;
