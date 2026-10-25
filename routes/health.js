const express = require('express');
const { pool } = require('../config/database');
const { withTimeout } = require('../services/async-utils');

const router = express.Router();
const HEALTHCHECK_TIMEOUT_MS = Math.max(Number.parseInt(process.env.HEALTHCHECK_TIMEOUT_MS, 10) || 3000, 500);

router.get(['/health', '/healthz'], async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await withTimeout(pool.execute('SELECT 1 AS ok'), HEALTHCHECK_TIMEOUT_MS, 'health check timeout');
    res.json({ code: 200, status: 'ok' });
  } catch (err) {
    console.error('[Health] 数据库检查失败:', err.message);
    res.status(503).json({ code: 503, status: 'unavailable' });
  }
});

module.exports = router;
