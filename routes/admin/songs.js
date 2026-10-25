const express = require('express');
const { pool } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { notifySongApproved, notifySongRejected, notifySongPlayed } = require('../../services/email');
const { getPagination } = require('../../services/pagination');
const { getErrorDetail } = require('../../services/async-utils');
const { generateCoverPrompt } = require('../../services/cover-prompt');
const { transitionSongStatus } = require('../../services/song-state-transitions');
const { rollbackOrDiscard, releaseConnection } = require('../../services/database-transaction');
const { parseSongSlotDateId, approveSong } = require('../../services/song-scheduling');
const { normalizeSongRejectReasons } = require('../../services/song-reject-reasons');

const router = express.Router();
router.get('/song-reject-reasons', requirePermission('songs:review'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT config_value FROM settings WHERE config_key = ?', ['song_reject_reasons']);
    res.json({
      code: 200,
      data: { song_reject_reasons: normalizeSongRejectReasons(rows[0] && rows[0].config_value) }
    });
  } catch (err) {
    console.error('[Songs] 获取拒绝理由预设失败:', getErrorDetail(err));
    res.json({ code: 500, message: '获取拒绝理由预设失败' });
  }
});

router.put('/song-reject-reasons', requirePermission('songs:review'), async (req, res) => {
  try {
    const reasons = normalizeSongRejectReasons(req.body && req.body.reasons);
    await pool.execute(
      'INSERT INTO settings (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
      ['song_reject_reasons', JSON.stringify(reasons), JSON.stringify(reasons)]
    );
    res.json({ code: 200, message: '打回理由预设已保存', data: { song_reject_reasons: reasons } });
  } catch (err) {
    console.error('[Songs] 保存拒绝理由预设失败:', getErrorDetail(err));
    res.json({ code: 500, message: '保存拒绝理由预设失败' });
  }
});

