'use strict';

const { pool } = require('../config/database');

async function createNotification(userId, type, title, content, relatedId, relatedType) {
  try {
    await pool.execute(
      'INSERT INTO notifications (user_id, type, title, content, related_id, related_type) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, type, title, content || '', relatedId || null, relatedType || null]
    );
  } catch (err) {
    console.error('创建通知失败:', err && (err.code || err.message) || 'unknown error');
  }
}

module.exports = { createNotification };
