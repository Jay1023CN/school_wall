'use strict';

const assert = require('assert');
const fs = require('fs');
const express = require('express');
const os = require('os');
const path = require('path');
const http = require('http');
const databasePath = require.resolve('../config/database');
let generatedRegistrationCodes = 0;
const loginAttemptQueries = [];
const fakePool = {
  async execute(sql) {
    if (sql.includes('SELECT config_key, config_value FROM settings')) return [[], []];
    if (sql.includes('FROM login_attempts')) {
      loginAttemptQueries.push(sql);
      return [[{ cnt: loginAttemptQueries.length === 1 ? 0 : 4 }], []];
    }
    if (sql.includes('INSERT INTO wechat_reg_codes')) {
      generatedRegistrationCodes += 1;
      return [{ insertId: generatedRegistrationCodes }, []];
    }
    return [[], []];
  }
};
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { pool: fakePool }
};
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-for-auth-upload';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-wall-auth-upload-'));
process.env.UPLOAD_DIR = testRoot;

const storage = require('../services/avatar-storage');
const upload = require('../routes/upload');
const auth = require('../routes/auth');

function filterResult(file) {
  return new Promise(function(resolve, reject) {
    upload.imageFileFilter({}, file, function(err, accepted) {
      if (err) return resolve({ err, accepted });
      resolve({ err: null, accepted });
    });
  });
}

async function main() {
  storage.ensureUploadDirs();
  const validPng = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const validPath = path.join(storage.AVATAR_DIR, 'avatar_valid.png');
  const oversizedPath = path.join(storage.AVATAR_DIR, 'avatar_oversized.png');
  fs.writeFileSync(validPath, validPng);
  fs.writeFileSync(oversizedPath, Buffer.concat([validPng, Buffer.alloc(16)]));

  assert.strictEqual(storage.resolveManagedImagePath(path.join(storage.AVATAR_DIR, '..', 'outside.txt')), null);
  assert.strictEqual(storage.resolveManagedImagePath(path.join(storage.AVATAR_DIR, 'default.png')), null);
  assert.strictEqual(await storage.validateImageFile(validPath, { maxBytes: 1024 }), true);
  assert.strictEqual(await storage.validateImageFile(oversizedPath, { maxBytes: 12 }), false);
  assert.strictEqual(upload.getSafeImageExtension({ originalname: 'avatar.PNG' }), '.png');
  assert.strictEqual(upload.getSafeImageExtension({ originalname: '../avatar.png' }), null);
  assert.strictEqual((await filterResult({ fieldname: 'avatar', originalname: 'a.png', mimetype: 'image/png' })).accepted, true);
  assert.strictEqual((await filterResult({ fieldname: 'avatar', originalname: 'a.svg', mimetype: 'image/svg+xml' })).err.code, 'LIMIT_UNEXPECTED_FILE');

  const captchaRoute = auth.stack.find(layer => layer.route && layer.route.path === '/captcha').route;
  let captchaResponse;
  await captchaRoute.stack[0].handle({}, { json(body) { captchaResponse = body; return body; } });
  assert.strictEqual(captchaResponse.code, 200);
  const captchaPng = Buffer.from(captchaResponse.data.captcha, 'base64');
  assert.deepStrictEqual(captchaPng.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), '验证码必须返回 PNG 栅格图');
  assert(!captchaResponse.data.captcha.includes('<svg'), '验证码响应不能包含可解析的 SVG 字形或路径');
  assert.strictEqual(typeof captchaResponse.data.key, 'string');

  const loginLimit = await auth.checkLoginRateLimit('192.0.2.10');
  assert.strictEqual(loginLimit.blocked, false, '账号失败次数达到阈值后不得锁定账号');
  assert.strictEqual(loginLimit.needCaptcha, true, '账号失败次数达到阈值后应要求验证码');
  assert.strictEqual(loginAttemptQueries.length, 2, '登录失败计数应检查来源 IP 和账号验证码状态');
  assert(loginAttemptQueries.some(function(sql) { return /username\s*=/.test(sql); }), '账号失败次数应只用于要求验证码');

  const registrationRoute = auth.stack.find(layer => layer.route && layer.route.path === '/generate-reg-code').route;
  const generateRegistrationCode = registrationRoute.stack[0].handle;
  const ip = 'auth-upload-test-' + process.pid;
  async function generateCode() {
    let response;
    let status = 200;
    await generateRegistrationCode({
      ip,
      body: { username: 'test-user', password: 'test-password', nickname: '测试用户' }
    }, {
      status(code) { status = code; return this; },
      json(body) { response = body; return body; }
    });
    return { status, body: response };
  }
  assert.strictEqual((await generateCode()).body.code, 200);
  assert.strictEqual((await generateCode()).body.code, 200);
  assert.strictEqual((await generateCode()).body.code, 200);
  const throttledRegistration = await generateCode();
  assert.strictEqual(throttledRegistration.body.code, 429, '微信注册码生成必须受每 IP 注册频率限制');
  assert.strictEqual(throttledRegistration.status, 429, '注册频率限制必须返回真实 HTTP 429');
  assert.strictEqual(generatedRegistrationCodes, 3, '超出频率后不得继续执行数据库写入');

  const uploadLimiterApp = express();
  uploadLimiterApp.use(function(req, res, next) {
    req.user = { id: req.headers['x-test-user'] || 'limiter-user-a' };
    next();
  });
  uploadLimiterApp.post('/upload', upload.uploadIpLimiter, upload.uploadUserLimiter, function(req, res) {
    res.json({ code: 200 });
  });
  const server = http.createServer(uploadLimiterApp);
  await new Promise(function(resolve) { server.listen(0, '127.0.0.1', resolve); });
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/upload';
    for (let attempt = 0; attempt < 30; attempt++) {
      assert.strictEqual((await fetch(endpoint, { method: 'POST' })).status, 200, '账号上传限额内应允许请求');
    }
    assert.strictEqual((await fetch(endpoint, { method: 'POST' })).status, 429, '超过账号上传限额必须在 Multer 前拦截');
    assert.strictEqual((await fetch(endpoint, { method: 'POST', headers: { 'x-test-user': 'limiter-user-b' } })).status, 200, '账号限额应彼此独立');
  } finally {
    await new Promise(function(resolve) { server.close(resolve); });
  }
  console.log('Auth/upload security tests passed');
}

main()
  .catch(function(err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(function() {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });
