'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const Module = require('module');
const express = require('express');
const { repairWechatAuthor } = require('../services/wechat-author-repair');

const copy = value => JSON.parse(JSON.stringify(value));
const fixtureUser = { id: 17, nickname: '测试署名', username: 'fixture', openid: 'private-openid-fixture' };
const fixtureRow = { id: 23, song_name: '测试歌', artist: '歌手', submitter: '匿名同学', status: 'pending', created_at: '2026-10-04' };
const state = { users: [fixtureUser], rows: [fixtureRow], related: [], writes: 0, rollbacks: 0, releases: 0, connections: 0, failWrite: false };
const pool = { async getConnection() {
  state.connections++;
  let working;
  return {
    async beginTransaction() { working = copy(state.rows); },
    async execute(sql, params) {
      if (sql.startsWith('SELECT id, nickname')) {
        assert(sql.includes('LIMIT 2 FOR UPDATE'));
        assert.deepStrictEqual(params, ['测试署名', '测试署名']);
        return [state.users];
      }
      if (sql.startsWith('SELECT id, song_name')) {
        assert(sql.includes('source = "wechat"') && sql.includes('INTERVAL 2 DAY') && sql.includes('LIMIT 1 FOR UPDATE'));
        assert.deepStrictEqual(params, [fixtureUser.openid]);
        return [working];
      }
      if (sql.startsWith('SELECT d.id AS record_id')) {
        assert(sql.includes('LIMIT 5') && sql.includes('INTERVAL 2 DAY') && sql.includes('d.source = "wechat"'));
        assert.deepStrictEqual(params, Array(4).fill('测试署名'));
        return [state.related];
      }
      if (sql.startsWith('UPDATE daily_song_recs')) {
        if (state.failWrite) throw Object.assign(new Error('private SQL details'), { code: 'ER_FIXTURE' });
        assert.deepStrictEqual(params, ['测试署名', 23, fixtureUser.openid, '匿名同学']);
        state.writes++;
        working[0].submitter = params[0];
        return [{ affectedRows: 1 }];
      }
      throw new Error('Unexpected repair SQL');
    },
    async commit() { state.rows = working; },
    async rollback() { state.rollbacks++; },
    release() { state.releases++; }
  };
} };

async function main() {
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wall-author-repair-test-'));
  const options = { backupDir };
  const inspect = { mode: 'inspect', account_name: '测试署名' };
  const apply = { ...inspect, mode: 'apply', record_id: 23, expected_name: '测试署名' };
  let server;
  const originalSecret = process.env.DEPLOY_SECRET;
  try {
    assert.equal((await repairWechatAuthor(pool, { ...inspect, mode: 'sql' }, options)).status, 400);
    assert.equal((await repairWechatAuthor(pool, { ...apply, record_id: '23' }, options)).status, 400);
    assert.equal((await repairWechatAuthor(pool, { ...inspect, account_name: 'x'.repeat(51) }, options)).status, 400);
    assert.equal(state.connections, 0, 'invalid arguments must not open the database');
    const preview = await repairWechatAuthor(pool, inspect, options);
    assert.equal(preview.body.data.repairable, true);
    assert.equal(state.writes, 0, 'inspect must never write');
    assert(!JSON.stringify(preview).includes(fixtureUser.openid));
    assert.equal((await fs.readdir(backupDir)).length, 0);

    assert.equal((await repairWechatAuthor(pool, { ...apply, record_id: 24 }, options)).status, 409);
    assert.equal((await repairWechatAuthor(pool, { ...apply, expected_name: '旧名称' }, options)).status, 409);
    state.users = [fixtureUser, { ...fixtureUser, id: 18 }];
    assert.equal((await repairWechatAuthor(pool, inspect, options)).status, 409);
    state.users = [{ ...fixtureUser, openid: null }];
    assert.equal((await repairWechatAuthor(pool, inspect, options)).status, 409);
    state.users = [];
    state.related = [{ record_id: 23, song_name: '测试署名的歌', artist: '歌手', nickname: '账号别名', username: 'fixture' }];
    const related = await repairWechatAuthor(pool, inspect, options);
    assert.equal(related.body.data.account_matches, 0);
    assert.equal(related.body.data.candidates.length, 1, 'inspection can return bounded name-related candidates');
    assert.equal((await repairWechatAuthor(pool, apply, options)).status, 409, 'related candidates cannot authorize an update');
    state.related = [];
    state.users = [fixtureUser];
    state.rows = [];
    assert.equal((await repairWechatAuthor(pool, inspect, options)).status, 404);
    state.rows = [{ ...fixtureRow, submitter: '自选署名' }];
    assert.equal((await repairWechatAuthor(pool, apply, options)).status, 409);
    assert.equal(state.writes, 0, 'identity ambiguity and custom names must block updates');

    state.rows = [copy(fixtureRow)];
    const blockingPath = path.join(backupDir, 'not-a-directory');
    await fs.writeFile(blockingPath, 'fixture');
    await assert.rejects(repairWechatAuthor(pool, apply, { backupDir: blockingPath }));
    assert.equal(state.writes, 0, 'backup failure must precede any update');
    state.failWrite = true;
    await assert.rejects(repairWechatAuthor(pool, apply, options));
    assert.equal(state.rows[0].submitter, '匿名同学', 'database failure must roll back');
    state.failWrite = false;
    const repaired = await repairWechatAuthor(pool, apply, options);
    assert.equal(repaired.body.data.changed, true);
    assert.equal(state.rows[0].submitter, '测试署名');
    const backup = await fs.readFile(path.join(backupDir, repaired.body.data.backup_id + '.json'), 'utf8');
    assert.equal(JSON.parse(backup).submitter, '匿名同学');
    assert(!backup.includes(fixtureUser.openid));
    const replay = await repairWechatAuthor(pool, apply, options);
    assert.equal(replay.body.data.changed, false);
    assert.equal(state.writes, 1, 'replay must not rewrite the row');
    assert.equal(state.releases, state.connections);

    // Exercise the actual operator route, including authorization before DB use.
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '../config/database') return { pool };
      return originalLoad.call(this, request, parent, isMain);
    };
    let router;
    try { router = require('../routes/deploy'); } finally { Module._load = originalLoad; }
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const url = 'http://127.0.0.1:' + server.address().port + '/api/deploy-maintenance/wechat-author';
    const post = token => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-gitee-token': token } : {}) }, body: JSON.stringify(inspect) });
    process.env.DEPLOY_SECRET = ['local', 'fixture', 'operator', 'secret'].join('-');
    const before = state.connections;
    assert.equal((await post()).status, 403);
    assert.equal((await post('invalid')).status, 403);
    assert.equal(state.connections, before, 'unauthorized calls cannot inspect accounts');
    delete process.env.DEPLOY_SECRET;
    assert.equal((await post()).status, 500);
    process.env.DEPLOY_SECRET = ['local', 'fixture', 'operator', 'secret'].join('-');
    // The lazily required DB must also be mocked during the HTTP handler.
    Module._load = function(request, parent, isMain) {
      if (request === '../config/database') return { pool };
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      const response = await post(process.env.DEPLOY_SECRET);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert(!(JSON.stringify(await response.json())).includes(fixtureUser.openid));
    } finally { Module._load = originalLoad; }
    console.log('wechat author repair checks passed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (originalSecret === undefined) delete process.env.DEPLOY_SECRET;
    else process.env.DEPLOY_SECRET = originalSecret;
    await fs.rm(backupDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
