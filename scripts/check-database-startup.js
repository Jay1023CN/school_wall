'use strict';

const fs = require('fs');
const path = require('path');

function identifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(String(value || '')) ? String(value) : null;
}

function structuralType(value) {
  // Numeric type parameters only; enum values and arbitrary strings are omitted.
  const match = String(value || '').toLowerCase().match(/^(varchar|char|int|tinyint|smallint|mediumint|bigint|text|mediumtext|longtext|json|date|datetime|timestamp|enum)(\(\d+(?:,\d+)?\))?(?: unsigned)?/);
  return match ? match[1] + (match[2] || '') : null;
}

// Export only structural identifiers, never SQL, parameters, error messages or
// connection options. The deployment status endpoint is authenticated.
function describeFailure(error) {
  const sql = String(error && error.sql || '');
  const operation = sql.match(/^\s*(CREATE|ALTER|INSERT|SELECT|UPDATE|DELETE|SHOW)\b/i);
  const table = sql.match(/\b(?:TABLE(?:\s+IF\s+NOT\s+EXISTS)?|FROM|INTO)\s+`?([A-Za-z_][A-Za-z0-9_]*)/i);
  const result = {
    phase: 'database',
    code: identifier(error && error.code) || 'DATABASE_CHECK_FAILED',
    operation: operation ? operation[1].toUpperCase() : null,
    table: identifier(error && error.table) || identifier(table && table[1])
  };
  if (result.code === 'SCHEMA_CONTRACT_MISMATCH') {
    const field = String(error.message || '').match(/^SCHEMA_CONTRACT_MISMATCH: [a-z_]+\.([a-z_]+) /);
    if (field) result.contractField = identifier(field[1]);
    const message = String(error.message || '');
    if (message.includes('缺少必需列')) result.contractIssue = 'missing_columns';
    else if (message.includes('类型为')) result.contractIssue = 'type';
    else if (message.includes('索引') || message.includes('唯一索引')) result.contractIssue = 'index';
    else if (message.includes('存储引擎')) result.contractIssue = 'engine';
    if (error.actualType) result.actualType = structuralType(error.actualType);
    if (error.expectedType) result.expectedType = structuralType(error.expectedType);
  }
  return result;
}

async function checkDatabase({ initialize, close, writeReport, revision, attempt }) {
  let failure = null;
  try { await initialize(); } catch (error) { failure = describeFailure(error); }
  try { await close(); } catch (error) { failure = failure || describeFailure(error); }
  const report = { ok: !failure, revision, attempt, checkedAt: new Date().toISOString(), failure };
  await writeReport(report);
  return report.ok;
}

function readFailure(file, revision, attempt) {
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (report.revision !== revision || report.attempt !== attempt || report.ok !== false || !report.failure) return null;
    const failure = report.failure;
    const result = {
      phase: 'database',
      code: identifier(failure.code) || 'DATABASE_CHECK_FAILED',
      operation: /^(CREATE|ALTER|INSERT|SELECT|UPDATE|DELETE|SHOW)$/.test(failure.operation) ? failure.operation : null,
      table: identifier(failure.table)
    };
    if (result.code === 'SCHEMA_CONTRACT_MISMATCH') {
      if (identifier(failure.contractField)) result.contractField = failure.contractField;
      if (['missing_columns', 'type', 'index', 'engine'].includes(failure.contractIssue)) result.contractIssue = failure.contractIssue;
      if (structuralType(failure.actualType)) result.actualType = structuralType(failure.actualType);
      if (structuralType(failure.expectedType)) result.expectedType = structuralType(failure.expectedType);
    }
    return result;
  } catch (error) { return null; }
}

async function main() {
  if (process.argv[2] === '--read-report') {
    process.stdout.write(JSON.stringify(readFailure(process.argv[3], process.argv[4], process.argv[5])));
    return;
  }
  const file = process.argv[2];
  const revision = process.argv[3];
  const attempt = process.argv[4];
  if (!file || !/^[a-f0-9]{40}$/.test(String(revision || '')) || !/^\d{10,}-\d+$/.test(String(attempt || ''))) throw new Error('Expected report path, revision and deployment attempt');
  require('../config/environment').loadEnvironment();
  const { initDB, pool } = require('../config/database');
  const ok = await checkDatabase({ initialize: initDB, close: () => pool.end(), revision, attempt,
    writeReport(report) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp.' + process.pid;
      fs.writeFileSync(temporary, JSON.stringify(report), { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
  });
  if (!ok) process.exitCode = 1;
}

if (require.main === module) main().catch(() => { console.error('[database-check] Unable to complete preflight'); process.exitCode = 1; });
module.exports = { describeFailure, checkDatabase, readFailure };
