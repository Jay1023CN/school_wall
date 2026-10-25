const express = require('express');
const { pool } = require('../../config/database');
const { requirePermission } = require('../../middleware/auth');
const { normalizeSongRejectReasons } = require('../../services/song-reject-reasons');
const { invalidateEmailTransporterCache } = require('../../services/email');
const { withTimeout, getErrorDetail } = require('../../services/async-utils');
const { rollbackOrDiscard, releaseConnection } = require('../../services/database-transaction');
const siteRouter = require('../site');

const TEST_EMAIL_TIMEOUT_MS = 20000;
const router = express.Router();
router.get('/settings', requirePermission('settings:view'), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT config_key, config_value FROM settings');
    const settings = {};
    rows.forEach(row => {
      settings[row.config_key] = row.config_value;
    });
    res.json({
      code: 200,
      data: {
        site_name: settings.site_name || '',
        site_description: settings.site_description || '',
        allow_register: settings.allow_register === 'true',
        post_review: settings.post_review === 'true',
        song_enabled: settings.song_enabled === 'true',
        daily_song_limit: parseInt(settings.daily_song_limit) || 3,
        anon_post: settings.anon_post === 'true',
        anon_comment: settings.anon_comment === 'true',
        anon_song: settings.anon_song === 'true',
        email_enabled: settings.email_enabled === 'true',
        register_email_verify_enabled: settings.register_email_verify_enabled === 'true',
        smtp_host: settings.smtp_host || '',
        smtp_port: settings.smtp_port || '587',
        smtp_user: settings.smtp_user || '',
        smtp_pass_configured: Boolean(String(settings.smtp_pass || '').trim()),
        smtp_from: settings.smtp_from || '',
        festival_theme: Object.prototype.hasOwnProperty.call(settings, 'festival_theme')
          ? (settings.festival_theme === '520' ? '520' : 'teachers_day')
          : (settings.special_mode_520 === 'true' ? '520' : 'teachers_day'),
        festival_enabled: Object.prototype.hasOwnProperty.call(settings, 'festival_enabled')
          ? settings.festival_enabled === 'true'
          : settings.special_mode_520 === 'true',
        song_pending_admin_notify: !['false', '0', 'off'].includes(String(settings.song_pending_admin_notify || 'true').toLowerCase()),
        song_reject_reasons: normalizeSongRejectReasons(settings.song_reject_reasons),
        special_mode_520: settings.special_mode_520 === 'true'
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/settings', requirePermission('settings:view'), async (req, res) => {
  try {
    const { site_name, site_description, allow_register, post_review, song_enabled, daily_song_limit, anon_post, anon_comment, anon_song, email_enabled, register_email_verify_enabled, song_pending_admin_notify, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_pass_clear, smtp_from, festival_theme, festival_enabled, song_reject_reasons } = req.body;
    const enabled = value => value === true || value === 1 || value === '1' || value === 'true';

    const keys = [
      ['site_name', site_name || ''],
      ['site_description', site_description || ''],
      ['allow_register', allow_register !== undefined ? String(Boolean(allow_register)) : 'true'],
      ['post_review', post_review !== undefined ? String(Boolean(post_review)) : 'false'],
      ['song_enabled', song_enabled !== undefined ? String(Boolean(song_enabled)) : 'true'],
      ['daily_song_limit', daily_song_limit !== undefined ? String(Math.max(1, parseInt(daily_song_limit) || 3)) : '3'],
      ...(anon_post !== undefined ? [['anon_post', String(enabled(anon_post))]] : []),
      ...(anon_comment !== undefined ? [['anon_comment', String(enabled(anon_comment))]] : []),
      ...(anon_song !== undefined ? [['anon_song', String(enabled(anon_song))]] : []),
      ['email_enabled', email_enabled !== undefined ? String(Boolean(email_enabled)) : 'false'],
      ['register_email_verify_enabled', register_email_verify_enabled !== undefined ? String(Boolean(register_email_verify_enabled)) : 'false'],
      ['song_pending_admin_notify', song_pending_admin_notify !== undefined ? String(Boolean(song_pending_admin_notify)) : 'true'],
      ['smtp_host', smtp_host || ''],
      ['smtp_port', smtp_port || '587'],
      ['smtp_user', smtp_user || ''],
      ['smtp_from', smtp_from || ''],
      ['festival_theme', festival_theme === '520' ? '520' : 'teachers_day'],
      ['festival_enabled', festival_enabled !== undefined ? String(Boolean(festival_enabled)) : 'false']
    ];
    const nextSmtpPass = typeof smtp_pass === 'string' ? smtp_pass.trim() : '';
    if (nextSmtpPass || smtp_pass_clear === true) {
      keys.push(['smtp_pass', smtp_pass_clear === true ? '' : nextSmtpPass]);
    }
    if (song_reject_reasons !== undefined) {
      keys.push(['song_reject_reasons', JSON.stringify(normalizeSongRejectReasons(song_reject_reasons))]);
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const [key, value] of keys) {
        await connection.execute(
          'INSERT INTO settings (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
          [key, value, value]
        );
      }
      await connection.commit();
    } catch (dbErr) {
      await rollbackOrDiscard(connection, dbErr);
      throw dbErr;
    } finally {
      releaseConnection(connection);
    }
    if (typeof siteRouter.invalidateSiteInfoCache === 'function') {
      siteRouter.invalidateSiteInfoCache();
    }
    invalidateEmailTransporterCache();

    res.json({ code: 200, message: '保存成功' });
  } catch (err) {
    console.error('[ERROR] 保存设置失败:', getErrorDetail(err));
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.put('/settings/song-reject-reasons', requirePermission('settings:view'), async (req, res) => {
  try {
    const reasons = normalizeSongRejectReasons(req.body && req.body.reasons);
    await pool.execute(
      'INSERT INTO settings (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
      ['song_reject_reasons', JSON.stringify(reasons), JSON.stringify(reasons)]
    );
    res.json({ code: 200, message: '点歌拒绝理由预设已保存', data: { song_reject_reasons: reasons } });
  } catch (err) {
    console.error('[Settings] 保存点歌拒绝理由失败:', err.message);
    res.json({ code: 500, message: '保存点歌拒绝理由失败' });
  }
});

router.post('/test-email', requirePermission('settings:view'), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.json({ code: 400, message: '请提供测试邮箱地址' });
    }
    const { sendEmail } = require('../../services/email');
    let success;
    try {
      success = await withTimeout(sendEmail(email, '🧪 测试邮件 · 校园墙', `
      <div style="text-align:center;padding:20px;font-family:sans-serif;">
        <div style="font-size:48px;margin-bottom:16px;">✉️</div>
        <h2 style="color:#FF6B9D;">邮件配置正确！</h2>
        <p style="color:#4A3F5C;font-size:15px;line-height:1.7;">🎉 恭喜，你的SMTP配置已经生效啦~<br>以后用户就能收到评论、点赞、关注等邮件通知了 ✨</p>
        <div style="margin-top:20px;padding:16px;background:#F8F5FF;border-radius:12px;font-size:13px;color:#B8A9D4;">💌 校园墙 — 让每一份心意都被看见</div>
      </div>
      `), TEST_EMAIL_TIMEOUT_MS, '测试邮件发送超时');
    } catch (err) {
      if (err && err.message === '测试邮件发送超时') {
        console.warn('[Email] 测试邮件发送超时');
        return res.status(504).json({ code: 504, message: 'SMTP连接或发送超时，请检查主机、端口和服务商限制' });
      }
      throw err;
    }
    if (success) {
      res.json({ code: 200, message: '测试邮件发送成功' });
    } else {
      res.json({ code: 500, message: '邮件发送失败，请检查SMTP配置' });
    }
  } catch (err) {
    console.error('[Email] 测试邮件发送失败:', getErrorDetail(err));
    res.json({ code: 500, message: '邮件发送失败，请检查配置后重试' });
  }
});



module.exports = router;
