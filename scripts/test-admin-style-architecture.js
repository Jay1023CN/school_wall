'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const frontendPath = path.join(__dirname, '..', 'frontend', 'admin', 'index.html');
const publicPath = path.join(__dirname, '..', 'public', 'admin', 'index.html');
const frontendCssPath = path.join(__dirname, '..', 'frontend', 'admin', 'css', 'admin.css');
const publicCssPath = path.join(__dirname, '..', 'public', 'admin', 'css', 'admin.css');
const globalCssPath = path.join(__dirname, '..', 'frontend', 'css', 'style.css');
const frontend = fs.readFileSync(frontendPath, 'utf8');
const publicMirror = fs.readFileSync(publicPath, 'utf8');
const frontendCss = fs.readFileSync(frontendCssPath, 'utf8');
const publicCss = fs.readFileSync(publicCssPath, 'utf8');
const globalCss = fs.readFileSync(globalCssPath, 'utf8');
const adminScriptDir = path.join(__dirname, '..', 'frontend', 'admin', 'js');
const adminRuntime = `${frontend}\n${['admin.js', 'admin-stories.js']
  .map((name) => fs.readFileSync(path.join(adminScriptDir, name), 'utf8')).join('\n')}`;

const baiduPush = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'baidu-push.js'), 'utf8');
assert.strictEqual(baiduPush, fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'baidu-push.js'), 'utf8'), '百度推送脚本镜像必须一致');
for (const pageName of ['index', 'mp-draft', 'gamification', 'email-settings']) {
  const pagePath = pageName === 'index'
    ? frontendPath
    : path.join(__dirname, '..', 'frontend', 'admin', `${pageName}.html`);
  const publicPagePath = pageName === 'index'
    ? publicPath
    : path.join(__dirname, '..', 'public', 'admin', `${pageName}.html`);
  const page = fs.readFileSync(pagePath, 'utf8');
  const publicPage = fs.readFileSync(publicPagePath, 'utf8');
  assert.strictEqual(page, publicPage, `${pageName} 页面镜像必须一致`);
  assert(/\/js\/baidu-push\.js\?v=\d+/.test(page), `${pageName} 必须通过带版本的外置脚本加载百度推送`);
  assert.strictEqual((page.match(/<script(?![^>]*src=)/gi) || []).length, 0, `${pageName} 不得保留内联脚本`);
}

for (const pageName of ['gamification', 'email-settings']) {
  const page = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'admin', `${pageName}.html`), 'utf8');
  const publicPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', `${pageName}.html`), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'admin', 'css', `${pageName}.css`), 'utf8');
  const publicCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'css', `${pageName}.css`), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'admin', 'js', `${pageName}.js`), 'utf8');
  const publicJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'js', `${pageName}.js`), 'utf8');
  assert.strictEqual(page, publicPage, `${pageName} 页面镜像必须一致`);
  assert.strictEqual(css, publicCss, `${pageName} CSS 镜像必须一致`);
  assert.strictEqual(js, publicJs, `${pageName} JS 镜像必须一致`);
  const cssVersion = page.match(new RegExp(`/admin/css/${pageName}\\.css\\?v=(\\d+)`));
  const jsVersion = page.match(new RegExp(`/admin/js/${pageName}\\.js\\?v=(\\d+)`));
  assert(cssVersion && jsVersion && cssVersion[1] === jsVersion[1], `${pageName} 必须加载同版本的外置资源`);
  assert.strictEqual((page.match(/<style\b/g) || []).length, 0, `${pageName} 不得保留页面级内联样式`);
  const inlineScripts = [...page.matchAll(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/gi)];
  assert(inlineScripts.every((match) => match[0].length <= 2000), `${pageName} 不得内联大段业务脚本`);
  assert(!/\bon(?:click|change|input|submit|error|mouseover|mouseout)\s*=/.test(page), `${pageName} 页面不得保留内联事件属性`);
  assert(!/\s+on[a-z]+\s*=/i.test(js), `${pageName} 脚本不得拼接内联事件属性`);
}

const loginPage = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'login.html'), 'utf8');
const loginCss = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'login.css'), 'utf8');
assert.strictEqual(loginPage, fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8'), '登录页镜像必须一致');
assert.strictEqual(loginCss, fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'login.css'), 'utf8'), '登录页 CSS 镜像必须一致');
assert(loginPage.includes('href="/css/login.css"') && !loginPage.includes('login-layout-final'), '登录页页面级样式必须通过外置 CSS 加载');
assert.strictEqual((loginPage.match(/<style\b/g) || []).length, 1, '登录页仅允许保留启动遮罩样式');
assert(!/\s+on[a-z]+\s*=/i.test(loginPage), '登录页不得保留内联事件属性');
const loginScript = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'login-page.js'), 'utf8');
assert(loginScript.includes('data-action') && loginScript.includes('reload-captcha') && loginScript.includes('toggle-theme'), '登录页交互必须通过外置脚本事件委托');