router.get('/songs', requirePermission('songs:review'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { status, slot_id, keyword } = req.query;

    let whereClause = 'sr.deleted_at IS NULL';
    const params = [];
    if (status) {
      whereClause += ' AND sr.status = ?';
      params.push(status);
    }
    if (slot_id) {
      whereClause += ' AND sr.slot_id = ?';
      params.push(slot_id);
    }
    if (keyword) {
      whereClause += ' AND (sr.song_name LIKE ? OR sr.artist LIKE ? OR u.nickname LIKE ? OR u.username LIKE ?)';
      const kw = '%' + keyword + '%';
      params.push(kw, kw, kw, kw);
    }

    const [[songs], [countResult]] = await Promise.all([
      pool.execute(`
      SELECT sr.*, ts.name as slot_name, ts.start_time, ts.end_time, u.username, u.nickname,
             DATE_FORMAT(sd.play_date, '%Y-%m-%d') as play_date
      FROM song_requests sr
      JOIN time_slots ts ON sr.slot_id = ts.id
      LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE ${whereClause}
      ORDER BY CASE sr.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
               sr.hot_score DESC, sr.created_at DESC, sr.id DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]),
      pool.execute(`
      SELECT COUNT(*) as total
      FROM song_requests sr
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE ${whereClause}
    `, params)
    ]);

    res.json({
      code: 200,
      data: {
        songs,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/songs/:id', requirePermission('songs:review'), async (req, res) => {
  try {
    const [songs] = await pool.execute(`
      SELECT sr.*, ts.name as slot_name, ts.start_time, ts.end_time, u.username, u.nickname,
             DATE_FORMAT(sd.play_date, '%Y-%m-%d') as play_date
      FROM song_requests sr
      JOIN time_slots ts ON sr.slot_id = ts.id
      LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.id = ? AND sr.deleted_at IS NULL
    `, [req.params.id]);

    if (songs.length === 0) {
      return res.json({ code: 404, message: '点歌记录不存在' });
    }

    res.json({ code: 200, data: songs[0] });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/songs/:id/reschedule-options', requirePermission('songs:review'), (req, res) => {
  res.json({ code: 410, message: '点歌审核不再提供播放排期，请刷新页面' });
});
router.put('/songs/:id/reschedule', requirePermission('songs:review'), (req, res) => {
  res.json({ code: 410, message: '点歌审核不再提供播放排期，请刷新页面' });
});

router.put('/songs/:id/status', requirePermission('songs:review'), async (req, res) => {
  try {
    const { status, play_order } = req.body || {};
    const rejectReason = status === 'rejected' ? String((req.body && req.body.reason) || '').trim().slice(0, 500) : null;
    if (!['approved', 'rejected', 'played', 'pending'].includes(status)) {
      return res.json({ code: 400, message: '无效状态' });
    }
    if (status === 'rejected' && !rejectReason) {
      return res.json({ code: 400, message: '请填写拒绝理由' });
    }
    let statusResult;
    if (status === 'approved') {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await approveSong(connection, req.params.id);
        await connection.commit();
        statusResult = { affectedRows: 1 };
      } catch (err) {
        const rolledBack = await rollbackOrDiscard(connection, err);
        if (rolledBack && err && err.isSongReviewValidationError) {
          return res.json({ code: 400, message: err.message });
        }
        throw err;
      } finally {
        releaseConnection(connection);
      }
    } else {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        statusResult = await transitionSongStatus(connection, req.params.id, status, rejectReason, play_order, req.body.expected_status);
        await connection.commit();
      } catch (error) {
        const rolledBack = await rollbackOrDiscard(connection, error);
        if (rolledBack && error.isSongReviewValidationError) return res.status(error.statusCode || 400).json({ code: error.statusCode || 400, message: error.message });
        throw error;
      } finally { releaseConnection(connection); }
    }
    if (!statusResult || statusResult.affectedRows === 0) return res.json({ code: 404, message: '点歌记录不存在或已在回收站' });

    setImmediate(async () => {
      try {
        const [songs] = await pool.execute(`
          SELECT sr.song_name, sr.artist, sr.user_id, ts.name as slot_name, ts.start_time, ts.end_time,
                 DATE_FORMAT(sd.play_date, '%Y-%m-%d') AS play_date, u.email, u.nickname, u.username
          FROM song_requests sr
          LEFT JOIN time_slots ts ON sr.slot_id = ts.id
          LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
          LEFT JOIN users u ON sr.user_id = u.id
           WHERE sr.id = ? AND sr.deleted_at IS NULL
        `, [req.params.id]);

        if (songs.length > 0 && songs[0].email) {
          const song = songs[0];
          const userNickname = song.nickname || song.username || '用户';

          if (status === 'approved') {
            await notifySongApproved(song.email, userNickname, song.song_name || '未知', song.artist || '未知', song.slot_name || '未知时段', song.user_id, {
              playDate: song.play_date,
              slotName: song.slot_name,
              startTime: song.start_time,
              endTime: song.end_time
            });
          } else if (status === 'rejected') {
            await notifySongRejected(song.email, userNickname, song.song_name || '未知', song.artist || '未知', rejectReason, song.user_id, {
              playDate: song.play_date,
              slotName: song.slot_name,
              startTime: song.start_time,
              endTime: song.end_time
            });
          } else if (status === 'played') {
            await notifySongPlayed(song.email, userNickname, song.song_name || '未知', song.artist || '未知', song.user_id);
          }
        }
      } catch (err) {
        console.error('[Email] 发送点歌审核通知失败:', getErrorDetail(err));
      }
    });

    res.json({ code: 200, message: '操作成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/songs/batch-status', requirePermission('songs:review'), async (req, res) => {
  try {
    const { ids, status } = req.body;
    const rejectReason = status === 'rejected' ? String(req.body.reason || '').trim().slice(0, 500) : null;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !['approved', 'rejected', 'pending'].includes(status)) {
      return res.json({ code: 400, message: '无效参数' });
    }
    if (status === 'rejected' && !rejectReason) {
      return res.json({ code: 400, message: '请填写拒绝理由' });
    }
    if (status === 'approved') {
      const reviewIds = Array.from(new Set(ids.map(parseSongSlotDateId).filter(Boolean)));
      const approvedIds = [];
      const failedMessages = [];
      for (const songId of reviewIds) {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          await approveSong(connection, songId);
          await connection.commit();
          approvedIds.push(songId);
        } catch (err) {
          const rolledBack = await rollbackOrDiscard(connection, err);
          if (rolledBack && err && err.isSongReviewValidationError) {
            failedMessages.push(err.message);
          } else {
            throw err;
          }
        } finally {
          releaseConnection(connection);
        }
      }
      if (approvedIds.length === 0) {
        return res.json({ code: 400, message: failedMessages[0] || '没有可通过的点歌' });
      }

      const approvedPlaceholders = approvedIds.map(() => '?').join(',');
      const [approvedSongs] = await pool.execute(`
        SELECT sr.song_name, sr.artist, sr.user_id, u.email, u.nickname, u.username, ts.name AS slot_name,
               ts.start_time, ts.end_time, DATE_FORMAT(sd.play_date, '%Y-%m-%d') AS play_date
        FROM song_requests sr
        LEFT JOIN time_slots ts ON sr.slot_id = ts.id
        LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
        LEFT JOIN users u ON sr.user_id = u.id
        WHERE sr.id IN (${approvedPlaceholders}) AND sr.deleted_at IS NULL
      `, approvedIds);
      setImmediate(async () => {
        for (const song of approvedSongs) {
          if (!song.email) continue;
          try {
            await notifySongApproved(song.email, song.nickname || song.username || '用户', song.song_name || '未知', song.artist || '未知', song.slot_name || '未知时段', song.user_id, {
              playDate: song.play_date,
              slotName: song.slot_name,
              startTime: song.start_time,
              endTime: song.end_time
            });
          } catch (err) {
            console.error('[Email] 批量发送点歌审核通知失败:', err.message);
          }
        }
      });
      const failedCount = reviewIds.length - approvedIds.length;
      return res.json({
        code: 200,
        message: failedCount > 0
          ? `已批量通过 ${approvedIds.length} 条，另有 ${failedCount} 条审核失败`
          : `已批量通过 ${approvedIds.length} 条`
      });
    }
    const reviewIds = [...new Set(ids.map(Number))].filter(id => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
    if (!reviewIds.length || reviewIds.length > 500) return res.status(400).json({ code: 400, message: '每次最多审核500条有效点歌' });
    const connection = await pool.getConnection();
    let songsToNotify = [];
    const changedIds = [];
    try {
      await connection.beginTransaction();
      for (const songId of reviewIds) {
        try {
          await transitionSongStatus(connection, songId, status, rejectReason, undefined, req.body.expected_statuses && req.body.expected_statuses[songId]);
          changedIds.push(songId);
        } catch (error) {
          if (!error.isSongReviewValidationError) throw error;
        }
      }
      if (status === 'rejected' && changedIds.length) {
        const placeholders = changedIds.map(() => '?').join(',');
        const [rows] = await connection.execute(`
          SELECT sr.song_name, sr.artist, sr.user_id, u.email, u.nickname, u.username, ts.name AS slot_name,
                 ts.start_time, ts.end_time, DATE_FORMAT(sd.play_date, '%Y-%m-%d') AS play_date
          FROM song_requests sr
          LEFT JOIN time_slots ts ON sr.slot_id = ts.id
          LEFT JOIN slot_dates sd ON sr.slot_date_id = sd.id
          LEFT JOIN users u ON sr.user_id = u.id
          WHERE sr.id IN (${placeholders}) AND sr.deleted_at IS NULL
        `, changedIds);
        songsToNotify = rows;
      }
      await connection.commit();
    } catch (error) {
      await rollbackOrDiscard(connection, error);
      throw error;
    } finally { releaseConnection(connection); }
    if (!changedIds.length) return res.status(409).json({ code: 409, message: '所选点歌状态已变化，请刷新后重试' });
    if (songsToNotify.length > 0) {
      setImmediate(async () => {
        for (const song of songsToNotify) {
          if (!song.email) continue;
          const userNickname = song.nickname || song.username || '用户';
          try {
            if (status === 'approved') {
              await notifySongApproved(song.email, userNickname, song.song_name || '未知', song.artist || '未知', song.slot_name || '未知时段', song.user_id, {
                playDate: song.play_date,
                slotName: song.slot_name,
                startTime: song.start_time,
                endTime: song.end_time
              });
            } else {
              await notifySongRejected(song.email, userNickname, song.song_name || '未知', song.artist || '未知', rejectReason, song.user_id, {
                playDate: song.play_date,
                slotName: song.slot_name,
                startTime: song.start_time,
                endTime: song.end_time
              });
            }
          } catch (err) {
            console.error('[Email] 批量发送点歌审核通知失败:', err.message);
          }
        }
      });
    }
    res.json({ code: 200, message: `已批量${status === 'approved' ? '通过' : status === 'rejected' ? '拒绝' : '设为待审核'} ${changedIds.length} 条` });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/songs/:id', requirePermission('songs:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute(
      'UPDATE song_requests SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
      [req.params.id]
    );
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '已移入回收站' : '歌曲不存在或已在回收站'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/trash/songs', requirePermission('songs:delete'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const [songs] = await pool.execute(`
      SELECT sr.*, ts.name as slot_name, u.username, u.nickname
      FROM song_requests sr
      JOIN time_slots ts ON sr.slot_id = ts.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.deleted_at IS NOT NULL
      ORDER BY sr.deleted_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM song_requests WHERE deleted_at IS NOT NULL');
    res.json({
      code: 200,
      data: {
        songs,
        total: countResult[0].total,
        page,
        limit,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取点歌回收站失败:', err.message);
    res.status(500).json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/trash/songs/:id', requirePermission('songs:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM song_requests WHERE id = ? AND deleted_at IS NOT NULL', [req.params.id]);
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '已永久删除' : '歌曲不存在或不在回收站'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/trash/songs/:id/restore', requirePermission('songs:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('UPDATE song_requests SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL', [req.params.id]);
    res.json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '已恢复' : '歌曲不存在或不在回收站'
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});


router.post('/search-song-info', requirePermission('songs:review'), async (req, res) => {
  try {
    const { song_name, artist } = req.body;
    if (!song_name) {
      return res.json({ code: 400, message: '请提供歌曲名' });
    }
    const aiService = require('../../services/ai');
    const info = await aiService.searchSongInfo(song_name, artist || '');
    if (info) {
      res.json({ code: 200, data: info });
    } else {
      res.json({ code: 500, message: '搜索失败' });
    }
  } catch (err) {
    res.json({ code: 500, message: '搜索失败，请稍后重试' });
  }
});

router.post('/search-song-lyrics', requirePermission('songs:review'), async (req, res) => {
  try {
    const { song_name, artist } = req.body;
    if (!song_name) {
      return res.json({ code: 400, message: '请提供歌曲名' });
    }
    const aiService = require('../../services/ai');
    const lyrics = await aiService.searchSongLyrics(song_name, artist || '');
    if (lyrics) {
      res.json({ code: 200, data: { lyrics } });
    } else {
      res.json({ code: 500, message: '搜索失败' });
    }
  } catch (err) {
    res.json({ code: 500, message: '搜索失败，请稍后重试' });
  }
});

router.post('/generate-song-intro', requirePermission('songs:review'), async (req, res) => {
  try {
    const { song_name, artist } = req.body;
    if (!song_name) {
      return res.json({ code: 400, message: '请提供歌曲名' });
    }
    const aiService = require('../../services/ai');
    const result = await aiService.generateSongIntro(song_name, artist || '');
    if (result.intro || result.lyrics) {
      res.json({ code: 200, data: { intro: result.intro || '', lyrics: result.lyrics || '' } });
    } else if (result.error) {
      const status = /API_KEY 未配置/.test(result.error) ? 503 : 502;
      res.status(status).json({
        code: status,
        message: result.error,
        data: result.prompt ? { prompt: result.prompt } : undefined
      });
    } else if (result.prompt) {
      res.json({ code: 200, data: { intro: '', lyrics: '', prompt: result.prompt, message: 'AI不可用，请复制提示词手动生成' } });
    } else {
      res.json({ code: 500, message: '生成失败' });
    }
  } catch (err) {
    res.json({ code: 500, message: '生成失败，请稍后重试' });
  }
});

router.post('/generate-cover-prompt', requirePermission('songs:review'), async (req, res) => {
  try {
    const data = await generateCoverPrompt(req.body);
    res.json({ code: 200, data: data });
  } catch (err) {
    const status = Number(err.status) || 502;
    if (status >= 500) console.error('[AI] 生成封面提示词失败:', err.message);
    res.status(status).json({ code: status, message: err.message || '封面提示词生成失败，请稍后重试' });
  }
});

router.get('/hot-chart', requirePermission('songs:review'), async (req, res) => {
  try {
    var https = require('https');
    var dateStr = new Date().toISOString().slice(0, 10);
    var url = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?tpl=3&page=detail&date=' + dateStr + '&topid=26&type=top&song_begin=0&song_num=10&format=json';
    var data = await new Promise(function(resolve, reject) {
      https.get(url, { headers: { 'Referer': 'https://y.qq.com/' } }, function(resp) {
        var body = '';
        resp.on('data', function(c) { body += c; });
        resp.on('end', function() { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    var songs = (data.songlist || []).slice(0, 10).map(function(item, index) {
      var d = item.data || {};
      var rawHeat = d.rank_value ?? d.cur_count ?? d.listenCount ?? d.hot ?? null;
      var heat = rawHeat === null || rawHeat === '' ? null : Number(rawHeat);
      if (!Number.isFinite(heat)) heat = null;
      var rawTrend = d.in_count ?? d.old_count ?? null;
      var trend = rawTrend === null || rawTrend === '' ? null : Number(rawTrend);
      if (!Number.isFinite(trend)) trend = null;
      return {
        name: d.songname || '',
        artist: (d.singer || []).map(function(s) { return s.name; }).join(' / '),
        album: d.albumname || d.album || '',
        albummid: d.albummid || '',
        rank: Number(d.cur_rank || d.rank || index + 1) || index + 1,
        heat: heat,
        trend: trend,
        heat_label: heat === null ? '' : String(heat)
      };
    });
    res.json({ code: 200, data: songs });
  } catch (err) {
    res.json({ code: 500, message: '获取热歌榜失败，请稍后重试' });
  }
});

router.get('/song-cover', requirePermission('songs:review'), async (req, res) => {
  try {
    var q = req.query.q || '';
    if (!q) return res.json({ code: 400, data: { albummid: '' } });
    var https = require('https');
    var url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent(q) + '&format=json&n=5&p=1';
    var data = await new Promise(function(resolve, reject) {
      https.get(url, { headers: { 'Referer': 'https://y.qq.com/' } }, function(resp) {
        var body = '';
        resp.on('data', function(c) { body += c; });
        resp.on('end', function() { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    var mid = '';
    if (data.data && data.data.song && data.data.song.list && data.data.song.list.length > 0) {
      var list = data.data.song.list;
      var parts = q.split(/\s+/);
      var artistPart = parts.length > 1 ? parts[parts.length - 1] : '';
      var best = list[0];
      if (artistPart) {
        for (var i = 0; i < list.length; i++) {
          var singers = (list[i].singer || []).map(function(s) { return s.name || ''; }).join(' ');
          if (singers.toLowerCase().indexOf(artistPart.toLowerCase()) !== -1) {
            best = list[i];
            break;
          }
        }
      }
      mid = best.albummid || '';
    }
    res.json({ code: 200, data: { albummid: mid } });
  } catch (err) {
    res.json({ code: 500, data: { albummid: '' } });
  }
});



module.exports = router;
