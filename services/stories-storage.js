const fs = require('fs');
const path = require('path');

const STORIES_BASE = path.join(__dirname, '..', 'config', 'stories');
const NOVELS_PATH = path.join(__dirname, '..', 'config', 'novels.json');
const PUBLICATION_CONFIG_PATH = path.join(__dirname, '..', 'config', 'auto-publish.json');
const DEFAULT_NOVEL = {
  id: 'default',
  title: '致那个夏天的你',
  author: '校园墙编辑部',
  desc: '校园青春小说'
};

if (!fs.existsSync(STORIES_BASE)) {
  fs.mkdirSync(STORIES_BASE, { recursive: true });
}

function getNovelList() {
  if (fs.existsSync(NOVELS_PATH)) {
    return JSON.parse(fs.readFileSync(NOVELS_PATH, 'utf8'));
  }

  const list = [];
  const oldIndexPath = path.join(STORIES_BASE, 'index.json');
  if (fs.existsSync(oldIndexPath)) {
    try {
      const oldIndex = JSON.parse(fs.readFileSync(oldIndexPath, 'utf8'));
      if (Array.isArray(oldIndex) && oldIndex.length > 0) {
        list.push({ ...DEFAULT_NOVEL, createdAt: new Date().toISOString().substring(0, 10) });
        const novelDir = getNovelDirectory('default');
        if (!fs.existsSync(novelDir)) fs.mkdirSync(novelDir, { recursive: true });
        fs.renameSync(oldIndexPath, path.join(novelDir, 'index.json'));
        oldIndex.forEach(entry => {
          const source = path.join(STORIES_BASE, entry.file);
          if (fs.existsSync(source)) fs.renameSync(source, path.join(novelDir, entry.file));
        });

        if (fs.existsSync(PUBLICATION_CONFIG_PATH)) {
          try {
            const publicationConfig = JSON.parse(fs.readFileSync(PUBLICATION_CONFIG_PATH, 'utf8'));
            publicationConfig.activeNovelId = 'default';
            if (!publicationConfig.novels) publicationConfig.novels = {};
            publicationConfig.novels.default = {
              currentStoryIndex: publicationConfig.currentStoryIndex || 0,
              promptConfig: publicationConfig.promptConfig || {}
            };
            delete publicationConfig.currentStoryIndex;
            delete publicationConfig.promptConfig;
            savePublicationConfig(publicationConfig);
          } catch (error) {}
        }
        console.log('[小说] 旧单本结构已自动迁移为多小说结构');
      }
    } catch (error) {
      console.warn('[小说] 自动迁移失败:', error.message);
    }
  }

  if (list.length === 0) {
    list.push({ ...DEFAULT_NOVEL, createdAt: new Date().toISOString().substring(0, 10) });
  }
  saveNovelList(list);
  return list;
}

