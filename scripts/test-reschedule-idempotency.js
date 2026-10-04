'use strict';
const assert = require('assert');
const { rescheduleApprovedSong } = require('../services/song-scheduling');
const { getChinaDate } = require('../services/date');

async function main() {
  let writes = 0;
  let scheduleId = 9;
  const connection = { async execute(sql, params) {
    if (sql.includes('SELECT id, status')) return [[{ id: 1, status: 'approved', slot_id: 2, slot_date_id: scheduleId }]];
    if (sql.includes('SELECT sd.id')) return [[{ id: params[0], slot_id: 2, play_date: getChinaDate(1), manual_override: 1, max_songs: 3 }]];
    if (sql.startsWith('SELECT COUNT')) return [[{ cnt: 0 }]];
    if (sql.startsWith('UPDATE song_requests')) { writes++; scheduleId = params[1]; return [{ affectedRows: 1 }]; }
    throw new Error('Unexpected SQL ' + sql);
  } };
  const first = await rescheduleApprovedSong(connection, 1, 10);
  assert(!first.unchanged);
  assert.equal(writes, 1);
  const repeated = await rescheduleApprovedSong(connection, 1, 10);
  assert(repeated.unchanged, 'same target returns explicit no-op, caller must not notify twice');
  assert.equal(writes, 1);
  const fs = require('fs'), path = require('path');
  const route = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  const section = route.slice(route.indexOf("router.put('/songs/:id/reschedule'"), route.indexOf('// 审核点歌'));
  assert(section.indexOf('writeResult.replayed') < section.indexOf('setImmediate'), 'receipt replay exits before mail');
  assert(section.includes("'songs:reschedule'"));
  console.log('Reschedule idempotency tests passed: repeated schedule does not write or notify twice');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
