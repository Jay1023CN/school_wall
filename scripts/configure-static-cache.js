'use strict';

// 在部署进程内修正本站的 Nginx 静态缓存；不提供远程命令或配置读取接口。
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

const CACHE = 'public, max-age=300, stale-while-revalidate=86400';
const MARKER = '# campus-wall-public-assets';
const HEADER_NAMES = ['cache-control', 'surrogate-control', 'age', 'eo-cache-status', 'content-type'];

function parse(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source[i] === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    const start = i;
    if ('{};'.includes(source[i])) { tokens.push({ value: source[i++], start, end: i }); continue; }
    let value = '';
    while (i < source.length && !/\s/.test(source[i]) && !'{};#'.includes(source[i])) {
      if (source[i] === '"' || source[i] === "'") {
        const quote = source[i++];
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\' && i + 1 < source.length) i++;
          value += source[i++];
        }
        if (source[i++] !== quote) throw new Error('config_quote');
      } else if (source[i] === '$' && source[i + 1] === '{') {
        const end = source.indexOf('}', i + 2);
        if (end < 0) throw new Error('config_variable');
        value += source.slice(i, end + 1); i = end + 1;
      } else if (source[i] === '\\' && i + 1 < source.length) {
        value += source.slice(i, i + 2); i += 2;
      } else { value += source[i++]; }
    }
    if (i === start) throw new Error('config_token');
    tokens.push({ value, start, end: i });
  }
  let cursor = 0;
  function block(depth = 0) {
    if (depth > 50) throw new Error('config_depth');
    const nodes = [];
    while (cursor < tokens.length && tokens[cursor].value !== '}') {
      const first = tokens[cursor]; const words = [];
      while (cursor < tokens.length && !['{', '}', ';'].includes(tokens[cursor].value)) words.push(tokens[cursor++].value);
      const delimiter = tokens[cursor++];
      if (!delimiter || !words.length || delimiter.value === '}') throw new Error('config_directive');
      const node = { name: words[0], args: words.slice(1), start: first.start, end: delimiter.end, children: null };
      if (delimiter.value === '{') {
        node.children = block(depth + 1);
        const closing = tokens[cursor++];
        if (!closing || closing.value !== '}') throw new Error('config_block');
        node.close = closing.start; node.end = closing.end;
      }
      nodes.push(node);
    }
    return nodes;
  }
  const result = block();
  if (cursor !== tokens.length) throw new Error('config_unbalanced');
  return result;
}

function allServers(nodes) {
  return nodes.flatMap(node => node.name === 'server' && node.children ? [node] : node.children ? allServers(node.children) : []);
}

function command(binary, args) {
  return spawnSync(binary, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
}

function atomicWrite(file, text, mode = 0o600) {
  const temp = `${file}.tmp.${process.pid}`;
  const previous = fs.existsSync(file) ? fs.statSync(file) : null;
  try {
    fs.writeFileSync(temp, text, { mode, flag: 'wx' });
    if (previous && typeof process.getuid === 'function' && process.getuid() === 0) fs.chownSync(temp, previous.uid, previous.gid);
    fs.renameSync(temp, file);
  }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function publicReport(report, revision) {
  if (!report || report.revision !== revision) return null;
  const allowed = ['revision', 'state', 'reason', 'updatedAt', 'changed', 'site', 'originBefore', 'origin', 'edge', 'nginx', 'nginxSyntax', 'reloaded', 'restored'];
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(report, key)).map(key => [key, report[key]]));
}

function probe(domain, pathname, origin = false, secure = true) {
  return new Promise(resolve => {
    const started = performance.now();
    const transport = secure ? https : http;
    const request = transport.get({ hostname: origin ? '127.0.0.1' : domain, port: secure ? 443 : 80,
      servername: domain, path: pathname, headers: { Host: domain, 'Accept-Encoding': 'gzip' },
      // 仅本机回环读取静态文件；源站证书可能由 CDN 签发，不携带任何凭据。
      rejectUnauthorized: !origin, agent: false }, response => {
      const result = { status: response.statusCode, firstByteMs: Math.round(performance.now() - started),
        headers: Object.fromEntries(HEADER_NAMES.filter(name => response.headers[name] !== undefined)
          .map(name => [name, String(response.headers[name]).slice(0, 250)])) };
      response.resume(); response.on('end', () => resolve(result));
      response.on('error', () => resolve({ error: 'response_error' }));
    });
    request.setTimeout(10000, () => request.destroy(new Error('probe_timeout')));
    request.on('error', error => resolve({ error: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'probe_failed' }));
  });
}

