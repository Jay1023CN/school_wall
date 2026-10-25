const mpDraftService = require('./mp-draft');
const { escapeHtml } = require('./html-utils');

const SITE_URL = 'https://campus.example.com';

async function uploadStoryImages(htmlContent) {
  var imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
  var match;
  var tasks = [];
  while ((match = imgRegex.exec(htmlContent)) !== null) {
    var originalSrc = match[1];
    if (originalSrc.indexOf('mmbiz.qpic.cn') >= 0 || originalSrc.indexOf('mmbiz.qlogo.cn') >= 0 || originalSrc.startsWith('data:')) continue;
    var uploadUrl = originalSrc.startsWith('/') ? SITE_URL + originalSrc : originalSrc;
    tasks.push({ original: originalSrc, upload: uploadUrl });
  }
  if (tasks.length === 0) return htmlContent;
  for (var i = 0; i < tasks.length; i++) {
    try {
      var weixinUrl = await mpDraftService.uploadMpImage(tasks[i].upload);
      if (weixinUrl) htmlContent = htmlContent.split(tasks[i].original).join(weixinUrl);
    } catch (e) { console.warn('[故事推送] 图片上传失败:', e.message); }
  }
  return htmlContent;
}

async function buildStoryArticle({ chapterIndex, novelTitle, index, chapter, dateInfo, weather, hitokoto }) {
  var chapNum = chapterIndex + 1;
  var chapTotal = index.length;
  var today = dateInfo.date;
  var week = dateInfo.week;
  var paragraphs = (chapter.content || '').replace(/\r\n/g, '\n').split(/\n\n+/);

  var storyHtml = '';
  storyHtml += '<div style="padding:6px 0;">';

  storyHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:22px 16px 18px;text-align:center;">';
  storyHtml += '<div style="color:#A78BFA;font-size:13px;margin-bottom:6px;letter-spacing:2px;">📖 校园小说连载 · 第' + chapNum + '/' + chapTotal + '章</div>';
  storyHtml += '<div style="color:#FF69B4;font-size:22px;font-weight:bold;letter-spacing:1px;">第' + chapNum + '章 ' + escapeHtml(chapter.title) + '</div>';
  storyHtml += '<div style="color:#bbb;font-size:12px;margin-top:8px;">' + today + ' ' + week + ' · ' + escapeHtml(chapter.author || '匿名投稿') + '</div>';
  storyHtml += '<div style="width:40px;height:3px;background:linear-gradient(90deg,#FFB6C1,#A78BFA);margin:14px auto 0;"></div>';
  storyHtml += '</td></tr></table>';

  var totalChars = (chapter.content || '').replace(/\s/g, '').length;
  var readMinutes = Math.max(1, Math.ceil(totalChars / 300));
  storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFFFF0;padding:12px;border-radius:10px;">';
  storyHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
  storyHtml += '<td style="text-align:center;width:33%;padding:4px;border-right:1px dashed #E8D5B5;">';
  storyHtml += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">📝 全文字数</div>';
  storyHtml += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">' + totalChars.toLocaleString() + ' 字</div>';
  storyHtml += '</td>';
  storyHtml += '<td style="text-align:center;width:33%;padding:4px;border-right:1px dashed #E8D5B5;">';
  storyHtml += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">⏱ 阅读时长</div>';
  storyHtml += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">约 ' + readMinutes + ' 分钟</div>';
  storyHtml += '</td>';
  storyHtml += '<td style="text-align:center;width:33%;padding:4px;">';
  storyHtml += '<div style="font-size:11px;color:#bbb;margin-bottom:2px;">📚 连载进度</div>';
  storyHtml += '<div style="font-size:16px;font-weight:bold;color:#D4876A;">第' + chapNum + '/' + chapTotal + '章</div>';
  storyHtml += '</td>';
  storyHtml += '</tr></table></td></tr></table>';

  if (weather && weather.temperature) {
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:linear-gradient(135deg,#E8F4FD,#E0F0FF);padding:16px;">';
    storyHtml += '<div style="font-size:13px;color:#888;margin-bottom:10px;font-weight:500;">🌤️ ' + (weather.city || '') + ' 天气预报</div>';
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0"><tr>';
    storyHtml += '<td style="width:50%;text-align:center;padding:4px;border-right:1px dashed #B0D4F1;">';
    storyHtml += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">今日</div>';
    storyHtml += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.icon || '🌤') + ' ' + (weather.temperature || '') + '</div>';
    storyHtml += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.weather || '') + '</div>';
    storyHtml += '<div style="font-size:11px;color:#999;margin-top:4px;">💨 ' + (weather.wind || '') + ' 💧 ' + (weather.humidity || '') + '</div>';
    storyHtml += '</td>';
    if (weather.tomorrow) {
      storyHtml += '<td style="width:50%;text-align:center;padding:4px;">';
      storyHtml += '<div style="font-size:11px;color:#aaa;margin-bottom:4px;">' + (weather.tomorrow.week || '周五') + '</div>';
      storyHtml += '<div style="font-size:20px;font-weight:bold;color:#4A90D9;">' + (weather.tomorrow.icon || '☀️') + ' ' + (weather.tomorrow.tempRange || '') + '</div>';
      storyHtml += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (weather.tomorrow.weather || '') + '</div>';
      storyHtml += '<div style="font-size:11px;color:#999;margin-top:4px;">📍 预报</div>';
      storyHtml += '</td>';
    } else {
      storyHtml += '<td style="width:50%;text-align:center;padding:4px;color:#ccc;font-size:13px;">🌤️ 暂无预报</td>';
    }
    storyHtml += '</tr></table></td></tr></table>';
  }

  if (hitokoto && hitokoto.text) {
    storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF9F5;padding:16px;border-left:3px solid #A78BFA;">';
    storyHtml += '<p style="font-size:14px;color:#888;margin:0 0 6px 0;line-height:1.8;font-style:italic;">💬 "' + escapeHtml(hitokoto.text) + '"</p>';
    storyHtml += '<p style="text-align:right;color:#ccc;font-size:12px;margin:0;">—— ' + escapeHtml(hitokoto.from_who || hitokoto.from || '') + '</p></td></tr></table>';
  }

  storyHtml += '<div style="text-align:center;margin:18px 0;color:#e8e8e8;font-size:14px;">❀&nbsp;&nbsp;❁&nbsp;&nbsp;❀</div>';

  storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr><td style="background:#FFFBFF;padding:20px 16px;">';
  storyHtml += '<div style="text-align:center;margin-bottom:20px;">';
  storyHtml += '<div style="display:inline-block;background:linear-gradient(135deg,#FFF0F5,#F8F0FF);padding:6px 20px;border-radius:20px;font-size:12px;color:#A78BFA;letter-spacing:1px;">第' + chapNum + '章</div>';
  storyHtml += '</div>';
  for (var pi = 0; pi < paragraphs.length; pi++) {
    var para = paragraphs[pi].trim();
    if (!para) continue;
    var isDialogue = para.includes('"') || para.includes('"') || para.includes('"');
    if (isDialogue) {
      storyHtml += '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#6B4C3B;margin-top:0;letter-spacing:0.5px;background:#FFFBF8;padding:8px 14px;border-radius:8px;border-left:3px solid #FFD4B8;">' + escapeHtml(para) + '</p>';
    } else {
      storyHtml += '<p style="text-indent:2em;line-height:2.1;margin-bottom:14px;font-size:15px;color:#444;margin-top:0;letter-spacing:0.5px;">' + escapeHtml(para) + '</p>';
    }
  }
  if (chapNum < chapTotal) {
    storyHtml += '<div style="text-align:center;margin:24px 0 10px 0;">';
    storyHtml += '<div style="display:inline-block;background:#FFF0F5;padding:8px 24px;border-radius:12px;font-size:13px;color:#FF69B4;">🌟 未完待续 · 同一时间见</div>';
    storyHtml += '</div>';
    storyHtml += '<div style="text-align:center;font-size:12px;color:#ccc;margin-top:6px;">📖 第' + (chapNum + 1) + '/' + chapTotal + '章 敬请期待</div>';
  }
  storyHtml += '</td></tr></table>';

  storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;"><tr><td style="background:#FFF8F0;padding:16px;border-radius:12px;">';
  storyHtml += '<div style="font-size:13px;color:#D4876A;line-height:1.8;text-align:center;">';
  storyHtml += '❤️ 校园故事持续征集中<br>';
  storyHtml += '校园助手准备了一篇暖心小说，希望你喜欢 ❤️<br><br>';
  storyHtml += '🎨 如果你也有故事，<strong style="color:#FF6B9D;">欢迎分享给身边的同学哦</strong><br>';
  storyHtml += '📮 想说的，去 <strong style="color:#FF6B9D;">https://campus.example.com</strong> 投稿吧！<br>';
  storyHtml += '你的每一个故事，都有可能成为下篇文章的主角 ❤️';
  storyHtml += '</div></td></tr></table>';

  storyHtml += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr><td style="background:linear-gradient(135deg,#FFF0F5,#FFE4E1);padding:24px 20px;text-align:center;border-radius:16px;">';
  storyHtml += '<div style="font-size:18px;color:#FF69B4;font-weight:bold;margin-bottom:6px;">🌸 校园故事站</div>';
  storyHtml += '<div style="font-size:13px;color:#DDA0DD;margin-bottom:16px;">扫码关注 · 分享身边的美好</div>';
  storyHtml += '<table align="center" style="margin:0 auto;"><tr><td style="background:linear-gradient(135deg,#FF69B4,#FFB6C1);padding:4px;border-radius:16px;">';
  storyHtml += '<table style="width:100%;background:#fff;border-radius:12px;"><tr><td style="padding:12px;">';
  storyHtml += '<img src="https://campus.example.com/images/gzh.png" style="width:200px;display:block;border-radius:6px;margin:0 auto;height:auto;" alt="校园墙二维码">';
  storyHtml += '</td></tr></table>';
  storyHtml += '</td></tr></table>';
  storyHtml += '<p style="color:#bbb;font-size:12px;margin:14px 0 4px 0;letter-spacing:1px;">📱 微信扫一扫 · 获取更多精彩</p>';
  storyHtml += '<p style="color:#FF69B4;font-size:13px;font-weight:bold;word-break:break-all;letter-spacing:0.5px;">https://campus.example.com</p>';
  storyHtml += '<div style="width:40px;height:2px;background:#FFB6C1;margin:12px auto 0;border-radius:2px;"></div>';
  storyHtml += '</td></tr></table>';
  storyHtml += '<p style="text-align:center;color:#ddd;font-size:12px;margin-top:18px;">❀ ' + dateInfo.year + ' 校园墙 ❀ ❀</p>';
  storyHtml += '</div>';

  storyHtml = await uploadStoryImages(storyHtml);

  var article = {
    title: '小说连载 · 第' + chapNum + '章 ' + chapter.title + ' | ' + dateInfo.date,
    author: 'EDITOR',
    digest: '小说连载 · ' + novelTitle + ' · ' + chapter.title + '。' + (chapter.content || '').replace(/[\n\r]+/g, '').substring(0, 60) + '...',
    content: storyHtml,
    content_source_url: 'https://campus.example.com',
    show_cover_pic: 1,
    need_open_comment: 1,
    only_fans_can_comment: 0
  };

  return article;
}

module.exports = { buildStoryArticle };
