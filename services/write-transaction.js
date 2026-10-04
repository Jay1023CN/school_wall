'use strict';

const crypto = require('crypto');
const { rollbackOrDiscard, releaseConnection } = require('./database-transaction');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function failure(status, message) {
  return { status, body: { code: status, message }, replayed: false };
}

function replayReceipt(receipt) {
  const body = typeof receipt.response_body === 'string' ? JSON.parse(receipt.response_body) : receipt.response_body;
  return { status: receipt.response_status, body, replayed: true };
}

async function readCommittedReceipt(pool, userId, scope, key) {
  const [receipts] = await pool.execute(
    'SELECT payload_hash, response_status, response_body FROM api_write_requests WHERE user_id = ? AND scope = ? AND request_key = ?',
    [userId, scope, key]
  );
  return receipts[0];
}

// The request receipt and business writes commit together. A lost HTTP response can
// be replayed without running the business operation a second time.
async function runWriteTransaction(pool, req, scope, operation, options = {}) {
  const key = (typeof req.get === 'function' ? req.get('Idempotency-Key') : req.headers && req.headers['idempotency-key']) || '';
  if (key && !/^[A-Za-z0-9_.:-]{16,128}$/.test(key)) return failure(400, '提交标识无效，请刷新后重试');
  const userId = req.user && req.user.id;
  if (key && !userId) return failure(401, '请先登录');
  const hash = crypto.createHash('sha256').update(JSON.stringify(canonicalize({ body: req.body || {}, params: req.params || {} }))).digest('hex');

  // Some writes need an external, pool-backed preparation step (for example,
  // refreshing song dates).  Check a committed receipt first so a retry can be
  // replayed even when that preparation is temporarily unavailable.  The
  // transaction below still locks the receipt and rechecks the same conditions
  // to preserve the race and payload-conflict semantics.
  if (typeof options.prepare === 'function' && key) {
    const receipt = await readCommittedReceipt(pool, userId, scope, key);
    if (receipt && receipt.payload_hash !== hash) return failure(409, '这次提交的内容已变更，请重新提交');
    if (receipt && receipt.response_body !== null && receipt.response_body !== undefined) {
      return replayReceipt(receipt);
    }
  }
  if (typeof options.prepare === 'function') {
    const prepared = await options.prepare({ key, hash, scope, userId, req });
    if (prepared) {
      if (!Number.isInteger(prepared.status) || !prepared.body) throw new Error('Invalid write preparation response');
      return { ...prepared, replayed: false };
    }
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (key) {
      await connection.execute(
        'INSERT INTO api_write_requests (user_id, scope, request_key, payload_hash) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE request_key = request_key',
        [userId, scope, key, hash]
      );
      const [receipts] = await connection.execute(
        'SELECT payload_hash, response_status, response_body FROM api_write_requests WHERE user_id = ? AND scope = ? AND request_key = ? FOR UPDATE',
        [userId, scope, key]
      );
      const receipt = receipts[0];
      if (!receipt || receipt.payload_hash !== hash) {
        if (!await rollbackOrDiscard(connection, new Error('idempotency payload conflict'))) {
          throw new Error('事务回滚失败');
        }
        return failure(409, '这次提交的内容已变更，请重新提交');
      }
      if (receipt.response_body !== null && receipt.response_body !== undefined) {
        await connection.commit();
        return replayReceipt(receipt);
      }
    }
    const result = await operation(connection);
    if (!result || !Number.isInteger(result.status) || !result.body) throw new Error('Invalid write response');
    if (result.status >= 400 || Number(result.body.code) >= 400) {
      if (!await rollbackOrDiscard(connection, new Error('write operation returned a client error'))) {
        throw new Error('事务回滚失败');
      }
      return { ...result, replayed: false };
    }
    if (key) await connection.execute(
      'UPDATE api_write_requests SET response_status = ?, response_body = ? WHERE user_id = ? AND scope = ? AND request_key = ?',
      [result.status, JSON.stringify(result.body), userId, scope, key]
    );
    await connection.commit();
    return { ...result, replayed: false };
  } catch (error) {
    await rollbackOrDiscard(connection, error);
    throw error;
  } finally {
    releaseConnection(connection);
  }
}

module.exports = { runWriteTransaction, canonicalize };
