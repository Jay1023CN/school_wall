'use strict';

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { registerMiddlewares } = require('../http/middleware');
const { getClientIp } = require('../services/ip-lookup');
const { transitionSongStatus } = require('../services/song-state-transitions');
const { rollbackOrDiscard, releaseConnection } = require('../services/database-transaction');

async function testProxy() {
  const prior = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  const app = express();
  registerMiddlewares(app, { logging: false });
  app.get('/ip', (req, res) => res.json({ ip: getClientIp(req) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/ip', {
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7', 'x-real-ip': '203.0.113.55' }
    });
    assert.equal((await response.json()).ip, '198.51.100.7', 'stop at nearest untrusted proxy; ignore forged leftmost/real-ip');
    assert.equal(getClientIp({ ip: '198.51.100.7', headers: { 'x-real-ip': '203.0.113.55' } }), '198.51.100.7');
    process.env.TRUST_PROXY = '*';
    assert.throws(() => registerMiddlewares(express()), /trusted proxy/);
  } finally {
    if (prior === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prior;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

async function testTransitions() {
  let current = 'pending';
  let writes = 0;
  const connection = { async execute(sql, params) {
    if (sql.startsWith('SELECT')) return [[{ id: 7, status: current }]];
    writes++;
    assert(sql.includes('AND status = ?'));
    if (params[params.length - 1] !== current) return [{ affectedRows: 0 }];
    current = params[0];
    return [{ affectedRows: 1 }];
  } };
  await transitionSongStatus(connection, 7, 'rejected', 'reason');
  assert.equal(current, 'rejected');
  await assert.rejects(transitionSongStatus(connection, 7, 'played'), error => error.statusCode === 409);
  assert.equal(writes, 1);
  await transitionSongStatus(connection, 7, 'pending');
  current = 'approved';
  await assert.rejects(transitionSongStatus(connection, 7, 'rejected', 'stale'), error => error.statusCode === 409);
  await transitionSongStatus(connection, 7, 'rejected', 'explicit', undefined, 'approved');
  assert.equal(current, 'rejected');
  current = 'approved';
  await transitionSongStatus(connection, 7, 'played', null, undefined, 'approved');
  await assert.rejects(transitionSongStatus(connection, 7, 'pending', null, undefined, 'played'), error => error.statusCode === 409);
}

async function testRollbackIsolation() {
  const logs = [];
  const connection = {
    released: 0,
    destroyed: 0,
    async rollback() {
      const error = new Error('rollback contains secret SQL payload');
      error.code = 'ER_TEST_ROLLBACK';
      throw error;
    },
    destroy() { this.destroyed += 1; },
    release() { this.released += 1; }
  };
  const originalError = new Error('original transaction failure');
  assert.strictEqual(await rollbackOrDiscard(connection, originalError, { error: (...args) => logs.push(args.join(' ')) }), false);
  assert.strictEqual(connection.destroyed, 1, '回滚失败必须销毁连接');
  assert.strictEqual(releaseConnection(connection), false, '已隔离连接不得释放回池');
  assert.strictEqual(connection.released, 0);
  assert(logs.join('\n').includes('ER_TEST_ROLLBACK'));
  assert(!logs.join('\n').includes('secret SQL payload'), '回滚日志不得包含错误详情或 SQL');

  const noDestroyConnection = {
    released: 0,
    async rollback() { throw new Error('rollback unavailable'); },
    release() { this.released += 1; }
  };
  assert.strictEqual(await rollbackOrDiscard(noDestroyConnection, originalError, { error() {} }), false);
  assert.strictEqual(releaseConnection(noDestroyConnection), false, '无 destroy 的 fake 连接也必须按标记丢弃');
  assert.strictEqual(noDestroyConnection.released, 0);
}

async function testBrowserReceipts() {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/js/app.js'), 'utf8');
  const section = source.slice(source.indexOf('function hasHeader('), source.indexOf('async function requestJson('));
  const stored = new Map();
  const context = vm.createContext({ URL, TextEncoder, Uint8Array, Date, getToken: () => 'fixture',
    window: { location: { origin: 'https://example.invalid' }, crypto: crypto.webcrypto },
    sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) } });
  vm.runInContext(section, context);
  const opts = () => ({ method: 'POST', body: '{"content":"hello"}', headers: {} });
  const first = opts();
  const fingerprint = await context.prepareWriteRequest('/api/posts', first);
  const retry = opts();
  await context.prepareWriteRequest('/api/posts', retry);
  assert.equal(retry.headers['Idempotency-Key'], first.headers['Idempotency-Key']);
  context.finishWriteRequest(fingerprint, { code: 500 });
  const ambiguous = opts(); await context.prepareWriteRequest('/api/posts', ambiguous);
  assert.equal(ambiguous.headers['Idempotency-Key'], first.headers['Idempotency-Key']);
  context.finishWriteRequest(fingerprint, { code: 200 });
  const fresh = opts(); await context.prepareWriteRequest('/api/posts', fresh);
  assert.notEqual(fresh.headers['Idempotency-Key'], first.headers['Idempotency-Key']);
  assert(![...stored.values()].join('').includes('hello'), 'storage contains digest, not submitted content');
  context.window.crypto = { subtle: { digest: async () => { throw new Error('denied'); } } };
  assert.equal(await context.prepareWriteRequest('/api/posts', opts()), null);
}

Promise.resolve().then(testProxy).then(testTransitions).then(testBrowserReceipts).then(testRollbackIsolation)
  .then(() => console.log('Architecture reliability tests passed: trusted proxies, stale transitions, ambiguous request receipts, rollback isolation'))
  .catch(error => { console.error(error); process.exitCode = 1; });
