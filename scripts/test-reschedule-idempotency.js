const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../routes/admin/songs.js'), 'utf8');
const section = require('./lib/source-sections').routeSource(source, 'put', '/songs/:id/reschedule');
assert(section.includes('code: 410') && !section.includes('setImmediate') && !section.includes('execute('), '旧改期入口不得写库或发送通知');
console.log('[reschedule-retired] 通过：重复调用旧改期入口不会改排期或发送通知');
