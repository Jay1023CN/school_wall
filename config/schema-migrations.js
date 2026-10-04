'use strict';

const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// CREATE TABLE IF NOT EXISTS does not inspect an existing table. These
// contracts make an incomplete pre-existing table fail closed before startup
// uses it. They describe structure only and never transform historical rows.
const SCHEMA_CONTRACTS = Object.freeze([
  {
    table: 'schema_migrations',
    columns: { version: 'int', name: 'varchar(255)', applied_at: 'datetime' },
    indexes: [{ name: 'PRIMARY', columns: ['version'], unique: true }]
  },
  {
    table: 'slot_reservations',
    columns: { id: 'int', user_id: 'int', slot_id: 'int', reservation_date: 'date', status: "enum('confirmed','cancelled')", created_at: 'timestamp' },
    indexes: [
      { name: 'PRIMARY', columns: ['id'], unique: true },
      { name: 'unique_reservation', columns: ['user_id', 'slot_id', 'reservation_date'], unique: true },
      { name: 'idx_reservations_slot_date_status', columns: ['slot_id', 'reservation_date', 'status'] },
      { name: 'idx_reservations_user_slot_date_status', columns: ['user_id', 'slot_id', 'reservation_date', 'status'] }
    ]
  },
  {
    table: 'api_write_requests',
    columns: { user_id: 'int', scope: 'varchar(80)', request_key: 'varchar(128)', payload_hash: 'char(64)', response_status: 'int', response_body: 'json', created_at: 'datetime' },
    indexes: [
      { name: 'PRIMARY', columns: ['user_id', 'scope', 'request_key'], unique: true },
      { name: 'idx_write_created', columns: ['created_at'] }
    ]
  },
  {
    table: 'notification_outbox',
    columns: { id: 'bigint', dedupe_key: 'varchar(191)', recipient: 'varchar(255)', subject: 'varchar(500)', html: 'mediumtext', notification_type: 'varchar(50)', recipient_name: 'varchar(100)', status: "enum('pending','processing','sent','failed')", attempts: 'int', next_attempt_at: 'datetime', lease_until: 'datetime', claim_token: 'char(36)', last_error: 'varchar(500)', created_at: 'datetime', sent_at: 'datetime' },
    indexes: [
      { name: 'PRIMARY', columns: ['id'], unique: true },
      { name: 'dedupe_key', columns: ['dedupe_key'], unique: true },
      { name: 'idx_notification_outbox_status_next_attempt', columns: ['status', 'next_attempt_at'] },
      { name: 'idx_notification_outbox_lease_until', columns: ['lease_until'] }
    ]
  },
  {
    table: 'mp_sync_jobs',
    columns: { id: 'varchar(64)', owner_id: 'bigint', status: 'varchar(24)', payload: 'longtext', progress: 'longtext', result: 'longtext', error: 'text', lease_until: 'datetime', claim_token: 'char(36)', attempts: 'int', external_started_at: 'datetime', created_at: 'timestamp', updated_at: 'timestamp' },
    indexes: [
      { name: 'PRIMARY', columns: ['id'], unique: true },
      { name: 'idx_mp_sync_claim', columns: ['status', 'lease_until', 'created_at'] },
      { name: 'idx_mp_sync_owner_status', columns: ['owner_id', 'status'] }
    ]
  },
  {
    table: 'mp_sync_owners',
    columns: { owner_id: 'bigint', job_id: 'varchar(64)', created_at: 'timestamp' },
    indexes: [{ name: 'PRIMARY', columns: ['owner_id'], unique: true }]
  },
  {
    table: 'mp_sync_queue_guard',
    columns: { id: 'tinyint', created_at: 'timestamp' },
    indexes: [{ name: 'PRIMARY', columns: ['id'], unique: true }]
  }
]);

