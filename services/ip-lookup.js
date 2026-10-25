'use strict';
const { isIP } = require('net');
const https = require('https');
const IP2Region = require('ip2region').default;
const ipaddr = require('ipaddr.js');

let database;
try {
  database = new IP2Region({
    ipv4db: process.env.IP_REGION_IPV4_DB || undefined,
    ipv6db: process.env.IP_REGION_IPV6_DB || undefined
  });
} catch (_) {
  console.warn('[IP] 离线归属地库不可用，将使用有超时限制的在线查询');
}

function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  const input = value.trim();
  if (!isIP(input)) return '';
  const parsed = ipaddr.parse(input);
  return parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address().toString() : parsed.toString();
}

function getClientIp(req) {
  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

function formatRegion(parts) {
  const unique = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const value = toChineseRegion(part.trim());
    if (!value || value === '0' || value === '未知') continue;
    const key = value.replace(/省$|市$/g, '');
    if (!unique.some(item => item.replace(/省$|市$/g, '') === key)) unique.push(value);
  }
  return unique.join(' · ');
}

function queryOnline(ip) {
  return new Promise(resolve => {
    let done = false;
    let request;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { finish(null); request?.destroy(); }, 2500);
    try {
      request = https.get('https://ipinfo.io/' + encodeURIComponent(ip) + '/json', { timeout: 2500 }, response => {
        if (response.statusCode !== 200) { response.resume(); finish(null); return; }
        let data = '';
        response.on('data', chunk => {
          data += chunk;
          if (data.length > 16384) { finish(null); response.destroy(); }
        });
        response.on('error', () => finish(null));
        response.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (normalizeIp(json.ip) !== ip || json.bogon || json.error) return finish(null);
            finish(formatRegion([json.region, json.city, json.country !== 'CN' ? json.country : '']));
          } catch (_) { finish(null); }
        });
      });
      request.on('error', () => finish(null));
      request.on('timeout', () => { finish(null); request.destroy(); });
    } catch (_) { finish(null); }
  });
}

const cache = new Map();
const pending = new Map();
async function getIpRegion(value) {
  const ip = normalizeIp(value);
  if (!ip) return '未知';
  const range = ipaddr.parse(ip).range();
  if (range === 'loopback') return '本地';
  if (range !== 'unicast') return '未知';
  const hit = cache.get(ip);
  if (hit && hit.expires > Date.now()) return hit.region;
  if (pending.has(ip)) return pending.get(ip);
  let region = '';
  try {
    const result = database?.search(ip);
    if (result) region = formatRegion([result.province, result.city]) || formatRegion([result.country]);
  } catch (_) {   }
  const remember = result => {
    const region = result || '未知';
    cache.set(ip, { region, expires: Date.now() + (result ? 86400000 : 60000) });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return region;
  };
  if (region) return remember(region);
  if (pending.size >= 8) return '未知';
  const lookup = queryOnline(ip).then(remember).finally(() => pending.delete(ip));
  pending.set(ip, lookup);
  return lookup;
}

var CN_MAP = {
  'Shanghai':'上海', 'Beijing':'北京', 'Guangzhou':'广州', 'Shenzhen':'深圳',
  'Chengdu':'成都', 'Hangzhou':'杭州', 'Wuhan':'武汉', 'Nanjing':'南京',
  'Chongqing':'重庆', 'Tianjin':'天津', 'Shenyang':'沈阳', 'Suzhou':'苏州',
  'Xi\'an':'西安', 'Changsha':'长沙', 'Zhengzhou':'郑州', 'Dongguan':'东莞',
  'Qingdao':'青岛', 'Ningbo':'宁波', 'Kunming':'昆明', 'Dalian':'大连',
  'Xiamen':'厦门', 'Fuzhou':'福州', 'Hefei':'合肥', 'Harbin':'哈尔滨',
  'Jinan':'济南', 'Wuxi':'无锡', 'Changchun':'长春', 'Guiyang':'贵阳',
  'Nanning':'南宁', 'Zhuhai':'珠海', 'Taiyuan':'太原', 'Xuzhou':'徐州',
  'Lanzhou':'兰州', 'Haikou':'海口', 'Urumqi':'乌鲁木齐', 'Hohhot':'呼和浩特',
  'Macau':'澳门', 'Hong Kong':'香港', 'Taipei':'台北', 'Taichung':'台中',
  'Kaohsiung':'高雄', 'Tainan':'台南',
  'Zhejiang':'浙江', 'Jiangsu':'江苏', 'Guangdong':'广东', 'Sichuan':'四川',
  'Fujian':'福建', 'Hubei':'湖北', 'Hunan':'湖南', 'Shandong':'山东',
  'Henan':'河南', 'Hebei':'河北', 'Anhui':'安徽', 'Jiangxi':'江西',
  'Liaoning':'辽宁', 'Yunnan':'云南', 'Shanxi':'山西', 'Jilin':'吉林',
  'Heilongjiang':'黑龙江', 'Shaanxi':'陕西', 'Gansu':'甘肃', 'Guizhou':'贵州',
  'Hainan':'海南', 'Qinghai':'青海', 'Neimenggu':'内蒙古', 'Xizang':'西藏',
  'Ningxia':'宁夏', 'Xinjiang':'新疆', 'Guangxi':'广西'
};

function toChineseRegion(region) {
  if (!region) return region;
  var result = region;
  for (var key in CN_MAP) {
    var regex = new RegExp('\\b' + key + '\\b', 'g');
    result = result.replace(regex, CN_MAP[key]);
  }
  return result;
}


module.exports = { getIpRegion, getClientIp, toChineseRegion, normalizeIp };
