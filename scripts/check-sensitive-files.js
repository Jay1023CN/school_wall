'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const checkerPath = path.relative(projectRoot, __filename).replace(/\\/g, '/');
const riskyName = /(^|\/)(\.env(?!\.example)(?:\.[^/]*)?|.*\.(?:pem|key|p12|pfx)|id_rsa(?:\.[^/]*)?)$/i;
const secretAssignment = /\b(?:api[_-]?key|access[_-]?token|deploy[_-]?secret|jwt[_-]?secret|password)\b\s*[:=]\s*(?!process\.env\b|\$\{|(?:['"]?)(?:your|change|replace|example|placeholder|xxx|这里|填写)\b)(?:[`'"][A-Za-z0-9_+/=-]{16,}[`'"]|[A-Za-z0-9_+/=-]{16,}(?=\s*(?:;|$)))/i;
const shellPasswordArgument = /\b(?:mysql|mysqldump)\b[^\r\n]*\s-p(?!\s*(?:["']?\$|["']?\{))["']?[A-Za-z0-9_+/=-]{4,}/i;
const urlCredential = /[?&](?:token|api[_-]?key|password)=[A-Za-z0-9_+/=-]{16,}/i;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Store only fingerprints: public checks must not carry reversible institution names.
const privateBrandFingerprints = [
  [2, '52104b37f376370a9b7570968245bd68019ade4e4211b9293e116fc39e9bca04'],
  [2, 'e5f599c1739e6d1ecd0855dde4305be9d42ec91749f88ab6211b69c21e9c705d'],
  [3, '17eaaba85c5ff1f56abaadb6e06a8482d88c894b07314bfba4dd7adf551a2e14'],
  [7, '96e387619769f4aafa5b1c8e16ade9d4cfc524b0d5f1c068f6f0115614478b34']
];
const brandCache = new Map();
function hasPrivateBrand(line) {
  const tokens = line.toLowerCase().match(/[\p{Script=Han}]+|[a-z]+/gu) || [];
  for (const token of tokens) {
    if (!brandCache.has(token)) {
      let matched = false;
      for (const [length, expected] of privateBrandFingerprints) {
        for (let i = 0; i <= token.length - length; i++) {
          const hash = createHash('sha256').update(token.slice(i, i + length)).digest('hex');
          if (hash === expected) { matched = true; break; }
        }
        if (matched) break;
      }
      brandCache.set(token, matched);
    }
    if (brandCache.get(token)) return true;
  }
  return false;
}
const privateRepository = /gitee(?:\\?\.)com/i;
const privateAssetHashes = new Set([
  '3c4725d6c2eea7334b9dfedd0766405b71f1d294ab6a6452e8a73ecc91fcdd02',
  'bb58541eccefb285c51b55c50a1aa4cc708e19e8848700f7e1091e63e25fd267',
  '87310aef74671489e7a8fcdcf1db748d46f6188fd261a67a4b655b9e0e9cec02'
]);

function isPrivateOrPlaceholderIp(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => part < 0 || part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    // RFC 5737 documentation networks are fixtures, never real server addresses.
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
    (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    value === '255.255.255.255';
}

function getTrackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

const trackedFiles = getTrackedFiles().filter(file => file !== checkerPath);
const issues = [];
for (const file of trackedFiles) {
  if (riskyName.test(file)) {
    issues.push({ file, line: 1, kind: '敏感文件名' });
    continue;
  }

  const absolutePath = path.join(projectRoot, file);
  let content;
  try {
    const bytes = fs.readFileSync(absolutePath);
    if (privateAssetHashes.has(createHash('sha256').update(bytes).digest('hex'))) {
      issues.push({ file, line: 1, kind: '原站点专属图片' });
    }
    content = bytes.toString('utf8');
  } catch (_) {
    continue;
  }
  if (content.includes('\u0000')) continue;

  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (hasPrivateBrand(line) || privateRepository.test(line)) {
      issues.push({ file, line: index + 1, kind: '学校标识或非公开仓库链接' });
    }
    if (secretAssignment.test(line)) {
      issues.push({ file, line: index + 1, kind: '疑似硬编码凭据' });
    }
    if (shellPasswordArgument.test(line) || urlCredential.test(line)) {
      issues.push({ file, line: index + 1, kind: '疑似命令行或 URL 凭据' });
    }
    const publicIps = /user-agent/i.test(line) ? [] : (line.match(ipv4) || []);
    if (publicIps.some(ip => !isPrivateOrPlaceholderIp(ip))) {
      issues.push({ file, line: index + 1, kind: '疑似公网地址' });
    }
  });
}

if (issues.length > 0) {
  console.error('[privacy] 检查未通过：发现以下文件/行，请移除或改用环境变量：');
  issues.forEach(issue => console.error(`- ${issue.file}:${issue.line} (${issue.kind})`));
  process.exitCode = 1;
} else {
  console.log(`[privacy] 通过：已检查 ${trackedFiles.length} 个文件，未发现已知学校标识、仓库链接、专属图片或明显凭据`);
}
