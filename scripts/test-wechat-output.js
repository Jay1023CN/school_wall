/*
 * 离线验证公众号聊天输出：不连接数据库、不读取公众号密钥。
 * 覆盖用户提交的歌曲名在 XML CDATA 中的安全边界，以及「推歌」入口文案。
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');

const replyPath = path.join(__dirname, '..', 'services', 'wechat-reply.js');
const originalLoad = Module._load;
let aiCalls = 0;
let availableRegCode = '';
let pendingRegCode = '';
let verifiedRegCode = '';

Module._load = function(request, parent, isMain) {
  if (request === '../config/database') {
    return {
      pool: {
        execute: async function(sql, params) {
          if (sql.includes('SELECT id FROM users WHERE openid')) return [[]];
          if (sql.includes('SELECT id, code, openid, verified, used FROM wechat_reg_codes')) {
            const requestedCode = params && params[0];
            return requestedCode === availableRegCode && availableRegCode
              ? [[{ id: 1, code: availableRegCode, openid: null, verified: 0, used: 0 }]]
              : [[]];
          }
          if (sql.includes('UPDATE wechat_reg_codes SET verified = 1')) {
            if (!availableRegCode) return [{ affectedRows: 0 }];
            verifiedRegCode = availableRegCode;
            availableRegCode = '';
            pendingRegCode = verifiedRegCode;
            return [{ affectedRows: 1 }];
          }
          if (sql.includes('UPDATE wechat_reg_codes SET used = 1')) return [{ affectedRows: 0 }];
          if (sql.includes('WHERE openid = ? AND verified = 1 AND used = 0')) {
            return [pendingRegCode ? [{ code: pendingRegCode }] : []];
          }
          return [[]];
        }
      }
    };
  }
  if (request === './ai') return { getAIReply: async function() { aiCalls += 1; return '不应出现的 AI 回复'; } };
  if (request === './wechat-flows') return {};
  if (request === './mp-draft') return {};
  if (request === './wechat') return {};
  return originalLoad.call(this, request, parent, isMain);
};

let reply;
try {
  reply = require(replyPath);
} finally {
  Module._load = originalLoad;
}

const persona = require(path.join(__dirname, '..', 'services', 'wechat-persona.js'));

const xml = reply.buildTextReply('openid]]>x', 'account', '《测试]]>歌曲》');
assert.ok(xml.includes('<![CDATA[openid]]]]><![CDATA[>x]]>'), 'openid 中的 CDATA 结束符必须被拆分');
assert.ok(xml.includes('<![CDATA[《测试]]]]><![CDATA[>歌曲》]]>'), '正文中的 CDATA 结束符必须被拆分');
assert.ok(!xml.includes('<![CDATA[《测试]]>歌曲》]]>'), '不得保留未拆分的 CDATA 结束符');

const help = persona.help();
const start = persona.songStartPush();
const confirm = persona.songConfirm('A & B', '歌手');
const success = persona.songPushSuccess('A & B', '歌手');
const namedConfirm = persona.songConfirm('A & B', '歌手', '账号昵称');
const namedSuccess = persona.songPushSuccess('A & B', '歌手', '账号昵称');
const nicknameRequired = persona.songNicknameRequired();
assert.ok(help.includes('一首歌的时间'), '帮助菜单应说明公众号推歌入口');
assert.ok(help.includes('点歌') && help.includes('广播') && help.includes('推歌') && help.includes('公众号'), '帮助菜单应区分广播点歌和公众号推歌');
assert.ok(start.includes('一首歌的时间'), '推歌首屏应说明投稿去向');
assert.ok(start.includes('点歌') && start.includes('公众号'), '推歌首屏应说明其与校园广播点歌的区别');
assert.ok(!persona.songAskArtist('测试曲').includes('跳过'), '推歌歌手不能再允许跳过');
assert.ok(persona.songArtistRequired().includes('歌手姓名'), '未填写歌手时应提示必填');
assert.ok(persona.songNotFound('测试曲', '测试歌手').includes('暂时没有搜到'), '搜不到歌曲时应明确告知');
const radioGuide = persona.radioSongGuide();
assert.ok(radioGuide.includes('校园广播') && radioGuide.includes('公众号') && radioGuide.includes('/radio'), '点歌指引应先区分用途，再提供校园广播网页入口');
assert.ok(confirm.includes('一首歌的时间') && confirm.includes('确认'), '确认步骤应保留确认命令');
assert.ok(success.includes('候选') && success.includes('审核'), '成功反馈不能暗示未审核内容已发布');
assert.ok(namedConfirm.includes('署名：账号昵称'), '点歌确认应展示实际署名');
assert.ok(namedSuccess.includes('署名：账号昵称'), '点歌成功应展示实际署名');
assert.ok(nicknameRequired.includes('填写') && nicknameRequired.includes('绑定'), '无可用账号署名时应提示填写或绑定');

const flowSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'wechat-flows.js'), 'utf8');
assert.ok(flowSource.includes('is_anonymous, created_at') && flowSource.includes(', 0, NOW()'), '投稿 INSERT 必须显式写入非匿名');
assert.ok(flowSource.includes('SELECT id, nickname, username FROM users WHERE openid = ?'), '投稿必须读取绑定账号署名');
assert.ok(!flowSource.includes("'匿名同学'"), '点歌和投稿流程不得自动回退匿名同学');

(async function() {
  const regReply = await reply.handleText('openid', 'account', 'reg');
  assert.ok(regReply.includes('/register') && regReply.includes('REG'), 'reg 必须返回固定注册指引');
  const bindReply = await reply.handleText('openid', 'account', '绑定');
  assert.ok(bindReply.includes('微信绑定教程'), '绑定必须返回固定绑定指引');
  availableRegCode = 'REGABCDEF12';
  const codeReply = await reply.handleText('openid', 'account', availableRegCode);
  assert.ok(codeReply.includes('微信验证已完成') && codeReply.includes(availableRegCode), '首次 REG 必须说明验证完成但账号尚未创建');
  pendingRegCode = 'REGABCDEF12';
  const duplicateReply = await reply.handleText('openid', 'account', 'REG76543210');
  assert.ok(duplicateReply.includes('无需再发送新的 REG') && duplicateReply.includes(pendingRegCode), '重复 REG 必须恢复原流程而不是继续确认新验证码');
  availableRegCode = 'REGNEWCD01';
  const newCodeReply = await reply.handleText('openid', 'account', availableRegCode);
  assert.ok(newCodeReply.includes('微信验证已完成') && newCodeReply.includes(availableRegCode), '新 REG 必须优先于旧的已验证待提交记录');
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  assert.ok(authSource.includes('used: !!record.used') && authSource.includes("state = record.used ? 'registered'"), '注册码状态接口必须区分已注册和仅微信验证');
  const registerSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'register.html'), 'utf8');
  assert.ok(registerSource.includes('pollRegCodeStatus({ manual: true })'), '恢复 REG 验证码后必须立即主动检查状态');
  assert.ok(registerSource.includes('检查并继续') && registerSource.includes('暂时无法检查验证状态'), 'REG 恢复流程必须提供明确的操作和错误反馈');
  assert.ok(registerSource.includes('scheduleRegCodeStatusCheck') && registerSource.includes('clearRegCodePollTimer'), 'REG 轮询必须能管理定时器，避免重复轮询');
  assert.strictEqual(aiCalls, 0, '注册/绑定指令及验证码不得调用 AI');
  console.log('wechat output static checks passed');
})().catch(function(error) {
  console.error(error);
  process.exitCode = 1;
});
