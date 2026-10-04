'use strict';

const assert = require('assert');
const path = require('path');
const { runSchemaMigrations, SCHEMA_MIGRATIONS, SCHEMA_CONTRACTS } = require('../config/schema-migrations');

function cloneContractSchema() {
  const schema = {};
  for (const contract of SCHEMA_CONTRACTS) {
    schema[contract.table] = {
      engine: 'InnoDB',
      columns: Object.entries(contract.columns).map(([Field, Type]) => ({ Field, Type })),
      indexes: contract.indexes.flatMap(index => index.columns.map((Column_name, offset) => ({
        Key_name: index.name,
        Non_unique: index.unique ? 0 : 1,
        Seq_in_index: offset + 1,
        Column_name
      })))
    };
  }
  return schema;
}

function tableName(sql, keyword) {
  const match = String(sql).match(new RegExp(keyword + "\\s+`?([a-z_]+)`?", 'i'));
  return match && match[1];
}

function makeExecutor(options) {
  const calls = [];
  const state = {
    applied: [...((options && options.applied) || [])],
    schema: (options && options.schema) || {},
    failAt: options && options.failAt
  };
  return {
    calls,
    state,
    async execute(sql, params) {
      calls.push({ sql: String(sql), params });
      if (state.failAt && String(sql).includes(state.failAt)) {
        const error = new Error('database unavailable');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      if (/SELECT version FROM schema_migrations/.test(sql)) {
        return [state.applied.map(version => ({ version })), []];
      }
      if (/^\s*CREATE TABLE IF NOT EXISTS/i.test(sql)) {
        const table = tableName(sql, 'CREATE TABLE IF NOT EXISTS');
        const contract = SCHEMA_CONTRACTS.find(item => item.table === table);
        if (contract) state.schema[table] = state.schema[table] || cloneContractSchema()[table];
      }
      if (/^\s*INSERT INTO schema_migrations/i.test(sql)) {
        state.applied.push(Number(params[0]));
      }
      if (/SHOW COLUMNS FROM/i.test(sql)) {
        const table = tableName(sql, 'SHOW COLUMNS FROM');
        return [state.schema[table] ? state.schema[table].columns : [], []];
      }
      if (/SHOW INDEX FROM/i.test(sql)) {
        const table = tableName(sql, 'SHOW INDEX FROM');
        return [state.schema[table] ? state.schema[table].indexes : [], []];
      }
      if (/information_schema\.TABLES/i.test(sql)) {
        const table = params && params[0];
        return [state.schema[table] ? [{ Engine: state.schema[table].engine }] : [], []];
      }
      return [[], []];
    }
  };
}

async function testVersionedRunner() {
  const first = makeExecutor({ applied: [] });
  await runSchemaMigrations(first);
  assert.strictEqual(
    first.calls.filter(call => call.sql.startsWith('INSERT INTO schema_migrations')).length,
    SCHEMA_MIGRATIONS.length,
    '首次运行必须记录每个迁移版本'
  );
  const ddl = first.calls.map(call => call.sql).join('\n');
  assert(ddl.includes('CREATE TABLE IF NOT EXISTS slot_reservations'), '缺少预约表迁移');
  assert(ddl.includes('user_id INT NOT NULL') && ddl.includes('slot_id INT NOT NULL'), '预约表缺少路由使用的用户/时段字段');
  assert(ddl.includes('reservation_date DATE NOT NULL') && ddl.includes("status ENUM('confirmed', 'cancelled')"), '预约表缺少日期/状态字段');
  assert(ddl.includes('UNIQUE KEY unique_reservation') && ddl.includes('idx_reservations_slot_date_status'), '预约表缺少唯一约束/查询索引');
  assert(ddl.includes('fk_slot_reservations_user') && ddl.includes('fk_slot_reservations_slot'), '预约表缺少用户/时段外键');
  assert(ddl.includes('CREATE TABLE IF NOT EXISTS api_write_requests'), '缺少写请求迁移');
  assert(ddl.includes('scope VARCHAR(80)') && ddl.includes('request_key VARCHAR(128) CHARACTER SET ascii'), '写请求表字段不完整');
  assert(ddl.includes('payload_hash CHAR(64) CHARACTER SET ascii') && ddl.includes('response_body JSON'), '写请求表响应字段不完整');
  assert(ddl.includes('CREATE TABLE IF NOT EXISTS notification_outbox'), '缺少通知 outbox 迁移');
  assert(ddl.includes('id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY') && ddl.includes('dedupe_key VARCHAR(191) CHARACTER SET ascii'), 'outbox 主键/去重字段不完整');
  assert(ddl.includes("status ENUM('pending', 'processing', 'sent', 'failed')") && ddl.includes('claim_token CHAR(36)') && ddl.includes('INDEX idx_notification_outbox_lease_until'), 'outbox 状态/租约字段不完整');
  assert(ddl.includes('claim_token CHAR(36)'), '公众号任务缺少 claim_token 字段');
  assert(first.calls.filter(call => /^SHOW (COLUMNS|INDEX) FROM/.test(call.sql)).length > 0, '首次迁移后必须执行只读结构校验');

  const repeat = makeExecutor({ applied: SCHEMA_MIGRATIONS.map(migration => migration.version), schema: cloneContractSchema() });
  await runSchemaMigrations(repeat);
  assert.strictEqual(
    repeat.calls.filter(call => call.sql.startsWith('INSERT INTO schema_migrations')).length,
    0,
    '已应用迁移不得重复执行'
  );

  const incomplete = makeExecutor({
    applied: SCHEMA_MIGRATIONS.map(migration => migration.version),
    schema: cloneContractSchema()
  });
  incomplete.state.schema.notification_outbox.columns = incomplete.state.schema.notification_outbox.columns.filter(column => column.Field !== 'claim_token');
  await assert.rejects(() => runSchemaMigrations(incomplete), error => error.code === 'SCHEMA_CONTRACT_MISMATCH' && /claim_token/.test(error.message));

  const brokenUnique = makeExecutor({
    applied: SCHEMA_MIGRATIONS.map(migration => migration.version),
    schema: cloneContractSchema()
  });
  brokenUnique.state.schema.slot_reservations.indexes = brokenUnique.state.schema.slot_reservations.indexes.filter(index => index.Key_name !== 'unique_reservation');
  await assert.rejects(() => runSchemaMigrations(brokenUnique), error => error.code === 'SCHEMA_CONTRACT_MISMATCH' && /unique_reservation/.test(error.message));

  const legacyIntegerWidths = makeExecutor({
    applied: SCHEMA_MIGRATIONS.map(migration => migration.version),
    schema: cloneContractSchema()
  });
  legacyIntegerWidths.state.schema.api_write_requests.columns.find(column => column.Field === 'user_id').Type = 'int(11)';
  legacyIntegerWidths.state.schema.api_write_requests.columns.find(column => column.Field === 'scope').Type = 'varchar(80)';
  await runSchemaMigrations(legacyIntegerWidths);
  legacyIntegerWidths.state.schema.api_write_requests.columns.find(column => column.Field === 'user_id').Type = 'int(11) unsigned';
  await assert.rejects(() => runSchemaMigrations(legacyIntegerWidths), error => error.code === 'SCHEMA_CONTRACT_MISMATCH' && /user_id/.test(error.message));

  const wrongEngine = makeExecutor({
    applied: SCHEMA_MIGRATIONS.map(migration => migration.version),
    schema: cloneContractSchema()
  });
  wrongEngine.state.schema.notification_outbox.engine = 'MyISAM';
  await assert.rejects(() => runSchemaMigrations(wrongEngine), error => error.code === 'SCHEMA_CONTRACT_MISMATCH' && /InnoDB/.test(error.message));

  const half = makeExecutor({ applied: [], failAt: 'INSERT INTO schema_migrations' });
  await assert.rejects(() => runSchemaMigrations(half), /database unavailable/);
  half.state.applied = [];
  half.state.failAt = null;
  await runSchemaMigrations(half);
  assert.deepStrictEqual(half.state.applied, [1, 2], '半迁移重试必须补记两个版本');

  const failed = makeExecutor({ applied: [], failAt: 'CREATE TABLE IF NOT EXISTS api_write_requests' });
  await assert.rejects(() => runSchemaMigrations(failed), /database unavailable/);
  assert.strictEqual(
    failed.calls.filter(call => call.sql.startsWith('INSERT INTO schema_migrations')).length,
    0,
    '迁移失败不得记录为已完成'
  );
}

async function testStartupLockAndFailure() {
  const mysqlPath = require.resolve('mysql2/promise');
  const databasePath = path.resolve(__dirname, '..', 'config', 'database.js');
  const originalMysql = require.cache[mysqlPath];
  const originalDatabase = require.cache[databasePath];
  const state = { connections: [], released: 0, lockReleased: 0, failAt: null };
  let poolOptions;

  function fakeConnection(kind) {
    const connection = {
      kind,
      async query(sql) {
        if (/CREATE DATABASE/.test(sql)) return [[], []];
        return [[], []];
      },
      async execute(sql) {
        if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }], []];
        if (/RELEASE_LOCK/.test(sql)) { state.lockReleased += 1; return [[{ released: 1 }], []]; }
        if (state.failAt && String(sql).includes(state.failAt)) {
          const error = new Error('database unavailable');
          error.code = 'ECONNREFUSED';
          throw error;
        }
        if (/SELECT version FROM schema_migrations/.test(sql)) return [[], []];
        if (/SHOW COLUMNS FROM/i.test(sql) || /SHOW INDEX FROM/i.test(sql)) {
          const table = tableName(sql, /SHOW COLUMNS FROM/i.test(sql) ? 'SHOW COLUMNS FROM' : 'SHOW INDEX FROM');
          const schema = cloneContractSchema()[table] || { columns: [], indexes: [] };
          return [/SHOW COLUMNS FROM/i.test(sql) ? schema.columns : schema.indexes, []];
        }
        if (/information_schema\.TABLES/i.test(sql)) return [[{ Engine: 'InnoDB' }], []];
        return [[], []];
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() { state.released += 1; },
      async end() { state.connections.push(`${kind}:ended`); }
    };
    return connection;
  }

  const fakeMysql = {
    createPool(options) {
      poolOptions = options;
      return {
        async getConnection() { return fakeConnection('pool'); },
        async execute(sql, params) { return fakeConnection('pool').execute(sql, params); }
      };
    },
    async createConnection(options) {
      return fakeConnection(options.database ? 'lock' : 'database');
    }
  };
  require.cache[mysqlPath] = { id: mysqlPath, filename: mysqlPath, loaded: true, exports: fakeMysql };
  delete require.cache[databasePath];
  const database = require(databasePath);
  assert.strictEqual(poolOptions.connectionLimit, 10, '连接池默认 connectionLimit 必须为 10');
  assert.strictEqual(poolOptions.queueLimit, 200, '连接池默认 queueLimit 必须有界为 200');
  assert.strictEqual(poolOptions.connectTimeout, 10000, '连接池 connectTimeout 必须为 10 秒');

  await database.initDB();
  assert.strictEqual(state.lockReleased, 1, '正常启动必须释放 GET_LOCK');
  assert.strictEqual(state.released, 1, '正常启动必须释放池连接');

  state.failAt = 'CREATE TABLE IF NOT EXISTS schema_migrations';
  await assert.rejects(() => database.initDB(), /database unavailable/);
  assert.strictEqual(state.lockReleased, 2, '启动失败也必须释放 GET_LOCK');
  assert.strictEqual(state.released, 2, '启动失败也必须释放池连接');

  if (originalDatabase) require.cache[databasePath] = originalDatabase;
  else delete require.cache[databasePath];
  if (originalMysql) require.cache[mysqlPath] = originalMysql;
  else delete require.cache[mysqlPath];
}

async function main() {
  await testVersionedRunner();
  await testStartupLockAndFailure();
  console.log('[schema-migrations] 通过：重复迁移、失败阻止启动、锁释放、连接池边界和 schema 结构检查均通过');
}

main().catch(error => {
  console.error('[schema-migrations] 失败:', error);
  process.exitCode = 1;
});
