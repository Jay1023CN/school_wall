const express = require('express');
const { pool } = require('../../config/database');
const { superAdminOnly, requirePermission } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');

const router = express.Router();

// ===== 每日推歌管理 =====
router.get('/', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { status, keyword } = req.query;
    const candidate = req.query.candidate === '1' || req.query.candidate === 'true';
    const candidateState = req.query.candidate_state === 'hidden' ? 'hidden' : 'active';

    var sql = 'SELECT * FROM daily_song_recs WHERE 1=1';
    var params = [];

    if (candidateState === 'hidden') {
      // “移出候选”只改变候选可见性，不能篡改已同步状态或发布时间。
      sql += ' AND candidate_hidden_at IS NOT NULL';
    } else if (candidate) {
      // 选稿器：未发布的歌始终可见；已同步的歌仅保留三天供调整后复用。
      // 兼容旧记录只写入 published 状态而缺少 published_at 的情况。
      sql += ' AND candidate_hidden_at IS NULL AND (status = "pending" OR (status = "published" AND COALESCE(published_at, created_at) >= DATE_SUB(NOW(), INTERVAL 3 DAY)))';
    }

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (keyword) {
      sql += ' AND (song_name LIKE ? OR artist LIKE ? OR submitter LIKE ?)';
      params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
    }

    const [countResult] = await pool.execute(sql.replace('SELECT *', 'SELECT COUNT(*) as total'), params);
    const total = countResult[0]?.total || 0;

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [songs] = await pool.execute(sql, params);

    res.json({
      code: 200,
      data: {
        songs,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
        total
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '查询失败，请稍后重试' });
  }
});

// 手动添加推歌
router.post('/', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    const songName = String(req.body?.song_name || '').trim();
    const artist = String(req.body?.artist || '').trim();
    const toWhom = String(req.body?.to_whom || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!songName) {
      return res.json({ code: 400, message: '请填写歌曲名' });
    }
    if (!artist) {
      return res.json({ code: 400, message: '请填写歌手' });
    }
    await pool.execute(
      'INSERT INTO daily_song_recs (song_name, artist, to_whom, message, source, submitter, status, created_at) VALUES (?, ?, ?, ?, "manual", "管理员", "pending", NOW())',
      [songName, artist, toWhom, message]
    );
    res.json({ code: 200, message: '添加成功' });
  } catch (err) {
    res.json({ code: 500, message: '添加失败，请稍后重试' });
  }
});

router.post('/:id/publish', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  // 保留路由以免旧后台直接报 404，但不允许绕过公众号草稿同步伪造已发布状态。
  res.status(409).json({ code: 409, message: '每日推歌只能在“同步到公众号”成功后自动标为已发布' });
});

router.post('/:id/unpublish', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  // 已同步到公众号的记录保留真实发布时间，不能通过后台回退成“未发布”。
  res.status(409).json({ code: 409, message: '已发布记录不能手动撤回；三天内仍可在公众号推送页复用' });
});

// 批量移出 / 恢复公众号候选。它不修改 status 或 published_at，避免把未同步歌曲伪造成已发布。
router.post('/candidate-visibility', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(rawIds.map(Number).filter(Number.isSafeInteger))];
    const hidden = req.body?.hidden === true;
    if (ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ code: 400, message: '请选择 1 到 100 首歌曲' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const [result] = await pool.execute(
      `UPDATE daily_song_recs SET candidate_hidden_at = ${hidden ? 'NOW()' : 'NULL'} WHERE id IN (${placeholders})`,
      ids
    );
    res.json({
      code: 200,
      message: hidden ? '已移出公众号候选' : '已取消移出标记',
      data: { updated: result.affectedRows }
    });
  } catch (err) {
    res.status(500).json({ code: 500, message: '更新候选状态失败，请稍后重试' });
  }
});

// 批量删除必须一次提交并返回影响数量；前端据此立即移除卡片和更新计数。
router.delete('/', superAdminOnly, requirePermission('songs:delete'), async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [...new Set(rawIds.map(Number).filter(Number.isSafeInteger))];
    if (ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ code: 400, message: '请选择 1 到 100 首歌曲' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const [result] = await pool.execute(`DELETE FROM daily_song_recs WHERE id IN (${placeholders})`, ids);
    res.json({ code: 200, message: '已删除', data: { deleted: result.affectedRows } });
  } catch (err) {
    res.status(500).json({ code: 500, message: '删除失败，请稍后重试' });
  }
});

