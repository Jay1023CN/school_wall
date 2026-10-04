'use strict';

const assert = require('assert');
const { enqueueFeedbackNotifications, createNotificationOutbox } = require('../services/notification-outbox');

function makeAdminConnection(admins, rows) {
  return {
    async execute(sql, params = []) {
      if (/SELECT id, email, nickname, username FROM users/i.test(sql)) return [admins];
      if (/INSERT INTO notification_outbox/i.test(sql)) {
        if (!rows.some(row => row.dedupe_key === params[0])) {
          rows.push({ dedupe_key: params[0], recipient: params[1], subject: params[2], html: params[3], type: params[4], name: params[5] });
        }
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected enqueue SQL: ${sql}`);
    }
  };
}

class FakeOutboxDatabase {
  constructor(rows) {
    this.rows = new Map(rows.map(row => [row.id, { status: 'pending', next_attempt_at: 0, attempts: 0, ...row }]));
    this.claimConnections = [];
    this.lastLeaseSeconds = null;
    this.failClaim = false;
    this.failRollback = false;
  }

  async getConnection() {
    const db = this;
    const connection = {
      began: 0, committed: 0, rolledBack: 0, released: 0, destroyed: 0,
      async beginTransaction() { this.began += 1; },
      async commit() { this.committed += 1; },
      async rollback() {
        this.rolledBack += 1;
        if (db.failRollback) {
          const error = new Error('simulated outbox rollback failure with secret payload');
          error.code = 'ER_TEST_ROLLBACK';
          throw error;
        }
      },
      release() { this.released += 1; },
      destroy() { this.destroyed += 1; },
      async execute(sql, params = []) {
        if (/UPDATE notification_outbox SET status = CASE WHEN attempts/i.test(sql)) {
          if (db.failClaim) throw new Error('claim database failure');
          const now = Date.now();
          for (const row of db.rows.values()) {
            if (row.status === 'processing' && row.lease_until && row.lease_until <= now) {
              row.status = row.attempts >= params[0] ? 'failed' : 'pending';
              row.claim_token = null;
              row.lease_until = null;
            }
          }
          return [{ affectedRows: 1 }];
        }
        if (/SELECT \* FROM notification_outbox/i.test(sql)) {
          const candidates = [...db.rows.values()]
            .filter(row => row.status === 'pending' && Number(row.next_attempt_at || 0) <= Date.now())
            .sort((left, right) => Number(left.next_attempt_at || 0) - Number(right.next_attempt_at || 0));
          return [candidates.length ? [{ ...candidates[0] }] : []];
        }
        if (/UPDATE notification_outbox SET status = 'processing'/i.test(sql)) {
          const [token, leaseSeconds, id] = params;
          db.lastLeaseSeconds = Number(leaseSeconds);
          const row = db.rows.get(id);
          assert(row, 'claim 必须针对存在的 outbox 行');
          row.status = 'processing';
          row.attempts = Number(row.attempts || 0) + 1;
          row.claim_token = token;
          row.lease_until = Date.now() + Number(leaseSeconds) * 1000;
          return [{ affectedRows: 1 }];
        }
        throw new Error(`unexpected claim SQL: ${sql}`);
      }
    };
    this.claimConnections.push(connection);
    return connection;
  }

  async execute(sql, params = []) {
    const [id, token] = /SET status = 'sent'/i.test(sql) ? [params[0], params[1]] : [params[3], params[4]];
    const row = this.rows.get(id);
    if (!row || row.claim_token !== token) return [{ affectedRows: 0 }];
    if (/SET status = 'sent'/i.test(sql)) {
      row.status = 'sent';
      row.sent_at = Date.now();
      row.lease_until = null;
      row.claim_token = null;
    } else {
      row.status = params[0];
      row.next_attempt_at = Date.now() + 60000;
      row.lease_until = null;
      row.claim_token = null;
      row.last_error = params[2];
    }
    return [{ affectedRows: 1 }];
  }
}

async function runOne(row, sendEmail, retryLimit = 6) {
  const db = new FakeOutboxDatabase([row]);
  const warnings = [];
  const outbox = createNotificationOutbox({
    pool: db,
    sendEmail,
    retryLimit,
    logger: { warn: message => warnings.push(message), error: error => warnings.push(String(error)) }
  });
  await outbox.run();
  return { db, warnings };
}

async function main() {
  const enqueueRows = [];
  const admins = [
    { id: 1, email: 'Admin@Example.com', nickname: '管理员一' },
    { id: 2, email: 'admin@example.com', nickname: '重复地址' },
    { id: 3, email: 'invalid-email', nickname: '无效地址' },
    { id: 4, email: 'second@example.com', nickname: '管理员二' },
    { id: 5, email: '', nickname: '空地址' }
  ];
  const enqueueConnection = makeAdminConnection(admins, enqueueRows);
  const buildCalls = [];
  const buildEmail = feedback => {
    buildCalls.push(feedback);
    return { subject: '反馈主题', html: '<p>反馈正文</p>' };
  };
  assert.strictEqual(await enqueueFeedbackNotifications(enqueueConnection, { id: 73, type: 'bug', title: '标题', content: '内容' }, buildEmail), 2);
  assert.strictEqual(await enqueueFeedbackNotifications(enqueueConnection, { id: 73, type: 'bug', title: '标题', content: '内容' }, buildEmail), 2);
  assert.strictEqual(buildCalls.length, 2);
  assert.strictEqual(new Set(enqueueRows.map(row => row.dedupe_key)).size, 2, '不同收件人应有独立 dedupe key');
  assert.strictEqual(enqueueRows.length, 2, '数据库唯一键应使重复入队保持两条逻辑任务');
  assert.strictEqual(new Set(enqueueRows.map(row => row.recipient.toLowerCase())).size, 2, '同邮箱大小写重复不得产生不同收件人');

  let sendCount = 0;
  const retry = await runOne({ id: 1, dedupe_key: 'retry', recipient: 'a@example.com', subject: 's', html: 'h', notification_type: 'feedback', recipient_name: 'A' }, async () => {
    sendCount += 1;
    return sendCount > 1;
  });
  const retryRow = retry.db.rows.get(1);
  assert.strictEqual(retryRow.status, 'pending', '首次失败应回到 pending 等待退避重试');
  assert.strictEqual(retryRow.attempts, 1);
  retryRow.next_attempt_at = 0;
  const outboxRetry = createNotificationOutbox({ pool: retry.db, sendEmail: async () => true, logger: { warn() {}, error() {} } });
  await outboxRetry.run();
  assert.strictEqual(retryRow.status, 'sent');
  assert.strictEqual(retryRow.attempts, 2);

  sendCount = 0;
  const success = await runOne({ id: 2, dedupe_key: 'success', recipient: 'b@example.com', subject: 's', html: 'h', notification_type: 'feedback', recipient_name: 'B' }, async () => { sendCount += 1; return true; });
  const successRow = success.db.rows.get(2);
  assert.strictEqual(successRow.status, 'sent');
  const successOutbox = createNotificationOutbox({ pool: success.db, sendEmail: async () => { sendCount += 1; return true; }, logger: { warn() {}, error() {} } });
  await successOutbox.run();
  assert.strictEqual(sendCount, 1, 'sent 终态不得重复发送');
  const stop = successOutbox.start();
  assert.strictEqual(typeof stop, 'function', 'outbox 必须暴露 start API');
  await successOutbox.drain();
  await stop();
  assert.strictEqual(typeof successOutbox.drain, 'function', 'outbox 必须暴露 drain API');

  const recovered = await runOne({ id: 3, dedupe_key: 'lease', recipient: 'c@example.com', subject: 's', html: 'h', notification_type: 'feedback', recipient_name: 'C', status: 'processing', claim_token: 'dead-worker', lease_until: Date.now() - 1, attempts: 2 }, async () => true);
  assert.strictEqual(recovered.db.rows.get(3).status, 'sent', '过期 processing 租约应被恢复后重新发送');
  assert.strictEqual(recovered.db.rows.get(3).attempts, 3);
  assert.strictEqual(recovered.db.lastLeaseSeconds, 120, 'claim 必须使用 120 秒租约');

  const staleDb = new FakeOutboxDatabase([{ id: 4, dedupe_key: 'token', recipient: 'd@example.com', subject: 's', html: 'h', notification_type: 'feedback', recipient_name: 'D' }]);
  const staleOutbox = createNotificationOutbox({
    pool: staleDb,
    sendEmail: async () => {
      staleDb.rows.get(4).claim_token = 'new-worker-token';
      return true;
    },
    logger: { warn() {}, error() {} }
  });
  await staleOutbox.run();
  assert.strictEqual(staleDb.rows.get(4).status, 'processing', '旧 worker 不得确认新 worker 的 claim');
  assert.strictEqual(staleDb.rows.get(4).claim_token, 'new-worker-token');

  const failed = await runOne({ id: 5, dedupe_key: 'limit', recipient: 'e@example.com', subject: 's', html: 'h', notification_type: 'feedback', recipient_name: 'E', attempts: 5 }, async () => false, 6);
  assert.strictEqual(failed.db.rows.get(5).status, 'failed', '达到重试上限后应进入 failed');
  assert(failed.warnings.length > 0, '失败发送应记录告警');

  const rollbackFailureDb = new FakeOutboxDatabase([{ id: 6, dedupe_key: 'rollback-failure', recipient: 'f@example.com', subject: 's', html: 'h', notification_type: 'feedback', recipient_name: 'F' }]);
  rollbackFailureDb.failClaim = true;
  rollbackFailureDb.failRollback = true;
  const rollbackFailureOutbox = createNotificationOutbox({
    pool: rollbackFailureDb,
    sendEmail: async () => true,
    logger: { warn() {}, error() {} }
  });
  await assert.rejects(
    rollbackFailureOutbox.run(),
    error => error && error.message === 'claim database failure',
    'claim 失败且回滚失败时不得伪装成成功'
  );
  const rollbackFailureConnection = rollbackFailureDb.claimConnections[0];
  assert.strictEqual(rollbackFailureConnection.destroyed, 1, 'outbox 回滚失败必须销毁连接');
  assert.strictEqual(rollbackFailureConnection.released, 0, 'outbox 已销毁连接不得释放回池');

  console.log('[notification-outbox] 通过：入队邮箱去重、失败退避重试、成功不重发、租约恢复、重试上限、claim token 与回滚失败隔离');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