async function configure({ root, frontend, reportFile, revision, apply = false }) {
  require('../config/environment').loadEnvironment(root);
  const report = { revision, state: 'unavailable', changed: false, updatedAt: new Date().toISOString() };
  const save = () => { atomicWrite(reportFile, JSON.stringify(report)); return report; };
  // 与应用的 SITE_URL 默认值一致，同时允许部署环境指定独立域名。
  const candidate = process.env.DEPLOY_STATIC_CACHE_DOMAIN || process.env.SITE_DOMAIN
    || process.env.SITE_URL || process.env.DEPLOY_PUBLIC_HEALTHCHECK_URL || 'https://wall.jay23.cn';
  let domain;
  try { domain = new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname; }
  catch { report.reason = 'site_domain_missing'; return save(); }
  if (!/^[a-z0-9.-]+$/i.test(domain) || !domain.includes('.')) { report.reason = 'site_domain_invalid'; return save(); }
  const staticRoot = fs.realpathSync(frontend || path.join(root, 'public'));
  if (!fs.existsSync(path.join(staticRoot, 'css', 'style.css')) || !fs.existsSync(path.join(staticRoot, 'js', 'app.js'))) {
    report.reason = 'static_directory_incomplete'; return save();
  }
  const binary = ['/www/server/nginx/sbin/nginx', '/usr/sbin/nginx', '/usr/local/nginx/sbin/nginx']
    .find(file => fs.existsSync(file));
  if (!binary) { report.reason = 'nginx_not_found'; return save(); }
  const cssPath = '/css/style.css?v=2026100401';
  const jsPath = '/js/theme-mode.js?v=2026101101';
  report.originBefore = await Promise.all([cssPath, jsPath, '/api/health'].map(async resource => ({ path: resource, ...await probe(domain, resource, true) })));
  async function probeEdge() {
    report.edge = [];
    for (const resource of [cssPath, jsPath]) {
      for (let round = 1; round <= 2; round++) report.edge.push({ path: resource, round, ...await probe(domain, resource) });
    }
    if ([cssPath, jsPath].every(resource => report.edge.some(result => result.path === resource
        && /hit/i.test(result.headers?.['eo-cache-status'] || '')))) report.state = 'edge_cache_hit';
    else report.reason = report.edge.every(result => result.error) ? 'edge_probe_unreachable' : 'edge_cache_not_confirmed';
  }
  if (report.originBefore.slice(0, 2).every(result => result.status === 200
      && /\bpublic\b/.test(result.headers['cache-control'] || '')
      && /max-age=[1-9]\d*/.test(result.headers['cache-control'] || '')
      && !/no-cache|no-store/.test(result.headers['cache-control'] || ''))) {
    report.origin = report.originBefore; report.state = 'origin_cache_ready';
    await probeEdge();
    return save();
  }
  // 日常部署只核对缓存。初始化/修复 Nginx 必须由管理员显式执行 --apply。
  if (!apply) { report.reason = 'origin_cache_requires_configuration'; return save(); }
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) { report.reason = 'nginx_root_required'; return save(); }
  const dump = command(binary, ['-T']);
  if (dump.status !== 0) {
    const errorText = String(dump.stderr || '');
    const version = command(binary, ['-V']);
    const versionText = String(version.stderr || '');
    report.nginx = { uid: typeof process.getuid === 'function' ? process.getuid() : null, binary,
      exitCode: dump.status, errors: ['Permission denied', 'No such file or directory', 'cannot load certificate',
        'unknown directive', 'cannot open', 'invalid', 'bind()'].filter(value => errorText.includes(value)),
      configPath: (versionText.match(/--conf-path=([^\s]+)/) || [])[1] || null };
    report.reason = 'nginx_config_unreadable'; return save();
  }
  const segments = String(dump.stdout).split(/^# configuration file (.+):\s*$/m);
  const sources = new Map();
  for (let i = 1; i + 1 < segments.length; i += 2) sources.set(segments[i], segments[i + 1]);
  function headersInScope(nodes, source, visited = new Set()) {
    const headers = [];
    for (const node of nodes) {
      if (node.name === 'add_header') headers.push(source.slice(node.start, node.end));
      if (node.name === 'add_header_inherit' && node.args.includes('merge')) throw new Error('merged_headers_require_review');
      if (node.name !== 'include' || node.args.length !== 1 || !path.isAbsolute(node.args[0])) continue;
      const pattern = new RegExp(`^${node.args[0].split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      for (const [includedPath, includedSource] of sources) {
        if (!pattern.test(includedPath) || visited.has(includedPath) || includedSource.startsWith(MARKER)) continue;
        const nextVisited = new Set(visited); nextVisited.add(includedPath);
        headers.push(...headersInScope(parse(includedSource), includedSource, nextVisited));
      }
    }
    return headers;
  }
  const matches = [];
  report.site = { frontend: staticRoot, configs: [] };
  for (let i = 1; i + 1 < segments.length; i += 2) {
    const file = segments[i]; const text = segments[i + 1];
    if (!path.isAbsolute(file) || !text.includes(domain)) continue;
    const actual = fs.readFileSync(file, 'utf8');
    for (const server of allServers(parse(actual))) {
      const names = server.children.filter(node => node.name === 'server_name').flatMap(node => node.args);
      if (!names.includes(domain)) continue;
      const listens = server.children.filter(node => node.name === 'listen').flatMap(node => node.args);
      if (!listens.some(value => /(?:^|:)443$/.test(value))) continue;
      // 对不上当前部署同步的目录时不猜测 alias/root。
      const roots = server.children.filter(node => node.name === 'root');
      report.site.configs.push({ file, roots: roots.flatMap(node => node.args) });
      if (roots.length !== 1 || roots[0].args.length !== 1 || !path.isAbsolute(roots[0].args[0])
          || !fs.existsSync(roots[0].args[0]) || fs.realpathSync(roots[0].args[0]) !== staticRoot) continue;
      matches.push({ file, actual, server });
    }
  }
  if (matches.length !== 1) { report.reason = matches.length ? 'site_config_ambiguous' : 'site_static_root_not_matched'; return save(); }
  const { file, actual, server } = matches[0];
  const includeFile = path.join(path.dirname(file), `.${domain}.public-assets.inc`);
  const alreadyManaged = actual.slice(server.start, server.end).includes(MARKER);
  if (!alreadyManaged && server.children.some(node => node.name === 'location'
      && node.args.some(arg => arg === '/css/' || arg === '/js/'))) {
    report.reason = 'existing_asset_location_requires_review'; return save();
  }
  if (!alreadyManaged && fs.existsSync(includeFile)) { report.reason = 'unmanaged_include_exists'; return save(); }
  if (alreadyManaged && !server.children.some(node => node.name === 'include' && node.args[0] === includeFile)) {
    report.reason = 'managed_include_not_matched'; return save();
  }
  // 新 location 的 add_header 会停止继承；复制服务器级和 http 级安全响应头。
  let inheritedHeaders = headersInScope(server.children, actual);
  if (!inheritedHeaders.length) {
    for (let i = 1; i + 1 < segments.length; i += 2) {
      for (const node of parse(segments[i + 1])) {
        if (node.name === 'http' && node.children) inheritedHeaders.push(...headersInScope(node.children, segments[i + 1]));
      }
    }
  }
  inheritedHeaders = inheritedHeaders.filter(line => !/^add_header\s+["']?(?:Cache-Control|Surrogate-Control|Pragma|Expires)["']?\s/i.test(line));
  const include = `${MARKER}\nlocation ~* ^/(?:css|js)/.+\\.(?:css|js)$ {\n`
    + '    autoindex off;\n    expires off;\n'
    + `    add_header Cache-Control "${CACHE}";\n    add_header Surrogate-Control "${CACHE}";\n`
    + inheritedHeaders.map(line => `    ${line}\n`).join('') + '}\n';
  // 置于原有通用 JS/CSS 规则之前，保留更早的敏感路径拦截；不使用 ^~ 跳过安全规则。
  const genericAssets = server.children.find(node => {
    if (node.name !== 'location' || !['~', '~*'].includes(node.args[0])) return false;
    try { const regex = new RegExp(node.args[1], node.args[0] === '~*' ? 'i' : '');
      return regex.test('/css/style.css') && regex.test('/js/theme-mode.js'); }
    catch { return false; }
  });
  const insertion = genericAssets ? genericAssets.start : server.close;
  const revised = alreadyManaged ? actual : `${actual.slice(0, insertion)}${MARKER}\n    include "${includeFile}";\n    ${actual.slice(insertion)}`;
  const oldInclude = fs.existsSync(includeFile) ? fs.readFileSync(includeFile) : null;
  const fileMode = fs.statSync(file).mode & 0o777;
  const backupDir = path.join(root, 'logs', 'static-cache-backups', `${Date.now()}-${revision.slice(0, 12)}`);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(backupDir, 'site.conf'), actual, { mode: 0o600 });
  if (oldInclude) fs.writeFileSync(path.join(backupDir, 'public-assets.inc'), oldInclude, { mode: 0o600 });
  fs.writeFileSync(path.join(backupDir, 'paths.json'), JSON.stringify({ file, includeFile }), { mode: 0o600 });
  let wrote = false;
  function restore() {
    if (!wrote) return;
    atomicWrite(file, actual, fileMode);
    if (oldInclude) atomicWrite(includeFile, oldInclude, 0o644);
    else if (fs.existsSync(includeFile)) fs.unlinkSync(includeFile);
    report.restored = command(binary, ['-t']).status === 0 && command(binary, ['-s', 'reload']).status === 0;
  }
  try {
    wrote = true;
    atomicWrite(includeFile, include, 0o644); atomicWrite(file, revised, fileMode);
    report.nginxSyntax = command(binary, ['-t']).status === 0;
    if (!report.nginxSyntax) throw new Error('nginx_syntax_rejected');
    report.reloaded = command(binary, ['-s', 'reload']).status === 0;
    if (!report.reloaded) throw new Error('nginx_reload_failed');
    await new Promise(resolve => setTimeout(resolve, 600));
    report.origin = await Promise.all([cssPath, jsPath, '/api/health'].map(async resource => ({ path: resource, ...await probe(domain, resource, true) })));
    if (!report.origin.slice(0, 2).every(result => result.status === 200
        && result.headers['cache-control'] === CACHE && result.headers['surrogate-control'] === CACHE)) {
      throw new Error('origin_cache_not_confirmed');
    }
    report.changed = revised !== actual || !oldInclude || oldInclude.toString() !== include;
    report.state = 'origin_cache_ready';
    await probeEdge();
  } catch (error) { report.state = 'failed'; report.reason = /^[a-z_]+$/.test(error.message) ? error.message : 'cache_configuration_failed'; restore(); }
  return save();
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--read-report') {
    try { process.stdout.write(JSON.stringify(publicReport(JSON.parse(fs.readFileSync(args[1], 'utf8')), args[2]))); }
    catch { process.stdout.write('null'); }
    return;
  }
  const [root, frontend, reportFile, revision, mode] = args;
  if (!path.isAbsolute(root || '') || !path.isAbsolute(reportFile || '') || !/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('invalid_arguments');
  const report = await configure({ root, frontend, reportFile, revision, apply: mode === '--apply' });
  console.log(`[deploy] static cache: ${report.state}${report.reason ? ` (${report.reason})` : ''}`);
}

if (require.main === module) main().catch(error => {
  const [root, , reportFile, revision] = process.argv.slice(2);
  if (path.isAbsolute(root || '') && reportFile === path.join(root, 'logs', 'deploy-static-cache.json')
      && /^[a-f0-9]{40}$/.test(revision || '')) {
    try { atomicWrite(reportFile, JSON.stringify({ revision, state: 'failed', changed: false,
      reason: /^[a-z_]+$/.test(error.message) ? error.message : 'inspection_failed', updatedAt: new Date().toISOString() })); }
    catch { /* 保留部署日志中的失败标记，不写入原始配置或异常文本。 */ }
  }
  console.error('[deploy] static cache: inspection_failed'); process.exitCode = 1;
});
module.exports = { parse, publicReport };
