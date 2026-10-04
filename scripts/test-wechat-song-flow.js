const assert = require('assert');
const Module = require('module');
const path = require('path');

let session;
let submitSession;
let users = [];
let searchResult = null;
let searchCalls = 0;
let dailyRows = [];
let dailyInsertParams = [];
let lastPostInsertSql = '';
let postInsertAffectedRows = 1;
const fakePool = {
  execute: async function(sql, params) {
    if (sql.startsWith('SELECT step, song_name, artist, intro, display_name FROM wechat_song_recs')) {
      return [[session ? Object.assign({}, session) : undefined].filter(Boolean)];
    }
    if (sql.startsWith('SELECT song_name FROM wechat_song_recs')) return [[{ song_name: session.song_name }]];
    if (sql.startsWith('SELECT display_name FROM wechat_song_recs')) {
      return session ? [[{ display_name: session.display_name || '' }]] : [[]];
    }
    if (sql.startsWith('SELECT intro FROM wechat_song_recs')) {
      return session ? [[{ intro: session.intro || '' }]] : [[]];
    }
    if (sql.startsWith('SELECT step, title, content, polished_content, images FROM wechat_submit_sessions')) {
      return [submitSession ? [Object.assign({}, submitSession)] : []];
    }
    if (sql.startsWith('SELECT id, nickname, username FROM users WHERE openid')) return [users];
    if (sql.startsWith('SELECT id FROM users WHERE openid')) return [users.map(function(user) { return { id: user.id }; })];
    if (sql.startsWith('UPDATE wechat_song_recs SET step = "song_name"')) {
      session = { step: 'song_name', song_name: null, artist: null, intro: null, display_name: null };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE wechat_song_recs SET step = "song_intro"')) {
      session.step = 'song_intro';
      session.artist = params[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE wechat_song_recs SET step = "song_nickname"')) {
      session.step = 'song_nickname';
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE wechat_song_recs SET step = "song_confirm"')) {
      session.step = 'song_confirm';
      session.display_name = params[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT INTO daily_song_recs')) {
      dailyInsertParams.push(params.slice());
      dailyRows = [{ id: dailyInsertParams.length }];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT id FROM daily_song_recs')) return [dailyRows];
    if (sql.startsWith('UPDATE daily_song_recs')) return [{ affectedRows: 1 }];
    if (sql.startsWith('SELECT title, content, images FROM wechat_submit_sessions')) return [submitSession ? [Object.assign({}, submitSession)] : []];
    if (sql.startsWith('SELECT config_value FROM settings')) return [[{ config_value: 'true' }]];
    if (sql.startsWith('INSERT INTO posts')) {
      lastPostInsertSql = sql;
      return [{ affectedRows: postInsertAffectedRows }];
    }
    if (sql.startsWith('DELETE FROM wechat_song_recs')) {
      session = null;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('DELETE FROM wechat_submit_sessions')) {
      submitSession = null;
      return [{ affectedRows: 1 }];
    }
    throw new Error('Unexpected SQL in song-flow test: ' + sql);
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../config/database') return { pool: fakePool };
  if (request === './ai') return {
    searchSongInfo: async function() { searchCalls += 1; return searchResult; },
    generateSongIntro: async function() { return null; },
    searchSongLyrics: async function() { return null; }
  };
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

  session = { step: 'song_nickname', song_name: '绑定歌', artist: '歌手', intro: '', display_name: null };
  users = [{ id: 7, nickname: '  绑定昵称 ', username: 'account-name' }];
  const nicknameSkip = await flow.handleSongFlow('openid', '跳过');
  assert.strictEqual(session.step, 'song_confirm', '绑定账号跳过署名应进入确认');
  assert.strictEqual(session.display_name, '绑定昵称', '跳过应优先使用绑定 nickname');
  assert.ok(nicknameSkip.text.includes('署名：绑定昵称'), '确认提示应展示绑定署名');

  dailyInsertParams = [];
  const nicknameConfirm = await flow.handleSongFlow('openid', '确认');
  assert.ok(nicknameConfirm.text.includes('署名：绑定昵称'), '成功提示应展示绑定署名');
  assert.strictEqual(dailyInsertParams[0][4], '绑定昵称', '写入 daily_song_recs 的 submitter 应为绑定署名');

  session = { step: 'song_nickname', song_name: '账号歌', artist: '歌手', intro: '', display_name: null };
  users = [{ id: 8, nickname: '  ', username: 'account-name' }];
  await flow.handleSongFlow('openid', '跳过');
  assert.strictEqual(session.display_name, 'account-name', 'nickname 为空时应回退 username');

  session = { step: 'song_nickname', song_name: '编号歌', artist: '歌手', intro: '', display_name: null };
  users = [{ id: 9, nickname: ' ', username: ' ' }];
  const idSkip = await flow.handleSongFlow('openid', '跳过');
  assert.strictEqual(session.display_name, '用户9', '无昵称和用户名时应使用账号 ID 署名');
  assert.ok(!idSkip.text.includes('openid'), '用户可见署名提示不得暴露 openid');

  session = { step: 'song_nickname', song_name: '未绑定歌', artist: '歌手', intro: '', display_name: null };
  users = [];
  const unboundSkip = await flow.handleSongFlow('openid', '跳过');
  assert.strictEqual(session.step, 'song_nickname', '未绑定用户跳过署名不得推进确认');
  assert.ok(unboundSkip.text.includes('填写') && unboundSkip.text.includes('绑定'), '未绑定跳过应明确要求填写或绑定');

  const customName = await flow.handleSongFlow('openid', '自己取的名字');
  assert.strictEqual(session.step, 'song_confirm', '自填署名应进入确认');
  assert.strictEqual(session.display_name, '自己取的名字', '自填署名必须保留');
  assert.ok(customName.text.includes('署名：自己取的名字'), '确认应展示自填署名');

  session = { step: 'song_confirm', song_name: '旧数据歌', artist: '歌手', intro: '', display_name: '' };
  users = [{ id: 11, nickname: '旧账号昵称', username: 'old-account' }];
  dailyInsertParams = [];
  const oldBoundConfirm = await flow.handleSongFlow('openid', '确认');
  assert.ok(oldBoundConfirm.text.includes('署名：旧账号昵称'), '旧空署名且已绑定时应解析账号署名');
  assert.strictEqual(dailyInsertParams[0][4], '旧账号昵称', '旧空署名写入时应使用账号署名');

  session = { step: 'song_confirm', song_name: '旧数据歌', artist: '歌手', intro: '', display_name: '' };
  users = [];
  const oldEmptyConfirm = await flow.handleSongFlow('openid', '确认');
  assert.strictEqual(session.step, 'song_nickname', '旧确认记录空署名且未绑定时应退回填写署名');
  assert.ok(oldEmptyConfirm.text.includes('填写') && oldEmptyConfirm.text.includes('绑定'), '旧空署名应明确要求补名');

  submitSession = { step: 'awaiting_image', title: '投稿标题', content: '投稿内容', images: '[]' };
  users = [{ id: 10, nickname: '投稿昵称', username: 'submit-account' }];
  postInsertAffectedRows = 1;
  const published = await flow.handleSubmitFlow('openid', '确认发布');
  assert.ok(published.text.includes('署名：投稿昵称'), '投稿成功提示应展示实际署名');
  assert.ok(lastPostInsertSql.includes('is_anonymous, created_at') && lastPostInsertSql.includes(', 0, NOW()'), '投稿 INSERT 应显式写入 is_anonymous=0');
  assert.strictEqual(submitSession, null, '投稿成功后应清理投稿会话');

  submitSession = { step: 'awaiting_image', title: '解绑投稿', content: '内容', images: '[]' };
  users = [{ id: 10, nickname: '投稿昵称', username: 'submit-account' }];
  postInsertAffectedRows = 0;
  const unboundDuringInsert = await flow.handleSubmitFlow('openid', '确认发布');
  assert.ok(unboundDuringInsert.text.includes('绑定'), '插入时账号已解绑应返回绑定提示');
  assert.notStrictEqual(submitSession, null, '插入未命中绑定用户时不得清理会话');

  console.log('wechat song-flow checks passed');
})().catch(function(error) {
  console.error(error);
  process.exitCode = 1;
});
