'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const messages = read('frontend/js/messages.js');
const messagesCss = read('frontend/css/messages-polish-enhanced.css');
const themeCss = read('frontend/css/style.css');
assert(messages.includes('window.innerWidth <= 768 && currentConversationId'), '私信在 768px 时必须走移动布局');
assert(messages.includes('window.innerWidth > 768'), '私信桌面布局必须从 769px 开始');
assert(!messages.includes('window.innerWidth < 768') && !messages.includes('window.innerWidth >= 768'), '私信不得使用与 CSS 不一致的 768px 边界');
assert.strictEqual(messages, read('public/js/messages.js'), '私信脚本镜像必须一致');
assert(messagesCss.includes('body.messages-page .messages-container {\n    display: block !important;'), '私信移动端容器必须清除固定桌面宽度带来的侧边空隙');
assert(messagesCss.includes('body.messages-page .messages-sidebar {\n    width: 100% !important;'), '私信会话列表在窄屏必须占满可用宽度');
assert(messagesCss.includes('position: absolute !important;\n    inset: 0 !important;'), '私信移动聊天层必须覆盖消息容器，不得被定位上下文向下推开');
assert(messagesCss.includes('[data-theme="dark"] body.messages-page .message-item.received .message-bubble'), '深色私信页必须为收到的消息提供独立对比色');
assert(themeCss.includes('--bg-primary: #12141f;') && themeCss.includes('--text-secondary: #c9c6d3;'), '全站深色主题必须使用统一的午夜背景和可读次级文字');

const adminPage = read('frontend/admin/index.html');
const admin = `${adminPage}\n${['admin.js', 'admin-stories.js']
  .map((name) => read('frontend/admin/js/' + name)).join('\n')}`;
assert(admin.includes('var isMobile = window.innerWidth <= 768;'), '后台弹窗在 768px 时必须使用移动布局');
assert(!admin.includes('var isMobile = window.innerWidth < 768;'), '后台不得使用与 CSS 不一致的移动端边界');
assert.strictEqual(adminPage, read('public/admin/index.html'), '后台页面镜像必须一致');

const mpDraftCss = read('frontend/admin/css/mp-draft.css');
assert.strictEqual(mpDraftCss, read('public/admin/css/mp-draft.css'), '公众号推送页样式镜像必须一致');
const mpDraftPageCss = read('frontend/admin/css/mp-draft-inline.css');
assert.strictEqual(mpDraftPageCss, read('public/admin/css/mp-draft-inline.css'), '公众号推送页页面级样式镜像必须一致');
const mpDraftPage = read('frontend/admin/mp-draft.html');
const mpDraftRuntime = `${mpDraftPage}\n${read('frontend/admin/js/mp-draft.js')}`;
assert.strictEqual(mpDraftPage, read('public/admin/mp-draft.html'), '公众号推送页结构镜像必须一致');
assert(/\/admin\/css\/mp-draft-inline\.css\?v=\d+/.test(mpDraftPage) && !mpDraftPage.includes('<style>'), '公众号推送页不得继续内联页面级样式');
assert(mpDraftCss.includes('@media (max-width: 768px)'), '公众号推送页必须在 768px 及以下启用移动布局');
assert(mpDraftCss.includes('body.admin-mp-page .selection-action-bar .btn {\n    width: auto !important;'), '移动端悬浮生成按钮不得继承全宽按钮样式');
assert(mpDraftCss.includes('left: 10px;') && mpDraftCss.includes('width: auto;'), '移动端悬浮操作栏必须由左右边距约束，不能被固定宽度撑出屏幕');
const adminCss = read('frontend/admin/css/admin.css');
assert(adminPage.includes('content="width=device-width, initial-scale=1.0"') && !adminPage.includes('user-scalable=no'), '管理后台不得禁止手机端缩放');
assert(adminCss.includes('height: 100dvh;') && adminCss.includes('env(safe-area-inset-bottom, 0px)'), '移动端后台抽屉必须使用动态视口并避开系统安全区');
assert(adminCss.includes('[data-theme="dark"] body.admin-page .admin-sidebar') && adminCss.includes('rgba(255, 107, 157, .20)'), '移动端后台抽屉必须保留完整深色主题覆盖');
assert(mpDraftCss.includes('/* 桌面端入场动画含 translateX(50%) 用于居中；移动端左右贴边时不能复用。 */\n    animation: none;'), '移动端悬浮操作栏不得继承桌面端的横向位移动画');
assert(mpDraftCss.includes('grid-template-areas:\n      "check title"\n      ". author"\n      ". stats";'), '移动端选帖记录必须使用勾选框与内容分区的卡片布局');
assert(mpDraftCss.includes('width: auto !important;\n    min-width: 0;'), '移动端选帖单元格不得保留桌面表格的全宽规则');
assert(mpDraftCss.includes('tr.post-row') && mpDraftRuntime.includes("'<tr class=\"post-row '"), '单条和多条真实帖子都必须使用移动卡片布局，不能误判单条帖子为空状态');

const campusPolishCss = read('frontend/css/campus-ui-polish.css');
assert(campusPolishCss.startsWith('/*\n * Campus UI polish styles') && !/^🎓/m.test(campusPolishCss), '校园增强样式说明必须位于合法 CSS 注释内');
assert(campusPolishCss.includes('[data-theme="dark"] .quick-card-gaokao') && campusPolishCss.includes('.side-card-countdown .side-card-title'), '夜间倒计时卡片必须覆盖校园增强样式的浅色强制背景和标题色');
['profile-polish.css', 'profile-polish-enhanced.css'].forEach(function(fileName) {
  const css = read('frontend/css/' + fileName);
  assert(!css.includes(':contains('), fileName + ' 不得使用浏览器不支持的 :contains 选择器');
  assert(css.includes('.btn-mark-all') && css.includes('.btn-wechat-unbind'), fileName + ' 必须保留通知和微信操作按钮样式');
});

console.log('[responsive-boundary] 通过：768px 统一归入移动端，769px 起使用桌面逻辑');
