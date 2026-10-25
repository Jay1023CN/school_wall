'use strict';

const assert = require('assert');
const { runWriteTransaction } = require('../services/write-transaction');

class FakeWriteDatabase {
  constructor() {
    this.receipts = new Map();
    this.businessWrites = [];
    this.connections = [];
    this.events = [];
    this.failOperation = false;
  }

  async getConnection() {
    const db = this;
    this.events.push('getConnection');
    const connection = {
      began: 0,
      committed: 0,
      rolledBack: 0,
      released: 0,
      destroyed: 0,
      async beginTransaction() { this.began += 1; },
      async commit() { this.committed += 1; },
      async rollback() {
        this.rolledBack += 1;
        if (db.failRollback) {
          const error = new Error('simulated rollback failure with secret payload');
          error.code = 'ER_TEST_ROLLBACK';
          throw error;
        }
      },
      release() { this.released += 1; },
      destroy() { this.destroyed += 1; },
      async execute(sql, params = []) {
        if (/INSERT INTO api_write_requests/i.test(sql)) {
          const [userId, scope, requestKey, payloadHash] = params;
          const key = `${userId}|${scope}|${requestKey}`;
          if (!db.receipts.has(key)) {
            db.receipts.set(key, { userId, scope, requestKey, payload_hash: payloadHash,
              response_status: null, response_body: null });
          }
          return [{ affectedRows: 1 }];
        }
        if (/SELECT payload_hash, response_status, response_body FROM api_write_requests/i.test(sql)) {
          const [userId, scope, requestKey] = params;
          const receipt = db.receipts.get(`${userId}|${scope}|${requestKey}`);
          return [receipt ? [receipt] : []];
        }
        if (/UPDATE api_write_requests SET response_status/i.test(sql)) {
          const [status, body, userId, scope, requestKey] = params;
          const receipt = db.receipts.get(`${userId}|${scope}|${requestKey}`);
          assert(receipt, '响应写入前必须已经存在请求收据');
          receipt.response_status = status;
          receipt.response_body = body;
          return [{ affectedRows: 1 }];
        }
        if (/INSERT INTO test_business/i.test(sql)) {
          if (db.failOperation) throw new Error('simulated business failure');
          db.businessWrites.push(params);
          return [{ affectedRows: 1, insertId: db.businessWrites.length }];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }
    };
    this.connections.push(connection);
    return connection;
  }

  pool() {
    return {
      execute: async (sql, params = []) => {
        this.events.push('pool.execute');
        if (/SELECT payload_hash, response_status, response_body FROM api_write_requests/i.test(sql)) {
          const [userId, scope, requestKey] = params;
          const receipt = this.receipts.get(`${userId}|${scope}|${requestKey}`);
          return [receipt ? [receipt] : []];
        }
        throw new Error(`unexpected pool SQL: ${sql}`);
      },
      getConnection: () => this.getConnection()
    };
  }
}

function request(body, userId = 7, key) {
  return {
    body,
    params: { id: '42' },
    user: { id: userId },
    headers: key ? { 'idempotency-key': key } : {}
  };
}

async function main() {
  const db = new FakeWriteDatabase();
  const pool = db.pool();
  const businessOperation = async connection => {
    await connection.execute('INSERT INTO test_business (value) VALUES (?)', ['once']);
    return { status: 200, body: { code: 200, data: { saved: true } } };
  };

  let result = await runWriteTransaction(pool, request({ title: 'first' }), 'test:create', businessOperation);
  assert.deepStrictEqual(result, { status: 200, body: { code: 200, data: { saved: true } }, replayed: false });
  assert.strictEqual(db.businessWrites.length, 1, '无 key 请求仍应在事务内执行业务写入');
  assert.strictEqual(db.connections[0].began, 1);
  assert.strictEqual(db.connections[0].committed, 1);
  assert.strictEqual(db.connections[0].rolledBack, 0);
  assert.strictEqual(db.connections[0].released, 1);

  db.events = [];
  const noKeyPrepareConnections = db.connections.length;
  let noKeyPrepareCalls = 0;
  result = await runWriteTransaction(pool, request({ title: 'prepared without key' }), 'test:prepare-no-key', async () => ({
    status: 200, body: { code: 200, data: { prepared: true } }
  }), {
    prepare: async () => {
      noKeyPrepareCalls += 1;
      assert.strictEqual(db.connections.length, noKeyPrepareConnections, '无 key prepare 执行时不得先占用事务连接');
      db.events.push('prepare');
    }
  });
  assert.strictEqual(result.replayed, false);
  assert.strictEqual(noKeyPrepareCalls, 1);
  assert.deepStrictEqual(db.events, ['prepare', 'getConnection'], '无 key prepare 必须先于事务连接获取');

  const key = 'write-key-12345678';
  const firstKeyRequest = request({ title: 'same' }, 7, key);
  result = await runWriteTransaction(pool, firstKeyRequest, 'test:create', businessOperation);
  assert.strictEqual(result.replayed, false);
  assert.strictEqual(db.businessWrites.length, 2);
  result = await runWriteTransaction(pool, firstKeyRequest, businessOperation ? 'test:create' : '', businessOperation);
  assert.strictEqual(result.replayed, true, '同用户、同作用域、同 payload 应直接回放');
  assert.strictEqual(db.businessWrites.length, 2, '幂等回放不得再次执行业务写入');

  result = await runWriteTransaction(pool, request({ title: 'changed' }, 7, key), 'test:create', businessOperation);
  assert.strictEqual(result.status, 409, '同 key 的 payload 冲突必须返回 409');
  assert.strictEqual(result.body.code, 409);
  assert.strictEqual(db.businessWrites.length, 2);
  const conflictConnection = db.connections.at(-1);
  assert.strictEqual(conflictConnection.rolledBack, 1, 'payload 冲突必须回滚事务');
  assert.strictEqual(conflictConnection.released, 1);

  result = await runWriteTransaction(pool, request({ title: 'other scope' }, 7, key), 'test:other-scope', businessOperation);
  assert.strictEqual(result.status, 200, '同 key 在不同 scope 下应有独立收据');
  assert.strictEqual(db.businessWrites.length, 3);
  result = await runWriteTransaction(pool, request({ title: 'other user' }, 8, key), 'test:create', businessOperation);
  assert.strictEqual(result.status, 200, '同 key 在不同用户下应有独立收据');
  assert.strictEqual(db.businessWrites.length, 4);

  const prepareKey = 'prepare-key-123456';
  db.events = [];
  const connectionsBeforePrepare = db.connections.length;
  let prepareCalls = 0;
  result = await runWriteTransaction(pool, request({ title: 'prepared' }, 7, prepareKey), 'test:prepare', businessOperation, {
    prepare: async () => {
      prepareCalls += 1;
      assert.strictEqual(db.connections.length, connectionsBeforePrepare, 'prepare 执行时不得先占用事务连接');
      db.events.push('prepare');
    }
  });
  assert.strictEqual(result.replayed, false);
  assert.strictEqual(prepareCalls, 1);
  assert.deepStrictEqual(db.events.slice(0, 3), ['pool.execute', 'prepare', 'getConnection'], 'prepare 必须在事务连接获取前执行');
  const writesAfterPrepare = db.businessWrites.length;
  db.events = [];
  result = await runWriteTransaction(pool, request({ title: 'prepared' }, 7, prepareKey), 'test:prepare', businessOperation, {
    prepare: async () => { prepareCalls += 1; }
  });
  assert.strictEqual(result.replayed, true, 'prepare 收据已完整时应直接回放');
  assert.strictEqual(prepareCalls, 1, '完整收据回放不得执行 prepare');
  assert.strictEqual(db.businessWrites.length, writesAfterPrepare, 'prepare 收据回放不得重复业务写入');
  assert.deepStrictEqual(db.events, ['pool.execute'], '完整收据回放不得获取事务连接');
  db.events = [];
  result = await runWriteTransaction(pool, request({ title: 'changed prepared' }, 7, prepareKey), 'test:prepare', businessOperation, {
    prepare: async () => { prepareCalls += 1; }
  });
  assert.strictEqual(result.status, 409, 'prepare 路径的 payload 冲突仍必须返回 409');
  assert.strictEqual(prepareCalls, 1, 'payload 冲突不得执行 prepare');
  assert.strictEqual(db.businessWrites.length, writesAfterPrepare, 'prepare 路径的 payload 冲突不得写入业务数据');
  assert.deepStrictEqual(db.events, ['pool.execute'], 'prepare 路径的已提交冲突不得获取事务连接');

  result = await runWriteTransaction(pool, request({ title: 'bad key' }, 7, 'short'), 'test:create', businessOperation);
  assert.strictEqual(result.status, 400, '短 key 必须在取连接前拒绝');
  assert.strictEqual(db.businessWrites.length, writesAfterPrepare);

  db.events = [];
  const prepareFailureConnections = db.connections.length;
  const prepareFailureWrites = db.businessWrites.length;
  const prepareFailureReceipts = db.receipts.size;
  let prepareFailureCalls = 0;
  result = await runWriteTransaction(pool, request({ title: 'prepare failure' }, 7, 'prepare-fail-123456'), 'test:prepare-failure', businessOperation, {
    prepare: async () => {
      prepareFailureCalls += 1;
      db.events.push('prepare');
      return { status: 503, body: { code: 503, message: '暂时不可用' } };
    }
  });
  assert.deepStrictEqual(result, { status: 503, body: { code: 503, message: '暂时不可用' }, replayed: false });
  assert.strictEqual(prepareFailureCalls, 1);
  assert.strictEqual(db.connections.length, prepareFailureConnections, 'prepare 失败不得获取事务连接');
  assert.strictEqual(db.businessWrites.length, prepareFailureWrites, 'prepare 失败不得执行业务写入');
  assert.strictEqual(db.receipts.size, prepareFailureReceipts, 'prepare 失败不得创建收据');
  assert.deepStrictEqual(db.events, ['pool.execute', 'prepare'], '有 key prepare 失败仍不得获取事务连接');

  result = await runWriteTransaction(pool, request({ title: 'client error' }), 'test:client-error', async () => ({
    status: 422, body: { code: 422, message: '业务校验失败' }
  }));
  assert.strictEqual(result.status, 422);
  const clientErrorConnection = db.connections.at(-1);
  assert.strictEqual(clientErrorConnection.rolledBack, 1, '4xx 业务结果必须回滚');
  assert.strictEqual(clientErrorConnection.committed, 0);

  db.failOperation = true;
  await assert.rejects(
    () => runWriteTransaction(pool, request({ title: 'throws' }, 9, 'throw-key-1234567'), 'test:throws', businessOperation),
    /simulated business failure/
  );
  const failedConnection = db.connections.at(-1);
  assert.strictEqual(failedConnection.rolledBack, 1, '异常必须回滚');
  assert.strictEqual(failedConnection.released, 1, '异常路径也必须释放连接');

  db.failRollback = true;
  await assert.rejects(
    () => runWriteTransaction(pool, request({ title: 'rollback fails' }, 9, 'rollback-key-1234'), 'test:rollback-fails', businessOperation),
    error => error && error.message === 'simulated business failure',
    '回滚失败时仍必须抛出原始业务异常'
  );
  const discardedConnection = db.connections.at(-1);
  assert.strictEqual(discardedConnection.rolledBack, 1, '回滚失败也必须尝试回滚');
  assert.strictEqual(discardedConnection.destroyed, 1, '回滚失败必须销毁连接');
  assert.strictEqual(discardedConnection.released, 0, '已销毁连接不得释放回池');

  console.log('[write-transaction] 通过：无 key 事务、同 key 回放、scope/user/payload 冲突、4xx 回滚、异常回滚、回滚失败隔离与连接释放');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
