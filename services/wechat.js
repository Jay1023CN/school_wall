
const https = require('https');
const crypto = require('crypto');
const { getAccessToken } = require('./wechat-token');

const WECHAT_APPID = process.env.WECHAT_APPID || '';
const WECHAT_SECRET = process.env.WECHAT_SECRET;
if (!WECHAT_SECRET) {
  throw new Error('[wechat] 缺少环境变量 WECHAT_SECRET，请检查 .env 配置');
}

require('./wechat-token');

function getQRCodeUrl(redirectUri, state) {
  return `https://open.weixin.qq.com/connect/qrconnect?appid=${WECHAT_APPID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`;
}

async function getOpenidByCode(code) {
  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}&code=${code}&grant_type=authorization_code`;
    https.get(url, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.openid) {
            resolve({ openid: json.openid, access_token: json.access_token });
          } else {
            reject(new Error('获取openid失败: ' + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function getUserInfo(openid) {
  try {
    var token = await getAccessToken();
    return new Promise((resolve, reject) => {
      const url = `https://api.weixin.qq.com/cgi-bin/user/info?access_token=${token}&openid=${openid}&lang=zh_CN`;
      https.get(url, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  } catch (e) {
    console.error('[WeChat] 获取用户信息失败:', e.message);
    return null;
  }
}

async function sendTemplateMessage(openid, templateId, data, url) {
  console.warn('[WeChat] 订阅号不支持模板消息功能');
  return false;
}

async function sendFollowPostNotify(openid, posterNickname, postTitle, postId) {
  var templateId = process.env.WECHAT_TEMPLATE_FOLLOW_POST || 'YOUR_TEMPLATE_ID';
  var data = {
    first: { value: `${posterNickname}发布了新帖子`, color: '#FF6B9D' },
    keyword1: { value: postTitle, color: '#4A3F5C' },
    keyword2: { value: '帖子', color: '#4A3F5C' },
    keyword3: { value: new Date().toLocaleString('zh-CN'), color: '#B8A9D4' },
    remark: { value: '点击查看TA的新帖子', color: '#C084FC' }
  };
  var url = `https://campus.example.com/post/${postId}`;
  return sendTemplateMessage(openid, templateId, data, url);
}

async function sendCommentNotify(openid, commenterNickname, postTitle, postId) {
  var templateId = process.env.WECHAT_TEMPLATE_COMMENT || 'YOUR_TEMPLATE_ID';
  var data = {
    first: { value: `有新的评论`, color: '#FF6B9D' },
    keyword1: { value: commenterNickname, color: '#C084FC' },
    keyword2: { value: postTitle, color: '#4A3F5C' },
    keyword3: { value: new Date().toLocaleString('zh-CN'), color: '#B8A9D4' },
    remark: { value: '点击查看评论内容', color: '#C084FC' }
  };
  var url = `https://campus.example.com/post/${postId}`;
  return sendTemplateMessage(openid, templateId, data, url);
}

async function sendSongPlayedNotify(openid, songName, artist) {
  var templateId = process.env.WECHAT_TEMPLATE_SONG || 'YOUR_TEMPLATE_ID';
  var data = {
    first: { value: '🎉 你的点歌被播放了！', color: '#FF6B9D' },
    keyword1: { value: songName, color: '#4A3F5C' },
    keyword2: { value: artist, color: '#4A3F5C' },
    keyword3: { value: new Date().toLocaleString('zh-CN'), color: '#B8A9D4' },
    remark: { value: '感谢你的参与，继续加油点歌哦~', color: '#C084FC' }
  };
  var url = 'https://campus.example.com/radio';
  return sendTemplateMessage(openid, templateId, data, url);
}

function generateQRCode() {
  console.warn('[WeChat] 订阅号不支持带参数二维码，使用固定公众号二维码');
  return '/images/gzh.png';
}

function downloadImageMedia(mediaId) {
  return getAccessToken().then(function(token) {
    return new Promise(function(resolve, reject) {
      var url = 'https://api.weixin.qq.com/cgi-bin/media/get?access_token=' + encodeURIComponent(token) + '&media_id=' + encodeURIComponent(mediaId);
      var req = https.get(url, function(res) {
        var chunks = [];
        var total = 0;
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('微信图片下载 HTTP' + res.statusCode));
        }
        res.on('data', function(chunk) {
          total += chunk.length;
          if (total > 10 * 1024 * 1024) {
            req.destroy();
            return reject(new Error('微信图片超过10MB限制'));
          }
          chunks.push(chunk);
        });
        res.on('end', function() {
          var contentType = String(res.headers['content-type'] || 'image/jpeg').split(';')[0].toLowerCase();
          if (contentType === 'application/json' || contentType === 'text/plain') {
            return reject(new Error('微信图片下载返回错误'));
          }
          resolve({
            base64: Buffer.concat(chunks).toString('base64'),
            contentType: contentType
          });
        });
      });
      req.setTimeout(15000, function() {
        req.destroy();
        reject(new Error('微信图片下载超时'));
      });
      req.on('error', reject);
    });
  });
}

module.exports = {
  getAccessToken,
  getQRCodeUrl,
  getOpenidByCode,
  getUserInfo,
  sendTemplateMessage,
  sendFollowPostNotify,
  sendCommentNotify,
  sendSongPlayedNotify,
  generateQRCode,
  downloadImageMedia
};
