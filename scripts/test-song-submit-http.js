'use strict';

const assert = require('assert');
const Module = require('module');
const express = require('express');
const { getChinaDate } = require('../services/date');

const state = { songs: [], receipts: {}, maintenanceCalls: 0, maintenanceOk: true, notices: [], dailyLimit: 3, capacity: 10,
  slotAvailable: true, weekdays: '0,1,2,3,4,5,6', manualOverride: 0, failInsert: false, failRemaining: false, commits: 0, rollbacks: 0, releases: 0 };
let transactionTail = Promise.resolve();
const copy = value => JSON.parse(JSON.stringify(value));
const unavailable = () => Object.assign(new Error('private SQL fixture details'), { code: 'ER_TEST_DATABASE' });
const pool = {
  async execute(sql) {
    if (state.failRemaining) throw unavailable();
    if (sql.includes('FROM settings')) return [[{ config_value: sql.includes('anon_song') ? 'false' : String(state.dailyLimit) }]];
    if (sql.includes('COUNT(*)')) return [[{ cnt: state.songs.length }]];
    throw new Error('unexpected non-transaction SQL');
  },
  async getConnection() {
    let working;
    let unlock;
    return {
      async beginTransaction() {
        const previous = transactionTail;
        transactionTail = new Promise(resolve => { unlock = resolve; });
        await previous;
        working = copy({ songs: state.songs, receipts: state.receipts });
      },
      async commit() { state.songs = working.songs; state.receipts = working.receipts; state.commits++; unlock(); },
      async rollback() { state.rollbacks++; if (unlock) unlock(); },
      release() { state.releases++; },
      async execute(sql, params = []) {
        if (sql.startsWith('INSERT INTO api_write_requests')) {
          const [user, scope, key, hash] = params;
          const id = [user, scope, key].join('|');
          if (!working.receipts[id]) working.receipts[id] = { payload_hash: hash, response_status: null, response_body: null };
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('SELECT payload_hash')) return [[working.receipts[params.join('|')]].filter(Boolean)];
        if (sql.startsWith('UPDATE api_write_requests')) {
          const [status, body, ...key] = params;
          Object.assign(working.receipts[key.join('|')], { response_status: status, response_body: body });
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('SELECT id FROM users')) return [[{ id: params[0] }]];
        if (sql.startsWith('SELECT sd.*')) return [state.slotAvailable ? [{ id: 11, slot_id: 5, play_date: getChinaDate(1),
          slot_name: '傍晚', start_time: '17:00', end_time: '17:10', max_songs: state.capacity, weekdays: state.weekdays, manual_override: state.manualOverride }] : []];
        if (sql.startsWith('SELECT COUNT(*)')) {
          return [[{ cnt: working.songs.filter(song => sql.includes('WHERE user_id') ? song.user_id === params[0] : song.slot_date_id === params[0]).length }]];
        }
        if (sql.startsWith('SELECT config_value')) return [[{ config_value: String(state.dailyLimit) }]];
        if (sql.startsWith('INSERT INTO song_requests')) {
          if (state.failInsert) throw unavailable();
          const id = working.songs.length + 1;
          working.songs.push({ id, user_id: params[0], slot_id: params[5], slot_date_id: params[6], anonymous: params[7] });
          return [{ insertId: id, affectedRows: 1 }];
        }
        throw new Error('unexpected transaction SQL');
      }
    };
  }
};

