const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const replyService = require('../services/wechat-reply');

const router = express.Router();

const WECHAT_TOKEN = process.env.WECHAT_TOKEN || '';
const WECHAT_ENCODING_AES_KEY = process.env.WECHAT_ENCODING_AES_KEY || '';
const WECHAT_APPID = process.env.WECHAT_APPID || '';
const WECHAT_SIGNATURE_TTL_SECONDS = Math.max(60, Number(process.env.WECHAT_SIGNATURE_TTL_SECONDS) || 300);
const WECHAT_BODY_LIMIT_BYTES = Math.max(16 * 1024, Number(process.env.WECHAT_BODY_LIMIT_BYTES) || 256 * 1024);

var processingLock = new Map();
const MESSAGE_REPLY_CACHE_TTL_MS = 5 * 60 * 1000;
const MESSAGE_REPLY_CACHE_LIMIT = 1000;

function timingSafeEqualText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function isFreshTimestamp(timestamp) {
  var value = Number(timestamp);
  return Number.isFinite(value) && Math.abs(Date.now() / 1000 - value) <= WECHAT_SIGNATURE_TTL_SECONDS;
}

function verifySignature(parts, signature) {
  if (!WECHAT_TOKEN || !signature || !isFreshTimestamp(parts[1])) return false;
  var expected = crypto.createHash('sha1').update(parts.slice().sort().join('')).digest('hex');
  return timingSafeEqualText(expected, String(signature).toLowerCase());
}

function rejectIfMisconfigured(res, encrypted) {
  if (!WECHAT_TOKEN || (encrypted && !WECHAT_ENCODING_AES_KEY)) {
    res.status(503).send('wechat not configured');
    return true;
  }
  return false;
}

function decryptMessage(encryptMsg, encodingAESKey) {
  try {
    var keyBuffer = Buffer.from(encodingAESKey + '=', 'base64');
    var encryptedBuffer = Buffer.from(encryptMsg, 'base64');
    var iv = keyBuffer.slice(0, 16);
    var decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, iv);
    var decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
    var content = decrypted.toString('utf8');
    var xmlLen = parseInt(content.substring(16, 20));
    return content.substring(20, 20 + xmlLen);
  } catch (err) {
    console.error('[WeChat] 消息解密失败:', err.message);
    throw err;
  }
}

function encryptMessage(xmlContent, appId, encodingAESKey) {
  try {
    var randomStr = Math.random().toString(36).substring(2, 18);
    var content = randomStr + String(xmlContent.length).padStart(16, '0') + xmlContent + appId;
    var keyBuffer = Buffer.from(encodingAESKey + '=', 'base64');
    var iv = keyBuffer.slice(0, 16);
    var cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
    var encrypted = Buffer.concat([cipher.update(Buffer.from(content, 'utf8')), cipher.final()]);
    return encrypted.toString('base64');
  } catch (err) {
    console.error('[WeChat] 消息加密失败:', err.message);
    throw err;
  }
}

function extractXML(xml, tag) {
  var match = xml.match(new RegExp('<' + tag + '><!\\[CDATA\\[(.*?)\\]\\]><\\/' + tag + '>'));
  return match ? match[1] : '';
}

router.get('/callback', (req, res) => {
  var signature = req.query.signature;
  var timestamp = req.query.timestamp;
  var nonce = req.query.nonce;
  var echostr = req.query.echostr;
  var msgSignature = req.query.msg_signature;

  if (rejectIfMisconfigured(res, Boolean(msgSignature))) return;

  if (msgSignature) {
    if (!verifySignature([WECHAT_TOKEN, timestamp, nonce, echostr], msgSignature)) return res.status(200).send('signature verify fail');
    try {
      res.status(200).send(decryptMessage(echostr, WECHAT_ENCODING_AES_KEY));
    } catch (err) {
      res.status(200).send('decrypt fail');
    }
  } else {
    res.status(200).send(verifySignature([WECHAT_TOKEN, timestamp, nonce], signature) ? echostr : 'signature error');
  }
});

