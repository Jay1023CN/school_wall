'use strict';

function stateConflict(message) {
  const error = new Error(message);
  error.isSongReviewValidationError = true;
  error.statusCode = 409;
  return error;
}

async function transitionSongStatus(connection, songId, target, reason, playOrder, expectedStatus) {
  const [rows] = await connection.execute('SELECT id, status FROM song_requests WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [songId]);
  if (!rows.length) throw stateConflict('点歌记录不存在或已在回收站');
  const current = rows[0].status;
  const defaults = { rejected: 'pending', played: 'approved', pending: 'rejected' };
  const expected = expectedStatus || defaults[target];
  if (current !== expected) throw stateConflict('点歌状态已变化，请刷新后重试');
  const allowed = { rejected: ['pending', 'approved'], played: ['approved'], pending: ['rejected'] };
  if (!allowed[target] || !allowed[target].includes(current)) throw stateConflict('当前状态不允许此操作');
  const fields = ['status = ?', 'reject_reason = ?'];
  const values = [target, target === 'rejected' ? reason : null];
  if (playOrder !== undefined) { fields.push('play_order = ?'); values.push(playOrder); }
  values.push(songId, current);
  const [updated] = await connection.execute(
    'UPDATE song_requests SET ' + fields.join(', ') + ' WHERE id = ? AND status = ? AND deleted_at IS NULL', values
  );
  if (!updated.affectedRows) throw stateConflict('点歌状态已变化，请刷新后重试');
  return updated;
}

module.exports = { transitionSongStatus, stateConflict };
