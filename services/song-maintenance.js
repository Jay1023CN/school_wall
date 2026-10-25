'use strict';
const { parseBoundedPositiveInt } = require('./number-utils');
const { getChinaDate, getChinaJsDayOfWeek, getChinaDayRange } = require('./date');

function createSongMaintenance({ repository, notifySongPlayed, now = () => new Date(), logger = console }) {
  let stop = null;
  async function markDueApprovedSongsAsPlayed() { return 0; }

  let futureDatesTask = null;
  let futureDatesTimer = null;
  let stopFutureDatesMaintenance = null;
  const FUTURE_DATES_INITIAL_DELAY_MS = 5000;
  const FUTURE_DATES_REFRESH_MS = 60 * 60 * 1000;
  const FUTURE_DATES_RETRY_MS = 60 * 1000;

  async function populateFutureDates() {
    try {
      const { slots, hasSlotCapacity } = await repository.findActiveSlots();
      if (slots.length === 0) return true;
      const todayNow = now();
      const { today, rangeEnd } = getChinaDayRange(todayNow);

      const capacityRows = await repository.findFutureCapacities(today);
      const slotCapacityById = new Map();
      for (const slot of slots) {
        const configuredCapacity = hasSlotCapacity && Number(slot.max_songs) > 0
          ? parseBoundedPositiveInt(slot.max_songs, 10, 100)
          : null;
        if (configuredCapacity) slotCapacityById.set(slot.id, configuredCapacity);
      }
      for (const row of capacityRows) {
        if (slotCapacityById.has(row.slot_id) || Number(row.manual_override) === 1) continue;
        const capacity = parseBoundedPositiveInt(row.max_songs, 10, 100);
        slotCapacityById.set(row.slot_id, capacity);
      }

      const dateRows = [];
      for (let i = 0; i < 14; i++) {
        const dateStr = getChinaDate(i, todayNow);
        const dayOfWeek = getChinaJsDayOfWeek(dateStr);
        for (const slot of slots) {
          const effectiveStartDate = slot.effective_start_date
            ? String(slot.effective_start_date).split('T')[0]
            : '';
          if (effectiveStartDate && dateStr < effectiveStartDate) {
            continue;
          }
          if (slot.weekdays && slot.weekdays !== '') {
            const allowedDays = slot.weekdays.split(',').map(w => parseInt(w));
            if (!allowedDays.includes(dayOfWeek)) {
              continue;
            }
          }
          dateRows.push([slot.id, dateStr, slotCapacityById.get(slot.id) || 10]);
        }
      }

      for (let start = 0; start < dateRows.length; start += 200) {
        const batch = dateRows.slice(start, start + 200);
        await repository.insertDates(batch);
      }
      await repository.pruneDates(today, rangeEnd);
      return true;
    } catch (e) {
      logger.error('[时段] 自动补充日期失败:', e.message);
      return false;
    }
  }

  function ensureFutureDates() {
    if (!futureDatesTask) {
      futureDatesTask = populateFutureDates().finally(() => {
        futureDatesTask = null;
      });
    }
    return futureDatesTask;
  }

  function startFutureDatesMaintenance() {
    if (stopFutureDatesMaintenance) return stopFutureDatesMaintenance;
    let active = true;

    let run;
    const scheduleNext = delay => {
      if (!active) return;
      futureDatesTimer = setTimeout(run, delay);
      if (typeof futureDatesTimer.unref === 'function') futureDatesTimer.unref();
    };

    run = () => {
      futureDatesTimer = null;
      ensureFutureDates()
        .then(success => scheduleNext(success ? FUTURE_DATES_REFRESH_MS : FUTURE_DATES_RETRY_MS))
        .catch(error => {
          logger.error('[时段] 后台维护任务失败:', error.message);
          scheduleNext(FUTURE_DATES_RETRY_MS);
        });
    };

    scheduleNext(FUTURE_DATES_INITIAL_DELAY_MS);
    stopFutureDatesMaintenance = function stopMaintenance() {
      if (active) {
        active = false;
        clearTimeout(futureDatesTimer);
        futureDatesTimer = null;
        stopFutureDatesMaintenance = null;
      }
      return futureDatesTask || Promise.resolve();
    };
    return stopFutureDatesMaintenance;
  }

  function start() {
    if (stop) return stop;
    const stopDates = startFutureDatesMaintenance();
    let stopping;
    stop = () => {
      if (stopping) return stopping;
      stop = null;
      stopping = Promise.all([stopDates()]);
      return stopping;
    };
    return stop;
  }

  async function drain() {
    await Promise.all([futureDatesTask]);
  }

  return { ensureFutureDates, markDueApprovedSongsAsPlayed, start, drain };
}

module.exports = { createSongMaintenance };
