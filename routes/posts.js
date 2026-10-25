const express = require('express');
const profilesRouter = require('./posts/profiles');
const feedRouter = require('./posts/feed');
const writeRouter = require('./posts/write');
const commentsRouter = require('./posts/comments');
const interactionsRouter = require('./posts/interactions');

const router = express.Router();

router.use(profilesRouter);
router.use(feedRouter);
router.use(writeRouter);
router.use(commentsRouter);
router.use(interactionsRouter);

router.startLikeDebounceCleanup = interactionsRouter.startLikeDebounceCleanup;

module.exports = router;