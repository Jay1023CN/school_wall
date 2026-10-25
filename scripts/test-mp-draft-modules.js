const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pairs = [
  ['frontend/admin/mp-draft.html', 'public/admin/mp-draft.html'],
  ['frontend/admin/js/mp-draft-utils.js', 'public/admin/js/mp-draft-utils.js'],
  ['frontend/admin/js/mp-draft-ui.js', 'public/admin/js/mp-draft-ui.js'],
  ['frontend/admin/js/mp-draft.js', 'public/admin/js/mp-draft.js'],
  ['frontend/admin/css/mp-draft-inline.css', 'public/admin/css/mp-draft-inline.css']
];

for (const [left, right] of pairs) {
  const leftText = fs.readFileSync(path.join(root, left), 'utf8');
  const rightText = fs.readFileSync(path.join(root, right), 'utf8');
  if (leftText !== rightText) {
    throw new Error(`mp-draft 镜像不一致: ${left} != ${right}`);
  }
}

const html = fs.readFileSync(path.join(root, 'frontend/admin/mp-draft.html'), 'utf8');
const cssMatch = html.match(/<link rel="stylesheet" href="\/admin\/css\/mp-draft-inline\.css\?v=(\d+)">/);
if (!cssMatch) throw new Error('mp-draft 页面必须加载带版本的外置页面样式');
const utilsMatch = html.match(/<script src="\/admin\/js\/mp-draft-utils\.js\?v=(\d+)"><\/script>/);
const uiMatch = html.match(/<script src="\/admin\/js\/mp-draft-ui\.js\?v=(\d+)"><\/script>/);
const mainMatch = html.match(/<script src="\/admin\/js\/mp-draft\.js\?v=(\d+)"><\/script>/);
if (!utilsMatch || !uiMatch || !mainMatch) throw new Error('mp-draft 所有业务脚本都必须带发布版本');
if (![utilsMatch[1], uiMatch[1], mainMatch[1]].every((version) => version === cssMatch[1])) {
  throw new Error('mp-draft 样式与脚本的发布版本必须一致');
}
const utilsIndex = html.indexOf(utilsMatch[0]);
const uiIndex = html.indexOf(uiMatch[0]);
const mainIndex = html.indexOf(mainMatch[0]);
if (utilsIndex < 0 || uiIndex < 0 || mainIndex < 0 || utilsIndex > uiIndex || uiIndex > mainIndex) {
  throw new Error('mp-draft 工具脚本必须在页面主脚本之前按顺序引入');
}

const mainScript = fs.readFileSync(path.join(root, 'frontend/admin/js/mp-draft.js'), 'utf8');
for (const name of [
  'setStatus', 'showMsg', 'showToast', 'escapeHtml', 'countVisibleText',
  'countText', 'getPreviewVideoUrl', 'getPreviewPosterUrl', 'buildPreviewVideoHtml', 'formatTime'
]) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`);
  if (declaration.test(mainScript)) {
    throw new Error(`工具函数仍重复声明在 mp-draft 主脚本中: ${name}`);
  }
}

if (/\bon(?:click|change|input|error|mouseover|mouseout)\s*=\s*["']/i.test(html)) {
  throw new Error('mp-draft 页面不得使用内联事件属性');
}
if (/\bon(?:click|change|input|error|mouseover|mouseout)\s*=\s*["']/i.test(mainScript)) {
  throw new Error('mp-draft 动态模板不得拼接内联事件属性');
}
for (const action of ['switch-tab', 'generate-preview-from-posts', 'sync-draft', 'song-template']) {
  if (!html.includes(`data-action="${action}"`) && !mainScript.includes(`data-action="${action}"`)) {
    throw new Error(`mp-draft 缺少事件委托动作: ${action}`);
  }
}

const inlineScripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/gi)];
if (inlineScripts.some((match) => match[0].length > 2000)) {
  throw new Error('mp-draft 页面不得继续内联大段业务脚本');
}

console.log('mp-draft 模块拆分静态检查通过');
