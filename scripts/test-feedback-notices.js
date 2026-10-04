'use strict';

const assert = require('assert');
const Module = require('module');

const executed = [];
const transactions = [];
const receipts = new Map();
const outboxRows = [];
let feedbackInsertId = 73;
let failNextQuery = false;

function createConnection() {
  const connection = {
    began: 0,
    committed: 0,
    rolledBack: 0,
    released: 0,
    async beginTransaction() { this.began += 1; },
    async commit() { this.committed += 1; },
    async rollback() { this.rolledBack += 1; },
    release() { this.released += 1; },
    async execute(sql, params = []) {
      executed.push({ sql, params, connection: this });
      if (failNextQuery) {
        failNextQuery = false;
        throw new Error('simulated database detail');
      }
      if (/INSERT INTO feedbacks/i.test(sql)) {
        return [{ affectedRows: 1, insertId: feedbackInsertId++ }];
      }
      if (/SELECT id, email, nickname, username FROM users/i.test(sql)) {
        return [[
          { id: 1, email: 'Admin@Example.com', nickname: '管理员一' },
          { id: 2, email: 'admin@example.com', nickname: '重复地址' },
          { id: 3, email: 'invalid-email', nickname: '无效地址' },
          { id: 4, email: 'second@example.com', nickname: '管理员二' }
        ]];
      }
      if (/INSERT INTO notification_outbox/i.test(sql)) {
        outboxRows.push({ dedupeKey: params[0], recipient: params[1], subject: params[2], connection: this });
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO api_write_requests/i.test(sql)) {
        const [userId, scope, requestKey, payloadHash] = params;
        const mapKey = `${userId}|${scope}|${requestKey}`;
        if (!receipts.has(mapKey)) receipts.set(mapKey, { payload_hash: payloadHash, response_status: null, response_body: null });
        return [{ affectedRows: 1 }];
      }
      if (/SELECT payload_hash, response_status, response_body FROM api_write_requests/i.test(sql)) {
        const [userId, scope, requestKey] = params;
        const receipt = receipts.get(`${userId}|${scope}|${requestKey}`);
        return [receipt ? [receipt] : []];
      }
      if (/UPDATE api_write_requests SET response_status/i.test(sql)) {
        const [status, body, userId, scope, requestKey] = params;
        const receipt = receipts.get(`${userId}|${scope}|${requestKey}`);
        assert(receipt, '反馈幂等收据必须先插入');
        receipt.response_status = status;
        receipt.response_body = body;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected connection SQL: ${sql}`);
    }
  };
  transactions.push(connection);
  return connection;
}

const fakePool = {
  async getConnection() { return createConnection(); },
  async execute(sql, params = []) {
    executed.push({ sql, params, connection: null });
    if (failNextQuery) {
      failNextQuery = false;
      return Promise.reject(new Error('simulated database detail'));
    }
    if (/^\s*CREATE TABLE/i.test(sql)) return [{}];
    if (/FROM feedbacks/i.test(sql)) return [[{ id: 1, title: '测试反馈' }]];
    if (/FROM notices/i.test(sql)) return [[{ id: 1, title: '测试公告' }]];
    throw new Error(`unexpected pool SQL: ${sql}`);
  }
};

let feedbackTableReady;
function ensureFeedbackTable(executor) {
  if (!feedbackTableReady) {
    feedbackTableReady = executor.execute('CREATE TABLE IF NOT EXISTS feedbacks (id INT PRIMARY KEY)').catch(error => {
      feedbackTableReady = undefined;
      throw error;
    });
  }
  return feedbackTableReady;
}

function createRouter() {
  const routes = [];
  return {
    get(path, ...handlers) { routes.push({ method: 'GET', path, handlers }); },
    post(path, ...handlers) { routes.push({ method: 'POST', path, handlers }); },
    __routes: routes
  };
}

function loadRouter(routePath, authModule) {
  const originalLoad = Module._load;
  const fakeExpress = { Router: createRouter };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return fakeExpress;
    if (request === '../config/database') return { pool: fakePool, ensureFeedbackTable };
    if (request === '../middleware/auth') return authModule;
    if (request === '../services/email') {
      return { buildAdminFeedbackEmail: feedback => ({ subject: `mock feedback ${feedback.id}`, html: '<p>mock</p>' }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const resolved = require.resolve(routePath);
    delete require.cache[resolved];
    return require(routePath);
  } finally {
    Module._load = originalLoad;
  }
}

function findRoute(router, method, path) {
  const route = router.__routes.find(item => item.method === method && item.path === path);
  assert(route, `route not found: ${method} ${path}`);
  return route;
}

async function invoke(route, req) {
  let response;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { response = payload; return payload; }
  };
  for (const handler of route.handlers) {
    let continued = false;
    const next = () => { continued = true; };
    const result = handler(req, res, next);
    if (result && typeof result.then === 'function') await result;
    if (response || !continued) break;
  }
  return { body: response, status: res.statusCode };
}

async function main() {
  const auth = (req, res, next) => {
    req.user = req.user || { id: 42, nickname: '用户' };
    next();
  };
  const feedbackRouter = loadRouter('../routes/feedback', { auth });
  const noticesRouter = loadRouter('../routes/notices', {});
  const submit = findRoute(feedbackRouter, 'POST', '/');
  const myFeedback = findRoute(feedbackRouter, 'GET', '/my');
  const notices = findRoute(noticesRouter, 'GET', '/');

  executed.length = 0;
  let result = await invoke(submit, { body: { type: 'bug', title: 123, content: '内容' }, user: { id: 42 } });
  assert.deepStrictEqual(result.body, { code: 400, message: '请输入标题' });
  assert.strictEqual(executed.length, 0, '非法反馈不应访问数据库');

  result = await invoke(submit, {
    body: { type: ' bug ', title: ' 标题 ', content: ' 内容 ', contact: ' 联系方式 ' },
    user: { id: 42, nickname: '用户' }
  });
  assert.strictEqual(result.body.code, 200);
  assert.strictEqual(transactions[0].began, 1);
  assert.strictEqual(transactions[0].committed, 1);
  assert.strictEqual(transactions[0].rolledBack, 0);
  assert.strictEqual(transactions[0].released, 1);
  assert.strictEqual(executed.filter(item => /^\s*CREATE TABLE/i.test(item.sql)).length, 0, '提交反馈不应再负责执行反馈表 DDL');
  const insert = executed.find(item => /^\s*INSERT INTO feedbacks/i.test(item.sql));
  assert.deepStrictEqual(insert.params, [42, 'bug', '标题', '内容', '联系方式', 'pending']);
  assert.strictEqual(outboxRows.length, 2, '反馈和管理员通知应在同一事务中登记，且收件人邮箱去重');
  assert(outboxRows.every(row => row.connection === transactions[0]), 'outbox 登记必须复用反馈事务连接');
  assert(outboxRows.every(row => row.subject.startsWith('mock feedback ')), '路由必须使用新的 {subject, html} 邮件模板结果');

  const keyRequest = {
    body: { type: 'other', title: '幂等标题', content: '幂等内容' },
    user: { id: 42, nickname: '用户' },
    headers: { 'idempotency-key': 'feedback-key-12345678' }
  };
  result = await invoke(submit, keyRequest);
  assert.strictEqual(result.body.code, 200);
  const writesAfterFirstKey = executed.filter(item => /^\s*INSERT INTO feedbacks/i.test(item.sql)).length;
  const outboxAfterFirstKey = outboxRows.length;
  result = await invoke(submit, keyRequest);
  assert.strictEqual(result.body.code, 200);
  assert.strictEqual(executed.filter(item => /^\s*INSERT INTO feedbacks/i.test(item.sql)).length, writesAfterFirstKey, '同 key 回放不得重复写反馈');
  assert.strictEqual(outboxRows.length, outboxAfterFirstKey, '同 key 回放不得重复登记通知');
  assert.strictEqual(transactions.at(-1).committed, 1, '幂等回放仍应正常提交读取事务');

  result = await invoke(submit, { ...keyRequest, body: { type: 'other', title: '被篡改', content: '幂等内容' } });
  assert.deepStrictEqual(result.body, { code: 409, message: '这次提交的内容已变更，请重新提交' });
  assert.strictEqual(transactions.at(-1).rolledBack, 1, '幂等 payload 冲突必须回滚');

  result = await invoke(myFeedback, { query: { page: '2', limit: '999999999' }, user: { id: 42 } });
  assert.strictEqual(result.body.code, 200);
  assert.strictEqual(executed.filter(item => /^\s*CREATE TABLE/i.test(item.sql)).length, 1, 'DDL 仅由列表接口遗留 ensure 且同进程只执行一次');
  const feedbackSelect = executed.filter(item => /FROM feedbacks/i.test(item.sql)).at(-1);
  assert.deepStrictEqual(feedbackSelect.params, [42, 100, 100]);
  assert(Array.isArray(result.body.data), '我的反馈 data 必须保持数组结构');

  result = await invoke(notices, { query: { page: '-1', limit: '999999999' } });
  assert.strictEqual(result.body.code, 200);
  const noticeSelect = executed.filter(item => /FROM notices/i.test(item.sql)).at(-1);
  assert.deepStrictEqual(noticeSelect.params, [50, 0]);
  assert(Array.isArray(result.body.data), '公告 data 必须保持数组结构');

  failNextQuery = true;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    result = await invoke(notices, { query: {} });
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepStrictEqual(result.body, { code: 500, message: '服务器错误' });

  console.log('[feedback/notices] 通过：输入校验、同事务反馈与 outbox 登记、幂等回放与冲突、DDL 去重、分页限幅和安全错误返回');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
