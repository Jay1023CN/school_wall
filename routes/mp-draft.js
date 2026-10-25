
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const mpDraftService = require('../services/mp-draft');
const { createMpSyncJobs, ensureMpSyncSchema } = require('../services/mp-sync-jobs');
const { generateCoverPrompt } = require('../services/cover-prompt');
const { escapeHtml } = require('../services/html-utils');
const { auth, isStaff, superAdminOnly, requirePermission } = require('../middleware/auth');
const { getPagination } = require('../services/pagination');
const { getChinaDate, getChinaDayOfWeek } = require('../services/date');

function normalizeWeeklyPeriod(period) {
  return period === 'month'
    ? { key: 'month', days: 30, label: '本月' }
    : { key: 'week', days: 7, label: '本周' };
}

async function getActiveUsers(period, userIds, limit) {
  const normalized = normalizeWeeklyPeriod(period);
  const params = [];
  let userFilter = '';
  if (Array.isArray(userIds) && userIds.length > 0) {
    userFilter = ` AND u.id IN (${userIds.map(() => '?').join(',')})`;
    params.push(...userIds);
  }
  let limitSql = '';
  if (Number.isInteger(limit) && limit > 0) {
    limitSql = ' LIMIT ?';
    params.push(limit);
  }

  const [users] = await pool.execute(`
    SELECT u.id, u.nickname, u.username, u.avatar,
      COALESCE(pa.post_count, 0) AS post_count,
      COALESCE(ca.comment_count, 0) AS comment_count,
      (COALESCE(pa.likes_received, 0) + COALESCE(pa.post_comment_count, 0) + COALESCE(ca.comment_count, 0)) AS contribution_score
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS post_count,
        COALESCE(SUM(likes_count), 0) AS likes_received,
        COALESCE(SUM(comments_count), 0) AS post_comment_count
      FROM posts
      WHERE status = 'approved' AND is_deleted = 0
        AND created_at >= DATE_SUB(NOW(), INTERVAL ${normalized.days} DAY)
      GROUP BY user_id
    ) pa ON pa.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS comment_count
      FROM comments
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${normalized.days} DAY)
      GROUP BY user_id
    ) ca ON ca.user_id = u.id
    WHERE u.role = 'user'
      AND (COALESCE(pa.post_count, 0) > 0 OR COALESCE(ca.comment_count, 0) > 0)
      ${userFilter}
    ORDER BY contribution_score DESC, post_count DESC, comment_count DESC
    ${limitSql}
  `, params);
  return { users, period: normalized };
}

function renderWechatVideoCard(post) {
  if (!post || !post.video_url) return '';
  const postUrl = `https://campus.example.com/post/${encodeURIComponent(post.id)}`;
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;"><tr><td style="background:#F3F0FF;padding:16px;text-align:center;border:1px solid #E7DEFF;">' +
    '<div style="font-size:22px;margin-bottom:6px;">🎬</div>' +
    '<div style="font-size:15px;font-weight:bold;color:#6554C0;margin-bottom:6px;">本帖包含视频</div>' +
    '<div style="font-size:12px;color:#888;line-height:1.7;margin-bottom:10px;">公众号草稿不直接嵌入站外视频，点击下方按钮可在校墙播放</div>' +
    '<a href="' + postUrl + '" style="display:inline-block;background:#7259D9;color:#fff;text-decoration:none;padding:9px 18px;border-radius:18px;font-size:13px;">▶ 打开原帖播放视频</a>' +
    '</td></tr></table>';
}

const DAILY_SONG_REUSE_DAYS = 3;
const DAILY_SONG_REUSE_MS = DAILY_SONG_REUSE_DAYS * 24 * 60 * 60 * 1000;

function normalizeDailySongIds(value) {
  if (value == null) return { ok: true, ids: [] };
  if (!Array.isArray(value) || value.length > 50) return { ok: false, ids: [] };

  const ids = [];
  const seen = new Set();
  for (const valueId of value) {
    if (!Number.isSafeInteger(valueId) || valueId <= 0 || seen.has(valueId)) {
      return { ok: false, ids: [] };
    }
    seen.add(valueId);
    ids.push(valueId);
  }
  return { ok: true, ids };
}

function isDailySongCandidate(song, now) {
  if (!song) return false;
  if (song.candidate_hidden_at) return false;
  if (song.status === 'pending') return true;
  if (song.status !== 'published') return false;
  const publishedAt = new Date(song.published_at || song.created_at || 0).getTime();
  return Number.isFinite(publishedAt) && publishedAt >= now.getTime() - DAILY_SONG_REUSE_MS;
}

function dailySongCandidateSql(alias) {
  const prefix = alias ? alias + '.' : '';
  return `${prefix}candidate_hidden_at IS NULL AND (${prefix}status = 'pending' OR (${prefix}status = 'published' AND COALESCE(${prefix}published_at, ${prefix}created_at) >= DATE_SUB(NOW(), INTERVAL ${DAILY_SONG_REUSE_DAYS} DAY)))`;
}

async function getSyncableDailySongs(dbPool, ids, article) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [songs] = await dbPool.execute(
    `SELECT id, song_name, status, published_at FROM daily_song_recs WHERE id IN (${placeholders}) AND ${dailySongCandidateSql()}`,
    ids
  );
  if (songs.length !== ids.length) {
    const error = new Error('存在不存在、已超过三天复用期或不可同步的每日推歌');
    error.code = 'DAILY_SONG_NOT_SYNCABLE';
    throw error;
  }

  const articleText = [article.title, article.digest, article.content].filter(Boolean).join('\n');
  const absentSong = songs.find(song => {
    const songName = String(song.song_name || '');
    return !songName || (articleText.indexOf(songName) < 0 && articleText.indexOf(escapeHtml(songName)) < 0);
  });
  if (absentSong) {
    const error = new Error('每日推歌“' + absentSong.song_name + '”不在本次同步文章中');
    error.code = 'DAILY_SONG_NOT_IN_ARTICLE';
    throw error;
  }
  return songs;
}

function createDailySongMarkConflict(requested, affected) {
  const error = new Error('每日推歌状态已变化，仅成功标记 ' + affected + '/' + requested + ' 首；请刷新候选列表，勿重复同步已创建草稿');
  error.code = 'DAILY_SONG_MARK_CONFLICT';
  error.requested = requested;
  error.affected = affected;
  error.markResult = { requested, affected, changed: affected, affectedRows: affected };
  return error;
}

async function markDailySongsPublished(dbPool, ids) {
  if (!ids.length) return { requested: 0, affected: 0, changed: 0, affectedRows: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const updateSql = `UPDATE daily_song_recs
     SET status = 'published',
         published_at = COALESCE(published_at, NOW())
     WHERE id IN (${placeholders})
       AND candidate_hidden_at IS NULL
       AND status IN ('pending', 'published')`;

  if (typeof dbPool.getConnection === 'function') {
    const connection = await dbPool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const [rows] = await connection.execute(
        `SELECT id FROM daily_song_recs
         WHERE id IN (${placeholders})
           AND candidate_hidden_at IS NULL
           AND (status = 'pending' OR (status = 'published' AND COALESCE(published_at, created_at) >= DATE_SUB(NOW(), INTERVAL ${DAILY_SONG_REUSE_DAYS} DAY)))
         FOR UPDATE`,
        ids
      );
      const affected = Array.isArray(rows) ? rows.length : 0;
      if (affected !== ids.length) throw createDailySongMarkConflict(ids.length, affected);
      const [result] = await connection.execute(updateSql, ids);
      await connection.commit();
      transactionStarted = false;
      const changed = Number(result && result.affectedRows) || 0;
      return { requested: ids.length, affected, changed, affectedRows: changed };
    } catch (err) {
      if (transactionStarted) {
        try { await connection.rollback(); } catch (rollbackError) {}
      }
      throw err;
    } finally {
      connection.release();
    }
  }

  const [result] = await dbPool.execute(updateSql, ids);
  const affected = Number(result && result.affectedRows) || 0;
  if (affected !== ids.length) throw createDailySongMarkConflict(ids.length, affected);
  return { requested: ids.length, affected, changed: affected, affectedRows: affected };
}

async function finalizeDailySongSync(createDraft, markPublished, articles, dailySongIds) {
  const mediaId = await createDraft(articles);
  try {
    if (dailySongIds.length) {
      const markResult = await markPublished(dailySongIds);
      if (!markResult || markResult.affected !== dailySongIds.length) {
        throw createDailySongMarkConflict(
          dailySongIds.length,
          markResult && Number.isSafeInteger(markResult.affected) ? markResult.affected : 0
        );
      }
    }
  } catch (err) {
    err.draftCreated = true;
    err.mediaId = mediaId;
    err.dailySongIds = dailySongIds.slice();
    if (!err.code) err.code = 'DAILY_SONG_MARK_FAILED';
    throw err;
  }
  return mediaId;
}

function formatDraftCreatedMarkFailure(err) {
  const mark = err && err.markResult;
  if (mark && Number.isSafeInteger(mark.requested) && Number.isSafeInteger(mark.affected)) {
    return '草稿已创建，但每日推歌状态只更新了 ' + mark.affected + '/' + mark.requested + ' 首；请刷新候选列表核对，勿重复同步此草稿';
  }
  return '草稿已创建，但每日推歌状态更新未确认；请先刷新候选列表和公众号草稿箱，勿重复同步此草稿';
}

