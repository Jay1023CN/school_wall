'use strict';

function normalizeDateOnly(value) {
  if (!value) return null;
  const date = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function slotDateValue(value) {
  return value ? String(value).split('T')[0] : '';
}

function parseSongSlotDateId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function songReviewValidationError(message) {
  const error = new Error(message);
  error.isSongReviewValidationError = true;
  return error;
}

async function approveSong(connection, songId) {
  const [songs] = await connection.execute(
    'SELECT id, status FROM song_requests WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [songId]
  );
  if (songs.length === 0) throw songReviewValidationError('点歌记录不存在或已在回收站');
  if (songs[0].status !== 'pending') throw songReviewValidationError('该点歌已不在待审核状态，请刷新后重试');
  await connection.execute(
    "UPDATE song_requests SET status = 'approved', reject_reason = NULL, approved_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR) WHERE id = ? AND status = 'pending' AND deleted_at IS NULL", [songId]
  );
}

module.exports = { normalizeDateOnly, slotDateValue, parseSongSlotDateId, approveSong, songReviewValidationError };
