'use strict';

const { scheduleCleanup, drainCleanup } = require('../services/cleanup');
const auth = require('../routes/auth');
const posts = require('../routes/posts');
const { maintenance: songs } = require('../modules/songs');
const mp = require('../routes/mp-draft');
const { getNotificationOutbox } = require('../services/notification-outbox');

let stop = null;

async function startBackgroundTasks() {
  if (stop) return stop;
  const stoppers = [];
  try {
    stoppers.push(auth.startCaptchaCleanup());
    stoppers.push(posts.startLikeDebounceCleanup());
    stoppers.push(songs.start());
    stoppers.push(await mp.startSyncJobs());
    stoppers.push(getNotificationOutbox().start());
    stoppers.push(scheduleCleanup());
  } catch (error) {
    await Promise.allSettled(stoppers.reverse().map(stopper => Promise.resolve().then(stopper)));
    await drainBackgroundTasks().catch(() => {});
    throw error;
  }
  let stopping;
  stop = function stopBackgroundTasks() {
    if (stopping) return stopping;
    stop = null;
    stopping = Promise.all(stoppers.reverse().map(stopper => stopper()));
    return stopping;
  };
  return stop;
}

async function drainBackgroundTasks() {
  await Promise.all([drainCleanup(), songs.drain(), mp.drainBackgroundTasks(), getNotificationOutbox().drain()]);
}

module.exports = { startBackgroundTasks, drainBackgroundTasks };
