'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { collectFiles } = require('./lib/frontend-assets');

function buildPagesDemo(root, base = '/school_wall/') {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw new Error('演示基础路径必须是绝对目录路径');
  root = fs.realpathSync(root);
  const output = path.join(root, '.pages-demo');
  if (fs.existsSync(output) && (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output) !== output)) {
    throw new Error('拒绝覆盖链接或越界目录');
  }
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output);
  const aliases = ['radio', 'profile', 'login', 'register', 'new-post', 'edit-post', 'edit-profile', 'feedback', 'agreement', 'privacy', 'messages'];
  for (const file of collectFiles(path.join(root, 'frontend'))) {
    if (!/\.(html|css|js|svg|png|jpg|jpeg|webp|gif|ico|woff2?|ttf)$/i.test(file)) continue;
    if (/\.(png|jpg|jpeg|webp|gif|ico)$/i.test(file) && !['images/default-cover.png'].includes(file)) continue;
    const target = path.join(output, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let content = fs.readFileSync(path.join(root, 'frontend', file));
    if (/\.(html|css|js|svg)$/i.test(file)) {
      content = content.toString('utf8')
        .replace(/https?:\/\/wall\.jay23\.cn/g, 'https://jay1023cn.github.io' + base.slice(0, -1))
        .replace(/嘉定二中|嘉定二|嘉二(?:の墙墙|校园墙管理|校园墙|中)?/g, '校园墙')
        .replace(/上海市嘉定区第二中学/g, '示例校园')
        .replace(/粤ICP备[\d-]+号(?:-\d+)?/g, 'GitHub Pages 演示');
      content = content.replace(/(["'])\/(?:uploads\/avatars\/default\.png|images\/default-avatar\.png)/g, '$1' + base + 'demo/avatar.svg');
      content = content.replace(/(["'])\/(?:favicon\.(?:ico|png)|logo-search\.png)/g, '$1' + base + 'demo/avatar.svg');
      content = content.replace(/(?:https:\/\/jay1023cn\.github\.io)?\/school_wall\/images\/gzh\.jpg/g, base + 'demo/wechat-disabled.svg');
      // Rewrite only string/attribute paths, never JS regular expressions or API routes.
      content = content.replace(/(["'`])\/post\//g, '$1' + base + 'post-detail.html?id=');
      content = content.replace(/(["'`])\/admin\/mp-draft(?=[?"'`])/g, '$1' + base + 'admin/mp-draft.html');
      for (const alias of aliases) {
        content = content.replace(new RegExp('(["\'`])/' + alias + '(?=[?"\'`])', 'g'), '$1' + base + alias + '.html');
      }
      content = content.replace(/(["'`])\/admin(?=["'`])/g, '$1' + base + 'admin/');
      content = content.replace(/(["'`])\/(?=(?:css|js|images|uploads|admin)\/)/g, '$1' + base);
      content = content.replace(new RegExp(base.replace(/\//g, '\\/') + 'images/gzh\\.jpg', 'g'), base + 'demo/wechat-disabled.svg');
      content = content.replace(/url\(\s*(["']?)\/(?=(?:css|images|uploads)\/)/g, 'url($1' + base);
      content = content.replace(/href=(["'])\/\1/g, 'href=$1' + base + '$1');
      content = content.replace(/(window\.location(?:\.href)?\s*=\s*)(["'])\/\2/g, '$1$2' + base + '$2');
      if (file === 'js/detail.js') content = content.replace("postId = window.location.pathname.split('/').pop();", "postId = new URLSearchParams(window.location.search).get('id') || '1';");
      if (file.endsWith('.html')) {
        // Search submission analytics and production structured data don't belong in a demo.
        content = content.replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<script>\(function\(\)\{var bp=document[\s\S]*?<\/script>/g, '')
          .replace(/<link\b[^>]*rel=["'](?:preconnect|dns-prefetch)["'][^>]*>/gi, '');
        const injected = '<script>window.CAMPUS_DEMO_BASE=' + JSON.stringify(base) + ';</script>' +
          '<script src="' + base + 'demo/runtime.js"></script><link rel="stylesheet" href="' + base + 'demo/demo.css">';
        content = content.replace(/<head(?:\s[^>]*)?>/i, '$&\n' + injected + '\n' +
          '<meta http-equiv="Content-Security-Policy" content="connect-src \'self\'; form-action \'none\'">');
      }
    }
    fs.writeFileSync(target, content);
  }
  fs.cpSync(path.join(root, 'demo'), path.join(output, 'demo'), { recursive: true });
  const avatar = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="#e9e5ff"/><circle cx="48" cy="35" r="16" fill="#8976df"/><path d="M18 83c0-32 60-32 60 0" fill="#8976df"/></svg>';
  fs.writeFileSync(path.join(output, 'demo', 'avatar.svg'), avatar);
  fs.writeFileSync(path.join(output, 'demo', 'wechat-disabled.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" rx="16" fill="#eef1f8"/><text x="90" y="83" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#4b5563">公众号功能演示</text><text x="90" y="111" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#6b7280">不提供真实关注二维码</text></svg>');
  // Generated fallback avatars only, never copy production uploads.
  const favicon = path.join(output, 'favicon.ico');
  if (!fs.existsSync(favicon)) fs.writeFileSync(path.join(output, 'favicon.svg'), avatar);
  fs.writeFileSync(path.join(output, '.nojekyll'), '');
  fs.writeFileSync(path.join(output, '404.html'), '<!doctype html><meta charset="utf-8"><title>页面不存在 · 校园墙演示</title><p>演示页面不存在。<a href="' + base + '">返回校园墙演示</a></p>');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(output, 'demo-build.json'), JSON.stringify({ revision, base, data: 'fictional', built_at: new Date().toISOString() }, null, 2) + '\n');
  return output;
}

if (require.main === module) console.log('[pages-demo] 演示构建完成：' + buildPagesDemo(path.resolve(__dirname, '..'), process.env.PAGES_BASE_PATH || '/school_wall/'));
module.exports = { buildPagesDemo };
