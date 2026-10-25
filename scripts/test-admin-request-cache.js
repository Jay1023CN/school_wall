'use strict';
const assert = require('assert');
const createCache = require('../frontend/admin/js/admin-request-cache');
const response = value => new Response(JSON.stringify({ code: 200, data: value }), { headers: { 'content-type': 'application/json' } });

async function main() {
  let clock = 0;
  let calls = 0;
  const cache = createCache({ now: () => clock });
  const settings = { scope: 'account-a' };
  const send = async () => { calls++; return response(calls); };
  const [a, b] = await Promise.all([cache.request('/api/admin/posts?page=1', settings, send), cache.request('/api/admin/posts?page=1', settings, send)]);
  assert.equal(calls, 1, '同一列表的并发读取应合并');
  assert.deepEqual(await a.json(), await b.json(), '多个调用者应能独立读取响应体');
  await cache.request('/api/admin/posts?page=1', settings, send);
  assert.equal(calls, 1, '短期切回列表应复用已读数据');
  clock = 15001;
  await cache.request('/api/admin/posts?page=1', settings, send);
  assert.equal(calls, 2, '过期后必须重新请求');
  await cache.request('/api/admin/posts/1/status', { ...settings, method: 'PUT' }, send);
  await cache.request('/api/admin/posts?page=1', settings, send);
  assert.equal(calls, 4, '审核等写入必须清空列表缓存');
  await cache.request('/api/admin/posts?page=1', { scope: 'account-b' }, send);
  assert.equal(calls, 5, '换号后不能复用前一个账号的数据');

  cache.clear();
  let finishOld;
  const old = cache.request('/api/admin/users?page=1', settings, () => new Promise(resolve => { finishOld = resolve; }));
  await cache.request('/api/admin/users/1', { ...settings, method: 'PUT' }, () => Promise.resolve(response('updated')));
  finishOld(response('old'));
  await old;
  const fresh = await cache.request('/api/admin/users?page=1', settings, () => Promise.resolve(response('fresh')));
  assert.equal((await fresh.json()).data, 'fresh', '写入前发出的慢请求不得重新污染缓存');

  let failures = 0;
  const fail = async () => { failures++; return new Response(JSON.stringify({ code: 500 })); };
  await cache.request('/api/admin/songs', settings, fail);
  await cache.request('/api/admin/songs', settings, fail);
  assert.equal(failures, 2, '业务错误不能被缓存');
  console.log('[admin-request-cache] 通过：并发合并、独立响应体、到期、写后失效、账号隔离及错误恢复');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