router.post('/callback', async (req, res) => {
  var signature = req.query.signature;
  var timestamp = req.query.timestamp;
  var nonce = req.query.nonce;
  var msgSignature = req.query.msg_signature;

  if (rejectIfMisconfigured(res, Boolean(msgSignature))) return;

  if (!verifySignature([WECHAT_TOKEN, timestamp, nonce], signature)) return res.send('signature error');

  var body = '';
  var bodyBytes = 0;
  var bodyTooLarge = false;
  req.on('data', function(chunk) {
    if (bodyTooLarge) return;
    bodyBytes += chunk.length;
    if (bodyBytes > WECHAT_BODY_LIMIT_BYTES) {
      bodyTooLarge = true;
      res.status(413).send('payload too large');
      req.destroy();
      return;
    }
    body += chunk.toString('utf8');
  });
  req.on('end', async function() {
    if (bodyTooLarge) return;
    try {
      var xmlContent = body;

      if (msgSignature) {
        var encryptMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
        if (!encryptMatch) return res.send('');
        var encryptMsg = encryptMatch[1];
        if (!verifySignature([WECHAT_TOKEN, timestamp, nonce, encryptMsg], msgSignature)) return res.send('');
        xmlContent = decryptMessage(encryptMsg, WECHAT_ENCODING_AES_KEY);
      }

      var openid = extractXML(xmlContent, 'FromUserName');
      var accountId = extractXML(xmlContent, 'ToUserName');
      var event = extractXML(xmlContent, 'Event');
      var eventKey = extractXML(xmlContent, 'EventKey');
      var msgType = extractXML(xmlContent, 'MsgType');
      var msgContent = extractXML(xmlContent, 'Content');
      var mediaId = extractXML(xmlContent, 'MediaId');
      var msgId = extractXML(xmlContent, 'MsgId');

      if (!openid) return res.send('');

      var replyXml = '';

      if (event) {
        if (event === 'subscribe') {
          var result = replyService.handleEventSubscribe(openid, accountId, eventKey);
          if (result.sceneId) {
            try {
              var [bindings] = await pool.execute(
                'SELECT user_id FROM wechat_bindings WHERE scene_id = ? AND used = 0 LIMIT 1',
                [result.sceneId]
              );
              if (bindings.length > 0) {
                await pool.execute('UPDATE wechat_bindings SET openid = ?, used = 1, bound_at = NOW() WHERE scene_id = ?', [openid, result.sceneId]);
                await pool.execute('UPDATE users SET openid = ? WHERE id = ?', [openid, bindings[0].user_id]);
              }
            } catch(e) { console.error('[WeChat] 扫码关注绑定失败:', e.message); }
          }
          try {
            await pool.execute('INSERT INTO wechat_pending_follows (openid, created_at) VALUES (?, NOW())', [openid]);
            await pool.execute('DELETE FROM wechat_pending_follows WHERE created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)');
          } catch(e) {}
          replyXml = replyService.buildTextReply(openid, accountId, result.replyText);
        } else if (event === 'unsubscribe') {
          replyService.handleEventUnsubscribe(openid);
          replyXml = '';
        } else if (event === 'SCAN') {
          var sceneId = eventKey;
          try {
            var [bindings] = await pool.execute(
              'SELECT user_id FROM wechat_bindings WHERE scene_id = ? AND used = 0 LIMIT 1',
              [sceneId]
            );
            if (bindings.length > 0) {
              await pool.execute('UPDATE wechat_bindings SET openid = ?, used = 1, bound_at = NOW() WHERE scene_id = ?', [openid, sceneId]);
              await pool.execute('UPDATE users SET openid = ? WHERE id = ?', [openid, bindings[0].user_id]);
            }
          } catch(e) {}
        }
        return res.send(replyXml);
      }

      if (msgType === 'text' && msgContent) {
        var requestKey = openid + '_' + (msgId || msgContent);
        var cached = processingLock.get(requestKey);
        if (cached) {
          if (cached.replyXml !== undefined && cached.expiresAt > Date.now()) return res.send(cached.replyXml);
          if (cached.promise) return res.send(await cached.promise);
          processingLock.delete(requestKey);
        }

        var replyPromise = replyService.handleText(openid, accountId, msgContent);
        processingLock.set(requestKey, { promise: replyPromise });
        try {
          replyXml = await replyPromise;
        } catch (err) {
          processingLock.delete(requestKey);
          throw err;
        }
        processingLock.set(requestKey, {
          replyXml: replyXml,
          expiresAt: Date.now() + (msgId ? MESSAGE_REPLY_CACHE_TTL_MS : 3000)
        });
        setTimeout(function() {
          var current = processingLock.get(requestKey);
          if (current && current.replyXml === replyXml) processingLock.delete(requestKey);
        }, msgId ? MESSAGE_REPLY_CACHE_TTL_MS : 3000);
        while (processingLock.size > MESSAGE_REPLY_CACHE_LIMIT) {
          processingLock.delete(processingLock.keys().next().value);
        }
        return res.send(replyXml);
      }

      if (msgType === 'image') {
        replyXml = await replyService.handleImage(openid, accountId, mediaId);
        return res.send(replyXml);
      }

      if (msgType === 'voice') {
        replyXml = replyService.handleVoice(openid, accountId);
      } else if (msgType === 'location') {
        replyXml = replyService.handleLocation(openid, accountId);
      } else if (msgType === 'link') {
        replyXml = replyService.handleLink(openid, accountId);
      }

      res.send(replyXml || '');
    } catch (err) {
      console.error('[WeChat] 处理消息失败:', err.message);
      res.send('');
    }
  });
});