function mpEscape(value) {
  return escapeHtml(value == null ? '' : String(value));
}

function addBusinessDays(dateValue, offsetDays) {
  const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + offsetDays));
  return date.toISOString().slice(0, 10);
}

function formatMonthDay(dateValue) {
  const match = String(dateValue || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? (Number(match[1]) + '月' + Number(match[2]) + '日') : '';
}

function getWeeklySongScheduleRange() {
  const weekStart = addBusinessDays(getChinaDate(), 1 - getChinaDayOfWeek(getChinaDate()));
  const weekEnd = addBusinessDays(weekStart, 7);
  return { weekStart, weekEnd, scheduleStart: weekStart, weekOffset: 0, periodLabel: '本周',
    label: formatMonthDay(weekStart) + '—' + formatMonthDay(addBusinessDays(weekEnd, -1)) };
}

router.use(auth, isStaff, superAdminOnly);

router.post('/cover-prompt', requirePermission('songs:review'), async (req, res) => {
  try {
    const data = await generateCoverPrompt(req.body);
    res.json({ code: 200, data: data });
  } catch (err) {
    const status = Number(err.status) || 502;
    if (status >= 500) console.error('[AI] 生成封面提示词失败:', err.message);
    res.status(status).json({ code: status, message: err.message || '封面提示词生成失败，请稍后重试' });
  }
});

router.get('/hot-posts', async (req, res) => {
  try {
    let hours = parseInt(req.query.hours);
    if (isNaN(hours)) hours = 24;
    if (hours < 0) hours = 24;
    if (hours > 24 * 30) hours = 24 * 30;
    const limit = getPagination(req.query, { defaultLimit: 10, maxLimit: 50 }).limit;

    let timeCondition = '';
    let params = [limit];
    if (hours > 0) {
      timeCondition = 'AND p.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)';
      params.unshift(hours);
    }

    const [posts] = await pool.execute(`
      SELECT 
        p.id, p.title, p.content, p.created_at, p.likes_count,
        p.views as view_count,
        CASE WHEN p.is_anonymous = 1 THEN '匿名用户' ELSE COALESCE(u.nickname, u.username, '同学') END AS author,
        p.is_anonymous,
        COUNT(DISTINCT c.id) as comment_count,
        p.images, p.video_url, p.video_poster
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved' AND p.is_deleted = 0
        ${timeCondition}
      GROUP BY p.id
      ORDER BY (p.likes_count * 2 + COUNT(DISTINCT c.id) * 3 + COALESCE(p.views, 0) * 0.1) DESC
      LIMIT ?
    `, params);

    res.json({
      code: 200,
      data: posts,
      message: hours > 0 ? `获取最近${hours}小时的${posts.length}条热门帖子` : `获取全站${posts.length}条精华帖`
    });
  } catch (err) {
    console.error('[MP素材] 获取热点帖子失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

router.get('/weekly-star', async (req, res) => {
  try {
    const result = await getActiveUsers(req.query.period, null, 5);
    
    res.json({
      code: 200,
      data: result.users,
      period: result.period.key,
      message: result.period.label + '活跃用户TOP5'
    });
  } catch (err) {
    console.error('[MP素材] 获取每周之星失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

router.get('/today-history-posts', async (req, res) => {
  try {
    const limit = getPagination(req.query, { defaultLimit: 5, maxLimit: 50 }).limit;
    
    const [posts] = await pool.execute(`
      SELECT 
        p.id, p.title, p.content, p.created_at, p.likes_count,
        p.views as view_count,
        CASE WHEN p.is_anonymous = 1 THEN '匿名用户' ELSE COALESCE(u.nickname, u.username, '同学') END AS author,
        p.is_anonymous,
        YEAR(p.created_at) as post_year,
        COUNT(DISTINCT c.id) as comment_count,
        p.images, p.video_url, p.video_poster
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved' AND p.is_deleted = 0
        AND MONTH(p.created_at) = MONTH(CURDATE())
        AND DAY(p.created_at) = DAY(CURDATE())
        AND YEAR(p.created_at) < YEAR(CURDATE())
      GROUP BY p.id
      ORDER BY p.likes_count DESC, p.created_at DESC
      LIMIT ?
    `, [limit]);
    
    res.json({
      code: 200,
      data: posts,
      message: `找到 ${posts.length} 条历史同日帖子`
    });
  } catch (err) {
    console.error('[MP素材] 获取历史同日帖子失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

router.get('/extra-info', async (req, res) => {
  try {
    const [weather, hitokoto, dateInfo] = await Promise.all([
      mpDraftService.getWeather(),
      mpDraftService.getHitokoto(),
      Promise.resolve(mpDraftService.getDateInfo())
    ]);

    res.json({
      code: 200,
      data: { weather, hitokoto, dateInfo },
      message: '获取成功'
    });
  } catch (err) {
    console.error('[MP素材] 获取辅助信息失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

async function uploadImagesToWeixin(htmlContent, beforeExternal) {
  var imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
  var match;
  var tasks = [];
  var seen = new Set();
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    var originalSrc = match[1];
    if (originalSrc.indexOf('mmbiz.qpic.cn') >= 0 || originalSrc.indexOf('mmbiz.qlogo.cn') >= 0 || originalSrc.startsWith('data:')) continue;
    if (!seen.has(originalSrc)) {
      seen.add(originalSrc);
      tasks.push({ original: originalSrc, upload: originalSrc });
    }
  }
  if (tasks.length === 0) return { content: htmlContent, total: 0, uploaded: 0, failed: 0 };

  var uploadResults = new Array(tasks.length);
  var nextTask = 0;
  var workerCount = Math.min(3, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, async function() {
    while (true) {
      var index = nextTask++;
      if (index >= tasks.length) return;
      var task = tasks[index];
      try {
        if (typeof beforeExternal === 'function') await beforeExternal();
        var url = await mpDraftService.uploadMpImage(task.upload);
        uploadResults[index] = { status: 'fulfilled', value: { original: task.original, url: url } };
      } catch (reason) {
        uploadResults[index] = { status: 'rejected', reason: reason };
      }
    }
  }));
  var uploadedCount = 0;
  var failures = [];
  uploadResults.forEach(function(r, idx) {
    if (r.status === 'fulfilled' && r.value && r.value.url) {
      htmlContent = htmlContent.split(r.value.original).join(r.value.url);
      uploadedCount++;
    } else if (r.status === 'rejected') {
      console.warn('[MP图片] 第' + (idx+1) + '张失败:', r.reason && r.reason.message);
      failures.push('第' + (idx + 1) + '张：' + ((r.reason && r.reason.message) || '上传失败'));
    }
  });
  if (failures.length > 0) {
    throw new Error('有 ' + failures.length + ' 张正文图片上传失败，已停止创建草稿；' + failures.slice(0, 3).join('；'));
  }
  return { content: htmlContent, total: tasks.length, uploaded: uploadedCount, failed: 0 };
}

async function prepareArticleForWeixin(article, onVideoProgress, beforeExternal) {
  var articleCopy = mpDraftService.normalizeDraftArticle(JSON.parse(JSON.stringify(article)));
  var videoUpload = await uploadVideosToWeixin(articleCopy.content || '', onVideoProgress, beforeExternal);
  articleCopy.content = videoUpload.content;

  var imageUpload = await uploadImagesToWeixin(articleCopy.content, beforeExternal);
  articleCopy.content = imageUpload.content;
  articleCopy.text_stats = mpDraftService.getArticleTextStats(articleCopy);

  return {
    article: articleCopy,
    video: videoUpload.result,
    image: {
      total: imageUpload.total,
      success: imageUpload.uploaded,
      failed: imageUpload.failed
    }
  };
}

const PUBLIC_WALL_ORIGIN = (process.env.PUBLIC_WALL_ORIGIN || 'https://campus.example.com').replace(/\/$/, '');

function getPostVideoUrl(value) {
  var pathname = getControlledPostVideoPath(value);
  if (!pathname) return '';
  return PUBLIC_WALL_ORIGIN + pathname;
}

function getPublicAssetPath(value, pattern) {
  var raw = String(value || '').trim();
  var pathname = raw.split('?')[0];
  if (/^https?:\/\//i.test(raw)) {
    try { pathname = new URL(raw).pathname; } catch (e) { return ''; }
  }
  return pattern.test(pathname) ? pathname : '';
}

function getPostVideoPath(value) {
  return getControlledPostVideoPath(value);
}

function getControlledPostVideoPath(value) {
  var raw = String(value || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      if (new URL(raw).origin !== new URL(PUBLIC_WALL_ORIGIN).origin) return '';
    } catch (e) {
      return '';
    }
  }
  return getPublicAssetPath(raw, /^\/uploads\/videos\/video_[A-Za-z0-9_-]+\.(?:mp4|webm|ogv)$/i);
}

function getPostPosterUrl(value) {
  var pathname = getPublicAssetPath(value, /^\/uploads\/posts\/post_[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|webp)$/i);
  if (!pathname) return '';
  return PUBLIC_WALL_ORIGIN + pathname;
}

async function uploadVideosToWeixin(htmlContent, onProgress, beforeExternal) {
  var videoRegex = /<video\b([^>]*)>[\s\S]*?<\/video>|<div\b([^>]*data-mp-video-placeholder=["']1["'][^>]*)>[\s\S]*?<\/div>/gi;
  var matches = [];
  var match;
  while ((match = videoRegex.exec(htmlContent)) !== null) matches.push(match);

  var result = { total: matches.length, success: 0, failed: 0, items: [] };
  if (matches.length === 0) return { content: htmlContent, result: result };

  var output = '';
  var cursor = 0;
  for (var i = 0; i < matches.length; i++) {
    var current = matches[i];
    var attrs = current[1] || current[2] || '';
    var source = getPostVideoPath(readHtmlAttribute(attrs, 'src'));
    var posterUrl = getPostPosterUrl(readHtmlAttribute(attrs, 'poster'));
    if (!source) source = getPostVideoPath(readHtmlAttribute(attrs, 'data-mp-video-source'));
    if (!posterUrl) posterUrl = getPostPosterUrl(readHtmlAttribute(attrs, 'data-mp-video-poster'));
    var following = htmlContent.substring(current.index + current[0].length, current.index + current[0].length + 1200);
    var viewUrl = getPostViewUrl(readHtmlAttribute(attrs, 'data-mp-video-view')) || getPostViewUrl(readHtmlAttribute(following, 'href')) || (source ? PUBLIC_WALL_ORIGIN + source : PUBLIC_WALL_ORIGIN);
    var item = { index: i + 1, status: 'failed', message: '' };
    var replacement;

    try {
      if (!source) throw new Error('视频地址不是校墙受控上传路径');
      if (typeof beforeExternal === 'function') await beforeExternal();
      await mpDraftService.uploadPermanentVideo(source, {
        title: '校墙投稿视频',
        introduction: '来自校墙的投稿视频，正文保留站内观看入口'
      });
      result.success++;
      item.status = 'success';
      item.message = '视频已上传到公众号永久素材';
      replacement = buildSyncedVideoHTML(posterUrl, viewUrl, true, '视频已同步到公众号素材库');
    } catch (error) {
      result.failed++;
      item.code = error && error.code ? String(error.code).substring(0, 64) : 'MP_VIDEO_UPLOAD_FAILED';
      item.message = error && error.message ? String(error.message).substring(0, 160) : '视频上传失败';
      result.errors = result.errors || [];
      result.errors.push({ index: item.index, code: item.code, message: item.message });
      replacement = buildSyncedVideoHTML(posterUrl, viewUrl, false, '视频上传失败，已保留站内观看入口：' + item.message);
    }
    result.items.push(item);
    output += htmlContent.substring(cursor, current.index) + replacement;
    cursor = current.index + current[0].length;
    if (typeof onProgress === 'function') await onProgress(result);
  }
  output += htmlContent.substring(cursor);
  return { content: output, result: result };
}

function formatVideoFailureDetails(videoResult) {
  var errors = videoResult && Array.isArray(videoResult.errors) ? videoResult.errors : [];
  if (errors.length === 0 && videoResult && Array.isArray(videoResult.items)) {
    errors = videoResult.items.filter(function(item) { return item && item.status === 'failed'; });
  }
  return errors.slice(0, 3).map(function(item) {
    var prefix = '视频' + (item.index || '') + (item.code ? ' [' + item.code + ']' : '');
    return prefix + '：' + (item.message || '视频处理失败');
  }).join('；');
}

function readHtmlAttribute(html, attribute) {
  var expression = new RegExp('\\b' + attribute + '\\s*=\\s*["\\\']([^"\\\']+)["\\\']', 'i');
  var match = expression.exec(String(html || ''));
  return match ? match[1] : '';
}

function getPostViewUrl(value) {
  var pathname = getPublicAssetPath(value, /^\/post\/\d+$/);
  return pathname ? PUBLIC_WALL_ORIGIN + pathname : '';
}

function buildSyncedVideoHTML(posterUrl, viewUrl, uploaded, message) {
  var cover = posterUrl
    ? '<img src="' + escapeHtml(posterUrl) + '" alt="视频封面" style="display:block;width:100%;max-height:360px;object-fit:cover;border-radius:9px;background:#172c2a;">'
    : '<div style="display:flex;align-items:center;justify-content:center;min-height:120px;border-radius:9px;background:#172c2a;color:#fff;font-size:38px;">🎬</div>';
  var color = uploaded ? '#2e9b68' : '#c47a00';
  return '<div data-mp-video-status="' + (uploaded ? 'success' : 'failed') + '" style="margin:14px 0;padding:12px;background:#f7f8fc;border-radius:12px;border:1px solid #ececf5;">' +
    cover +
    '<div style="margin-top:8px;font-size:13px;line-height:1.7;color:' + color + ';">' + (uploaded ? '✅ ' : '⚠️ ') + escapeHtml(message) + '</div>' +
    '<div style="margin-top:5px;text-align:center;font-size:12px;line-height:1.6;"><a href="' + escapeHtml(viewUrl) + '" style="color:#667eea;text-decoration:none;">点击打开校墙观看视频 →</a></div>' +
    '</div>';
}

function buildPostVideoHTML(post) {
  var videoUrl = getPostVideoUrl(post && post.video_url);
  if (!videoUrl) return '';
  var posterUrl = getPostPosterUrl(post && post.video_poster);
  var articleUrl = /^\d+$/.test(String(post && post.id || '')) ? PUBLIC_WALL_ORIGIN + '/post/' + String(post.id) : videoUrl;
  var cover = posterUrl ? '<img src="' + escapeHtml(posterUrl) + '" alt="视频封面" style="display:block;width:100%;max-height:360px;object-fit:cover;border-radius:9px;background:#172c2a;">' : '🎬 ';
  return '<div data-mp-video-placeholder="1" data-mp-video-source="' + escapeHtml(videoUrl) + '" data-mp-video-poster="' + escapeHtml(posterUrl) + '" data-mp-video-view="' + escapeHtml(articleUrl) + '" style="margin:14px 0;padding:12px;background:#f7f8fc;border-radius:12px;border:1px solid #ececf5;text-align:center;">' +
    cover +
    '<br><span style="font-size:13px;color:#667eea;font-weight:600;">🎬 视频投稿 · 同步时上传公众号永久 MP4 素材</span><br>' +
    '<a href="' + escapeHtml(articleUrl) + '" style="color:#667eea;text-decoration:none;font-size:12px;line-height:1.6;">播放器无法显示？点击打开视频页面 →</a>' +
    '</div>';
}

function formatRichTextInline(text) {
  var safe = mpEscape(String(text || ''));
  return safe
    .replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
}

function autoFormatContent(text) {
  if (!text) return '';
  var blocks = [];

  var byDoubleNewline = text.split(/\n\s*\n/);
  if (byDoubleNewline.length > 1) {
    blocks = byDoubleNewline;
  } else {
    var byNewline = text.split(/\n/);
    if (byNewline.length > 1) {
      blocks = byNewline;
    } else {
      var raw = text;
      var sentences = [];
      var buffer = '';
      for (var k = 0; k < raw.length; k++) {
        buffer += raw[k];
        if (/[。！？；;!?]/.test(raw[k])) {
          sentences.push(buffer);
          buffer = '';
        }
      }
      if (buffer.trim()) sentences.push(buffer);
      if (sentences.length === 0) sentences = [text];

      for (var g = 0; g < sentences.length; g += 3) {
        blocks.push(sentences.slice(g, g + 3).join(''));
      }
    }
  }

  return blocks.filter(function(b) { return b.trim(); }).map(function(b) {
    return '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#444;margin-top:0;letter-spacing:0.5px;">' + formatRichTextInline(b.trim()) + '</p>';
  }).join('\n');
}

function generateTextStatsHTML(readMinutes, postCount) {
  var html = '<!-- mp-text-stats-start --><table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;table-layout:fixed;border-collapse:collapse;"><tr><td style="background:#FFFFF0;padding:12px;border-radius:10px;">';
  html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100% !important;table-layout:fixed;border-collapse:collapse;"><tr>';
  html += '<td width="31.33%" style="width:31.33% !important;text-align:center;padding:6px 0;border-right:1px dashed #E8D5B5;overflow:hidden;"><div style="font-size:15px;font-weight:bold;color:#D4876A;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">__MP_VISIBLE_TEXT_COUNT__</div><div style="font-size:11px;color:#756b78;margin-top:3px;white-space:nowrap;">全文字数</div></td>';
  html += '<td width="3%" style="width:3% !important;padding:0;font-size:0;line-height:0;">&nbsp;</td>';
  html += '<td width="31.33%" style="width:31.33% !important;text-align:center;padding:6px 0;border-right:1px dashed #E8D5B5;overflow:hidden;"><div style="font-size:15px;font-weight:bold;color:#8A5AA8;line-height:1.2;white-space:nowrap;">' + readMinutes + '</div><div style="font-size:11px;color:#756b78;margin-top:3px;white-space:nowrap;">阅读分钟</div></td>';
  html += '<td width="3%" style="width:3% !important;padding:0;font-size:0;line-height:0;">&nbsp;</td>';
  html += '<td width="31.33%" style="width:31.33% !important;text-align:center;padding:6px 0;overflow:hidden;"><div style="font-size:15px;font-weight:bold;color:#C23F78;line-height:1.2;white-space:nowrap;">' + postCount + '</div><div style="font-size:11px;color:#756b78;margin-top:3px;white-space:nowrap;">精选帖子</div></td>';
  html += '</tr></table></td></tr></table><!-- mp-text-stats-end -->';
  return html;
}

function generateWeatherMetaHTML(value, icon) {
  var clean = String(value || '').trim();
  var content = clean ? (icon + ' ' + mpEscape(clean)) : '&nbsp;';
  return '<div style="font-size:11px;color:#999;margin-top:4px;line-height:16px;min-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + content + '</div>';
}

function generateCardHTML(posts, weather, hitokoto, dateInfo, stats, categories, songs, todayHistory, weeklyStar, commentsByPost, includeGaokao, dailySongs, includeSongs, articleTitle) {
  const today = dateInfo.date;
  const week = dateInfo.week;
  const safeArticleTitle = mpEscape(articleTitle || '校园来信');

  var html = '';
  html += '<div style="padding:6px 0;">';

  html += '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:22px 16px 18px;text-align:center;">';
  html += '<div style="color:#A78BFA;font-size:13px;margin-bottom:6px;letter-spacing:1px;">校园墙 · 校园来信</div>';
  html += '<div style="color:#FF69B4;font-size:22px;font-weight:bold;letter-spacing:0.5px;line-height:1.45;">' + safeArticleTitle + '</div>';
  html += '<div style="color:#999;font-size:12px;margin-top:8px;">' + mpEscape(today) + ' ' + mpEscape(week) + ' · 把今天的校园日常，写给你</div>';
  html += '<div style="width:40px;height:3px;background:linear-gradient(90deg,#FFB6C1,#A78BFA);margin:14px auto 0;"></div>';
  html += '</td></tr></table>';

  var totalChars = 0;
  for (var pc = 0; pc < posts.length; pc++) {
    totalChars += (posts[pc].content || '').replace(/\s/g, '').length;
  }
  var readMinutes = Math.max(1, Math.ceil(totalChars / 300));
  html += generateTextStatsHTML(readMinutes, posts.length);

  if (weather && weather.temperature) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:linear-gradient(135deg,#E8F4FD,#E0F0FF);padding:16px;">';
    html += '<div style="font-size:13px;color:#666;margin-bottom:10px;font-weight:600;">☁️ ' + mpEscape(weather.city || '') + ' 校园天气</div>';
    html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100% !important;table-layout:fixed;border-collapse:collapse;"><tr>';
    html += '<td width="48%" style="width:48% !important;vertical-align:top;text-align:center;padding:0;overflow:hidden;">';
    html += '<div style="box-sizing:border-box;overflow:hidden;padding:8px 2px;border-right:1px dashed #B0D4F1;">';
    html += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">今日</div>';
    html += '<div style="font-size:17px;font-weight:bold;color:#4A90D9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mpEscape(weather.icon || '☀️') + ' ' + mpEscape(weather.temperature || '') + '</div>';
    html += '<div style="font-size:12px;color:#666;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mpEscape(weather.weather || '') + '</div>';
    html += generateWeatherMetaHTML(weather.wind, '💨');
    html += generateWeatherMetaHTML(weather.humidity, '💧');
    html += '</div></td><td width="4%" style="width:4% !important;padding:0;font-size:0;line-height:0;">&nbsp;</td>';
    if (weather.tomorrow) {
      html += '<td width="48%" style="width:48% !important;vertical-align:top;text-align:center;padding:0;overflow:hidden;">';
      html += '<div style="box-sizing:border-box;overflow:hidden;padding:8px 2px;">';
      html += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">明日 ' + mpEscape(weather.tomorrow.week || '') + '</div>';
      html += '<div style="font-size:17px;font-weight:bold;color:#4A90D9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mpEscape(weather.tomorrow.icon || '☀️') + ' ' + mpEscape(weather.tomorrow.tempRange || '') + '</div>';
      html += '<div style="font-size:12px;color:#666;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mpEscape(weather.tomorrow.weather || '') + '</div>';
      html += generateWeatherMetaHTML(weather.tomorrow.wind, '💨');
      html += generateWeatherMetaHTML(weather.tomorrow.humidity, '💧');
      html += '</div></td>';
    } else {
      html += '<td width="48%" style="width:48% !important;vertical-align:top;text-align:center;padding:8px 2px;color:#999;font-size:12px;">明日预报暂未更新</td>';
    }
    html += '</tr></table>';
    html += '</td></tr></table>';
  }

  if (hitokoto && hitokoto.text) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF9F5;padding:16px;border-left:3px solid #A78BFA;">';
    html += '<p style="font-size:14px;color:#888;margin:0 0 6px 0;line-height:1.8;font-style:italic;">💬 "' + escapeHtml(hitokoto.text) + '"</p>';
    html += '<p style="text-align:right;color:#ccc;font-size:12px;margin:0;">—— ' + escapeHtml(hitokoto.from_who || hitokoto.from || '') + '</p>';
    html += '</td></tr></table>';
  }

  if (includeGaokao === true) {
    var gaokaoDate = new Date();
    gaokaoDate.setMonth(5);
    gaokaoDate.setDate(7);
    gaokaoDate.setHours(9, 0, 0);
    if (gaokaoDate < new Date()) {
      gaokaoDate.setFullYear(gaokaoDate.getFullYear() + 1);
    }
    var gaokaoDiff = Math.ceil((gaokaoDate - new Date()) / (1000 * 60 * 60 * 24));
    var gaokaoPercent = Math.round((365 - gaokaoDiff) / 365 * 100);
    html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100% !important;max-width:100%;table-layout:fixed;border-collapse:collapse;margin-top:16px;"><tr><td style="padding:0 16px;">';
    html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100% !important;max-width:100%;table-layout:fixed;border-collapse:collapse;background:linear-gradient(135deg,#FFF8E1,#FFE4B5);border-radius:16px;overflow:hidden;"><tr><td style="padding:16px;box-sizing:border-box;max-width:100%;overflow:hidden;">';
    html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100% !important;max-width:100%;table-layout:fixed;border-collapse:collapse;"><tr>';
    html += '<td width="48%" style="width:48% !important;max-width:48%;box-sizing:border-box;text-align:center;padding:4px 2px;overflow:hidden;word-break:break-word;">';
    html += '<div style="font-size:11px;color:#888;margin-bottom:4px;line-height:1.4;">📚 距离高考</div>';
    html += '<div style="font-size:24px;font-weight:bold;color:#FF8C00;line-height:1.2;white-space:nowrap;">' + gaokaoDiff + '</div>';
    html += '<div style="font-size:12px;color:#666;">天</div>';
    html += '</td>';
    html += '<td width="4%" style="width:4% !important;padding:0;font-size:0;line-height:0;">&nbsp;</td>';
    html += '<td width="48%" style="width:48% !important;max-width:48%;box-sizing:border-box;text-align:center;padding:4px 2px;overflow:hidden;word-break:break-word;">';
    html += '<div style="font-size:11px;color:#888;margin-bottom:4px;line-height:1.4;">⏳ 进度</div>';
    html += '<div style="font-size:20px;font-weight:bold;color:#FF8C00;line-height:1.4;white-space:nowrap;">' + gaokaoPercent + '%</div>';
    html += '<div style="font-size:12px;color:#666;">已完成</div>';
    html += '</td>';
    html += '</tr></table></td></tr></table></td></tr></table>';
  }

  if (stats && stats.total > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#F0FFF0;padding:14px;text-align:center;">';
    html += '<div style="font-size:14px;color:#666;line-height:1.6;">📊 今日校园 · 共 <strong style="color:#43e97b;font-size:18px;">' + stats.total + '</strong> 篇新帖子</div>';
    html += '</td></tr></table>';
  }

  if (categories && categories.length > 0) {
    var catNames = { 'daily':'日常', 'confession':'表白', 'help':'求助', 'secondhand':'二手', 'club':'社团', 'other':'其他' };
    var catEmoji = { '日常':'🌸', '表白':'💕', '求助':'🆘', '二手':'🛍️', '社团':'🎪', '其他':'📌' };
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFFFF0;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:6px;">🏷️ 热门分类</div>';
    html += '<div style="font-size:14px;color:#666;line-height:1.8;">';
    for (var ci = 0; ci < categories.length; ci++) {
      var cat = categories[ci];
      var cName = catNames[cat.category] || cat.category;
      html += (ci > 0 ? '&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;' : '') + (catEmoji[cName] || '📌') + ' ' + cName + ' <strong style="color:#FFB6C1;font-size:14px;">' + cat.cnt + '</strong>';
    }
    html += '</div></td></tr></table>';
  }

  if (todayHistory && todayHistory.title) {
    var htParts = (todayHistory.title || '').split(' ');
    var datePart = htParts.length > 1 ? htParts[0] : '';
    var eventPart = htParts.length > 1 ? htParts.slice(1).join(' ') : todayHistory.title;
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#F8F0FF;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:5px;">📜 历史上的今天</div>';
    html += '<div style="font-size:14px;color:#666;line-height:1.7;">' + (datePart ? '<span class="history-date">' + escapeHtml(datePart) + '</span> ' : '') + '<span class="history-event">' + escapeHtml(eventPart) + '</span></div>';
    html += '</td></tr></table>';
  }

  if (includeSongs !== false && songs && songs.length > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF0F5;padding:12px 14px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:6px;">🎵 最近点歌</div>';
    for (var si = 0; si < songs.length; si++) {
      var s = songs[si];
      var authorStr = s.is_anonymous ? '匿名同学' : (s.nickname || s.username || '同学');
      html += '<div style="border-top:' + (si > 0 ? '1px dashed #FFD1DC;' : 'none;') + ';padding:8px 0;">';
      html += '<div style="font-size:14px;color:#555;line-height:1.6;">🎶 <strong>' + mpEscape(s.song_name || '') + '</strong>' + (s.artist ? ' - <span style="color:#aaa;">' + mpEscape(s.artist) + '</span>' : '') + '</div>';
      html += '<div style="font-size:12px;color:#bbb;margin-top:3px;line-height:1.5;">';
      html += '审核通过';
      if (s.message) html += ' &nbsp;💬 ' + mpEscape(s.message);
      if (s.to_whom) html += ' &nbsp;💝 ' + mpEscape(s.to_whom);
      html += ' &nbsp;👤 ' + mpEscape(authorStr);
      html += '</div>';
      html += '</div>';
    }
    html += '</td></tr></table>';
  }

  if (weeklyStar && weeklyStar.length > 0) {
    var medals = ['🥇', '🥈', '🥉'];
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF9F9;padding:14px 14px 18px;">';
    html += '<div style="font-size:13px;color:#999;margin-bottom:10px;">⭐ 每周之星</div>';
    for (var wsStart = 0; wsStart < weeklyStar.length; wsStart += 3) {
      var wsRow = weeklyStar.slice(wsStart, wsStart + 3);
      var wsWidth = ((100 - ((wsRow.length - 1) * 2)) / wsRow.length).toFixed(2) + '%';
    html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100% !important;table-layout:fixed;border-collapse:collapse;' + (wsStart ? 'margin-top:8px;' : '') + '"><tr>';
      for (var wi = 0; wi < wsRow.length; wi++) {
        var w = wsRow[wi];
        var wName = w.nickname || w.username || '同学';
        if (wi > 0) html += '<td width="2%" style="width:2% !important;padding:0;font-size:0;line-height:0;">&nbsp;</td>';
        html += '<td width="' + wsWidth + '" style="width:' + wsWidth + ' !important;text-align:center;vertical-align:top;padding:0;overflow:hidden;">';
        html += '<div style="width:100%;box-sizing:border-box;overflow:hidden;">';
        html += '<div style="font-size:20px;">' + (medals[(wsStart + wi) % medals.length] || '🏅') + '</div>';
        html += '<div style="font-weight:600;font-size:13px;color:#555;margin-top:4px;word-break:break-all;">' + escapeHtml(wName) + '</div>';
        html += '<div style="font-size:11px;color:#bbb;margin-top:2px;word-break:break-all;">📝' + (w.post_count || 0) + ' 💬' + (w.comment_count || 0) + '</div>';
        html += '</div></td>';
      }
      html += '</tr></table>';
    }
    html += '</td></tr></table>';
  }

  if (dailySongs && dailySongs.length > 0) {
    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#FFF0F5;padding:14px;">';
    html += '<div style="font-size:13px;color:#A2376C;font-weight:700;margin-bottom:10px;">🎵 每日歌曲推荐</div>';
    for (var si = 0; si < dailySongs.length; si++) {
      var s = dailySongs[si];
      html += '<div style="border-top:' + (si > 0 ? '1px dashed #FFD1DC;' : 'none;') + ';padding:10px 0;">';
      html += '<div style="font-size:15px;color:#2E2438;line-height:1.6;">🎶 <strong>' + escapeHtml(s.song_name || '') + '</strong>' + (s.artist ? ' - <span style="color:#75677B;">' + escapeHtml(s.artist) + '</span>' : '') + '</div>';
      html += '<div style="font-size:12px;color:#6F6077;margin-top:4px;line-height:1.5;">';
      if (s.to_whom) html += '💝 送给 ' + escapeHtml(s.to_whom) + ' &nbsp;';
      if (s.message) html += '💬 ' + escapeHtml(s.message) + ' &nbsp;';
      html += '👤 ' + escapeHtml(s.submitter || '同学');
      html += '</div>';
      if (s.intro) {
        html += '<div style="font-size:12px;color:#888;margin-top:6px;padding:8px 10px;background:#FFF9F5;border-radius:8px;border-left:3px solid #FFB7C5;line-height:1.5;">';
        html += '📖 ' + escapeHtml(s.intro);
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</td></tr></table>';
  }

  html += '<div style="text-align:center;margin:18px 0;color:#e8e8e8;font-size:14px;">❀&nbsp;&nbsp;❁&nbsp;&nbsp;❀</div>';

  posts.forEach((p, i) => {
    var colors = ['#FFB6C1','#DDA0DD','#87CEEB','#98FB98','#FFD700'];
    var bgColors = ['#FFF0F5','#F8F0FF','#F0F8FF','#F0FFF0','#FFFFF0'];
    var c = colors[i % colors.length];
    var bg = bgColors[i % bgColors.length];
    var allImgs = [];
    try { if (p.images) { var parsed = JSON.parse(p.images); if (Array.isArray(parsed)) allImgs = parsed; } } catch(e) {}
    var coverImgs = '';
    for (var ii = 0; ii < allImgs.length; ii++) {
      coverImgs += (ii > 0 ? '<div style="border-top:1px dashed #eee;margin:8px 0;"></div>' : '') + '<img src="' + mpEscape(allImgs[ii]) + '" style="width:100%;" alt="帖子配图">';
    }
    var videoHtml = buildPostVideoHTML(p);
    var safeTitle = (p.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    var content = p.content || '';

    html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="border-top:3px solid ' + c + ';background:' + bg + ';padding:16px;">';
    html += '<div style="color:' + c + ';font-weight:bold;font-size:13px;margin-bottom:6px;">#' + (i+1) + ' · 热门帖子</div>';
    html += '<div style="font-weight:bold;font-size:18px;color:#333;margin-bottom:8px;line-height:1.4;">' + safeTitle + '</div>';
    html += coverImgs;
    html += videoHtml;
    html += '<div style="margin:12px 0 0 0;">' + autoFormatContent(content) + '</div>';
    html += '<div style="font-size:13px;color:#bbb;margin-top:12px;padding-top:10px;border-top:1px solid #eee;line-height:1.6;">';
    html += '👤 ' + mpEscape(p.author || '匿名同学') + '&nbsp;&nbsp;&nbsp;❤️ ' + (p.likes_count || 0) + '&nbsp;&nbsp;&nbsp;💬 ' + (p.comment_count || 0) + '</div>';
    if (commentsByPost && commentsByPost[p.id] && commentsByPost[p.id].length > 0) {
      html += '<div style="margin-top:10px;">';
      commentsByPost[p.id].forEach(function(comment) {
        var commAuthor = comment.author || '同学';
        var commContent = comment.content || '';
        var safeCommAuthor = (commAuthor).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var safeCommText = (commContent).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html += '<div style="background:#f9f9f9;border-radius:8px;padding:8px 12px;margin-top:6px;font-size:13px;">';
        html += '<span style="color:#667eea;font-weight:600;">' + safeCommAuthor + '</span>';
        html += '<span style="color:#999;">: </span>';
        html += '<span style="color:#555;">' + safeCommText + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</td></tr></table>';
  });

  html += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#FFE4E1);padding:24px 20px;text-align:center;border-radius:16px;">';
  html += '<div style="font-size:18px;color:#FF69B4;font-weight:bold;margin-bottom:6px;">🌸 校园墙</div>';
  html += '<div style="font-size:13px;color:#DDA0DD;margin-bottom:16px;">同学正在发生的事，等你来聊</div>';
  html += '<table align="center" style="margin:0 auto;"><tr><td style="background:linear-gradient(135deg,#FF69B4,#FFB6C1);padding:4px;border-radius:16px;">';
  html += '<table style="width:100%;background:#fff;border-radius:12px;"><tr><td style="padding:12px;">';
  html += '<img src="https://campus.example.com/images/gzh.png" style="width:200px;display:block;border-radius:6px;margin:0 auto;height:auto;" alt="校园墙二维码">';
  html += '</td></tr></table>';
  html += '</td></tr></table>';
  html += '<p style="color:#bbb;font-size:12px;margin:14px 0 4px 0;letter-spacing:1px;">📱 微信扫一扫 · 获取更多精彩</p>';
  html += '<p style="color:#FF69B4;font-size:13px;font-weight:bold;word-break:break-all;letter-spacing:0.5px;">https://campus.example.com</p>';
  html += '<div style="width:40px;height:2px;background:#FFB6C1;margin:12px auto 0;border-radius:2px;"></div>';
  html += '</td></tr></table>';
  html += '<p style="text-align:center;color:#ddd;font-size:12px;margin-top:18px;">❀ ' + dateInfo.year + ' 校园墙 ❀ ❀</p>';
  html += '</div>';

  return html;
}

router.post('/generate-content', async (req, res) => {
  try {
    const { postIds, template = 'daily-summary', includeWeather = true, includeHitokoto = true, includeWeeklyStar = true, includeGaokao = true, includeSongs = true, weeklyStarUserIds = [] } = req.body;
    const canPushDailySongs = req.user && req.user.role === 'super_admin';
    const includeDailySongs = canPushDailySongs && includeSongs !== false;

    if (!postIds || !Array.isArray(postIds)) {
      return res.json({ code: 400, message: '请提供帖子ID列表' });
    }

    let postsQuery;
    if (postIds.length > 0) {
      const postIdsStr = postIds.join(',');
      postsQuery = pool.execute(`
        SELECT 
          p.id, p.title, p.content, p.created_at, p.likes_count,
          p.views as view_count,
          CASE WHEN p.is_anonymous = 1 THEN '匿名用户' ELSE COALESCE(u.nickname, u.username, '同学') END AS author,
          p.is_anonymous,
          COUNT(DISTINCT c.id) as comment_count,
          p.images, p.video_url, p.video_poster
        FROM posts p
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN comments c ON c.post_id = p.id
        WHERE p.status = 'approved' AND p.is_deleted = 0 AND FIND_IN_SET(p.id, ?)
        GROUP BY p.id
        ORDER BY FIELD(p.id, ?)
      `, [postIdsStr, postIdsStr]);
    } else {
      postsQuery = Promise.resolve([[]]);
    }
    const [postsResult, weather, hitokoto, dateInfo, statsResult, catResult, todayHistory, weeklyStarResult, commentsResult] = await Promise.all([
      postsQuery,
      includeWeather ? mpDraftService.getWeather() : Promise.resolve(null),
      includeHitokoto ? mpDraftService.getHitokoto() : Promise.resolve(null),
      Promise.resolve(mpDraftService.getDateInfo()),
      pool.execute("SELECT COUNT(*) as total FROM posts WHERE status='approved' AND is_deleted=0 AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)").then(r => r[0][0]),
      pool.execute("SELECT category, COUNT(*) as cnt FROM posts WHERE status='approved' AND is_deleted=0 GROUP BY category ORDER BY cnt DESC LIMIT 3").then(r => r[0]),
      mpDraftService.getTodayInHistory(),
      (async function() {
        if (!includeWeeklyStar) return [];
        const result = await getActiveUsers('week', weeklyStarUserIds, weeklyStarUserIds.length > 0 ? null : 3);
        return result.users;
      })(),
      (async function() {
        if (postIds.length === 0) return {};
        const idsStr = postIds.join(',');
        const [rows] = await pool.execute(`
          SELECT c.post_id, c.content, c.created_at,
            CASE WHEN c.is_anonymous = 1 THEN '匿名用户' ELSE COALESCE(u.nickname, u.username, '同学') END AS author,
            c.is_anonymous
          FROM comments c
          LEFT JOIN users u ON c.user_id = u.id
          WHERE FIND_IN_SET(c.post_id, ?)
          ORDER BY c.created_at ASC
          LIMIT 50
        `, [idsStr]);
        var grouped = {};
        rows.forEach(function(r) {
          if (!grouped[r.post_id]) grouped[r.post_id] = [];
          grouped[r.post_id].push(r);
        });
        return grouped;
      })(),
    ]);

    const posts = postsResult[0];
    const stats = statsResult || {};
    const categories = catResult || [];
    const weeklyStar = weeklyStarResult || [];
    const commentsByPost = commentsResult || {};

    var dailySongs = (includeDailySongs && Array.isArray(req.body.dailySongs)) ? req.body.dailySongs : [];
    if (posts.length === 0 && dailySongs.length === 0) {
      return res.json({ code: 404, message: '未找到帖子' });
    }

    var songReq = [];
    try {
      const range = getWeeklySongScheduleRange(0);
      songReq = await pool.execute(`SELECT sr.song_name, sr.artist, sr.message, sr.to_whom, sr.is_anonymous,
        CASE WHEN sr.is_anonymous = 1 THEN NULL ELSE u.username END AS username,
        CASE WHEN sr.is_anonymous = 1 THEN NULL ELSE u.nickname END AS nickname
        FROM song_requests sr LEFT JOIN users u ON sr.user_id=u.id
        WHERE sr.status IN ('approved','played') AND sr.deleted_at IS NULL
          AND sr.approved_at >= ? AND sr.approved_at < ?
        ORDER BY sr.approved_at, sr.id`, [range.weekStart, range.weekEnd]).then(r => r[0]);
    } catch(e) {}

    const articles = [];

    if (template === 'daily-summary') {
      const titleInfo = mpDraftService.generateArticleTitle({
        type: 'daily', posts: posts, songs: dailySongs, dateInfo: dateInfo
      });
      const contentHtml = generateCardHTML(posts, weather, hitokoto, dateInfo, stats, categories, songReq, todayHistory, weeklyStar, commentsByPost, includeGaokao, dailySongs, includeDailySongs, titleInfo.title);

      articles.push(mpDraftService.normalizeDraftArticle({
        title: titleInfo.title,
        title_meta: titleInfo.meta,
        author: '校园墙',
        digest: titleInfo.digest,
        content: contentHtml,
        content_source_url: 'https://campus.example.com',
        show_cover_pic: 1,
        need_open_comment: 1,
        only_fans_can_comment: 0
      }));
    } else {
      posts.forEach(post => {
        var postImages = [];
        try { postImages = JSON.parse(post.images || '[]'); } catch (e) {}
        if (!Array.isArray(postImages)) postImages = [];
        const coverImg = postImages.map(function(src) {
          return '<img src="' + mpEscape(src) + '" style="width:100%;margin:10px 0;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">';
        }).join('');
        const videoHtml = buildPostVideoHTML(post);
        const titleInfo = mpDraftService.generateArticleTitle({ type: 'post', post: post, dateInfo: dateInfo });

        const rawContent = post.content || '';
        const safeTitle = (post.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const safeAuthor = (post.author || '匿名').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        var postChars = (post.content || '').replace(/\s/g, '').length;
        var postReadMin = Math.max(1, Math.ceil(postChars / 300));
        var readingCard = generateTextStatsHTML(postReadMin, 1);
        const contentHtml = `
          <section style="padding: 20px; font-family: -apple-system, sans-serif;">
            <div style="color:#A78BFA;font-size:12px;letter-spacing:1px;margin-bottom:6px;">校园墙 · 想和你说</div>
            <h2 style="color: #667eea; font-size: 22px;line-height:1.45;">${mpEscape(titleInfo.title)}</h2>
            ${coverImg}
            ${videoHtml}
            ${readingCard}
            ${autoFormatContent(rawContent)}
            <section style="margin-top: 25px; padding: 15px; background: #f8f9fa; border-radius: 8px; display: flex; justify-content: space-between; font-size: 13px; color: #999;">
              <span>👤 ${safeAuthor}</span>
              <span>❤️ ${post.likes_count} 赞</span>
              <span>🕒 ${new Date(post.created_at).toLocaleString('zh-CN')}</span>
            </section>
          </section>
        `;

        articles.push(mpDraftService.normalizeDraftArticle({
          title: titleInfo.title,
          title_meta: titleInfo.meta,
          author: post.author || '匿名',
          digest: titleInfo.digest,
          content: contentHtml,
          content_source_url: `https://campus.example.com/post/${post.id}`,
          show_cover_pic: 1,
          need_open_comment: 1,
          only_fans_can_comment: 0
        }));
      });
    }

    articles.forEach(function(article) {
      var initialTextStats = mpDraftService.getArticleTextStats(article);
      article.content = String(article.content || '').replace(/__MP_VISIBLE_TEXT_COUNT__/g, initialTextStats.total.toLocaleString());
      article.text_stats = mpDraftService.getArticleTextStats(article);
    });
    var textStats = articles.reduce(function(total, article) {
      var stats = article.text_stats || {};
      total.title += stats.title || 0;
      total.author += stats.author || 0;
      total.content += stats.content || 0;
      total.total += stats.total || 0;
      return total;
    }, { title: 0, author: 0, content: 0, total: 0 });

    res.json({
      code: 200,
      data: { articles, text_stats: textStats, posts, weather, hitokoto, dateInfo, stats, categories, songs: songReq, todayHistory, weeklyStar, commentsByPost, dailySongs: dailySongs || [] },
      message: '生成成功'
    });
  } catch (err) {
    console.error('[MP素材] 生成内容失败:', err.message);
    res.json({ code: 500, message: '生成失败，请稍后重试' });
  }
});

router.post('/upload-cover', async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.json({ code: 400, message: '请提供图片URL' });
    }

    const mediaId = await mpDraftService.uploadMedia(imageUrl, 'image');

    res.json({
      code: 200,
      data: { media_id: mediaId },
      message: '上传成功'
    });
  } catch (err) {
    console.error('[MP素材] 上传封面失败:', err.message);
    res.json({ code: 500, message: '上传失败，请稍后重试' });
  }
});

router.post('/create-draft', async (req, res) => {
  try {
    const { articles } = req.body;

    if (!articles || !Array.isArray(articles) || articles.length === 0) {
      return res.json({ code: 400, message: '请提供图文内容' });
    }

    for (let article of articles) {
      if (article.cover_image_url && !article.thumb_media_id) {
        try {
          article.thumb_media_id = await mpDraftService.uploadMedia(article.cover_image_url, 'image');
        } catch (err) {
          console.warn('[MP素材] 上传封面失败，使用默认:', err.message);
          article.thumb_media_id = process.env.MP_DEFAULT_THUMB_MEDIA_ID || '';
        }
      }
    }

    const mediaId = await mpDraftService.createDraft(articles);

    res.json({
      code: 200,
      data: { media_id: mediaId },
      message: '草稿创建成功，请在公众号后台查看'
    });
  } catch (err) {
    console.error('[MP素材] 创建草稿失败:', err.message);
    res.json({ code: 500, message: '创建失败，请稍后重试' });
  }
});

router.get('/daily-songs', superAdminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const candidate = req.query.candidate === '1' || req.query.candidate === 'true';
    const limit = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 }).limit;
    let sql = 'SELECT * FROM daily_song_recs WHERE 1=1';
    const params = [];

    if (candidate) {
      sql += ' AND ' + dailySongCandidateSql();
    } else if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const [songs] = await pool.execute(sql, params);
    res.json({ code: 200, data: songs });
  } catch (err) {
    console.error('[MP素材] 获取每日推歌失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

router.get('/weekly-song-schedule', superAdminOnly, async (req, res) => {
  try {
    const range = getWeeklySongScheduleRange(0);
    const [songs] = await pool.execute(`
      SELECT sr.id, sr.song_name, sr.artist, sr.message, sr.to_whom, sr.is_anonymous,
             CASE WHEN sr.is_anonymous = 1 THEN NULL ELSE COALESCE(u.nickname, u.username) END AS requester_name
      FROM song_requests sr
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.status IN ('approved', 'played') AND sr.deleted_at IS NULL
        AND sr.approved_at >= ? AND sr.approved_at < ?
      ORDER BY sr.approved_at, sr.id
    `, [range.weekStart, range.weekEnd]);
    const titleInfo = mpDraftService.generateArticleTitle({
      type: 'weekly-song', songs, weekLabel: range.label, periodLabel: range.periodLabel
    });
    res.json({
      code: 200,
      data: {
        songs,
        week_start: range.weekStart,
        schedule_start: range.scheduleStart,
        week_end: addBusinessDays(range.weekEnd, -1),
        week_label: range.label,
        period_label: range.periodLabel,
        week_offset: range.weekOffset,
        title: titleInfo.title,
        digest: titleInfo.digest,
        title_meta: titleInfo.meta
      }
    });
  } catch (err) {
    console.error('[MP素材] 获取本周审核通过歌单失败:', err.message);
    res.json({ code: 500, message: '获取本周审核通过歌单失败，请稍后重试' });
  }
});

router.post('/publish-daily', requirePermission('songs:review'), async (req, res) => {
  try {
    const canPushDailySongs = req.user && req.user.role === 'super_admin';
    const requestedHours = Number.parseInt(req.body.hours, 10);
    const hours = Number.isFinite(requestedHours) && requestedHours > 0 ? Math.min(requestedHours, 24 * 30) : 24;
    const requestedLimit = parseInt(req.body.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : 10;

    const [posts] = await pool.execute(`
      SELECT 
        p.id, p.title, p.content, p.created_at, p.likes_count,
        p.views as view_count,
        CASE WHEN p.is_anonymous = 1 THEN '匿名用户' ELSE COALESCE(u.nickname, u.username, '同学') END AS author,
        p.is_anonymous,
        COUNT(DISTINCT c.id) as comment_count,
        p.images, p.video_url, p.video_poster
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      WHERE p.status = 'approved' AND p.is_deleted = 0
        AND p.created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      GROUP BY p.id
      ORDER BY (p.likes_count * 2 + COUNT(DISTINCT c.id) * 3 + COALESCE(p.views, 0) * 0.1) DESC
      LIMIT ?
    `, [hours, limit]);

    if (posts.length === 0) {
      return res.json({ code: 400, message: '暂无热门帖子' });
    }

    const [weather, hitokoto, dateInfo] = await Promise.all([
      mpDraftService.getWeather(),
      mpDraftService.getHitokoto(),
      Promise.resolve(mpDraftService.getDateInfo())
    ]);

    var dailySongs = [];
    try {
      if (!canPushDailySongs) {
        dailySongs = [];
      } else {
        dailySongs = await pool.execute(
          'SELECT * FROM daily_song_recs WHERE ' + dailySongCandidateSql() + ' ORDER BY CASE WHEN status = "pending" THEN 0 ELSE 1 END, created_at DESC LIMIT 10'
        ).then(r => r[0]);
      }
    } catch(e) {}

    const titleInfo = mpDraftService.generateArticleTitle({
      type: 'daily', posts: posts, songs: dailySongs, dateInfo: dateInfo
    });
    const contentHtml = generateCardHTML(posts, weather, hitokoto, dateInfo, null, null, [], null, [], {}, true, dailySongs, canPushDailySongs, titleInfo.title);

    const articles = [mpDraftService.normalizeDraftArticle({
      title: titleInfo.title,
      title_meta: titleInfo.meta,
      author: '校园墙',
      digest: titleInfo.digest,
      content: contentHtml,
      content_source_url: 'https://campus.example.com',
      show_cover_pic: 1,
      need_open_comment: 1,
      only_fans_can_comment: 0
    })];

    const prepared = await prepareArticleForWeixin(articles[0]);
    const videoFailureDetails = formatVideoFailureDetails(prepared.video);
    const hasVideoFailures = Boolean(prepared.video && prepared.video.failed > 0);
    const dailySongIds = dailySongs.map(song => song.id).filter(Number.isSafeInteger);
    const mediaId = await finalizeDailySongSync(
      draftArticles => mpDraftService.createDraft(draftArticles),
      ids => markDailySongsPublished(pool, ids),
      [prepared.article],
      dailySongIds
    );

    res.json({
      code: 200,
      data: { 
        media_id: mediaId,
        post_count: posts.length,
        weather: weather ? `${weather.icon} ${weather.temperature}` : null,
        hitokoto: hitokoto ? hitokoto.text.substring(0, 30) + '...' : null,
        image: prepared.image,
        video: prepared.video,
        sync_status: hasVideoFailures ? 'done_with_video_warning' : 'done',
        daily_song_count: dailySongIds.length,
        failure_reason: videoFailureDetails || null,
        text_stats: prepared.article.text_stats
      },
      message: hasVideoFailures
        ? '草稿已创建，但视频素材同步失败：' + videoFailureDetails + '；正文已保留封面和站内观看入口；每日推歌已按草稿标记，请勿重复同步'
        : '草稿创建成功，请在公众号后台审核后发布'
    });
  } catch (err) {
    console.error('[MP素材] 一键发布失败:', err.message);
    if (err && err.draftCreated) {
      return res.status(409).json({
        code: 409,
        data: {
          media_id: err.mediaId,
          sync_status: 'draft_created_mark_failed',
          daily_song_ids: err.dailySongIds || [],
          mark_result: err.markResult || null
        },
        message: formatDraftCreatedMarkFailure(err)
      });
    }
    res.json({ code: 500, message: '发布失败，请稍后重试' });
  }
});

router.get('/drafts', async (req, res) => {
  try {
    const requestedOffset = parseInt(req.query.offset, 10);
    const requestedCount = parseInt(req.query.count, 10);
    const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0 ? Math.min(requestedOffset, 100000) : 0;
    const count = Number.isFinite(requestedCount) && requestedCount > 0 ? Math.min(requestedCount, 50) : 20;

    const drafts = await mpDraftService.getDraftList(offset, count);

    res.json({
      code: 200,
      data: drafts,
      message: '获取成功'
    });
  } catch (err) {
    console.error('[MP素材] 获取草稿列表失败:', err.message);
    res.json({ code: 500, message: '获取失败，请稍后重试' });
  }
});

router.delete('/draft/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;

    await mpDraftService.deleteDraft(mediaId);

    res.json({
      code: 200,
      message: '删除成功'
    });
  } catch (err) {
    console.error('[MP素材] 删除草稿失败:', err.message);
    res.json({ code: 500, message: '删除失败，请稍后重试' });
  }
});

let mpSyncJobsInstance = null;
function getMpSyncJobs() {
  if (!mpSyncJobsInstance) mpSyncJobsInstance = createMpSyncJobs({ db: pool, processor: processMpSyncJob, concurrency: 2, queueLimit: 100, leaseMs: 240000 });
  return mpSyncJobsInstance;
}

async function processMpSyncJob(input) {
  const job = input.job;
  const context = input.context;
  const payload = job.payload || {};
  const dailySongIds = Array.isArray(payload.dailySongIds) ? payload.dailySongIds : [];
  let preparedArticle = payload.preparedArticle || null;
  let progress = job.progress || {};
  let result = job.result || {};

  if (job.status !== 'draft_created') {
    if (!preparedArticle) {
      const prepared = await prepareArticleForWeixin(payload.article, async video => {
        progress = Object.assign({}, progress, {
          video: video,
          msg: '视频素材上传中（成功 ' + video.success + '/' + video.total + '，失败 ' + video.failed + '）'
        });
        await context.checkpoint({ progress });
      }, context.assertWorkerLock);
      preparedArticle = prepared.article;
      progress = Object.assign({}, progress, { image: prepared.image, video: prepared.video, msg: '素材处理完成，正在创建公众号草稿' });
      await context.checkpoint({
        payload: { preparedArticle: preparedArticle, preparedImage: prepared.image, preparedVideo: prepared.video },
        progress: progress
      });
    }

    await context.markExternalStarted();
    const mediaId = await mpDraftService.createDraft([preparedArticle]);
    result = {
      media_id: mediaId,
      image: payload.preparedImage || progress.image || { total: 0, success: 0, failed: 0 },
      video: payload.preparedVideo || progress.video || { total: 0, success: 0, failed: 0, items: [] },
      text_stats: preparedArticle.text_stats || null,
      sync_status: (payload.preparedVideo && payload.preparedVideo.failed > 0) ? 'done_with_video_warning' : 'done'
    };
    await context.markDraftCreated(mediaId, result);
  }

  if (dailySongIds.length) {
    try {
      const markResult = await markDailySongsPublished(pool, dailySongIds);
      if (!markResult || markResult.affected !== dailySongIds.length) {
        throw createDailySongMarkConflict(dailySongIds.length, markResult && markResult.affected || 0);
      }
      result = Object.assign({}, result, { mark_result: markResult });
    } catch (error) {
      error.draftCreated = true;
      error.mediaId = result.media_id || job.result.media_id;
      error.markResult = error.markResult || null;
      throw error;
    }
  }

  const video = result.video || {};
  const image = result.image || {};
  result.sync_status = video.failed > 0 ? 'done_with_video_warning' : 'done';
  const videoFailureDetails = formatVideoFailureDetails(video);
  const videoMessage = video.total > 0
    ? '，视频成功 ' + video.success + '/' + video.total + (video.failed > 0 ? '，失败 ' + video.failed + '（正文已保留封面和观看入口）' : '')
    : '';
  result.msg = video.failed > 0
    ? '草稿已创建；视频素材处理失败（' + videoFailureDetails + '），正文已保留封面和观看入口；每日推歌已按草稿标记，请勿重复同步'
    : '同步成功（图片 ' + (image.success || 0) + '/' + (image.total || 0) + videoMessage + '）';
  return result;
}

router.post('/sync-draft', requirePermission('songs:review'), async (req, res) => {
  const { article, dailySongIds } = req.body || {};
  if (!article || typeof article !== 'object') return res.json({ code: 400, message: '请先生成图文内容' });
  if (!article.title || !String(article.title).trim()) return res.json({ code: 400, message: '文章标题不能为空' });
  if (!article.content || !String(article.content).trim()) return res.json({ code: 400, message: '文章正文不能为空' });
  const normalizedSongIds = normalizeDailySongIds(dailySongIds);
  if (!normalizedSongIds.ok) return res.status(400).json({ code: 400, message: '每日推歌参数无效' });
  if (normalizedSongIds.ids.length > 0 && (!req.user || req.user.role !== 'super_admin')) {
    return res.status(403).json({ code: 403, message: '仅超级管理员可同步每日推歌' });
  }
  if (typeof article.content !== 'string') return res.json({ code: 400, message: '文章正文格式无效' });
  const articleBytes = Buffer.byteLength(article.content, 'utf8');
  if (articleBytes > 5 * 1024 * 1024) {
    return res.json({ code: 413, message: '文章内容超过 5MB,请减少帖子数或图片数(' + (articleBytes / 1024 / 1024).toFixed(2) + 'MB)' });
  }

  try {
    const active = await getMpSyncJobs().getActive(req.user.id);
    if (active) {
      if (active.sync_status === 'needs_review' || active.sync_status === 'draft_created_mark_failed') {
        return res.status(409).json({ code: 409, data: active, message: active.msg });
      }
      return res.status(409).json({
        code: 409,
        message: '你已有一个公众号同步任务正在处理，请等待完成后再提交',
        data: { sync_id: active.sync_id, processing: true, status: active.status }
      });
    }
    await getSyncableDailySongs(pool, normalizedSongIds.ids, article);
    const imageTags = article.content.match(/<img[^>]+src=["'][^"']+["'][^>]*>/g) || [];
    const imageCount = imageTags.filter(tag => {
      const match = tag.match(/src=["']([^"']+)["']/);
      return match && match[1].indexOf('mmbiz.qpic.cn') < 0 && match[1].indexOf('mmbiz.qlogo.cn') < 0 && !match[1].startsWith('data:');
    }).length;
    const videoCount = (article.content.match(/<video\b[^>]*>[\s\S]*?<\/video>|<div\b[^>]*data-mp-video-placeholder=["']1["'][^>]*>[\s\S]*?<\/div>/gi) || []).length;
    const submission = await getMpSyncJobs().submit(req.user.id, {
      article: article,
      dailySongIds: normalizedSongIds.ids,
      progress: {
        msg: '任务排队中',
        image: { total: imageCount, success: 0, failed: 0 },
        video: { total: videoCount, success: 0, failed: 0, items: [] }
      }
    });
    if (submission.full) return res.status(503).json({ code: 503, message: '公众号同步队列已满，请稍后重试' });
    if (submission.conflict) {
      const existing = await getMpSyncJobs().getStatus(req.user.id, submission.id);
      if (existing && existing.sync_status === 'needs_review') {
        return res.status(409).json({ code: 409, data: existing, message: existing.msg });
      }
      if (existing && existing.sync_status === 'draft_created_mark_failed') {
        return res.status(409).json({ code: 409, data: existing, message: existing.msg });
      }
      return res.json({ code: 409, message: '你已有一个公众号同步任务正在处理，请等待完成后再提交', data: { sync_id: submission.id, processing: true } });
    }
    res.json({
      code: 200,
      data: { sync_id: submission.id, processing: true, img_count: imageCount, video_count: videoCount },
      message: '同步任务已提交(' + submission.id + ')，正在后台处理...'
    });
  } catch (err) {
    const status = err.code === 'DAILY_SONG_NOT_SYNCABLE' || err.code === 'DAILY_SONG_NOT_IN_ARTICLE' ? 409 : 500;
    res.status(status).json({ code: status, message: err.message || '同步任务提交失败' });
  }
});

router.get('/sync-status', async (req, res) => {
  try {
    const syncId = req.query.sync_id;
    const status = syncId ? await getMpSyncJobs().getStatus(req.user.id, syncId) : null;
    if (!status) return res.json({ code: 404, message: '未找到该同步任务' });
    res.json({ code: 200, data: status });
  } catch (err) {
    console.error('[MP同步] 查询任务状态失败:', err.message);
    res.status(500).json({ code: 500, message: '状态查询失败，请稍后重试' });
  }
});

router.post('/sync-review', requirePermission('songs:review'), async (req, res) => {
  const body = req.body || {};
  if (body.decision === 'not_created' && body.confirm_no_draft !== true) {
    return res.status(400).json({ code: 400, message: '请先核对公众号草稿箱，并明确确认没有创建草稿' });
  }
  try {
    const result = await getMpSyncJobs().resolveUnknown(
      req.user.id,
      String(body.sync_id || ''),
      body.decision,
      body.media_id
    );
    if (!result.found) return res.status(404).json({ code: 404, message: '未找到需要人工核对的同步任务' });
    return res.json({
      code: 200,
      data: result,
      message: result.status === 'draft_created'
        ? '已记录公众号草稿，将继续更新每日推歌状态，不会重新创建草稿'
        : '已记录人工确认结果；系统没有重发草稿'
    });
  } catch (err) {
    return res.status(400).json({ code: 400, message: err.message || '人工核对结果提交失败' });
  }
});

router._dailySongState = {
  DAILY_SONG_REUSE_DAYS,
  normalizeDailySongIds,
  isDailySongCandidate,
  dailySongCandidateSql,
  markDailySongsPublished,
  finalizeDailySongSync,
  formatDraftCreatedMarkFailure
};

router.ensureMpSyncSchema = ensureMpSyncSchema;
router.startSyncJobs = () => getMpSyncJobs().start();
router.stopSyncJobs = () => mpSyncJobsInstance ? mpSyncJobsInstance.stop() : Promise.resolve();
router.drainBackgroundTasks = () => mpSyncJobsInstance ? mpSyncJobsInstance.drain() : Promise.resolve();
router._getMpSyncJobs = getMpSyncJobs;
module.exports = router;
