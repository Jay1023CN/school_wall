'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

// 只覆盖公开页面根目录；admin 和 images/README.html 不属于主题首屏入口。
const pageNames = fs.readdirSync(path.join(root, 'frontend'))
  .filter((name) => name.endsWith('.html'))
  .sort();

assert(pageNames.length > 0, '必须找到公开 HTML 页面');

pageNames.forEach((pageName) => {
  const frontendPage = read(`frontend/${pageName}`);
  const publicPage = read(`public/${pageName}`);
  assert.strictEqual(frontendPage, publicPage, `${pageName} 的 frontend/public 镜像必须一致`);

  // 基础样式和深色偏好先恢复，正文不等待活动主题。
  const bootStart = frontendPage.indexOf('<style id="app-shell-style">');
  const firstStylesheet = frontendPage.indexOf('<link rel="stylesheet"');
  const themeScript = frontendPage.indexOf('/js/theme-mode.js');
  assert(bootStart >= 0, `${pageName} 必须包含前置 boot 样式`);
  assert(firstStylesheet > bootStart, `${pageName} 的 boot 样式必须先于外部 CSS`);
  assert(themeScript > bootStart, `${pageName} 的主题脚本必须位于 boot 样式之后`);
  assert(!frontendPage.includes('app-booting'), `${pageName} 不得因活动主题隐藏正文`);
  assert(!frontendPage.includes('festival-theme-ready') && !frontendPage.includes('release(true)'), `${pageName} 不得等待主题事件或硬超时才显示`);
  assert(frontendPage.includes('localStorage.getItem("theme") === "dark"'), `${pageName} 基础深色偏好应同步恢复`);
  assert(!frontendPage.includes('window.addEventListener("load", release'), `${pageName} 不得由 load 事件提前释放`);
  assert(!frontendPage.includes('href="/css/teacher.css"') && !frontendPage.includes('href="/css/festival-520.css"'),
    `${pageName} 不得在主题配置确定前静态加载节日 CSS`);
  assert(frontendPage.includes('<script src="/js/theme-mode.js?v=2026101101" async fetchpriority="low"></script>'), `${pageName} 主题脚本应异步低优先级加载`);
});

const themeMode = read('frontend/js/theme-mode.js');
assert.strictEqual(themeMode, read('public/js/theme-mode.js'), '主题脚本镜像必须一致');
assert(themeMode.includes('THEME_HINT_TTL_MS = 60 * 60 * 1000'), '主题提示缓存必须有明确 TTL');
assert(themeMode.includes('__ts: Date.now()'), '主题提示缓存必须记录确认时间');
assert(themeMode.includes('validTimestamp'), '过期或未来主题提示必须被拒绝');
assert(themeMode.includes('festival_mode === true'), '主题开关必须严格按后端布尔值判断');
assert(themeMode.includes('Promise.race([Promise.resolve(window.CampusWallSiteInfoPromise), sharedTimeout])'),
  '共享站点配置 Promise 必须受首屏超时保护');
assert(themeMode.includes('applyTheme(cachedHint || { festival_mode: false }, stylesheets, false)'),
  '接口失败回退不得刷新缓存时间');
assert(themeMode.includes('setThemeStylesheets(baseState, stylesheets)'),
  '主题 CSS 加载失败时必须停用半套主题并回退基础主题');
assert(themeMode.includes("link.media = 'print'") && themeMode.includes("stylesheets.teacher.media = state.teacher && loaded ? 'all' : 'print'"),
  '活动主题样式必须在准备好后才启用');

console.log(`[theme-first-paint] 通过：${pageNames.length} 个公开页面正文不等待主题；缓存、共享请求和 CSS 失败均有确定回退`);
