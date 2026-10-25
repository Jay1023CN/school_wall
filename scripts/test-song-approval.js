'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { functionSource, routeSource: getRouteSource } = require('./lib/source-sections');
const { approveSong } = require('../services/song-scheduling');
const { getChinaDate, getChinaDayOfWeek } = require('../services/date');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

async function main() {
  let state = 'pending';
  const queries = [];
  const connection = { async execute(sql, params) {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT')) return [[{ id: 1, status: state }]];
    state = 'approved';
    return [{ affectedRows: 1 }];
  } };
  // 不提供日期、不查询时段也能通过；旧客户端携带日期时同样不能排期。
  await approveSong(connection, 1, 999, 1, '2099-01-01', 88, true);
  assert.strictEqual(queries.length, 2);
  assert(queries[0].sql.includes('FOR UPDATE'));
  assert(queries[1].sql.includes('approved_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR)'));
  assert(!/slot_|play_date|play_order/.test(queries[1].sql));
  await assert.rejects(approveSong(connection, 1), /已不在待审核/);
  await assert.rejects(approveSong({ execute: async () => [[]] }, 999), /不存在/);

  const radio = read('routes/songs.js');
  const hide = vm.runInNewContext('(' + radio.slice(radio.indexOf('function hidePlaybackSchedule'), radio.indexOf('function getListPagination')).trim() + ')');
  const song = { id: 1, song_name: '听见夏天', status: 'approved', slot_id: 1, slot_date_id: 2, play_order: 1,
    play_date: '2099-01-01', slot_name: '午夜广播', start_time: '23:58', end_time: '23:59' };
  const visible = hide(song);
  assert.deepStrictEqual(Object.keys(visible).sort(), ['id', 'song_name', 'status']);
  assert.strictEqual(song.play_date, '2099-01-01', '投影不得修改原记录');
  assert.strictEqual((radio.match(/songs\.map\(hidePlaybackSchedule\)/g) || []).length, 3);

  const routeSource = read('routes/mp-draft.js');
  let handler;
  let weeklyQuery;
  const context = {
    router: { get: (_url, _auth, fn) => { handler = fn; } }, superAdminOnly: () => {},
    pool: { execute: async (sql, params) => { weeklyQuery = { sql, params }; return [[{ song_name: '听见夏天' }]]; } },
    getChinaDate, getChinaDayOfWeek,
    mpDraftService: { generateArticleTitle: () => ({ title: '本周审核通过歌单', digest: '本周审核通过的歌曲' }) },
    console
  };
  vm.createContext(context);
  vm.runInContext(['addBusinessDays', 'formatMonthDay', 'getWeeklySongScheduleRange'].map(name => functionSource(routeSource, name)).join('\n'), context);
  const start = routeSource.indexOf("router.get('/weekly-song-schedule'");
  vm.runInContext(getRouteSource(routeSource, 'get', '/weekly-song-schedule'), context);
  let result;
  await handler({ query: { week: 'next' } }, { json: value => { result = value; } });
  assert.strictEqual(result.code, 200);
  assert.strictEqual(result.data.period_label, '本周', '旧客户端的下周参数不能生成播放预告');
  assert(weeklyQuery.sql.includes("sr.status IN ('approved', 'played')"), '本周已经播放的已审核歌曲也应保留');
  assert(weeklyQuery.sql.includes('sr.approved_at >= ? AND sr.approved_at < ?'));
  assert(!/slot_|play_date|start_time|end_time|created_at/.test(weeklyQuery.sql));
  assert.strictEqual(weeklyQuery.params[0], result.data.week_start);

  const client = read('frontend/admin/js/mp-draft.js');
  const builderContext = vm.createContext({
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    currentAdminUser: null, renderSignatureCard: () => ''
  });
  for (const name of ['buildNextWeekRadioSectionHtml', 'buildWeeklySongScheduleHtml']) {
    const from = client.indexOf('        function ' + name + '(');
    const to = client.indexOf('\n        }', from) + '\n        }'.length;
    vm.runInContext(client.slice(from, to), builderContext);
    const html = builderContext[name]({ period_label: '本周', week_label: '审核周', songs: [{ ...song, artist: '<歌手>', requester_name: '不得显示', is_anonymous: 1, message: '<留言>', play_date_label: '一月一日', weekday: '周日' }] });
    for (const value of ['2099', '午夜广播', '23:58', '23:59', '一月一日', '不得显示']) {
      assert(!html.includes(value), name + ' 不得泄露排期或匿名身份：' + value);
    }
    assert(html.includes('听见夏天') && html.includes('&lt;歌手&gt;'));
    assert(html.includes('匿名同学'));
    assert(html.includes('具体播放日期和时段不另行通知'));
  }
  console.log('[song-approval] 通过：无排期审核、重复审核保护、审核周筛选、接口字段及两种公众号正文均不泄露播放安排');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