router.delete('/:id', superAdminOnly, requirePermission('songs:delete'), async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM daily_song_recs WHERE id = ?', [req.params.id]);
    res.status(result.affectedRows > 0 ? 200 : 404).json({
      code: result.affectedRows > 0 ? 200 : 404,
      message: result.affectedRows > 0 ? '已删除' : '歌曲不存在或已删除'
    });
  } catch (err) {
    res.json({ code: 500, message: '删除失败，请稍后重试' });
  }
});

// 推歌编辑器共用的数据清洗与更新逻辑。状态、发布时间和候选可见性由各自流程维护，不能从编辑器篡改。
function normalizeDailySongField(body, key, maxLength) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, key)) return { present: false, value: undefined };
  var value = body[key] === null || body[key] === undefined ? '' : String(body[key]).trim();
  if (value.length > maxLength) {
    var labels = { song_name: '歌曲名', artist: '歌手', to_whom: '收件人', message: '祝福语', intro: '介绍词', lyrics: '歌词' };
    throw { status: 400, message: (labels[key] || key) + '不能超过' + maxLength + '字' };
  }
  return { present: true, value: value };
}

async function updateDailySongFields(id, body) {
  var payload = body || {};
  var name = normalizeDailySongField(payload, 'song_name', 200);
  var artist = normalizeDailySongField(payload, 'artist', 200);
  var toWhom = normalizeDailySongField(payload, 'to_whom', 100);
  var message = normalizeDailySongField(payload, 'message', 5000);
  var intro = normalizeDailySongField(payload, 'intro', 5000);
  var lyrics = normalizeDailySongField(payload, 'lyrics', 30000);
  if (name.present && !name.value) throw { status: 400, message: '请填写歌曲名' };
  if (artist.present && !artist.value) throw { status: 400, message: '请填写歌手' };

  var sets = [];
  var values = [];
  [[name, 'song_name'], [artist, 'artist'], [toWhom, 'to_whom'], [message, 'message'], [intro, 'intro'], [lyrics, 'lyrics']].forEach(function(pair) {
    if (pair[0].present) {
      var value = pair[0].value;
      if (pair[1] === 'intro') {
        // 自动清理模型偶尔返回的 JSON/Markdown 包装，避免把标记直接发到公众号。
        if (value.startsWith('{')) {
          try {
            var parsed = JSON.parse(value);
            value = parsed.intro || value;
            if (!lyrics.present && parsed.lyrics) {
              sets.push('lyrics = ?');
              values.push(String(parsed.lyrics).trim().slice(0, 30000));
            }
          } catch (e) {}
        }
        value = value.replace(/^#{1,6}\s+/gm, '').replace(/\*\*/g, '').replace(/^>\s*/gm, '').replace(/【介绍】/g, '').replace(/【歌词】/g, '').trim();
      }
      sets.push(pair[1] + ' = ?');
      values.push(value);
    }
  });

  if (Object.prototype.hasOwnProperty.call(payload, 'song_info')) {
    var songInfo = payload.song_info;
    if (typeof songInfo === 'string' && songInfo.trim()) {
      try { songInfo = JSON.parse(songInfo); } catch (e) { throw { status: 400, message: '歌曲信息格式不正确' }; }
    }
    if (songInfo !== null && songInfo !== undefined && (typeof songInfo !== 'object' || Array.isArray(songInfo))) {
      throw { status: 400, message: '歌曲信息格式不正确' };
    }
    var encodedInfo = songInfo && Object.keys(songInfo).length ? JSON.stringify(songInfo) : null;
    sets.push('song_info = ?');
    values.push(encodedInfo);
  }

  if (!sets.length) throw { status: 400, message: '没有需要保存的内容' };
  values.push(id);
  var result = await pool.execute('UPDATE daily_song_recs SET ' + sets.join(', ') + ' WHERE id = ?', values);
  return result[0];
}

// 保存推歌完整可编辑内容（歌曲名、歌手、收件信息、介绍词、歌词和歌曲资料）。
router.put('/:id', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    var result = await updateDailySongFields(req.params.id, req.body);
    if (!result.affectedRows) return res.status(404).json({ code: 404, message: '歌曲不存在或已删除' });
    res.json({ code: 200, message: '已保存' });
  } catch (err) {
    var status = err && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ code: status, message: err.message || '保存失败，请稍后重试' });
  }
});

// 兼容旧后台只保存介绍词/歌词的调用。
router.put('/:id/intro', superAdminOnly, requirePermission('songs:review'), async (req, res) => {
  try {
    var result = await updateDailySongFields(req.params.id, req.body);
    if (!result.affectedRows) return res.status(404).json({ code: 404, message: '歌曲不存在或已删除' });
    res.json({ code: 200, message: '已保存' });
  } catch (err) {
    var status = err && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ code: status, message: err.message || '保存失败，请稍后重试' });
  }
});

module.exports = router;
