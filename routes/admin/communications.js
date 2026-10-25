const express = require('express');
const { pool } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { getPagination } = require('../../services/pagination');
const { getErrorDetail } = require('../../services/async-utils');

const router = express.Router();
router.get('/email/recipients', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { type = 'all' } = req.query;
    let whereClause = '1=1';

    if (type === 'active') {
      whereClause += ' AND last_login_at > DATE_SUB(NOW(), INTERVAL 30 DAY)';
    } else if (type === 'role_user') {
      whereClause += ' AND role = "user"';
    } else if (type === 'role_reviewer') {
      whereClause += ' AND role = "reviewer"';
    } else if (type === 'role_radio_admin') {
      whereClause += ' AND role = "radio_admin"';
    } else if (type === 'role_admin') {
      whereClause += ' AND role = "admin"';
    } else if (type === 'role_super_admin') {
      whereClause += ' AND role = "super_admin"';
    }

    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM users WHERE ${whereClause}`
    );
    const [emailCount] = await pool.execute(
      `SELECT COUNT(*) as total FROM users WHERE ${whereClause} AND email IS NOT NULL AND email != ""`
    );

    res.json({ code: 200, data: { count: countResult[0].total, emailCount: emailCount[0].total } });
  } catch (err) {
    console.error('获取收件人数量错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/email/send-batch', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { subject, content, link, recipientType = 'all' } = req.body;

    if (!subject || !content) {
      return res.json({ code: 400, message: '标题和内容不能为空' });
    }

    let whereClause = 'email IS NOT NULL AND email != ""';
    if (recipientType === 'active') {
      whereClause += ' AND last_login_at > DATE_SUB(NOW(), INTERVAL 30 DAY)';
    } else if (recipientType === 'role_user') {
      whereClause += ' AND role = "user"';
    } else if (recipientType === 'role_reviewer') {
      whereClause += ' AND role = "reviewer"';
    } else if (recipientType === 'role_radio_admin') {
      whereClause += ' AND role = "radio_admin"';
    } else if (recipientType === 'role_admin') {
      whereClause += ' AND role = "admin"';
    } else if (recipientType === 'role_super_admin') {
      whereClause += ' AND role = "super_admin"';
    }

    const [users] = await pool.execute(
      `SELECT id, email, nickname, username FROM users WHERE ${whereClause}`
    );

    if (users.length === 0) {
      return res.json({ code: 400, message: '没有符合条件的收件人' });
    }

    const { sendEmail } = require('../../services/email');
    const siteUrl = process.env.SITE_URL || 'https://campus.example.com';

    const emailHtml = `
      <p style="font-size:15px;color:#4A3F5C;margin:0 0 16px;line-height:1.8;">
        亲爱的同学：
      </p>
      <div style="font-size:14px;color:#4A3F5C;line-height:1.8;white-space:pre-wrap;">${content}</div>
      <p style="font-size:14px;color:#B8A9D4;margin:16px 0 0;"> 来自 校园墙 的温馨提醒</p>
    `;

    const { kawaiiLayout } = require('../../services/email');
    const fullHtml = kawaiiLayout(subject, emailHtml, link || siteUrl);

    const [historyInsertResult] = await pool.execute(
      'INSERT INTO email_batch_history (admin_id, subject, content, recipient_type, total_count, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, subject, content, recipientType, users.length, 'sending']
    );
    const historyId = historyInsertResult.insertId;

    let successCount = 0;
    let failCount = 0;
    const logs = [];

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const userEmail = user.email;
      try {
        const success = await sendEmail(userEmail, subject, fullHtml);
        if (success) {
          successCount++;
          logs.push({ email: userEmail, status: 'success' });
        } else {
          failCount++;
          logs.push({ email: userEmail, status: 'fail' });
        }
      } catch (err) {
        failCount++;
        logs.push({ email: userEmail, status: 'fail', error: err.message });
      }

      if ((i + 1) % 10 === 0 || i === users.length - 1) {
        await pool.execute(
          'UPDATE email_batch_history SET sent_count = ?, fail_count = ?, logs = ? WHERE id = ?',
          [successCount, failCount, JSON.stringify(logs), historyId]
        );
      }
    }

    const finalStatus = failCount === 0 ? 'success' : (successCount > 0 ? 'partial' : 'fail');
    await pool.execute(
      'UPDATE email_batch_history SET status = ?, sent_count = ?, fail_count = ?, logs = ?, finished_at = NOW() WHERE id = ?',
      [finalStatus, successCount, failCount, JSON.stringify(logs), historyId]
    );

    res.json({
      code: 200,
      message: '发送完成',
      data: {
        historyId,
        total: users.length,
        success: successCount,
        fail: failCount,
        status: finalStatus
      }
    });
  } catch (err) {
    console.error('邮件群发错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/email/history', requirePermission('notices:manage'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query, { defaultLimit: 20, maxLimit: 100 });

    const [history] = await pool.execute(
      `SELECT h.*, u.nickname as admin_nickname
       FROM email_batch_history h
       LEFT JOIN users u ON h.admin_id = u.id
       ORDER BY h.created_at DESC
       LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );

    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM email_batch_history');

    res.json({
      code: 200,
      data: {
        history,
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (err) {
    console.error('获取发送历史错误:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/wechat/users', requirePermission('wechat:review'), async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT DISTINCT u.id, u.username, u.nickname, u.role, u.openid, ' +
      'MAX(wb.bound_at) as bound_at ' +
      'FROM users u ' +
      'LEFT JOIN wechat_bindings wb ON u.id = wb.user_id AND wb.used = 1 ' +
      'WHERE u.openid IS NOT NULL ' +
      'GROUP BY u.id ' +
      'ORDER BY bound_at DESC'
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    console.error('[Admin] 获取微信用户失败:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/wechat/test-message', requirePermission('wechat:review'), async (req, res) => {
  try {
    var { openid, user_id } = req.body;
    if (!openid) {
      return res.json({ code: 400, message: '缺少openid' });
    }

    var wechatService = require('../../services/wechat');
    var token;
    try {
      token = await wechatService.getAccessToken();
    } catch (e) {
      return res.json({ code: 500, message: '获取AccessToken失败: ' + e.message + '，请检查WECHAT_SECRET配置' });
    }

    var postData = JSON.stringify({
      touser: openid,
      msgtype: 'text',
      text: {
        content: '🔔 校园墙 - 测试消息'
      }
    });

    var result = await new Promise((resolve, reject) => {
      var https = require('https');
      var url = 'https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=' + token;
      var urlObj = new URL(url);
      var options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      };
      var reqHttps = https.request(options, function(response) {
        var body = '';
        response.on('data', function(chunk) { body += chunk; });
        response.on('end', function() {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });
      reqHttps.on('error', reject);
      reqHttps.write(postData);
      reqHttps.end();
    });

    if (result && result.errcode === 0) {
      res.json({ code: 200, message: '✅ 消息推送成功！' });
    } else {
      var errMsg = result?.errmsg || '';
      if (errMsg.indexOf('unauthorized') !== -1) {
        res.json({
          code: 200,
          message: '✅ AccessToken获取成功，openid: ' + openid + '\n（订阅号不支持主动推送消息，需用户在公众号发消息后48小时内才能回复）'
        });
      } else {
        res.json({ code: 500, message: '发送失败: ' + errMsg });
      }
    }
  } catch (err) {
    console.error('[Admin] 测试消息推送错误:', err.message);
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/email-logs', requirePermission('notices:manage'), async (req, res) => {
  try {
    var emailPagination = getPagination({ page: req.query.page, limit: req.query.pageSize }, { defaultLimit: 30, maxLimit: 100 });
    var page = emailPagination.page;
    var ps = emailPagination.limit;
    var off = emailPagination.offset;
    await pool.execute("CREATE TABLE IF NOT EXISTS email_logs (id INT AUTO_INCREMENT PRIMARY KEY,to_email VARCHAR(255) NOT NULL,subject VARCHAR(500) NOT NULL,type VARCHAR(50) DEFAULT '',content_preview VARCHAR(500) DEFAULT '',status ENUM('success','fail') DEFAULT 'success',error_msg VARCHAR(500) DEFAULT '',target_user_name VARCHAR(100) DEFAULT '',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_created (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    var [rows] = await pool.execute("SELECT id,to_email,subject,type,content_preview,status,error_msg,target_user_name,created_at FROM email_logs ORDER BY created_at DESC LIMIT ? OFFSET ?", [ps, off]);
    var [cnt] = await pool.execute("SELECT COUNT(*) as t FROM email_logs");
    res.json({ code: 200, data: { logs: rows, total: cnt[0].t, page: page, pageSize: ps } });
  } catch(e) { res.json({ code: 200, data: { logs: [], total: 0 } }); }
});

router.delete('/email-logs/old', requirePermission('notices:manage'), async (req, res) => {
  try {
    var days = parseInt(req.query.days) || 30;
    var [result] = await pool.execute(
      'DELETE FROM email_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    res.json({ code: 200, message: '已删除 ' + days + ' 天前的邮件记录', data: { deleted: result.affectedRows } });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/email-logs/all', requirePermission('notices:manage'), async (req, res) => {
  try {
    var [result] = await pool.execute('DELETE FROM email_logs');
    res.json({ code: 200, message: '已清空所有邮件记录', data: { deleted: result.affectedRows } });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.delete('/email-logs/:id', requirePermission('notices:manage'), async (req, res) => {
  try {
    var logId = parseInt(req.params.id);
    if (isNaN(logId)) {
      return res.json({ code: 400, message: '无效的日志ID' });
    }
    var [result] = await pool.execute('DELETE FROM email_logs WHERE id = ?', [logId]);
    if (result.affectedRows === 0) {
      return res.json({ code: 404, message: '日志不存在' });
    }
    res.json({ code: 200, message: '删除成功' });
  } catch(e) {
    res.json({ code: 500, message: '服务器错误' });
  }
});


module.exports = router;
