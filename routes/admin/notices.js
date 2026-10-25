const express = require('express');
const { pool } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');

const router = express.Router();
router.get('/notices', requirePermission('notices:manage'), async (req, res) => {
  try {
    const [notices] = await pool.execute(
      'SELECT * FROM notices ORDER BY is_top DESC, created_at DESC'
    );
    res.json({ code: 200, data: { notices } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/notices', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { title, content, is_top = false } = req.body;
    await pool.execute(
      'INSERT INTO notices (admin_id, title, content, is_top) VALUES (?, ?, ?, ?)',
      [req.user.id, title, content, is_top]
    );
    res.json({ code: 200, message: '发布成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/notices/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { title, content, is_top } = req.body;
    const top = is_top ? 1 : 0;
    await pool.execute(
      'UPDATE notices SET title = ?, content = ?, is_top = ? WHERE id = ?',
      [title, content, top, req.params.id]
    );
    res.json({ code: 200, message: '更新成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/notices/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM notices WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: '删除成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});



module.exports = router;