function loadRouter() {
  const routePath = require.resolve('../routes/songs');
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === routePath) {
      if (request === '../config/database') return { pool };
      if (request === '../modules/songs') return { maintenance: { async ensureFutureDates() { state.maintenanceCalls++; return state.maintenanceOk; } } };
      if (request === '../middleware/auth') {
        const auth = (req, res, next) => {
          if (!req.get('Authorization')) return res.status(401).json({ code: 401 });
          req.user = { id: Number(req.get('X-Test-User') || 7), nickname: '测试用户' }; next();
        };
        return { auth, optionalAuth: (req, res, next) => next() };
      }
      if (request === '../services/email') return { notifyRadioAdminsNewSongPending: async notice => { state.notices.push(notice); } };
    }
    return original.call(this, request, parent, isMain);
  };
  try { delete require.cache[routePath]; return require(routePath); }
  finally { Module._load = original; }
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/songs', loadRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const body = { song_name: '测试歌曲', artist: '测试歌手', slot_id: 5, slot_date_id: 11, is_anonymous: false };
  async function submit(payload = body, key, user = 7) {
    const response = await fetch(base + '/api/songs', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer fixture', 'X-Test-User': String(user), ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(payload) });
    const result = await response.json();
    await new Promise(resolve => setImmediate(resolve));
    return { status: response.status, body: result };
  }
  try {
    const first = await submit(body, 'song-request-key-0001');
    assert.strictEqual(first.body.code, 200, '合法点歌必须经过实际 POST handler 并保存成功');
    assert.strictEqual(state.songs.length, 1);
    assert.strictEqual(state.maintenanceCalls, 1, '提交必须使用共享 maintenance 服务');
    assert.strictEqual(state.notices.length, 1);
    assert.deepStrictEqual(await submit(body, 'song-request-key-0001'), first);
    assert.strictEqual(state.songs.length, 1, '重试不得重复保存');
    assert.strictEqual(state.notices.length, 1, '重试不得重复审核通知');
    assert.strictEqual((await submit({ ...body, artist: '不同歌手' }, 'song-request-key-0001')).body.code, 409);

    state.capacity = 1;
    assert.strictEqual((await submit(body, 'song-request-key-0002')).body.code, 400, '满额要返回明确业务错误');
    state.capacity = 10; state.dailyLimit = 1;
    assert.strictEqual((await submit(body, 'song-request-key-0002')).body.code, 400, '每日次数上限要返回明确业务错误');
    state.dailyLimit = 3; state.slotAvailable = false;
    assert.strictEqual((await submit()).body.code, 400, '过期日期不能保存');
    state.slotAvailable = true;
    assert.strictEqual((await submit({ ...body, slot_id: 6 })).body.code, 400);
    assert.strictEqual((await submit({ ...body, artist: '' })).body.code, 400);
    assert.strictEqual((await submit({ ...body, is_anonymous: true })).body.code, 400, '关闭匿名时不能点匿名歌曲');

    state.failInsert = true;
    const rollbacksBeforeFailure = state.rollbacks;
    const releasesBeforeFailure = state.releases;
    const failed = await submit(body, 'song-request-key-retry');
    assert.strictEqual(failed.status, 500);
    assert.strictEqual(failed.body.code, 500);
    assert(!JSON.stringify(failed.body).includes('private SQL'));
    assert.strictEqual(state.songs.length, 1);
    assert.strictEqual(state.rollbacks, rollbacksBeforeFailure + 1, 'INSERT 失败的本次请求必须回滚');
    assert.strictEqual(state.releases, releasesBeforeFailure + 1, 'INSERT 失败的本次请求必须释放连接');
    assert(!Object.keys(state.receipts).some(key => key.includes('song-request-key-retry')), '失败请求不得提交收据');
    state.failInsert = false;
    assert.strictEqual((await submit(body, 'song-request-key-retry')).body.code, 200, '故障修复后同一提交可以成功');

    state.maintenanceOk = false;
    assert.strictEqual((await submit()).body.code, 503, '日期维护失败必须明确返回暂时不可用');
    const slots = await fetch(base + '/api/songs/slots');
    assert.strictEqual(slots.status, 503);
    assert.strictEqual((await slots.json()).code, 503);
    state.maintenanceOk = true;
    state.failRemaining = true;
    const remaining = await fetch(base + '/api/songs/remaining', { headers: { Authorization: 'Bearer fixture' } });
    assert.strictEqual(remaining.status, 503, '数据库故障不能伪造剩余 3 次成功响应');
    assert.strictEqual((await remaining.json()).data, undefined);
    state.failRemaining = false;

    const unauthenticated = await fetch(base + '/api/songs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual(unauthenticated.status, 401);
    state.capacity = 3;
    const concurrent = await Promise.all([submit(body, 'concurrent-song-key-01', 8), submit(body, 'concurrent-song-key-02', 9)]);
    assert.deepStrictEqual(concurrent.map(result => result.body.code).sort(), [200, 400], '最后一个名额只能由一个并发请求获得');
    assert.strictEqual(state.songs.length, 3);
    assert(state.rollbacks > 0 && state.releases >= state.commits + state.rollbacks);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  console.log('[song-submit-http] 通过：真实路由提交、幂等、容量/次数、匿名/日期校验、回滚与故障恢复');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
