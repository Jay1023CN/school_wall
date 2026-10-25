const express = require('express');
const { auth, isStaff } = require('../middleware/auth');

const router = express.Router();
const dailySongsRouter = require('./admin/daily-songs');
const slotsRouter = require('./admin/slots');
const systemRouter = require('./admin/system');
const storiesRouter = require('./admin-stories');
const adminPostsRouter = require('./admin/posts');
const adminUsersRouter = require('./admin/users');
const adminSongsRouter = require('./admin/songs');
const adminFeedbackRouter = require('./admin/feedbacks');
const adminNotificationsRouter = require('./admin/notifications');
const adminLogsRouter = require('./admin/logs');
const adminGamificationRouter = require('./admin/gamification');
const adminCommunicationsRouter = require('./admin/communications');
const adminNoticesRouter = require('./admin/notices');
const adminSettingsRouter = require('./admin/settings');
const adminPostViewsRouter = require('./admin/post-views');
const adminMessagesRouter = require('./admin/messages');

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.use(auth, isStaff);

router.use('/daily-songs', dailySongsRouter);
router.use('/slots', slotsRouter);
router.use(systemRouter);
router.use(adminPostsRouter);
router.use(adminUsersRouter);
router.use(adminSongsRouter);
router.use(adminLogsRouter);
router.use(adminNoticesRouter);
router.use(adminSettingsRouter);
router.use(adminFeedbackRouter);
router.use(adminNotificationsRouter);
router.use(adminPostViewsRouter);
router.use(adminGamificationRouter);
router.use(adminCommunicationsRouter);
router.use(adminMessagesRouter);
router.use(storiesRouter);

module.exports = router;
