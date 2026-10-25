'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('events');
const source = fs.readFileSync(require.resolve('../services/ip-lookup'), 'utf8');
let calls = 0;
let networkCalls = 0;
let responseIp = '203.0.113.8';
const context = { module: { exports: {} }, process: { env: {} }, console, setTimeout, clearTimeout,
  require(name) {
    if (name === 'ip2region') return { default: class {
      constructor(options) { assert.equal(typeof options, 'object'); }
      search(ip) {
        calls++;
        if (ip === '203.0.113.8') return null;
        if (ip.includes(':')) return { country: '中国', province: '上海市', city: '上海' };
        return { country: '中国', province: '江苏省', city: '南京市' };
      }
    } };
    // 文档保留网段仅在本模拟服务里代表公网样本，不向真实网络发送请求。
    if (name === 'ipaddr.js') {
      const actual = require(name);
      return { parse(value) {
        const parsed = actual.parse(value);
        if (['203.0.113.8', '198.51.100.1', '2001:db8::1'].includes(parsed.toString())) parsed.range = () => 'unicast';
        return parsed;
      } };
    }
    if (name === 'https') return { get(url, options, callback) {
      networkCalls++;
      assert(url.startsWith('https://ipinfo.io/203.0.113.8/json'));
      const req = new EventEmitter(); req.destroy = () => {};
      setTimeout(() => {
        const res = new EventEmitter(); res.statusCode = 200;
        callback(res);
        res.emit('data', JSON.stringify({ ip: responseIp, region: 'Shanghai', city: 'Shanghai', country: 'CN' }));
        res.emit('end');
      }, 5);
      return req;
    } };
    return require(name);
  } };
vm.runInNewContext(source, context);
const service = context.module.exports;
(async () => {
  for (const ip of ['', null, {}, '203.0.113.8/path', '127.1', '10.0.0.1', 'fc00::1', '192.168.1.1']) {
    assert.equal(await service.getIpRegion(ip), '未知');
  }
  assert.equal(calls, 0, '非法及非公网地址不外发查询');
  assert.equal(await service.getIpRegion('::ffff:127.0.0.1'), '本地');
  assert.equal(service.normalizeIp('::ffff:203.0.113.8'), '203.0.113.8');
  assert.equal(service.getClientIp({ ip: '::ffff:203.0.113.8', headers: { 'x-real-ip': '198.51.100.1' } }), '203.0.113.8');
  assert.equal(await service.getIpRegion('198.51.100.1'), '江苏省 · 南京市');
  assert.equal(await service.getIpRegion('2001:db8::1'), '上海市');
  const results = await Promise.all([service.getIpRegion('203.0.113.8'), service.getIpRegion('::ffff:203.0.113.8')]);
  assert.deepEqual(results, ['上海', '上海']);
  assert.equal(networkCalls, 1, '同一 IP 合并查询');
  assert.equal(await service.getIpRegion('203.0.113.8'), '上海');
  assert.equal(networkCalls, 1, '查询缓存生效');
  // 新实例验证第三方返回出口 IP 时不能误用，失败缓存不返回原始地址。
  const retryContext = { ...context, module: { exports: {} } };
  vm.runInNewContext(source, retryContext);
  responseIp = '198.51.100.1';
  assert.equal(await retryContext.module.exports.getIpRegion('203.0.113.8'), '未知');
  assert.equal(await retryContext.module.exports.getIpRegion('203.0.113.8'), '未知');
  assert.equal(networkCalls, 2);
  console.log('[ip-lookup] 通过：地址校验、IPv6 离线库、去重、缓存、合并和失败隐私');
})().catch(error => { console.error(error); process.exitCode = 1; });