const SCHEMA_MIGRATIONS = Object.freeze([
  {
    version: 1,
    name: 'write-requests-outbox-and-reservations',
    async up(executor) {
      await executor.execute(`
        CREATE TABLE IF NOT EXISTS slot_reservations (
          id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          slot_id INT NOT NULL,
          reservation_date DATE NOT NULL,
          status ENUM('confirmed', 'cancelled') NOT NULL DEFAULT 'confirmed',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_reservation (user_id, slot_id, reservation_date),
          INDEX idx_reservations_slot_date_status (slot_id, reservation_date, status),
          INDEX idx_reservations_user_slot_date_status (user_id, slot_id, reservation_date, status),
          CONSTRAINT fk_slot_reservations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_slot_reservations_slot FOREIGN KEY (slot_id) REFERENCES song_slots(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      await executor.execute(`
        CREATE TABLE IF NOT EXISTS api_write_requests (
          user_id INT NOT NULL,
          scope VARCHAR(80) NOT NULL,
          request_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
          payload_hash CHAR(64) CHARACTER SET ascii NOT NULL,
          response_status INT NULL,
          response_body JSON NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, scope, request_key),
          INDEX idx_write_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      await executor.execute(`
        CREATE TABLE IF NOT EXISTS notification_outbox (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          dedupe_key VARCHAR(191) CHARACTER SET ascii NOT NULL UNIQUE,
          recipient VARCHAR(255) NOT NULL,
          subject VARCHAR(500) NOT NULL,
          html MEDIUMTEXT NOT NULL,
          notification_type VARCHAR(50) NOT NULL,
          recipient_name VARCHAR(100) NULL,
          status ENUM('pending', 'processing', 'sent', 'failed') NOT NULL DEFAULT 'pending',
          attempts INT NOT NULL DEFAULT 0,
          next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          lease_until DATETIME NULL,
          claim_token CHAR(36) NULL,
          last_error VARCHAR(500) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          sent_at DATETIME NULL,
          INDEX idx_notification_outbox_status_next_attempt (status, next_attempt_at),
          INDEX idx_notification_outbox_lease_until (lease_until)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }
  },
  {
    version: 2,
    name: 'durable-mp-sync-jobs',
    async up(executor) {
      const { MP_SYNC_SCHEMA_SQL } = require('../services/mp-sync-jobs');
      for (const sql of MP_SYNC_SCHEMA_SQL) await executor.execute(sql);
      await executor.execute('INSERT IGNORE INTO mp_sync_queue_guard (id) VALUES (1)');
    }
  }
]);

function assertExecutor(executor) {
  if (!executor || typeof executor.execute !== 'function') {
    throw new TypeError('schema migration executor must provide execute(sql, params)');
  }
}

function contractError(message, table) {
  const error = new Error('SCHEMA_CONTRACT_MISMATCH: ' + message);
  error.code = 'SCHEMA_CONTRACT_MISMATCH';
  if (table) error.table = table;
  return error;
}

function normalizeType(type) {
  let value = String(type || '').trim().toLowerCase().replace(/\s*,\s*/g, ',');
  value = value.replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)( unsigned)?$/, '$1$2');
  return value;
}

function indexColumns(rows, keyName) {
  return rows
    .filter(row => String(row.Key_name || row.key_name || '') === keyName)
    .sort((a, b) => Number(a.Seq_in_index || a.seq_in_index) - Number(b.Seq_in_index || b.seq_in_index))
    .map(row => String(row.Column_name || row.column_name || '').toLowerCase());
}

async function validateSchemaContracts(executor) {
  assertExecutor(executor);
  for (const contract of SCHEMA_CONTRACTS) {
    let columns;
    let indexes;
    let tableStatus;
    try {
      [columns] = await executor.execute(`SHOW COLUMNS FROM \`${contract.table}\``);
      [indexes] = await executor.execute(`SHOW INDEX FROM \`${contract.table}\``);
      [tableStatus] = await executor.execute(
        'SELECT ENGINE AS Engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [contract.table]
      );
    } catch (error) {
      if (error && error.code === 'SCHEMA_CONTRACT_MISMATCH') throw error;
      throw contractError(`${contract.table} 无法读取表结构：${error.message || error}`, contract.table);
    }
    const statusRows = Array.isArray(tableStatus) ? tableStatus : [];
    if (!statusRows.length || String(statusRows[0].Engine || statusRows[0].engine || '').toLowerCase() !== 'innodb') {
      throw contractError(`${contract.table} 存储引擎必须为 InnoDB`, contract.table);
    }
    const columnRows = Array.isArray(columns) ? columns : [];
    const columnMap = new Map(columnRows.map(row => [String(row.Field || row.field || '').toLowerCase(), row]));
    const missingColumns = Object.keys(contract.columns).filter(name => !columnMap.has(name));
    if (missingColumns.length) {
      throw contractError(`${contract.table} 缺少必需列：${missingColumns.join(', ')}`, contract.table);
    }
    for (const [name, expected] of Object.entries(contract.columns)) {
      const actual = columnMap.get(name);
      if (normalizeType(actual.Type || actual.type) !== normalizeType(expected)) {
        throw contractError(`${contract.table}.${name} 类型为 ${actual.Type || actual.type}，要求 ${expected}`, contract.table);
      }
    }
    const indexRows = Array.isArray(indexes) ? indexes : [];
    for (const required of contract.indexes) {
      const rows = indexRows.filter(row => String(row.Key_name || row.key_name || '') === required.name);
      const actualColumns = indexColumns(indexRows, required.name);
      if (!rows.length || JSON.stringify(actualColumns) !== JSON.stringify(required.columns)) {
        throw contractError(`${contract.table}.${required.name} 索引列不匹配：实际 ${actualColumns.join(',') || '不存在'}，要求 ${required.columns.join(',')}`, contract.table);
      }
      if (required.unique && Number(rows[0].Non_unique ?? rows[0].non_unique) !== 0) {
        throw contractError(`${contract.table}.${required.name} 必须是唯一索引`, contract.table);
      }
    }
  }
}

async function runSchemaMigrations(executor) {
  assertExecutor(executor);
  await executor.execute(SCHEMA_MIGRATIONS_TABLE_SQL);
  const [rows] = await executor.execute(
    'SELECT version FROM schema_migrations ORDER BY version'
  );
  const applied = new Set((rows || []).map(row => Number(row.version)));

  for (const migration of SCHEMA_MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    // MySQL DDL implicitly commits. Record the version only after all DDL
    // succeeds; a later start retries CREATE IF NOT EXISTS and validates the
    // complete contract instead of assuming an incomplete table is usable.
    await migration.up(executor);
    await executor.execute(
      'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
      [migration.version, migration.name]
    );
  }
  await validateSchemaContracts(executor);
}

module.exports = {
  SCHEMA_MIGRATIONS,
  SCHEMA_MIGRATIONS_TABLE_SQL,
  SCHEMA_CONTRACTS,
  validateSchemaContracts,
  runSchemaMigrations
};
