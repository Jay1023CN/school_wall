'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { rollbackOrDiscard, releaseConnection } = require('./database-transaction');

const failure = (status, message) => ({ status, body: { code: status, message } });

// Fixed-purpose maintenance only: no caller-supplied SQL, table or file paths.
// An operator must inspect first, then pin the record and account name to apply.
async function repairWechatAuthor(pool, input, options = {}) {
  const accountName = typeof input.account_name === 'string' ? input.account_name.trim() : '';
  if (!accountName || accountName.length > 50 || !['inspect', 'apply'].includes(input.mode)) {
    return failure(400, '请提供准确账号名称和 inspect/apply 模式');
  }
  if (input.mode === 'apply' && (!Number.isSafeInteger(input.record_id) || input.record_id < 1 ||
      typeof input.expected_name !== 'string' || !input.expected_name || input.expected_name.length > 50)) {
    return failure(400, '修改前必须核对记录 ID 和账号署名');
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [users] = await connection.execute(
      'SELECT id, nickname, username, openid FROM users WHERE nickname = ? OR username = ? LIMIT 2 FOR UPDATE',
      [accountName, accountName]
    );
    if (users.length !== 1 || !users[0].openid) {
      // A user may identify a recommendation by the artist or an account alias.
      // Return bounded, name-related candidates for inspection only; applying
      // still requires a unique, exact account match and the pinned record ID.
      let candidates = [];
      if (input.mode === 'inspect') {
        const [related] = await connection.execute(
          'SELECT d.id AS record_id, d.song_name, d.artist, d.submitter, d.status, d.created_at, ' +
          'u.id AS account_id, u.nickname, u.username FROM daily_song_recs d ' +
          'LEFT JOIN users u ON u.openid = d.openid WHERE d.source = "wechat" ' +
          'AND d.created_at >= DATE_SUB(NOW(), INTERVAL 2 DAY) ' +
          'AND (LOCATE(?, d.song_name) > 0 OR LOCATE(?, d.artist) > 0 OR LOCATE(?, u.nickname) > 0 OR LOCATE(?, u.username) > 0) ' +
          'ORDER BY d.created_at DESC, d.id DESC LIMIT 5', [accountName, accountName, accountName, accountName]
        );
        candidates = related;
      }
      await connection.commit();
      return { status: 409, body: { code: 409, message: '未找到唯一且已绑定微信的账号，未修改记录',
        data: { account_matches: users.length, bound: users.length === 1 && Boolean(users[0].openid), candidates } } };
    }
    const user = users[0];
    const displayName = String(user.nickname || '').trim() || String(user.username || '').trim() || '用户' + user.id;
    // The recent, latest submission is intentional: never rewrite historical or
    // explicitly named recommendations as a bulk "anonymous cleanup".
    const [rows] = await connection.execute(
      'SELECT id, song_name, artist, submitter, status, created_at FROM daily_song_recs ' +
      'WHERE openid = ? AND source = "wechat" AND created_at >= DATE_SUB(NOW(), INTERVAL 2 DAY) ' +
      'ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE', [user.openid]
    );
    if (!rows.length) {
      await connection.commit();
      return failure(404, '未找到该账号最近两天的公众号推歌，未修改记录');
    }
    const row = rows[0];
    const data = { record_id: row.id, account_id: user.id, song_name: row.song_name, artist: row.artist,
      submitter: row.submitter, expected_name: displayName, status: row.status, created_at: row.created_at };
    if (input.mode === 'inspect') {
      await connection.commit();
      return { status: 200, body: { code: 200, data: { ...data, repairable: row.submitter === '匿名同学' } } };
    }
    if (row.id !== input.record_id || displayName !== input.expected_name) {
      await connection.commit();
      return failure(409, '记录或账号署名已变化，请重新核对，未修改记录');
    }
    if (row.submitter === displayName) {
      await connection.commit();
      return { status: 200, body: { code: 200, data: { ...data, changed: false } } };
    }
    if (row.submitter !== '匿名同学') {
      await connection.commit();
      return failure(409, '记录已有自选署名，未修改记录');
    }
    const backupDir = options.backupDir || path.join(__dirname, '..', 'logs', 'wechat-author-repairs');
    const backupId = crypto.randomUUID();
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    // Save the old value before touching the row; an unavailable backup aborts.
    // No OpenID or authentication data is persisted or returned.
    await fs.writeFile(path.join(backupDir, backupId + '.json'), JSON.stringify({
      ...data, backup_id: backupId, prepared_at: new Date().toISOString()
    }) + '\n', { flag: 'wx', mode: 0o600 });
    const [updated] = await connection.execute(
      'UPDATE daily_song_recs SET submitter = ? WHERE id = ? AND openid = ? AND source = "wechat" AND submitter = ?',
      [displayName, row.id, user.openid, '匿名同学']
    );
    if (updated.affectedRows !== 1) throw new Error('AUTHOR_REPAIR_CONFLICT');
    await connection.commit();
    return { status: 200, body: { code: 200, data: { ...data, submitter: displayName, changed: true, backup_id: backupId } } };
  } catch (error) {
    await rollbackOrDiscard(connection, error);
    throw error;
  } finally {
    releaseConnection(connection);
  }
}

module.exports = { repairWechatAuthor };
