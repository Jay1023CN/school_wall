'use strict';

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatUtcDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function getChinaDate(offsetDays = 0, now = new Date()) {
  const chinaNow = new Date(now.getTime() + CHINA_OFFSET_MS + offsetDays * DAY_MS);
  return formatUtcDate(chinaNow);
}

function getChinaDayOfWeek(value) {
  if (value instanceof Date) {
    value = [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return NaN;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return day === 0 ? 7 : day;
}

function getChinaJsDayOfWeek(value) {
  if (value instanceof Date) {
    value = [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return NaN;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

function toChinaDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:\s|$)/.test(value.trim())) {
    return value.trim().slice(0, 10);
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : getChinaDate(0, date);
}

function getChinaTime(now = new Date()) {
  const chinaNow = new Date(now.getTime() + CHINA_OFFSET_MS);
  return [chinaNow.getUTCHours(), chinaNow.getUTCMinutes(), chinaNow.getUTCSeconds()]
    .map(value => String(value).padStart(2, '0')).join(':');
}

function getChinaDayRange(now = new Date()) {
  const today = getChinaDate(0, now);
  const nextDay = getChinaDate(1, now);
  return { today, rangeEnd: getChinaDate(14, now),
    todayStart: today + ' 00:00:00', tomorrowStart: nextDay + ' 00:00:00' };
}

module.exports = { getChinaTime, getChinaDayRange, getChinaDate, getChinaDayOfWeek, getChinaJsDayOfWeek, toChinaDate };
