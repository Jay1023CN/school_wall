'use strict';

const crypto = require('crypto');
const { createIntervalTask } = require('./task-lifecycle');
const { rollbackOrDiscard, releaseConnection } = require('./database-transaction');

async function enqueueFeedbackNotifications(connection, feedback, buildEmail) {
  const [admins] = await connection.execute(
    'SELECT id, email, nickname, username FROM users WHERE role IN ("admin", "super_admin") AND status = 1 AND email IS NOT NULL AND email != ""'
  );
  const message = buildEmail(feedback);
  const recipients = new Set();
  for (const admin of admins) {
    const email = String(admin.email || '').trim();
    const normalized = email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || recipients.has(normalized)) continue;
    recipients.add(normalized);
    const dedupeKey = crypto.createHash('sha256').update('feedback:' + feedback.id + ':' + normalized).digest('hex');
    await connection.execute(
      'INSERT INTO notification_outbox (dedupe_key, recipient, subject, html, notification_type, recipient_name) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE dedupe_key = dedupe_key',
      [dedupeKey, email, message.subject, message.html, 'admin_new_feedback', String(admin.nickname || admin.username || '管理员').slice(0, 100)]
    );
  }
  return recipients.size;
}

function createNotificationOutbox({ pool, sendEmail, logger = console, retryLimit = 6 }) {
  let pending = null;
  const leaseSeconds = 120;

  async function claim() {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // A crashed sender's lease expires. SMTP delivery is at least once: a lost
      // acknowledgement can lead to a duplicate, never to a claimed inbox proof.
      await connection.execute("UPDATE notification_outbox SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END, claim_token = NULL, lease_until = NULL WHERE status = 'processing' AND lease_until < NOW()", [retryLimit]);
      const [rows] = await connection.execute(
        "SELECT * FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= NOW() ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE"
      );
      if (!rows.length) { await connection.commit(); return null; }
      const row = rows[0];
      const token = crypto.randomUUID();
      await connection.execute(
        "UPDATE notification_outbox SET status = 'processing', attempts = attempts + 1, claim_token = ?, lease_until = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?",
        [token, leaseSeconds, row.id]
      );
      await connection.commit();
      return { ...row, attempts: Number(row.attempts) + 1, claim_token: token };
    } catch (error) {
      await rollbackOrDiscard(connection, error, logger);
      throw error;
    } finally { releaseConnection(connection); }
  }

  async function deliver(row) {
    let sent = false;
    let errorDetail = 'SMTP未配置、已关闭或发送失败';
    try {
      sent = await sendEmail(row.recipient, row.subject, row.html, row.notification_type, row.recipient_name,
        { messageId: '<outbox-' + row.dedupe_key + '@wall.jay23.cn>' });
    } catch (error) { errorDetail = String(error.code || error.message || 'send failed').slice(0, 500); }
    if (sent) {
      await pool.execute(
        "UPDATE notification_outbox SET status = 'sent', sent_at = NOW(), lease_until = NULL, claim_token = NULL, last_error = NULL WHERE id = ? AND claim_token = ?",
        [row.id, row.claim_token]
      );
    } else {
      const status = row.attempts >= retryLimit ? 'failed' : 'pending';
      const delay = Math.min(3600, 30 * 2 ** Math.max(0, row.attempts - 1));
      await pool.execute(
        'UPDATE notification_outbox SET status = ?, next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND), lease_until = NULL, claim_token = NULL, last_error = ? WHERE id = ? AND claim_token = ?',
        [status, delay, errorDetail, row.id, row.claim_token]
      );
      logger.warn('[Outbox] 邮件任务发送失败，任务=' + row.id + '，尝试=' + row.attempts + '，状态=' + status);
    }
  }

  function run() {
    if (pending) return pending;
    pending = (async () => {
      for (let i = 0; i < 5; i++) {
        const row = await claim();
        if (!row) break;
        await deliver(row);
      }
    })().finally(() => { pending = null; });
    return pending;
  }
  const task = createIntervalTask(run, 5000, { initialDelayMs: 1000, onError: error => logger.error('[Outbox]', error.code || error.message) });
  return { run, start: task.start, drain: () => pending || Promise.resolve() };
}

let singleton;
function getNotificationOutbox() {
  if (!singleton) singleton = createNotificationOutbox({
    pool: require('../config/database').pool, sendEmail: require('./email').sendEmail
  });
  return singleton;
}

module.exports = { enqueueFeedbackNotifications, createNotificationOutbox, getNotificationOutbox };
