'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeFailure, checkDatabase, readFailure } = require('./check-database-startup');

async function main() {
  const secret = 'private-password-test-value';
  const diagnostic = describeFailure({ code: 'ER_BAD_FIELD_ERROR', sql: 'ALTER TABLE users ADD COLUMN example INT', message: secret, sqlMessage: secret, values: [secret] });
  assert.deepStrictEqual(diagnostic, { phase: 'database', code: 'ER_BAD_FIELD_ERROR', operation: 'ALTER', table: 'users' });
  assert(!JSON.stringify(diagnostic).includes(secret));
  const typeDiagnostic = describeFailure({ code: 'SCHEMA_CONTRACT_MISMATCH', table: 'slot_reservations', message: "SCHEMA_CONTRACT_MISMATCH: slot_reservations.status 类型为 varchar(20)，要求 enum('confirmed','cancelled')", actualType: 'varchar(20)', expectedType: "enum('confirmed','cancelled')" });
  assert.strictEqual(typeDiagnostic.contractField, 'status');
  assert.strictEqual(typeDiagnostic.actualType, 'varchar(20)');
  assert.strictEqual(typeDiagnostic.expectedType, 'enum');
  assert(!JSON.stringify(typeDiagnostic).includes('confirmed'));
  assert.strictEqual(describeFailure({ code: secret + ';', table: 'users; SELECT private' }).table, null);
  let closed = 0;
  let report;
  const revision = 'a'.repeat(40);
  assert.strictEqual(await checkDatabase({ initialize: async () => { throw { code: 'ECONNREFUSED', message: secret }; }, close: async () => { closed++; }, writeReport: value => { report = value; }, revision }), false);
  assert.strictEqual(closed, 1);
  assert.strictEqual(report.failure.code, 'ECONNREFUSED');
  assert.strictEqual(await checkDatabase({ initialize: async () => {}, close: async () => { closed++; }, writeReport: value => { report = value; }, revision }), true);
  assert.strictEqual(report.failure, null);
  assert.strictEqual(closed, 2);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-db-report-'));
  const file = path.join(directory, 'report.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ ok: false, revision, failure: { ...diagnostic, message: secret } }));
    assert.deepStrictEqual(readFailure(file, revision), diagnostic);
    assert.strictEqual(readFailure(file, 'b'.repeat(40)), null);
    assert(!JSON.stringify(readFailure(file, revision)).includes(secret));
    fs.writeFileSync(file, JSON.stringify({ ok: false, revision, attempt: 'attempt1', failure: diagnostic }));
    assert.deepStrictEqual(readFailure(file, revision, 'attempt1'), diagnostic);
    assert.strictEqual(readFailure(file, revision, 'attempt2'), null, '同一提交上次失败的报告不能归属到新部署');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('[database-startup-check] 通过：预检成功/失败、关闭连接、结构诊断脱敏和旧报告隔离');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
