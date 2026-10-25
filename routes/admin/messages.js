const express = require('express');
const { pool } = require('../../config/database');
const { superAdminOnly } = require('../../middleware/auth');

const router = express.Router();
router.get('/messages', superAdminOnly, async (req, res) => {
  try {
    const [convs] = await pool.execute(`
      SELECT c.id, c.user1_id, c.user2_id, c.user1_dnd, c.user2_dnd,
        c.user1_cleared_at, c.user2_cleared_at, c.last_message_at, c.created_at,
        u1.nickname as u1_name, u1.username as u1_username,
        u2.nickname as u2_name, u2.username as u2_username,
        (SELECT content FROM messages WHERE conversation_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) as last_msg,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as total_msgs,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND deleted_at IS NOT NULL) as deleted_msgs
      FROM conversations c
      LEFT JOIN users u1 ON u1.id = c.user1_id
      LEFT JOIN users u2 ON u2.id = c.user2_id
      WHERE c.id IS NOT NULL
      ORDER BY c.last_message_at DESC
    `);
    res.json({ code: 200, data: { conversations: convs } });
  } catch (err) {
    console.error('[Admin] 获取消息列表失败:', err.message);
    res.status(500).json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

router.get('/messages/:id/messages', superAdminOnly, async (req, res) => {
  try {
    const convId = parseInt(req.params.id);
    const [msgs] = await pool.execute(`
      SELECT m.*, u.nickname as sender_name, u.username as sender_username
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
    `, [convId]);
    const [conv] = await pool.execute(`
      SELECT c.*, u1.nickname as u1_name, u2.nickname as u2_name
      FROM conversations c
      LEFT JOIN users u1 ON u1.id = c.user1_id
      LEFT JOIN users u2 ON u2.id = c.user2_id
      WHERE c.id = ?
    `, [convId]);
    res.json({ code: 200, data: { conversation: conv[0] || null, messages: msgs } });
  } catch (err) {
    console.error('[Admin] 获取会话消息失败:', err.message);
    res.status(500).json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

router.delete('/messages/:id', superAdminOnly, async (req, res) => {
  try {
    await pool.execute('DELETE FROM messages WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ code: 200, message: '消息已永久删除' });
  } catch (err) {
    res.status(500).json({ code: 500, message: '操作失败，请稍后重试' });
  }
});

router.post('/conversations/:id/purge', superAdminOnly, async (req, res) => {
  try {
    await pool.execute('DELETE FROM messages WHERE conversation_id = ?', [parseInt(req.params.id)]);
    await pool.execute('DELETE FROM conversations WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ code: 200, message: '会话及消息已全部永久删除' });
  } catch (err) {
    res.status(500).json({ code: 500, message: '操作失败，请稍后重试' });
  }
});


module.exports = router;
