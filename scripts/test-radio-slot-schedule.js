'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const database = read('config/database.js');
const admin = read('routes/admin.js') + '\n' + read('routes/admin/songs.js');
const slotsAdmin = read('routes/admin/slots.js');
const scheduling = read('services/song-scheduling.js');
const songs = read('routes/songs.js');
const maintenance = read('services/song-maintenance.js');
const maintenanceSql = read('repositories/song-maintenance.js');
const adminPageHtml = read('frontend/admin/index.html');
const adminHtml = `${adminPageHtml}\n${['admin.js', 'admin-stories.js']
  .map((name) => read('frontend/admin/js/' + name)).join('\n')}`;
const { getChinaJsDayOfWeek } = require(path.join(root, 'services', 'date'));

assert(database.includes('effective_start_date DATE DEFAULT NULL'), 'time_slots 必须保存周期生效日期');
assert(database.includes('manual_override TINYINT DEFAULT 0'), 'slot_dates 必须保存单日播放例外');
assert(database.includes('UPDATE slot_dates SET is_active = 1 WHERE is_active IS NULL'), '迁移只能补齐空状态，不能重置管理员关闭的日期');
assert(!database.includes('UPDATE slot_dates SET is_active = 1 WHERE is_active = 0 OR is_active IS NULL'), '不能在启动时重新开放已关闭日期');
assert(songs.includes('effective_start_date') && maintenance.includes('dateStr < effectiveStartDate'), '自动补齐必须遵守周期生效日期');
assert(!maintenanceSql.includes('UPDATE slot_dates SET max_songs = ? WHERE max_songs != ? AND play_date >= ?'), '自动补齐不得用全局设置覆盖所有时段容量');
assert(maintenance.includes('slotCapacityById') && maintenance.includes('manual_override') && maintenanceSql.includes('max_songs FROM time_slots'), '自动补齐必须按时段读取容量并跳过单日例外');
assert(songs.includes('该日期不在当前开放周期内'), '提交点歌必须再次校验当前星期周期');
assert.strictEqual(getChinaJsDayOfWeek('2026-09-08'), 2, '周二必须使用历史时段数据的值 2');
assert.strictEqual(getChinaJsDayOfWeek('2026-09-06'), 0, '周日必须使用历史时段数据的值 0');
assert(songs.indexOf('该日期不在当前开放周期内') < songs.indexOf('await connection.commit()'), '星期校验必须在提交事务前完成');
assert(slotsAdmin.includes("UPDATE slot_dates SET is_active = 0, manual_override = 1 WHERE id = ? AND slot_id = ?"), '移除日期必须保留为禁用例外，防止自动补齐复活');
assert(slotsAdmin.includes('INSERT IGNORE INTO slot_dates'), '补齐日期不能覆盖管理员关闭的记录');
assert(slotsAdmin.includes("router.post('/:slotId/calendar-date'"), '编辑日历必须有单日加播或停播接口');
assert(slotsAdmin.includes("router.put('/:slotId/calendar-dates'"), '编辑日历必须提供批量保存接口');
assert(slotsAdmin.includes('await connection.beginTransaction()') && slotsAdmin.includes('日期调整已保存'), '批量保存日期必须使用事务并返回明确结果');
assert(slotsAdmin.includes('const rangeEnd = getChinaDate(28);'), '编辑日历接口必须覆盖完整的未来 28 天窗口，确保保存后可回读');
assert(slotsAdmin.includes('manual_override = 1'), '单日加播或停播必须保留为例外，不能被星期周期覆盖');
assert(songs.includes('Number(d.manual_override) === 1'), '用户投稿列表必须识别非周期日的单日加播');
assert(adminHtml.includes('id="slot-start-date-calendar"'), '后台必须提供可直接点击的播放日历，不依赖手机 yyyy/mm/dd 输入');
assert(adminHtml.includes('点紫色日期可设为不播放') && adminHtml.includes('点灰色日期可临时加播'), '日历必须直接表达取消播放和临时加播');
assert(adminHtml.includes('renderSlotStartDateCalendar') && adminHtml.includes('toggleSlotEditCalendarDate'), '切换星期或点击日期必须即时刷新播放安排');
assert(adminHtml.includes('slotEditCalendarDirty') && adminHtml.includes('persistSlotEditCalendarDraft'), '日期点击只能暂存，必须在保存时统一提交');
assert(!adminHtml.includes("method: 'POST',\n                    body: JSON.stringify({ play_date: dateStr, is_active: nextActive })"), '日期点击不得再次逐项立即提交');
assert(adminHtml.includes('loadSlotEditCalendarDates(id)'), '编辑既有时段时必须载入单日例外');
assert(!adminHtml.includes('manageSlotDates'), '时段列表不应再提供重复的日期管理入口');
assert(!adminHtml.includes('id="slot-dates-modal"'), '日期管理弹窗应收拢到编辑日历，避免两处操作');
assert(!adminHtml.includes('id="slot-date-input"'), '日期管理不应继续暴露手机难操作的 YYYY-MM-DD 输入');
assert(!adminHtml.includes('openSongApprovalModal') && !adminHtml.includes('open-song-reschedule'), '审核不得要求选择排期或提供改期操作');
assert(admin.includes('code: 410') && admin.includes('不再提供播放排期'), '旧客户端排期接口必须停止写入');
assert.strictEqual(adminPageHtml, read('public/admin/index.html'), '后台审核页面镜像必须一致');
assert.strictEqual(read('frontend/admin/css/admin.css'), read('public/admin/css/admin.css'), '后台样式镜像必须一致');

console.log('[radio-slot-schedule] 通过：星期周期与单日加播/停播例外均已收拢到编辑日历');
