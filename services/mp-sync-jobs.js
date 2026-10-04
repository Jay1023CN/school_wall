'use strict';

const crypto = require('crypto');
const { rollbackOrDiscard, releaseConnection } = require('./database-transaction');

const MP_SYNC_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS mp_sync_jobs (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    status VARCHAR(24) NOT NULL,
    payload LONGTEXT NOT NULL,
    progress LONGTEXT NULL,
    result LONGTEXT NULL,
    error TEXT NULL,
    lease_until DATETIME NULL,
    claim_token CHAR(36) NULL,
    attempts INT NOT NULL DEFAULT 0,
    external_started_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_mp_sync_claim (status, lease_until, created_at),
    INDEX idx_mp_sync_owner_status (owner_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS mp_sync_owners (
    owner_id BIGINT NOT NULL PRIMARY KEY,
    job_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mp_sync_owner_job FOREIGN KEY (job_id) REFERENCES mp_sync_jobs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS mp_sync_queue_guard (
    id TINYINT NOT NULL PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

const GLOBAL_WORKER_LOCK = 'wall_mp_sync_' + crypto.createHash('sha256').update(String(process.env.DB_NAME || 'campus_wall')).digest('hex').slice(0, 32);

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (error) { return fallback; }
}

function toPublicJob(row) {
  if (!row) return null;
  const payload = parseJson(row.payload, {});
  const progress = parseJson(row.progress, {});
  const result = parseJson(row.result, {});
  return {
    sync_id: row.id,
    status: ['needs_review', 'mark_failed', 'failed'].includes(row.status) ? 'fail' : ['queued', 'processing', 'creating', 'draft_created'].includes(row.status) ? 'processing' : row.status,
    msg: row.status === 'needs_review'
      ? '同步任务 ' + row.id + ' 的公众号草稿创建结果未知，请核对草稿箱后使用人工核对功能处理；系统不会自动重试'
      : row.status === 'mark_failed'
        ? '草稿已创建，但每日推歌状态更新失败；请核对后勿重复创建草稿。' + (row.error ? ' ' + row.error : '')
        : (row.error || (result && result.msg) || (progress && progress.msg) || ''),
    createdAt: row.created_at,
    finishedAt: ['done', 'failed', 'needs_review', 'mark_failed'].includes(row.status) ? row.updated_at : null,
    ownerId: Number(row.owner_id),
    image: progress.image || { total: 0, success: 0, failed: 0 },
    video: progress.video || { total: 0, success: 0, failed: 0, items: [] },
    daily_song_count: Array.isArray(payload.dailySongIds) ? payload.dailySongIds.length : 0,
    daily_song_ids: Array.isArray(payload.dailySongIds) ? payload.dailySongIds : [],
    sync_status: row.status === 'needs_review' ? 'needs_review' : row.status === 'mark_failed' ? 'draft_created_mark_failed' : (result.sync_status || progress.sync_status || row.status),
    media_id: result.media_id || null,
    image_result: result.image || null,
    video_result: result.video || null,
    text_stats: result.text_stats || null,
    failure_reason: row.error || null,
    mark_result: result.mark_result || null
  };
}

function createMpSyncJobs(options) {
  options = options || {};
  const db = options.db;
  const processor = options.processor;
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 2));
  const queueLimit = Math.max(1, Number(options.queueLimit) || 100);
  const leaseMs = Math.max(30000, Number(options.leaseMs) || 240000);
  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || 1000);
  const retryDelayMs = Math.max(1000, Number(options.retryDelayMs) || 30000);
  const configuredConnectionLimit = Number(db && db.pool && db.pool.config && db.pool.config.connectionLimit)
    || (() => {
      const configured = Number(process.env.DB_CONNECTION_LIMIT);
      return Number.isSafeInteger(configured) && configured >= 1 && configured <= 100 ? configured : 10;
    })();
  if (!db || typeof db.execute !== 'function') throw new TypeError('db.execute is required');
  if (typeof processor !== 'function') throw new TypeError('processor is required');

  let started = false;
  let pumping = false;
  let timer = null;
  let workerConnection = null;
  const inFlight = new Set();
  const inFlightIds = new Set();
  let lockLost = false;

  async function withTransaction(callback) {
    if (typeof db.getConnection !== 'function') {
      throw new Error('mp sync jobs require a database pool with getConnection()');
    }
    const connection = await db.getConnection();
    let active = false;
    try {
      await connection.beginTransaction();
      active = true;
      const result = await callback(connection);
      await connection.commit();
      active = false;
      return result;
    } catch (error) {
      if (active) await rollbackOrDiscard(connection, error);
      throw error;
    } finally {
      releaseConnection(connection);
    }
  }

  async function getExistingOwnerJob(ownerId) {
    const [rows] = await db.execute(
      `SELECT j.id, j.status FROM mp_sync_owners o
       JOIN mp_sync_jobs j ON j.id = o.job_id WHERE o.owner_id = ? LIMIT 1`, [ownerId]);
    return rows[0] || null;
  }

  async function submit(ownerId, payload) {
    const id = 'sync_' + crypto.randomBytes(16).toString('hex');
    try {
      const result = await withTransaction(async connection => {
        const [guards] = await connection.execute('SELECT id FROM mp_sync_queue_guard WHERE id = 1 FOR UPDATE');
        if (!guards[0] || Number(guards[0].id) !== 1) {
          throw new Error('公众号同步队列容量保护行缺失，请检查数据库迁移');
        }
        const [owners] = await connection.execute('SELECT job_id FROM mp_sync_owners WHERE owner_id = ? FOR UPDATE', [ownerId]);
        if (owners.length) return { conflict: true, id: owners[0].job_id };

        const [counts] = await connection.execute(
          `SELECT COUNT(*) AS count FROM mp_sync_jobs
           WHERE status IN ('queued','processing','creating','draft_created')`);
        if (Number(counts[0] && counts[0].count) >= queueLimit) return { full: true };

        await connection.execute(
          `INSERT INTO mp_sync_jobs (id, owner_id, status, payload, progress)
           VALUES (?, ?, 'queued', ?, ?)` ,
          [id, ownerId, JSON.stringify(payload), JSON.stringify({ msg: '任务排队中', image: payload.progress && payload.progress.image, video: payload.progress && payload.progress.video })]);
        await connection.execute('INSERT INTO mp_sync_owners (owner_id, job_id) VALUES (?, ?)', [ownerId, id]);
        return { id, conflict: false };
      });
      return result;
    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY') {
        const existing = await getExistingOwnerJob(ownerId);
        if (existing) return { conflict: true, id: existing.id, status: existing.status };
      }
      throw error;
    }
  }

  async function getStatus(ownerId, id) {
    const [rows] = await db.execute('SELECT * FROM mp_sync_jobs WHERE id = ? AND owner_id = ? LIMIT 1', [id, ownerId]);
    return toPublicJob(rows[0]);
  }

  async function getActive(ownerId) {
    const [rows] = await db.execute(
      `SELECT j.* FROM mp_sync_owners o
       JOIN mp_sync_jobs j ON j.id = o.job_id WHERE o.owner_id = ? LIMIT 1`, [ownerId]);
    return toPublicJob(rows[0]);
  }

  async function resolveUnknown(ownerId, id, decision, mediaId) {
    if (!['created', 'not_created'].includes(decision)) throw new Error('resolution decision is invalid');
    if (decision === 'created' && (typeof mediaId !== 'string' || !mediaId.trim())) throw new Error('created 草稿必须提供 media_id');
    return withTransaction(async connection => {
      const [rows] = await connection.execute(
        `SELECT * FROM mp_sync_jobs WHERE id = ? AND owner_id = ? FOR UPDATE`, [id, ownerId]);
      const row = rows[0];
      if (!row || !['needs_review', 'mark_failed'].includes(row.status)) return { found: false };
      if (decision === 'created') {
        const priorResult = parseJson(row.result, {});
        const resolvedMediaId = (mediaId || priorResult.media_id || '').trim();
        if (!resolvedMediaId) throw new Error('created 草稿必须提供 media_id');
        if (priorResult.media_id && priorResult.media_id !== resolvedMediaId) throw new Error('media_id 与任务已记录的草稿不一致');
        const result = Object.assign({}, priorResult, { media_id: resolvedMediaId, sync_status: 'draft_created_mark_failed' });
        await connection.execute(
          `UPDATE mp_sync_jobs SET status = 'draft_created', result = ?, attempts = 0, error = NULL, lease_until = NULL, claim_token = NULL WHERE id = ?`,
          [JSON.stringify(result), id]);
        return { found: true, status: 'draft_created' };
      }
      if (row.status !== 'needs_review') throw new Error('已有草稿创建记录，不能确认成未创建');
      await connection.execute(
        `UPDATE mp_sync_jobs SET status = 'failed', result = ?, error = ?, lease_until = NULL, claim_token = NULL WHERE id = ?`,
        [JSON.stringify({ resolution: 'confirmed_not_created' }), '管理员确认公众号草稿箱中没有对应草稿；系统未重发', id]);
      await connection.execute('DELETE FROM mp_sync_owners WHERE owner_id = ? AND job_id = ?', [ownerId, id]);
      return { found: true, status: 'failed' };
    });
  }

  async function recoverExpiredJobs(executor, excludeIds) {
    const excluded = Array.isArray(excludeIds) ? excludeIds : [];
    const exclusionSql = excluded.length ? ` AND id NOT IN (${excluded.map(() => '?').join(',')})` : '';
    await executor.execute(
      `UPDATE mp_sync_jobs SET
         status = CASE
           WHEN status = 'draft_created' THEN 'draft_created'
           WHEN external_started_at IS NOT NULL THEN 'needs_review'
           ELSE 'queued'
         END,
         lease_until = NULL,
         claim_token = NULL,
         error = CASE
           WHEN status <> 'draft_created' AND external_started_at IS NOT NULL
             THEN '进程退出时微信公众号草稿创建结果未知，请人工核对'
           ELSE error
         END
       WHERE status IN ('processing','creating','draft_created')
         AND lease_until IS NOT NULL AND lease_until < NOW()${exclusionSql}`,
      excluded);
  }

  async function assertWorkerLock() {
    const connection = workerConnection;
    if (!connection) { lockLost = true; throw new Error('公众号同步 worker 已失去全局锁'); }
    try {
      const [rows] = await connection.execute(
        'SELECT CONNECTION_ID() AS connection_id, IS_USED_LOCK(?) AS owner_id', [GLOBAL_WORKER_LOCK]);
      if (!rows[0] || String(rows[0].connection_id) !== String(rows[0].owner_id)) {
        lockLost = true;
        workerConnection = null;
        connection.release();
        throw new Error('公众号同步 worker 已失去全局锁');
      }
    } catch (error) {
      if (workerConnection === connection) {
        lockLost = true;
        workerConnection = null;
        // A failed lock query leaves advisory-lock ownership unknown. Destroy
        // the mysql2 connection so it cannot return to the pool holding a lock.
        if (typeof connection.destroy === 'function') connection.destroy();
        else connection.release();
      }
      throw error;
    }
  }

  async function acquireWorkerLock() {
    if (workerConnection) return true;
    if (typeof db.getConnection !== 'function') return false;
    const connection = await db.getConnection();
    let lockAcquired = false;
    try {
      const [rows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [GLOBAL_WORKER_LOCK]);
      if (Number(rows[0] && rows[0].acquired) !== 1) {
        connection.release();
        return false;
      }
      lockAcquired = true;
      workerConnection = connection;
      lockLost = false;
      await recoverExpiredJobs(connection, [...inFlightIds]);
      return true;
    } catch (error) {
      if (workerConnection === connection) workerConnection = null;
      if (lockAcquired) {
        try { await connection.execute('SELECT RELEASE_LOCK(?)', [GLOBAL_WORKER_LOCK]); } catch (releaseError) {}
      }
      connection.release();
      throw error;
    }
  }

  async function releaseWorkerLock() {
    const connection = workerConnection;
    workerConnection = null;
    if (!connection) return;
    try { await connection.execute('SELECT RELEASE_LOCK(?)', [GLOBAL_WORKER_LOCK]); } catch (error) {}
    connection.release();
    lockLost = false;
  }

  function assertUpdated(result, operation) {
    if (!result || !result[0] || Number(result[0].affectedRows) !== 1) {
      const error = new Error('公众号同步任务 claim 已失效，拒绝' + operation);
      error.code = 'MP_SYNC_CLAIM_LOST';
      throw error;
    }
  }

  async function claimOne(excludeIds) {
    return withTransaction(async connection => {
      const excluded = Array.isArray(excludeIds) ? excludeIds : [];
      const exclusionSql = excluded.length ? ` AND id NOT IN (${excluded.map(() => '?').join(',')})` : '';
      const [rows] = await connection.execute(
        `SELECT * FROM mp_sync_jobs
         WHERE (status = 'queued' OR (status = 'draft_created' AND (lease_until IS NULL OR lease_until < NOW())))${exclusionSql}
         ORDER BY created_at, id LIMIT 1 FOR UPDATE`, excluded);
      const row = rows[0];
      if (!row) return null;
      const nextStatus = row.status === 'draft_created' ? 'draft_created' : 'processing';
      const claimToken = crypto.randomUUID();
      const [updateResult] = await connection.execute(
        `UPDATE mp_sync_jobs SET status = ?, attempts = attempts + 1,
         lease_until = DATE_ADD(NOW(), INTERVAL ? SECOND), error = NULL, claim_token = ? WHERE id = ?`,
        [nextStatus, Math.ceil(leaseMs / 1000), claimToken, row.id]);
      assertUpdated([updateResult], '认领任务');
      row.status = nextStatus;
      row.claim_token = claimToken;
      row.attempts = Number(row.attempts || 0) + 1;
      return row;
    });
  }

  async function updateJob(job, updates) {
    if (!job || !job.claim_token) {
      const error = new Error('公众号同步任务没有有效 claim_token');
      error.code = 'MP_SYNC_CLAIM_LOST';
      throw error;
    }
    const fields = [];
    const params = [];
    if (Object.prototype.hasOwnProperty.call(updates, 'status')) { fields.push('status = ?'); params.push(updates.status); }
    if (Object.prototype.hasOwnProperty.call(updates, 'payload')) { fields.push('payload = ?'); params.push(JSON.stringify(updates.payload)); }
    if (Object.prototype.hasOwnProperty.call(updates, 'progress')) { fields.push('progress = ?'); params.push(JSON.stringify(updates.progress)); }
    if (Object.prototype.hasOwnProperty.call(updates, 'result')) { fields.push('result = ?'); params.push(JSON.stringify(updates.result)); }
    if (Object.prototype.hasOwnProperty.call(updates, 'error')) { fields.push('error = ?'); params.push(updates.error); }
    if (updates.externalStarted) fields.push('external_started_at = COALESCE(external_started_at, NOW())');
    if (Object.prototype.hasOwnProperty.call(updates, 'claimToken')) { fields.push('claim_token = ?'); params.push(updates.claimToken); }
    if (updates.setLease) fields.push(`lease_until = DATE_ADD(NOW(), INTERVAL ${Math.ceil(leaseMs / 1000)} SECOND)`);
    if (updates.setLeaseMs) fields.push(`lease_until = DATE_ADD(NOW(), INTERVAL ${Math.ceil(updates.setLeaseMs / 1000)} SECOND)`);
    if (updates.clearLease) fields.push('lease_until = NULL');
    if (!fields.length) return;
    params.push(job.id, job.claim_token);
    const [result] = await db.execute(`UPDATE mp_sync_jobs SET ${fields.join(', ')} WHERE id = ? AND claim_token = ?`, params);
    assertUpdated([result], '更新状态');
  }

  async function finishJob(job, result) {
    await withTransaction(async connection => {
      const [updateResult] = await connection.execute(
        `UPDATE mp_sync_jobs SET status = 'done', result = ?, error = NULL, lease_until = NULL, claim_token = NULL WHERE id = ? AND claim_token = ?`,
        [JSON.stringify(result || {}), job.id, job.claim_token]);
      assertUpdated([updateResult], '完成任务');
      await connection.execute('DELETE FROM mp_sync_owners WHERE owner_id = ? AND job_id = ?', [job.owner_id, job.id]);
    });
  }

  async function failJob(job, error, context) {
    const message = String(error && error.message || error || '同步任务失败').slice(0, 2000);
    if (context.draftCreated) {
      // The remote draft is durable. Keep the owner lock and retry only local post-create work.
      const status = Number(job.attempts) >= 5 ? 'mark_failed' : 'draft_created';
      const result = Object.assign({}, job.result || {});
      if (error && error.markResult) result.mark_result = error.markResult;
      await updateJob(job, {
        status,
        result: result,
        error: message,
        ...(status === 'draft_created' ? { setLeaseMs: retryDelayMs } : { clearLease: true, claimToken: null })
      });
      return;
    }
    if (context.externalStarted) {
      await withTransaction(async connection => {
        const [updateResult] = await connection.execute(
          `UPDATE mp_sync_jobs SET status = 'needs_review', error = ?, lease_until = NULL, claim_token = NULL WHERE id = ? AND claim_token = ?`,
          [message, job.id, job.claim_token]);
        assertUpdated([updateResult], '标记人工核对');
      });
      return;
    }
    await withTransaction(async connection => {
      const [updateResult] = await connection.execute(
        `UPDATE mp_sync_jobs SET status = 'failed', error = ?, lease_until = NULL, claim_token = NULL WHERE id = ? AND claim_token = ?`,
        [message, job.id, job.claim_token]);
      assertUpdated([updateResult], '结束失败任务');
      await connection.execute('DELETE FROM mp_sync_owners WHERE owner_id = ? AND job_id = ?', [job.owner_id, job.id]);
    });
  }

  async function runClaimed(row) {
    const job = Object.assign({}, row, {
      payload: parseJson(row.payload, {}),
      progress: parseJson(row.progress, {}),
      result: parseJson(row.result, {})
    });
    const context = {
      draftCreated: row.status === 'draft_created' && Boolean(job.result && job.result.media_id),
      externalStarted: Boolean(row.external_started_at),
      assertWorkerLock: assertWorkerLock,
      checkpoint: async patch => {
        await assertWorkerLock();
        if (patch.payload) job.payload = Object.assign({}, job.payload, patch.payload);
        if (patch.progress) job.progress = Object.assign({}, job.progress, patch.progress);
        await updateJob(job, { payload: job.payload, progress: job.progress, setLease: true });
      },
      markExternalStarted: async () => {
        await assertWorkerLock();
        context.externalStarted = true;
        job.status = 'creating';
        await updateJob(job, { status: 'creating', externalStarted: true, setLease: true });
      },
      markDraftCreated: async (mediaId, result) => {
        if (!mediaId) throw new Error('创建草稿未返回 media_id');
        job.result = Object.assign({}, result || {}, { media_id: mediaId });
        await updateJob(job, { status: 'draft_created', result: job.result, setLease: true });
        context.draftCreated = true;
        job.status = 'draft_created';
      }
    };

    const heartbeat = setInterval(() => {
      updateJob(job, { setLease: true }).catch(error => console.error('[MP同步任务] lease续期失败:', error.message));
    }, Math.max(10000, Math.floor(leaseMs / 3)));
    if (heartbeat.unref) heartbeat.unref();
    try {
      await assertWorkerLock();
      const result = await processor({ job, context });
      await finishJob(job, result);
    } catch (error) {
      console.error('[MP同步任务] worker失败:', error.message);
      await failJob(job, error, context);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function pump() {
    if (!started || pumping) return;
    pumping = true;
    try {
      if (lockLost && inFlight.size) return;
      if (!workerConnection) await acquireWorkerLock();
      if (!workerConnection) return;
      await assertWorkerLock();
      await recoverExpiredJobs(workerConnection, [...inFlightIds]);
      while (started && inFlight.size < concurrency) {
        await assertWorkerLock();
        const row = await claimOne([...inFlightIds]);
        if (!row) break;
        const task = runClaimed(row);
        inFlight.add(task);
        inFlightIds.add(row.id);
        const settled = () => {
          inFlight.delete(task);
          inFlightIds.delete(row.id);
          if (started) pump().catch(error => console.error('[MP同步任务] worker轮询失败:', error.message));
        };
        task.then(settled, error => {
          console.error('[MP同步任务] 任务状态更新失败:', error.message);
          settled();
        });
      }
    } catch (error) {
      console.error('[MP同步任务] worker轮询失败:', error.message);
      if (workerConnection && error && error.fatal) await releaseWorkerLock();
    } finally {
      pumping = false;
    }
  }

  async function start() {
    if (started) return stop;
    if (configuredConnectionLimit < 3) {
      throw new Error('公众号同步 worker 需要 DB_CONNECTION_LIMIT 至少为 3，以免全局锁连接占满数据库池');
    }
    started = true;
    await pump();
    timer = setInterval(() => pump().catch(error => console.error('[MP同步任务] worker轮询失败:', error.message)), pollIntervalMs);
    if (timer.unref) timer.unref();
    return stop;
  }

  async function stop() {
    started = false;
    clearInterval(timer);
    timer = null;
    // Keep the global lock through drain; drain releases it after current work settles.
  }

  async function drain() {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    await releaseWorkerLock();
  }

  return { submit, getStatus, getActive, resolveUnknown, start, stop, drain, recoverExpiredJobs, toPublicJob };
}

async function ensureMpSyncSchema(executor) {
  if (!executor || typeof executor.execute !== 'function') throw new TypeError('schema executor.execute is required');
  for (const sql of MP_SYNC_SCHEMA_SQL) await executor.execute(sql);
  await executor.execute('INSERT IGNORE INTO mp_sync_queue_guard (id) VALUES (1)');
}

module.exports = { createMpSyncJobs, MP_SYNC_SCHEMA_SQL, ensureMpSyncSchema, toPublicJob };