function saveNovelList(list) {
  fs.writeFileSync(NOVELS_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function getNovelById(id) {
  const list = getNovelList();
  for (let index = 0; index < list.length; index += 1) {
    if (list[index].id === id) return list[index];
  }
  return null;
}

function getNovelDirectory(novelId) {
  return path.join(STORIES_BASE, novelId || 'default');
}

function ensureNovelDirectory(novelId) {
  const directory = getNovelDirectory(novelId);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
}

function removeNovelDirectory(novelId) {
  const directory = getNovelDirectory(novelId);
  try {
    const index = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8') || '[]');
    index.forEach(entry => {
      try { fs.unlinkSync(path.join(directory, entry.file)); } catch (error) {}
    });
    try { fs.unlinkSync(path.join(directory, 'index.json')); } catch (error) {}
    try { fs.rmdirSync(directory); } catch (error) {}
  } catch (error) {}
}

function getNovelPublicationSettings(publicationConfig, novelId) {
  novelId = novelId || publicationConfig.activeNovelId || 'default';
  if (!publicationConfig.novels) publicationConfig.novels = {};
  if (!publicationConfig.novels[novelId]) {
    publicationConfig.novels[novelId] = { currentStoryIndex: 0, promptConfig: {} };
  }
  return {
    novels: publicationConfig.novels,
    currentStoryIndex: publicationConfig.novels[novelId].currentStoryIndex || 0,
    promptConfig: publicationConfig.novels[novelId].promptConfig || {}
  };
}

function saveNovelPublicationSettings(publicationConfig, novelId, data) {
  novelId = novelId || publicationConfig.activeNovelId || 'default';
  if (!publicationConfig.novels) publicationConfig.novels = {};
  if (!publicationConfig.novels[novelId]) publicationConfig.novels[novelId] = {};
  if (data.currentStoryIndex !== undefined) publicationConfig.novels[novelId].currentStoryIndex = data.currentStoryIndex;
  if (data.promptConfig !== undefined) publicationConfig.novels[novelId].promptConfig = data.promptConfig;
  savePublicationConfig(publicationConfig);
}

function savePublicationConfig(publicationConfig) {
  fs.writeFileSync(PUBLICATION_CONFIG_PATH, JSON.stringify(publicationConfig, null, 2), 'utf8');
}

function getPublicationConfig() {
  if (fs.existsSync(PUBLICATION_CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(PUBLICATION_CONFIG_PATH, 'utf8')); } catch (error) {}
  }
  return { hour: 8, minute: 0, enabled: true, activeNovelId: 'default', novels: {} };
}

function getChapterIndex(novelId) {
  const directory = getNovelDirectory(novelId);
  const indexPath = path.join(directory, 'index.json');
  if (fs.existsSync(indexPath)) return JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  if (!novelId || novelId === 'default') {
    const oldDirectory = path.join(__dirname, '..', 'config', 'stories');
    const oldIndexPath = path.join(oldDirectory, 'index.json');
    if (fs.existsSync(oldIndexPath)) {
      try {
        const oldIndex = JSON.parse(fs.readFileSync(oldIndexPath, 'utf8'));
        if (Array.isArray(oldIndex) && oldIndex.length > 0) {
          if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
          fs.renameSync(oldIndexPath, indexPath);
          oldIndex.forEach(entry => {
            const source = path.join(oldDirectory, entry.file);
            if (fs.existsSync(source)) fs.renameSync(source, path.join(directory, entry.file));
          });
          console.log('[故事] 从 config/stories/ 迁移到 ' + directory + '，共' + oldIndex.length + '章');
          return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        }
      } catch (error) {
        console.warn('[故事] 迁移 config/stories/ 失败:', error.message);
      }
    }
  }

  const oldStoriesPath = path.join(__dirname, '..', 'config', 'stories.json');
  if (fs.existsSync(oldStoriesPath)) {
    try {
      const oldStories = JSON.parse(fs.readFileSync(oldStoriesPath, 'utf8'));
      if (Array.isArray(oldStories) && oldStories.length > 0) {
        if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
        const index = [];
        oldStories.forEach((story, storyIndex) => {
          const chapterFile = storyIndex + '.json';
          fs.writeFileSync(
            path.join(directory, chapterFile),
            JSON.stringify({ title: story.title, content: story.content, author: story.author || '校园墙编辑部' }, null, 2),
            'utf8'
          );
          index.push({ file: chapterFile, title: story.title, author: story.author || '校园墙编辑部', published: false });
        });
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
        fs.renameSync(oldStoriesPath, oldStoriesPath + '.bak');
        console.log('[故事] 旧格式已自动迁移，共' + index.length + '章');
        return index;
      }
    } catch (error) {
      console.warn('[故事] 迁移旧格式失败:', error.message);
    }
  }
  return [];
}

function saveChapterIndex(index, novelId) {
  const directory = getNovelDirectory(novelId);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
}

function getChapter(indexPosition, novelId) {
  const index = getChapterIndex(novelId);
  const directory = getNovelDirectory(novelId);
  if (indexPosition >= 0 && indexPosition < index.length) {
    const chapterPath = path.join(directory, index[indexPosition].file);
    if (fs.existsSync(chapterPath)) return JSON.parse(fs.readFileSync(chapterPath, 'utf8'));
  }
  return null;
}

function saveChapter(indexPosition, data, novelId) {
  const index = getChapterIndex(novelId);
  const directory = getNovelDirectory(novelId);
  if (indexPosition >= 0 && indexPosition < index.length) {
    fs.writeFileSync(
      path.join(directory, index[indexPosition].file),
      JSON.stringify({ title: data.title, content: data.content, author: data.author }, null, 2),
      'utf8'
    );
    index[indexPosition].title = data.title;
    index[indexPosition].author = data.author || '校园墙编辑部';
    if (index[indexPosition].published === undefined) index[indexPosition].published = false;
    saveChapterIndex(index, novelId);
  }
}

function addChapter(title, content, author, novelId) {
  const index = getChapterIndex(novelId);
  const directory = getNovelDirectory(novelId);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const nextFile = index.length + '.json';
  fs.writeFileSync(
    path.join(directory, nextFile),
    JSON.stringify({ title: title, content: content || '', author: author || '校园墙编辑部' }, null, 2),
    'utf8'
  );
  index.push({ file: nextFile, title: title, author: author || '校园墙编辑部', published: false });
  saveChapterIndex(index, novelId);
  return index.length - 1;
}

function deleteChapter(indexPosition, novelId) {
  const index = getChapterIndex(novelId);
  const directory = getNovelDirectory(novelId);
  if (indexPosition >= 0 && indexPosition < index.length) {
    try { fs.unlinkSync(path.join(directory, index[indexPosition].file)); } catch (error) {}
    index.splice(indexPosition, 1);
    saveChapterIndex(index, novelId);
  }
  return index;
}

module.exports = {
  addChapter,
  deleteChapter,
  deleteNovelDirectory: removeNovelDirectory,
  ensureNovelDirectory,
  getChapter,
  getChapterIndex,
  getNovelById,
  getNovelList,
  getNovelPublicationSettings,
  getPublicationConfig,
  saveChapter,
  saveChapterIndex,
  saveNovelList,
  saveNovelPublicationSettings,
  savePublicationConfig
};