assert.strictEqual(frontend, publicMirror, '后台管理页的 frontend/public 镜像必须完全一致');
assert.strictEqual(frontendCss, publicCss, '后台 CSS 的 frontend/public 镜像必须完全一致');
assert(/\s+data-admin-action=/.test(frontend), '后台主页面必须通过 data-admin-action 声明交互入口');
assert(!/\s+on[a-z]+\s*=/i.test(frontend), '后台主页面不得保留内联事件属性');
assert(!/\s+on[a-z]+\s*=/i.test(adminRuntime), '后台运行时模板不得拼接内联事件属性');
assert.ok(frontend.includes('href="/admin/css/admin.css"'), '后台必须加载唯一的专属样式入口');
assert.strictEqual((frontend.match(/<style\b/g) || []).length, 0, '后台 HTML 不得再保留静态 style 标签');
assert.strictEqual((frontendCss.match(/点歌管理组件：唯一结构规则/g) || []).length, 1, '点歌管理只能有一个组件结构入口');
assert.ok(frontendCss.includes('--song-pending:') && frontendCss.includes('--song-approved:'), '点歌状态颜色必须由同一组语义 token 提供');
assert.ok(frontendCss.includes('#panel-songs .table-actions-compact .action-approve'), '桌面与移动端必须共用同一通过按钮状态类');
assert.ok(frontendCss.includes('--admin-page-bg:') && frontendCss.includes('--admin-action-primary:'), '后台必须提供独立语义主题 token');
assert.ok(frontendCss.includes('[data-admin-theme="violet"] body.admin-page'), '新增后台主题必须只通过语义 token 映射');
assert.ok(adminRuntime.includes('window.setAdminThemeVariant') && adminRuntime.includes('admin-theme-variant'), '后台必须保留可扩展主题切换入口');
assert.ok(frontendCss.includes('--admin-z-drawer-backdrop:') && frontendCss.includes('var(--admin-z-modal)'), '后台抽屉、弹窗和 toast 必须通过统一层级 token 定位');
assert.ok(frontendCss.includes('body.admin-page .admin-sidebar.sidebar-open') && frontendCss.includes('sidebar-open 作为唯一抽屉状态'), '移动端抽屉必须与脚本的 sidebar-open 状态类保持一致');
assert.ok(adminRuntime.includes("window.matchMedia('(max-width: 768px)').matches") && adminRuntime.includes("if (!isMobileDrawerViewport()) return;"), '抽屉脚本只能在移动断点打开，不能在缩放后的桌面单独打开遮罩');
assert.ok(frontendCss.includes('body.admin-page .sidebar-overlay.show') && frontendCss.includes('抽屉遮罩没有桌面语义'), '桌面端即使遗留遮罩状态也必须强制隐藏，避免全屏阴影');
assert.ok(frontendCss.includes('--admin-sidebar-header-bg: linear-gradient') && frontendCss.includes('Mobile: profile-card visual system'), '后台浅色侧栏与移动端必须使用统一的柔和卡片视觉系统');
assert.ok(frontendCss.includes('#panel-songs .admin-table-wrapper') && frontendCss.includes('max-height: none !important;'), '点歌移动列表不得继承桌面表格的固定最大高度');
assert.ok(frontendCss.includes('body.admin-page .admin-topbar .bell-badge') && frontendCss.includes('var(--admin-surface-raised)'), '通知数字必须使用可随亮暗主题切换的语义色');
assert.ok(frontendCss.includes('--admin-sidebar-header-bg:') && frontendCss.includes('var(--admin-sidebar-header-text) !important'), '侧栏标题区必须使用独立的高对比主题 token');
assert.ok(frontend.includes('class="stories-toolbar"') && frontendCss.includes('#panel-stories .stories-toolbar'), '连载小说工具栏必须有独立结构，不能继续依赖内联彩色按钮');
assert.ok(frontendCss.includes('#panel-stories .admin-table-wrapper') && frontendCss.includes('max-height: none !important;'), '连载小说移动端外层不得截断章节或编辑内容');
assert.ok(frontendCss.includes('@media (min-width: 769px)') && frontendCss.includes('width: calc(100% - 260px);') && frontendCss.includes('box-sizing: border-box;'), '桌面主内容必须扣除固定侧栏宽度，不能以 100% 宽度叠加 margin-left');
assert.ok(frontendCss.includes('@media (max-width: 768px)') && frontendCss.includes('#panel-songs .songs-table tbody tr'), '点歌移动端规则必须明确限定在 768px 及以下');
assert.ok(frontendCss.includes('/* ===== 后台壳层 =====') && frontendCss.includes('body.admin-page .admin-sidebar'), '后台壳层必须由后台专属 CSS 唯一维护');
assert.ok(!globalCss.includes('.admin-layout {') && !globalCss.includes('.admin-sidebar {') && !globalCss.includes('.admin-topbar {'), '全站样式不得再维护后台壳层，避免加载顺序决定布局');
assert.ok(frontendCss.includes('padding: 0 !important;') && frontendCss.includes('padding-left: 36px !important;'), '点歌移动卡片必须清除桌面单元格内边距，避免复选框遮住歌名');
assert.ok(frontendCss.includes('微信绑定用户卡片：每个字段独占一行') && frontendCss.includes('grid-template-columns: 62px minmax(0, 1fr)'), '微信绑定用户卡片必须为标签和长字段保留稳定宽度');
assert.ok(frontendCss.includes('.wechat-user-table tbody td:nth-child(4) .openid-text') && frontendCss.includes('word-break: break-all'), '移动端 OpenID 必须在字段内部换行，不得挤压其它字段');
assert.ok(!adminRuntime.includes('style.cssText') && !adminRuntime.includes('<style>'), '运行时浮层不得再注入样式字符串');
assert.ok(!/migrated:|mobile-[\w-]*final|layout-v2/.test(frontendCss), '后台样式不得保留历史 final/v2 覆盖块标记');

console.log('[admin-style-architecture] 通过：后台样式入口、主题 token、点歌组件与镜像边界均已锁定');
