'use strict';

const assert = require('assert');
const { createMpSyncJobs, ensureMpSyncSchema, MP_SYNC_SCHEMA_SQL } = require('../services/mp-sync-jobs');

class FakePool {
  constructor() {
    this.jobs = new Map();
    this.owners = new Map();
    this.locked = false;
    this.guardPresent = true;
    this.statements = [];
    this.executions = [];
  }

  async getConnection() { return this; }
  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() {}

  async execute(sql, params = []) {
    const query = sql.replace(/\s+/g, ' ').trim();
    const placeholderCount = (query.match(/\?/g) || []).length;
    assert.strictEqual(placeholderCount, params.length, 'prepared SQL placeholder count matches parameters: ' + query);
    const lower = query.toLowerCase();
    this.statements.push(query);
    this.executions.push({ query, params: params.slice() });
    if (lower.startsWith('create table') || lower.startsWith('insert ignore into mp_sync_queue_guard')) return [{ affectedRows: 1 }];
    if (lower.includes('connection_id()') && lower.includes('is_used_lock')) {
      return [[{ connection_id: 101, owner_id: this.locked ? 101 : null }]];
    }
    if (lower.includes('get_lock')) return [[{ acquired: this.locked ? 0 : (this.locked = true, 1) }]];
    if (lower.includes('release_lock')) { this.locked = false; return [[{ released: 1 }]]; }
    if (lower.startsWith('select id from mp_sync_queue_guard')) return [this.guardPresent ? [{ id: 1 }] : []];
    if (lower.startsWith('select job_id from mp_sync_owners')) {
      const id = this.owners.get(Number(params[0]));
      return [id ? [{ job_id: id }] : []];
    }
    if (lower.startsWith('select j.id, j.status from mp_sync_owners')) {
      const id = this.owners.get(Number(params[0]));
      const row = id && this.jobs.get(id);
      return [row ? [{ id: row.id, status: row.status }] : []];
    }
    if (lower.startsWith('select count(*) as count from mp_sync_jobs')) {
      const count = [...this.jobs.values()].filter(row => ['queued', 'processing', 'creating', 'draft_created'].includes(row.status)).length;
      return [[{ count }]];
    }
    if (lower.startsWith('insert into mp_sync_jobs')) {
      const [id, ownerId, payload, progress] = params;
      this.jobs.set(id, {
        id, owner_id: Number(ownerId), status: 'queued', payload, progress, result: null,
        error: null, lease_until: null, claim_token: null, attempts: 0, external_started_at: null,
        created_at: new Date(), updated_at: new Date()
      });
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('insert into mp_sync_owners')) {
      const [ownerId, jobId] = params;
      if (this.owners.has(Number(ownerId))) {
        const error = new Error('duplicate owner'); error.code = 'ER_DUP_ENTRY'; throw error;
      }
      this.owners.set(Number(ownerId), jobId);
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('select * from mp_sync_jobs where id = ? and owner_id = ?')) {
      const row = this.jobs.get(params[0]);
      return [row && row.owner_id === Number(params[1]) ? [Object.assign({}, row)] : []];
    }
    if (lower.startsWith('select * from mp_sync_jobs') && lower.includes('order by created_at')) {
      const now = Date.now();
      const excluded = lower.includes(' id not in (') ? params.map(String) : [];
      const rows = [...this.jobs.values()].filter(row => row.status === 'queued' ||
        (row.status === 'draft_created' && (!row.lease_until || row.lease_until.getTime() < now)))
        .filter(row => !excluded.includes(String(row.id)));
      rows.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      return [rows.length ? [Object.assign({}, rows[0])] : []];
    }
    if (lower.startsWith('update mp_sync_jobs set status = case')) {
      const now = Date.now();
      const excluded = params.map(String);
      for (const row of this.jobs.values()) {
        if (excluded.includes(String(row.id))) continue;
        if (['processing', 'creating', 'draft_created'].includes(row.status) && row.lease_until && row.lease_until.getTime() < now) {
          if (row.status !== 'draft_created' && row.external_started_at) {
            row.status = 'needs_review'; row.error = '进程退出时微信公众号草稿创建结果未知，请人工核对';
          } else if (row.status === 'draft_created') row.status = 'draft_created';
          else row.status = 'queued';
          row.lease_until = null; row.claim_token = null;
        }
      }
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('update mp_sync_jobs set status = ?, attempts = attempts + 1')) {
      const [status, seconds, token, id] = params;
      const row = this.jobs.get(id);
      row.status = status; row.attempts++; row.lease_until = new Date(Date.now() + seconds * 1000); row.error = null; row.claim_token = token;
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('update mp_sync_jobs set status = \'done\'')) {
      const [result, id, token] = params; const row = this.jobs.get(id);
      if (!row || row.claim_token !== token) return [{ affectedRows: 0 }];
      row.status = 'done'; row.result = result; row.error = null; row.lease_until = null; row.claim_token = null; row.updated_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('update mp_sync_jobs set status = \'draft_created\'') && !lower.includes('attempts = 0')) {
      const [result, id, token] = params; const row = this.jobs.get(id);
      if (!row || row.claim_token !== token) return [{ affectedRows: 0 }];
      row.status = 'draft_created'; row.result = result; row.error = null; row.lease_until = null; row.updated_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('update mp_sync_jobs set status = \'draft_created\', result = ?, attempts = 0')) {
      const [result, id] = params; const row = this.jobs.get(id);
      row.status = 'draft_created'; row.result = result; row.attempts = 0; row.error = null; row.lease_until = null; row.claim_token = null; row.updated_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('update mp_sync_jobs set status = \'needs_review\'')) {
      const [error, id, token] = params; const row = this.jobs.get(id);
      if (!row || row.claim_token !== token) return [{ affectedRows: 0 }];
      row.status = 'needs_review'; row.error = error; row.lease_until = null; row.claim_token = null; row.updated_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('update mp_sync_jobs set status = \'failed\'') && lower.includes('result = ?')) {
      const [result, error, id] = params; const row = this.jobs.get(id);
      row.status = 'failed'; row.result = result; row.error = error; row.lease_until = null; row.updated_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('update mp_sync_jobs set status = \'failed\'')) {
      const [error, id, token] = params; const row = this.jobs.get(id);
      if (!row || row.claim_token !== token) return [{ affectedRows: 0 }];
      row.status = 'failed'; row.error = error; row.lease_until = null; row.claim_token = null; row.updated_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('update mp_sync_jobs set ')) {
      const hasClaimCondition = lower.includes('where id = ? and claim_token = ?');
      const id = params[params.length - (hasClaimCondition ? 2 : 1)];
      const row = this.jobs.get(id);
      if (!row) throw new Error('job not found for update: ' + query);
      const token = hasClaimCondition ? params[params.length - 1] : params[params.length - 2];
      if (hasClaimCondition && row.claim_token !== token) return [{ affectedRows: 0 }];
      let paramIndex = 0;
      const assignments = query.slice(query.toLowerCase().indexOf(' set ') + 5, query.toLowerCase().lastIndexOf(' where ')).split(', ');
      for (const assignment of assignments) {
        if (assignment === 'external_started_at = COALESCE(external_started_at, NOW())') row.external_started_at = row.external_started_at || new Date();
        else if (assignment.startsWith('lease_until = DATE_ADD')) {
          const interval = assignment.match(/INTERVAL (\d+) SECOND/);
          row.lease_until = new Date(Date.now() + (Number(interval && interval[1] || 1) * 1000));
        }
        else if (assignment === 'lease_until = NULL') row.lease_until = null;
        else if (assignment === 'claim_token = NULL') row.claim_token = null;
        else {
          const field = assignment.split(' = ')[0];
          const value = params[paramIndex++];
          row[field] = value;
        }
      }
      row.updated_at = new Date();
      return [{ affectedRows: 1 }];
    }
    if (lower.startsWith('delete from mp_sync_owners')) {
      const [ownerId, jobId] = params;
      if (this.owners.get(Number(ownerId)) === jobId) this.owners.delete(Number(ownerId));
      return [{ affectedRows: 1 }];
    }
    throw new Error('Unsupported fake SQL: ' + query);
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function run() {
  const recoveryPool = new FakePool();
  await ensureMpSyncSchema(recoveryPool);
  assert.strictEqual(recoveryPool.statements.filter(sql => sql.toLowerCase().startsWith('create table')).length, 3);
  assert(MP_SYNC_SCHEMA_SQL[0].includes('claim_token CHAR(36) NULL'), 'job schema stores a per-claim fencing token');
  const first = createMpSyncJobs({ db: recoveryPool, processor: async () => ({ ok: true }), pollIntervalMs: 250 });
  const missingGuardPool = new FakePool();
  missingGuardPool.guardPresent = false;
  const missingGuardService = createMpSyncJobs({ db: missingGuardPool, processor: async () => ({}) });
  await assert.rejects(missingGuardService.submit(16, { article: {}, dailySongIds: [] }), /队列容量保护行缺失/);
  const pending = await first.submit(17, { article: { title: 'persist me' }, dailySongIds: [] });
  const duplicate = await first.submit(17, { article: { title: 'duplicate' }, dailySongIds: [] });
  assert.strictEqual(duplicate.conflict, true, 'same owner gets an active-job conflict');
  assert.strictEqual(duplicate.id, pending.id);
  const recoveredProcessorCalls = [];
  const restarted = createMpSyncJobs({
    db: recoveryPool,
    processor: async ({ job }) => { recoveredProcessorCalls.push(job.payload.article.title); return { media_id: 'recovered' }; },
    pollIntervalMs: 250
  });
  assert.strictEqual(await restarted.getStatus(999, pending.id), null, 'other owners cannot read task state');
  await restarted.start();
  await waitFor(async () => (await restarted.getStatus(17, pending.id)).status === 'done', 'queued job recovery');
  assert.deepStrictEqual(recoveredProcessorCalls, ['persist me']);
  await restarted.stop(); await restarted.drain();

  const unknownPool = new FakePool();
  let externalCalls = 0;
  const unknownWorker = createMpSyncJobs({
    db: unknownPool,
    processor: async ({ context }) => {
      externalCalls++;
      await context.markExternalStarted();
      throw new Error('response timed out after remote acceptance');
    },
    pollIntervalMs: 250
  });
  const unknown = await unknownWorker.submit(21, { article: {}, dailySongIds: [] });
  await unknownWorker.start();
  await waitFor(async () => (await unknownWorker.getStatus(21, unknown.id)).sync_status === 'needs_review', 'unknown external result');
  assert.strictEqual(externalCalls, 1);
  await unknownWorker.stop(); await unknownWorker.drain();
  const unknownRestart = createMpSyncJobs({
    db: unknownPool,
    processor: async ({ job }) => {
      if (job.status !== 'draft_created') externalCalls++;
      return Object.assign({}, job.result, { mark_result: { requested: 0, affected: 0 } });
    },
    pollIntervalMs: 250
  });
  await unknownRestart.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.strictEqual(externalCalls, 1, 'unknown remote outcomes are never retried');
  assert.match((await unknownRestart.getStatus(21, unknown.id)).msg, /不会自动重试/);
  const resolvedCreated = await unknownRestart.resolveUnknown(21, unknown.id, 'created', 'media-manual');
  assert.strictEqual(resolvedCreated.status, 'draft_created', 'manual created resolution resumes local finalization');
  await waitFor(async () => (await unknownRestart.getStatus(21, unknown.id)).status === 'done', 'manual created resolution');
  await unknownRestart.stop(); await unknownRestart.drain();

  const confirmedPool = new FakePool();
  const confirmedService = createMpSyncJobs({ db: confirmedPool, processor: async () => ({}), pollIntervalMs: 250 });
  const confirmedTask = await confirmedService.submit(25, { article: {}, dailySongIds: [] });
  const confirmedRow = confirmedPool.jobs.get(confirmedTask.id);
  confirmedRow.status = 'needs_review'; confirmedRow.external_started_at = new Date();
  const confirmed = await confirmedService.resolveUnknown(25, confirmedTask.id, 'not_created');
  assert.strictEqual(confirmed.status, 'failed');
  assert.strictEqual(confirmedPool.owners.has(25), false, 'manual no-draft confirmation releases the owner lock only');

  const lockPool = new FakePool();
  let letProcessorContinue;
  let processorStarted;
  const processorGate = new Promise(resolve => { letProcessorContinue = resolve; });
  const startedSignal = new Promise(resolve => { processorStarted = resolve; });
  let externalCallsAfterLockLoss = 0;
  const lockWorker = createMpSyncJobs({
    db: lockPool,
    pollIntervalMs: 250,
    processor: async ({ context }) => {
      processorStarted();
      await processorGate;
      await context.markExternalStarted();
      externalCallsAfterLockLoss++;
    }
  });
  const lockJob = await lockWorker.submit(26, { article: {}, dailySongIds: [] });
  await lockWorker.start();
  await startedSignal;
  lockPool.locked = false;
  await new Promise(resolve => setTimeout(resolve, 275));
  letProcessorContinue();
  await waitFor(async () => (await lockWorker.getStatus(26, lockJob.id)).status === 'fail', 'worker lock loss safety');
  assert.strictEqual(externalCallsAfterLockLoss, 0, 'worker lock loss blocks new external draft requests');
  await lockWorker.stop(); await lockWorker.drain();

  const inFlightPool = new FakePool();
  let releaseFirst;
  let firstStarted;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const firstStartedSignal = new Promise(resolve => { firstStarted = resolve; });
  const inFlightCalls = new Map();
  const inFlightWorker = createMpSyncJobs({
    db: inFlightPool,
    concurrency: 2,
    pollIntervalMs: 250,
    processor: async ({ job }) => {
      inFlightCalls.set(job.id, (inFlightCalls.get(job.id) || 0) + 1);
      if (job.payload.marker === 'first') { firstStarted(); await firstGate; }
      return { ok: true };
    }
  });
  const firstExpiredCandidate = await inFlightWorker.submit(28, { marker: 'first' });
  const secondCandidate = await inFlightWorker.submit(29, { marker: 'second' });
  // Production breaks timestamp ties with random IDs. Give this ordered test
  // distinct times instead of assuming two same-millisecond submits sort FIFO.
  inFlightPool.jobs.get(firstExpiredCandidate.id).created_at = new Date(0);
  inFlightPool.jobs.get(secondCandidate.id).created_at = new Date(1000);
  await inFlightWorker.start();
  await firstStartedSignal;
  const inFlightRow = inFlightPool.jobs.get(firstExpiredCandidate.id);
  const inFlightToken = inFlightRow.claim_token;
  inFlightRow.lease_until = new Date(0);
  await waitFor(async () => (await inFlightWorker.getStatus(29, secondCandidate.id)).status === 'done', 'claim excludes local in-flight expired lease');
  await waitFor(async () => inFlightPool.executions.some(call => call.query.includes("status = 'queued' OR (status = 'draft_created'") && call.params.includes(firstExpiredCandidate.id)), 'claim query excludes the gated in-flight task');
  assert.strictEqual(inFlightCalls.get(firstExpiredCandidate.id), 1, 'expired lease does not duplicate this process in-flight work');
  assert.strictEqual(inFlightRow.status, 'processing', 'recovery does not reset a local in-flight job');
  assert.strictEqual(inFlightRow.claim_token, inFlightToken, 'local in-flight claim token survives deadline scan');
  assert(inFlightPool.executions.some(call => call.query.includes('id NOT IN (?)') && call.params[0] === firstExpiredCandidate.id),
    'expired recovery receives the local in-flight id as its prepared parameter');
  assert(inFlightPool.executions.some(call => call.query.includes("status = 'queued' OR (status = 'draft_created'") && call.params[0] === firstExpiredCandidate.id),
    'claim query receives the local in-flight id as its prepared parameter');
  releaseFirst();
  await waitFor(async () => (await inFlightWorker.getStatus(28, firstExpiredCandidate.id)).status === 'done', 'in-flight task completion');
  await inFlightWorker.stop(); await inFlightWorker.drain();

  const staleClaimPool = new FakePool();
  let releaseStale;
  let staleStarted;
  const staleGate = new Promise(resolve => { releaseStale = resolve; });
  const staleStartedSignal = new Promise(resolve => { staleStarted = resolve; });
  let staleExternalCalls = 0;
  let staleCheckpointRejected = false;
  const staleWorker = createMpSyncJobs({
    db: staleClaimPool,
    pollIntervalMs: 250,
    processor: async ({ context }) => {
      staleStarted();
      await staleGate;
      try { await context.checkpoint({ progress: { msg: 'stale claim' } }); }
      catch (error) { staleCheckpointRejected = error.code === 'MP_SYNC_CLAIM_LOST'; throw error; }
      await context.markExternalStarted();
      staleExternalCalls++;
    }
  });
  const staleJob = await staleWorker.submit(30, { article: {}, dailySongIds: [] });
  await staleWorker.start();
  await staleStartedSignal;
  const staleRow = staleClaimPool.jobs.get(staleJob.id);
  const replacementToken = '00000000-0000-4000-8000-000000000001';
  staleRow.claim_token = replacementToken;
  staleRow.status = 'processing';
  staleRow.lease_until = new Date(Date.now() + 60000);
  releaseStale();
  await waitFor(() => staleCheckpointRejected, 'stale worker CAS rejection');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(staleExternalCalls, 0, 'stale worker cannot start external work');
  assert.strictEqual(staleRow.claim_token, replacementToken, 'stale worker cannot replace the newer claim token');
  assert.strictEqual(staleRow.status, 'processing', 'stale worker cannot overwrite the new claim status');
  assert.strictEqual(staleClaimPool.owners.get(30), staleJob.id, 'stale worker cannot release the new owner lock');
  await staleWorker.stop(); await staleWorker.drain();

  const previousLimit = process.env.DB_CONNECTION_LIMIT;
  process.env.DB_CONNECTION_LIMIT = '1';
  try {
    const lowLimit = createMpSyncJobs({ db: new FakePool(), processor: async () => ({}) });
    await assert.rejects(lowLimit.start(), /DB_CONNECTION_LIMIT 至少为 3/);
  } finally {
    if (previousLimit === undefined) delete process.env.DB_CONNECTION_LIMIT;
    else process.env.DB_CONNECTION_LIMIT = previousLimit;
  }

  const markPool = new FakePool();
  let createDraftCalls = 0;
  let markCalls = 0;
  const markWorker = createMpSyncJobs({
    db: markPool,
    processor: async ({ job, context }) => {
      if (job.status !== 'draft_created') {
        createDraftCalls++;
        await context.markExternalStarted();
        await context.markDraftCreated('media-42', { media_id: 'media-42' });
      }
      markCalls++;
      if (markCalls === 1) {
        const error = new Error('daily song mark transaction failed');
        error.draftCreated = true; error.mediaId = 'media-42'; error.markResult = { requested: 1, affected: 0 };
        throw error;
      }
      return Object.assign({}, job.result, { mark_result: { requested: 1, affected: 1 } });
    },
    pollIntervalMs: 250,
    retryDelayMs: 30000
  });
  const markJob = await markWorker.submit(31, { article: {}, dailySongIds: [8] });
  await markWorker.start();
  await waitFor(() => markPool.jobs.get(markJob.id).status === 'draft_created', 'durable created draft after local marking failure');
  await markWorker.stop(); await markWorker.drain();
  const expiredClaimToken = markPool.jobs.get(markJob.id).claim_token;
  assert(expiredClaimToken, 'failed local finalization retains its claim until lease recovery');
  markPool.jobs.get(markJob.id).lease_until = new Date(0);
  const markRestart = createMpSyncJobs({
    db: markPool,
    processor: async ({ job }) => {
      assert.strictEqual(job.status, 'draft_created', 'restart resumes local finalization stage');
      assert(job.claim_token && job.claim_token !== expiredClaimToken, 'deadline recovery assigns a fresh claim token');
      markCalls++;
      return Object.assign({}, job.result, { mark_result: { requested: 1, affected: 1 } });
    },
    pollIntervalMs: 250
  });
  await markRestart.start();
  await waitFor(async () => (await markRestart.getStatus(31, markJob.id)).status === 'done', 'resume daily song marking');
  assert.strictEqual(createDraftCalls, 1, 'recorded media_id prevents duplicate external draft creation');
  assert.strictEqual(markCalls, 2, 'local mark work resumes after draft creation');
  await markRestart.stop(); await markRestart.drain();

  const boundedPool = new FakePool();
  let active = 0;
  let peak = 0;
  const bounded = createMpSyncJobs({
    db: boundedPool,
    concurrency: 2,
    queueLimit: 3,
    pollIntervalMs: 250,
    processor: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 25));
      active--;
      return { ok: true };
    }
  });
  const boundedJobs = await Promise.all([1, 2, 3].map(async ownerId => Object.assign({ ownerId }, await bounded.submit(ownerId, { article: {}, dailySongIds: [] }))));
  assert.strictEqual((await bounded.submit(4, { article: {}, dailySongIds: [] })).full, true, 'queue cap is enforced');
  await bounded.start();
  await waitFor(async () => {
    const states = await Promise.all(boundedJobs.map(job => bounded.getStatus(job.ownerId, job.id)));
    return states.every(state => state.status === 'done');
  }, 'bounded global worker concurrency');
  assert.strictEqual(peak, 2, 'global worker semaphore caps concurrent tasks at two');
  await bounded.stop(); await bounded.drain();

  console.log('MP sync job lifecycle checks passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