router.get('/status', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    if (!token) return res.json({ code: 401, message: '未登录' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET || require('../config/jwt-secret'));
    var [users] = await pool.execute('SELECT openid FROM users WHERE id = ?', [decoded.id]);
    res.json({ code: 200, data: { bound: !!users[0]?.openid } });
  } catch (err) {
    res.json({ code: 401, message: '登录已过期' });
  }
});

router.post('/generate-bind', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ code: 401, message: '未登录' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET || require('../config/jwt-secret'));
    var userId = decoded.id;
    var [users] = await pool.execute('SELECT openid FROM users WHERE id = ?', [userId]);
    if (users[0]?.openid) return res.json({ code: 200, message: '已绑定', data: { bound: true } });

    var bindCode = 'BIND' + Math.random().toString(36).substring(2, 6).toUpperCase();
    var sceneId = 'bind_' + userId + '_' + Date.now();
    await pool.execute(
      'INSERT INTO wechat_bindings (user_id, scene_id, bind_code, created_at) VALUES (?, ?, ?, NOW())',
      [userId, sceneId, bindCode]
    );
    var wechatService = require('../services/wechat');
    res.json({ code: 200, data: { qrCodeUrl: wechatService.generateQRCode(), sceneId: sceneId, bindCode: bindCode } });
  } catch (err) {
    console.error('[WeChat] 生成绑定验证码失败:', err.message);
    res.json({ code: 500, message: '生成失败' });
  }
});

router.post('/unbind', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ code: 401, message: '未登录' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET || require('../config/jwt-secret'));
    await pool.execute('UPDATE users SET openid = NULL WHERE id = ?', [decoded.id]);
    res.json({ code: 200, message: '已解绑' });
  } catch (err) {
    res.json({ code: 500, message: '解绑失败' });
  }
});

router.post('/verify-follow', async (req, res) => {
  try {
    var token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.json({ code: 401, message: '未登录' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET || require('../config/jwt-secret'));
    var [users] = await pool.execute('SELECT openid FROM users WHERE id = ?', [decoded.id]);
    res.json({ code: 200, message: users[0]?.openid ? '已绑定' : '未绑定', bound: !!users[0]?.openid });
  } catch (err) {
    res.json({ code: 500, message: '查询失败' });
  }
});

module.exports = router;
