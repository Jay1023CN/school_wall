const DEFAULT_SONG_REJECT_REASONS = [
  '当前播放时段名额已满，请选择其他时段再点歌。',
  '本周暂未开放点歌，请下周再来。',
  '歌曲内容不适合校园广播，请更换其他歌曲。',
  '歌曲信息不完整，请补充歌名或歌手后重新提交。',
  '该歌曲已重复点歌，请选择其他歌曲。',
  '当前歌曲暂时无法播放，请更换其他歌曲。'
];

function normalizeSongRejectReasons(value) {
  let reasons = value;
  if (typeof reasons === 'string') {
    try {
      reasons = JSON.parse(reasons);
    } catch (error) {
      reasons = reasons.split(/\r?\n/);
    }
  }
  if (!Array.isArray(reasons)) return DEFAULT_SONG_REJECT_REASONS.slice();
  reasons = reasons.map(reason => String(reason || '').trim().slice(0, 500)).filter(Boolean).slice(0, 20);
  return reasons.length > 0 ? reasons : DEFAULT_SONG_REJECT_REASONS.slice();
}

module.exports = { normalizeSongRejectReasons };
