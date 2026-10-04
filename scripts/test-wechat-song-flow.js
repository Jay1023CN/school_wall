const assert = require('assert');
const Module = require('module');
const path = require('path');

let session;
let searchResult = null;
let searchCalls = 0;
const fakePool = {
  execute: async function(sql, params) {
    if (sql.startsWith('SELECT step, song_name, artist, intro, display_name FROM wechat_song_recs')) {
      return [[session ? Object.assign({}, session) : undefined].filter(Boolean)];
    }
    if (sql.startsWith('SELECT song_name FROM wechat_song_recs')) return [[{ song_name: session.song_name }]];
    if (sql.startsWith('UPDATE wechat_song_recs SET step = "song_name"')) {
      session = { step: 'song_name', song_name: null, artist: null };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE wechat_song_recs SET step = "song_intro"')) {
      session.step = 'song_intro';
      session.artist = params[0];
      return [{ affectedRows: 1 }];
    }
    throw new Error('Unexpected SQL in song-flow test: ' + sql);
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../config/database') return { pool: fakePool };
  if (request === './ai') return { searchSongInfo: async function() { searchCalls += 1; return searchResult; } };
  if (request === './wechat') return {};
  return originalLoad.call(this, request, parent, isMain);
};
let flow;
try {
  flow = require(path.join(__dirname, '..', 'services', 'wechat-flows.js'));
} finally {
  Module._load = originalLoad;
}

(async function() {
  session = { step: 'song_artist', song_name: '测试曲', artist: null, intro: null, display_name: null };
  searchCalls = 0;
  const blankArtist = await flow.handleSongFlow('openid', '   ');
  assert.ok(blankArtist.text.includes('歌手姓名'), '歌手为空时应要求补填');
  assert.strictEqual(searchCalls, 0, '歌手为空时不得执行搜索');

  const skippedArtist = await flow.handleSongFlow('openid', '跳过');
  assert.ok(skippedArtist.text.includes('歌手姓名'), '回复跳过时也应要求填写歌手');
  assert.strictEqual(searchCalls, 0, '跳过歌手时不得进入后续流程');

  searchResult = null;
  const missing = await flow.handleSongFlow('openid', '测试歌手');
  assert.ok(missing.text.includes('暂时没有搜到'), '搜索无结果时应先告知用户');
  assert.strictEqual(session.step, 'song_name', '搜索无结果后应让用户重新填写歌曲名和歌手');

  session = { step: 'song_artist', song_name: '测试曲', artist: null, intro: null, display_name: null };
  searchResult = { album: '测试专辑' };
  const found = await flow.handleSongFlow('openid', '测试歌手');
  assert.ok(found.text.includes('听歌理由'), '搜索到歌曲后才进入下一步');
  assert.strictEqual(session.step, 'song_intro', '搜到后应保存歌手并继续推歌流程');
  assert.strictEqual(session.artist, '测试歌手');
  assert.strictEqual(searchCalls, 2, '每次提交歌手信息应先搜索一次');
  console.log('wechat song-flow checks passed');
})().catch(function(error) {
  console.error(error);
  process.exitCode = 1;
});
