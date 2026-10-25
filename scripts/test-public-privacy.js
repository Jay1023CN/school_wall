'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const { createHash } = require('crypto');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-public-privacy-'));

try {
  fs.mkdirSync(path.join(root, 'scripts'));
  // Synthetic fixtures exercise the detector without publishing original names.
  const fixtures = ['样本', '示例街', 'example'];
  const fingerprints = fixtures.map(value => [value.length, createHash('sha256').update(value).digest('hex')]);
  const checker = fs.readFileSync(path.join(__dirname, 'check-sensitive-files.js'), 'utf8')
    .replace(/const privateBrandFingerprints = \[[\s\S]*?\];/, 'const privateBrandFingerprints = ' + JSON.stringify(fingerprints) + ';');
  fs.writeFileSync(path.join(root, 'scripts/check-sensitive-files.js'), checker);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const check = (file, content, expected) => {
    fs.writeFileSync(path.join(root, file), content);
    execFileSync('git', ['add', '--', file], { cwd: root, stdio: 'pipe' });
    const result = spawnSync(process.execPath, ['scripts/check-sensitive-files.js'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (expected === 1) {
      assert.match(result.stderr, /学校标识或非公开仓库链接/);
      assert(!result.stderr.includes(content), '诊断不能回显原内容');
    }
    execFileSync('git', ['rm', '-f', '--cached', '--', file], { cwd: root, stdio: 'pipe' });
  };
  check('README.md', '校园墙，通用学校；https://github.com/owner/project；X-Gitee-Token', 0);
  check('README.md', '样本校园墙', 1);
  check('config.env.example', 'SCHOOL_NAME=样本学校', 1);
  check('README.md', '示例街校园', 1);
  check('README.md', 'EXAMPLE Campus', 1);
  const host = ['git', 'ee'].join('') + '.com';
  check('README.md', 'https://' + host + '/owner/project', 1);
  check('deploy.sh', 'git@' + host + ':owner/project.git', 1);
  console.log('[public-privacy] 通过：校名、配置样例和仓库链接被拦截，通用文案及协议字段可保留');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
