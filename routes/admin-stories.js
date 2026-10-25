const express = require('express');
const { requirePermission } = require('../middleware/auth');
const storyStorage = require('../services/stories-storage');
const aiService = require('../services/ai');
const mpDraftService = require('../services/mp-draft');
const storyPublication = require('../services/story-publication');

const router = express.Router();
router.get('/novels', requirePermission('stories:review'), async (req, res) => {
  try {
    var list = storyStorage.getNovelList();
    var pubConfig = storyStorage.getPublicationConfig();
    res.json({ code: 200, data: { novels: list, activeNovelId: pubConfig.activeNovelId || 'default' } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/novels/create', requirePermission('stories:review'), async (req, res) => {
  try {
    var { title, author, desc } = req.body;
    if (!title) return res.json({ code: 400, message: '小说标题不能为空' });
    var list = storyStorage.getNovelList();
    var id = 'novel_' + Date.now();
    list.push({ id: id, title: title, author: author || '校园墙编辑部', desc: desc || '', createdAt: new Date().toISOString().substring(0, 10) });
    storyStorage.saveNovelList(list);
    storyStorage.ensureNovelDirectory(id);
    var pubConfig = storyStorage.getPublicationConfig();
    if (!pubConfig.novels) pubConfig.novels = {};
    pubConfig.novels[id] = { currentStoryIndex: 0, promptConfig: { novelTitle: title } };
    storyStorage.savePublicationConfig(pubConfig);
    res.json({ code: 200, data: { id: id }, message: '小说「' + title + '」创建成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/novels/delete', requirePermission('stories:review'), async (req, res) => {
  try {
    var { novelId } = req.body;
    var list = storyStorage.getNovelList();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === novelId) { idx = i; break; }
    }
    if (idx < 0) return res.json({ code: 400, message: '小说不存在' });
    if (list.length <= 1) return res.json({ code: 400, message: '至少保留一本小说' });
    storyStorage.deleteNovelDirectory(novelId);
    list.splice(idx, 1);
    storyStorage.saveNovelList(list);
    var pubConfig = storyStorage.getPublicationConfig();
    if (pubConfig.novels && pubConfig.novels[novelId]) {
      delete pubConfig.novels[novelId];
    }
    if (pubConfig.activeNovelId === novelId) {
      pubConfig.activeNovelId = list[0].id;
    }
    storyStorage.savePublicationConfig(pubConfig);
    res.json({ code: 200, message: '已删除' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/novels/set-active', requirePermission('stories:review'), async (req, res) => {
  try {
    var { novelId } = req.body;
    var novel = storyStorage.getNovelById(novelId);
    if (!novel) return res.json({ code: 400, message: '小说不存在' });
    var pubConfig = storyStorage.getPublicationConfig();
    pubConfig.activeNovelId = novelId;
    storyStorage.savePublicationConfig(pubConfig);
    res.json({ code: 200, message: '已切换到「' + novel.title + '」' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});


function getNovelId(req) {
  return req.query.novelId || req.body.novelId || '';
}

function buildChapterSummary(index, novelId, previewLength, formatLine) {
  var summaryLines = [];
  for (var chapterIndex = 0; chapterIndex < index.length; chapterIndex++) {
    var chapter = storyStorage.getChapter(chapterIndex, novelId);
    var preview = chapter ? (chapter.content || '').replace(/[\n\r]+/g, ' ').substring(0, previewLength) : '';
    summaryLines.push(formatLine(chapterIndex + 1, index[chapterIndex], preview));
  }
  return summaryLines.join('\n');
}

function buildAiChapterPrompt(config, novelTitle, nextChapterNumber, chapterSummary) {
  var prompt = '';
  prompt += '你是一位校园青春小说作家兼编辑，擅长描写青春期细腻的情感变化。请保持人物动机清楚、情绪真实克制、场景具体、前后设定一致，避免空泛抒情和重复表达。\n\n';
  prompt += '请写一篇校园青春小说的第' + nextChapterNumber + '章。\n';
  prompt += '小说标题：' + novelTitle + '\n\n';
  if (chapterSummary) {
    prompt += '已有章节梗概：\n' + chapterSummary + '\n\n';
  }
  prompt += '第' + nextChapterNumber + '章要求：\n';
  prompt += '- 字数：' + (config.wordCount || '800-1200字') + '\n';
  prompt += '- 风格：' + (config.style || '温暖治愈，校园青春') + '\n';
  prompt += '- ' + (config.sceneRequirement || '需要出现1-2个新的校园场景') + '\n';
  prompt += '- ' + (config.endingRequirement || '在章节末尾留下悬念或期待') + '\n';
  prompt += '- 标题自拟\n';
  prompt += '- 请注意使用中文引号「」或""表示对话\n';
  if (config.extraRequirements) {
    prompt += '- ' + config.extraRequirements + '\n';
  }
  prompt += '\n请直接输出章节正文，不要输出提纲、分析、思考过程、免责声明或“以下是”等套话。';
  return prompt;
}

function getAiChapterContext(novelId) {
  var index = storyStorage.getChapterIndex(novelId);
  var pubConfig = storyStorage.getPublicationConfig();
  var novelConfig = storyStorage.getNovelPublicationSettings(pubConfig, novelId);
  var config = novelConfig.promptConfig || {};
  var nextChapterNumber = index.length + 1;
  var chapterSummary = buildChapterSummary(index, novelId, 150, function(chapterNumber, chapter, preview) {
    return '第' + chapterNumber + '章《' + (chapter.title || '') + '》：' + preview + '...';
  });
  var novel = storyStorage.getNovelById(novelId);
  var novelTitle = config.novelTitle || (novel ? novel.title : '致那个夏天的你');
  return {
    nextChapterNumber: nextChapterNumber,
    prompt: buildAiChapterPrompt(config, novelTitle, nextChapterNumber, chapterSummary)
  };
}

function parseGeneratedChapter(generatedContent, chapterNumber) {
  var lines = generatedContent.split('\n');
  var title = '';
  var content = generatedContent;
  if (lines.length > 0) {
    var firstLine = lines[0].replace(/^#+\s*/, '').replace(/^第\d+章[：\s]*/, '').trim();
    if (firstLine.length > 0 && firstLine.length < 30) {
      title = firstLine;
      content = lines.slice(1).join('\n').trim();
    }
  }
  if (!title) title = '第' + chapterNumber + '章';
  return { title: title, content: content, chapterNum: chapterNumber };
}

router.get('/stories', requirePermission('stories:review'), async (req, res) => {
  try {
    var novelId = getNovelId(req) || storyStorage.getPublicationConfig().activeNovelId || 'default';
    var index = storyStorage.getChapterIndex(novelId);
    var pubConfig = storyStorage.getPublicationConfig();
    var novelCfg = storyStorage.getNovelPublicationSettings(pubConfig, novelId);
    res.json({
      code: 200,
      data: {
        stories: index,
        currentIndex: novelCfg.currentStoryIndex || 0,
        totalChapters: index.length,
        promptConfig: novelCfg.promptConfig || {}
      }
    });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/stories/chapter-content', requirePermission('stories:review'), async (req, res) => {
  try {
    var novelId = getNovelId(req) || storyStorage.getPublicationConfig().activeNovelId || 'default';
    var idx = parseInt(req.query.index);
    var chapter = storyStorage.getChapter(idx, novelId);
    if (chapter) {
      res.json({ code: 200, data: chapter });
    } else {
      res.json({ code: 404, message: '章节不存在' });
    }
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/stories/save', requirePermission('stories:review'), async (req, res) => {
  try {
    var { index, title, content, author, novelId } = req.body;
    novelId = novelId || storyStorage.getPublicationConfig().activeNovelId || 'default';
    storyStorage.saveChapter(index, { title: title, content: content, author: author }, novelId);
    res.json({ code: 200, message: '保存成功' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/stories/add', requirePermission('stories:review'), async (req, res) => {
  try {
    var { title, content, author, novelId } = req.body;
    novelId = novelId || storyStorage.getPublicationConfig().activeNovelId || 'default';
    var newIdx = storyStorage.addChapter(title || '新章节', content, author, novelId);
    res.json({ code: 200, message: '添加成功', data: { index: newIdx } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/stories/delete', requirePermission('stories:review'), async (req, res) => {
  try {
    var { index, novelId } = req.body;
    novelId = novelId || storyStorage.getPublicationConfig().activeNovelId || 'default';
    var pubConfig = storyStorage.getPublicationConfig();
    var novelCfg = storyStorage.getNovelPublicationSettings(pubConfig, novelId);
    var resultIndex = storyStorage.deleteChapter(index, novelId);
    if (novelCfg.currentStoryIndex >= index && novelCfg.currentStoryIndex > 0) {
      novelCfg.currentStoryIndex = novelCfg.currentStoryIndex - 1;
      if (novelCfg.currentStoryIndex >= resultIndex.length) novelCfg.currentStoryIndex = 0;
      storyStorage.saveNovelPublicationSettings(pubConfig, novelId, { currentStoryIndex: novelCfg.currentStoryIndex });
    }
    res.json({ code: 200, message: '删除成功', data: { stories: resultIndex, currentIndex: novelCfg.currentStoryIndex || 0 } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/stories/set-current', requirePermission('stories:review'), async (req, res) => {
  try {
    var { index, novelId } = req.body;
    novelId = novelId || storyStorage.getPublicationConfig().activeNovelId || 'default';
    var pubConfig = storyStorage.getPublicationConfig();
    storyStorage.saveNovelPublicationSettings(pubConfig, novelId, { currentStoryIndex: index });
    res.json({ code: 200, message: '已设置为第' + (index + 1) + '章' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/stories/save-prompt-config', requirePermission('stories:review'), async (req, res) => {
  try {
    var { promptConfig, novelId } = req.body;
    novelId = novelId || storyStorage.getPublicationConfig().activeNovelId || 'default';
    var pubConfig = storyStorage.getPublicationConfig();
    storyStorage.saveNovelPublicationSettings(pubConfig, novelId, { promptConfig: promptConfig });
    res.json({ code: 200, message: '提示词模板已保存' });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.get('/stories/next-prompt', requirePermission('stories:review'), async (req, res) => {
  try {
    var novelId = getNovelId(req) || storyStorage.getPublicationConfig().activeNovelId || 'default';
    var index = storyStorage.getChapterIndex(novelId);
    var pubConfig = storyStorage.getPublicationConfig();
    var novelCfg = storyStorage.getNovelPublicationSettings(pubConfig, novelId);
    var cfg = novelCfg.promptConfig || {};
    var nextChapNum = index.length + 1;

    var chapterSummary = buildChapterSummary(index, novelId, 80, function(chapterNumber, chapter, preview) {
      return chapterNumber + '. ' + (chapter.title || '') + '：' + preview + '...';
    });

    var novel = storyStorage.getNovelById(novelId);
    var novelTitle = cfg.novelTitle || (novel ? novel.title : '致那个夏天的你');
    var promptLines = [
      cfg.authorRole || '你是一位校园青春小说作家兼编辑：重视人物动机、情绪真实和前后设定一致，文字清新但不堆砌辞藻。',
      '',
      '请写一篇校园青春小说的第' + nextChapNum + '章，继续以下故事：',
      '小说标题：' + novelTitle,
      '',
      '已有章节梗概：'
    ];
    promptLines.push(chapterSummary);
    promptLines.push('');
    promptLines.push('');
    promptLines.push('第' + nextChapNum + '章要求：');
    promptLines.push('- 字数：' + (cfg.wordCount || '800-1200字'));
    promptLines.push('- 风格：' + (cfg.style || '温暖治愈，校园青春'));
    promptLines.push('- ' + (cfg.sceneRequirement || '需要出现1-2个新的校园场景'));
    promptLines.push('- ' + (cfg.endingRequirement || '在章节末尾留下悬念或期待'));
    promptLines.push('- ' + (cfg.titleFormat || '标题自拟（格式如"第X章 标题"）'));
    promptLines.push('- ' + (cfg.dialogueFormat || '注意：章节内容使用中文引号「」或""表示对话'));
    if (cfg.extraRequirements) {
      promptLines.push('- ' + cfg.extraRequirements);
    }
    promptLines.push('');
    promptLines.push(cfg.outputInstruction || '请直接输出章节正文，不要输出提纲、分析、思考过程、免责声明或“以下是”等套话。');

    res.json({ code: 200, data: { prompt: promptLines.join('\n'), nextChapterNum: nextChapNum } });
  } catch (err) {
    res.json({ code: 500, message: '服务器错误' });
  }
});

router.post('/stories/generate-chapter', requirePermission('stories:review'), async (req, res) => {
  try {
    var novelId = getNovelId(req) || storyStorage.getPublicationConfig().activeNovelId || 'default';
    var context = getAiChapterContext(novelId);
    var generatedContent = await aiService.generateChapter(context.prompt);
    if (!generatedContent || generatedContent.length < 50) {
      return res.json({ code: 500, message: '生成内容过短，请重试' });
    }

    res.json({ code: 200, data: parseGeneratedChapter(generatedContent, context.nextChapterNumber) });
  } catch (err) {
    console.error('[Admin] AI生成失败:', err.message);
    res.json({ code: 500, message: 'AI生成失败，请稍后重试' });
  }
});

router.get('/stories/generate-chapter-stream', requirePermission('stories:review'), async (req, res) => {
  var pingTimer = null;
  var clientDisconnected = false;
  res.on('close', function() {
    clientDisconnected = true;
    if (pingTimer) clearInterval(pingTimer);
  });
  try {
    var novelId = req.query.novelId || storyStorage.getPublicationConfig().activeNovelId || getNovelId(req) || 'default';
    var context = getAiChapterContext(novelId);
    var nextChapNum = context.nextChapterNumber;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    var fullText = '';
    pingTimer = setInterval(function() {
      if (!clientDisconnected && !res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    }, 25000);
    await aiService.generateChapterStream(context.prompt, function(token) {
      if (clientDisconnected || res.writableEnded || res.destroyed) return;
      fullText += token;
      var safe = token.replace(/\n/g, '\\n').replace(/\r/g, '');
      res.write('data: ' + safe + '\n\n');
    });
    clearInterval(pingTimer);
    pingTimer = null;

    if (clientDisconnected || res.writableEnded || res.destroyed) return;

    var generatedChapter = parseGeneratedChapter(fullText, nextChapNum);
    res.write('event: done\ndata: ' + JSON.stringify(generatedChapter) + '\n\n');
    res.end();
  } catch (err) {
    console.error('[SSE] 生成错误:', err.message);
    if (clientDisconnected || res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.write('event: error\ndata: AI生成失败，请稍后重试\n\n');
    res.end();
  } finally {
    if (pingTimer) clearInterval(pingTimer);
  }
});

router.post('/stories/publish-to-wechat', requirePermission('stories:review'), async (req, res) => {
  try {
    var { chapterIndex, novelId } = req.body;
    novelId = novelId || storyStorage.getPublicationConfig().activeNovelId || 'default';
    var novel = storyStorage.getNovelById(novelId);
    var novelTitle = novel ? novel.title : '小说连载';
    var index = storyStorage.getChapterIndex(novelId);
    if (index.length === 0) return res.json({ code: 400, message: '故事库为空' });
    if (chapterIndex === undefined || chapterIndex < 0 || chapterIndex >= index.length) {
      return res.json({ code: 400, message: '无效的章节索引' });
    }

    var chapter = storyStorage.getChapter(chapterIndex, novelId);
    if (!chapter) return res.json({ code: 400, message: '章节内容不存在' });

    var [weather, hitokoto, dateInfo] = await Promise.all([
      mpDraftService.getWeather(),
      mpDraftService.getHitokoto(),
      Promise.resolve(mpDraftService.getDateInfo())
    ]);

    var article = await storyPublication.buildStoryArticle({
      chapterIndex: chapterIndex,
      novelTitle: novelTitle,
      index: index,
      chapter: chapter,
      dateInfo: dateInfo,
      weather: weather,
      hitokoto: hitokoto
    });

    var mediaId = await mpDraftService.createDraft([article]);

    var idx = storyStorage.getChapterIndex(novelId);
    if (chapterIndex >= 0 && chapterIndex < idx.length) {
      idx[chapterIndex].published = true;
      storyStorage.saveChapterIndex(idx, novelId);
    }

    res.json({ code: 200, data: { media_id: mediaId }, message: '✅ 已同步到公众号草稿箱' });
  } catch (err) {
    console.error('[故事推送] 失败:', err.message);
    res.json({ code: 500, message: '推送失败，请稍后重试' });
  }
});


module.exports = router;
