'use strict';

const assert = require('assert');
const axios = require('axios');
const cloudbase = require('@cloudbase/node-sdk');
const set = require('lodash.set');
const unset = require('lodash.unset');
const manifest = require('../package.json');

function packageVersion(name) {
  return require(`${name}/package.json`).version;
}

assert.strictEqual(packageVersion('axios'), '1.20.0', 'CloudBase HTTP client must use the patched Axios release');
assert.strictEqual(axios.VERSION, '1.20.0', 'Axios runtime version must match the audited version');
assert.strictEqual(packageVersion('lodash'), '4.18.1', 'safe compatibility shims must use the pinned patched Lodash release');
assert.strictEqual(packageVersion('lodash.set'), '4.18.1', 'lodash.set must resolve to the safe compatibility shim');
assert.strictEqual(packageVersion('lodash.unset'), '4.18.1', 'lodash.unset must resolve to the safe compatibility shim');
assert.strictEqual(typeof set, 'function', 'CloudBase lodash.set compatibility API must remain callable');
assert.strictEqual(typeof unset, 'function', 'CloudBase lodash.unset compatibility API must remain callable');
assert.strictEqual(typeof cloudbase.init, 'function', 'CloudBase SDK must load with the Axios override');
assert.strictEqual(manifest.devDependencies.vite, '^6.4.3', 'Vite must use a release outside the audited vulnerable range');
assert.strictEqual(manifest.devDependencies.nodemon, undefined, 'vulnerable Nodemon dependency must be removed');
assert.strictEqual(manifest.devDependencies['@vitejs/plugin-vue'], undefined, 'unused Vue plugin must not remain in the dependency tree');
assert.strictEqual(manifest.scripts.dev, 'node --watch server.js', 'development reload must use the built-in Node watcher');

const record = {};
set(record, 'profile.nickname', 'EDITOR');
assert.strictEqual(record.profile.nickname, 'EDITOR', 'safe setter must retain nested property behavior');
set(record, '__proto__.polluted', true);
set(record, 'constructor.prototype.polluted', true);
unset(record, '__proto__.polluted');
unset(record, 'constructor.prototype.polluted');
assert.strictEqual({}.polluted, undefined, 'lodash compatibility functions must not pollute Object.prototype');

const client = axios.create({ baseURL: 'https://example.invalid' });
assert.strictEqual(client.getUri({ url: '/health' }), 'https://example.invalid/health', 'Axios 1.x request construction must work');

console.log('[dependency-safety] 通过：CloudBase 依赖覆盖、Axios 兼容性与 Lodash 原型污染防护');
