'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');
const Module = require('module');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakePool(initialState) {
  const pool = {
    state: clone(initialState),
    failure: null,
    connections: [],
    async getConnection() {
      const connection = {
        state: null,
        begun: false,
        committed: false,
        rolledBack: false,
        released: false,
        pollOptionWrites: 0,
        async beginTransaction() {
          this.state = clone(pool.state);
          this.begun = true;
        },
        async commit() {
          pool.state = this.state;
          this.committed = true;
        },
        async rollback() {
          this.rolledBack = true;
        },
        release() {
          this.released = true;
        },
        async execute(sql, params = []) {
          const normalized = sql.trim().replace(/\s+/g, ' ').toLowerCase();
          const fail = (needle) => {
            if (pool.failure && normalized.includes(needle)) {
              pool.failure.seen = (pool.failure.seen || 0) + 1;
              if (pool.failure.seen === pool.failure.nth) throw new Error('injected failure: ' + needle);
            }
          };

          if (normalized.startsWith('select config_value from settings')) return [[{ config_value: 'false' }], []];
          if (normalized.startsWith('select id from posts where id = ? and status')) {
            return [this.state.posts.some(post => String(post.id) === String(params[0]) && post.status === 'approved' && !post.is_deleted)
              ? [{ id: Number(params[0]) }]
              : [], []];
          }
          if (normalized.startsWith('select id, user_id from posts where id = ? and status')) {
            const post = this.state.posts.find(item => String(item.id) === String(params[0]) && item.status === 'approved' && !item.is_deleted);
            return [post ? [{ id: post.id, user_id: post.user_id }] : [], []];
          }
          if (normalized.startsWith('select id, user_id from comments where id = ? and post_id = ?')) {
            const comment = this.state.comments.find(item => String(item.id) === String(params[0]) && String(item.post_id) === String(params[1]));
            return [comment ? [{ id: comment.id, user_id: comment.user_id }] : [], []];
          }
          if (normalized.startsWith('select user_id, title, content, is_anonymous, is_deleted, poll_type from posts')) {
            const post = this.state.posts.find(item => String(item.id) === String(params[0]));
            return [post ? [clone(post)] : [], []];
          }
          if (normalized.startsWith('select config_value from settings')) return [[{ config_value: 'false' }], []];
          if (normalized.startsWith('insert into posts')) {
            const row = { id: this.state.nextPostId++, user_id: params[0], title: params[1], content: params[2], is_anonymous: params[6], status: params[10], poll_type: null, is_deleted: 0 };
            this.state.posts.push(row);
            return [{ insertId: row.id, affectedRows: 1 }, []];
          }
          if (normalized.startsWith('insert into comments')) {
            const row = { id: this.state.nextCommentId++, post_id: params[0], user_id: params[1], content: params[2] };
            this.state.comments.push(row);
            return [{ insertId: row.id, affectedRows: 1 }, []];
          }
          if (normalized.startsWith('update posts set comments_count = comments_count + 1')) {
            fail('update posts set comments_count = comments_count + 1');
            const post = this.state.posts.find(item => String(item.id) === String(params[0]));
            if (post) post.comments_count = Number(post.comments_count || 0) + 1;
            return [{ affectedRows: post ? 1 : 0 }, []];
          }
          if (normalized.startsWith('delete from comments where id = ? and post_id = ?')) {
            const before = this.state.comments.length;
            this.state.comments = this.state.comments.filter(item => !(String(item.id) === String(params[0]) && String(item.post_id) === String(params[1])));
            return [{ affectedRows: before - this.state.comments.length }, []];
          }
          if (normalized.startsWith('update posts set comments_count = greatest')) {
            fail('update posts set comments_count = greatest');
            const post = this.state.posts.find(item => String(item.id) === String(params[0]));
            if (post) post.comments_count = Math.max(0, Number(post.comments_count || 0) - 1);
            return [{ affectedRows: post ? 1 : 0 }, []];
          }
          if (normalized.startsWith('delete from poll_votes')) {
            this.state.pollVotes = [];
            return [{ affectedRows: 1 }, []];
          }
          if (normalized.startsWith('delete from poll_options')) {
            this.state.pollOptions = [];
            return [{ affectedRows: 1 }, []];
          }
          if (normalized.startsWith('insert into poll_options')) {
            this.pollOptionWrites += 1;
            fail('insert into poll_options');
            const row = { id: this.state.nextPollOptionId++, post_id: params[0], option_text: params[1], votes_count: 0 };
            this.state.pollOptions.push(row);
            return [{ insertId: row.id, affectedRows: 1 }, []];
          }
          if (normalized.startsWith('update posts set poll_type =')) {
            const post = this.state.posts.find(item => String(item.id) === String(params[1]));
            if (post) post.poll_type = params[0];
            return [{ affectedRows: post ? 1 : 0 }, []];
          }
          if (normalized.startsWith('update posts set') && normalized.includes('where id = ? and is_deleted = 0')) {
            const post = this.state.posts.find(item => String(item.id) === String(params[params.length - 1]));
            if (!post) return [{ affectedRows: 0 }, []];
            if (normalized.includes('title = ?')) post.title = params[0];
            if (normalized.includes('status = ?')) post.status = params[params.length - 3];
            return [{ affectedRows: 1 }, []];
          }
          if (normalized.startsWith('select id, user1_id, user2_id from conversations')) {
            const conversation = this.state.conversations.find(item => String(item.id) === String(params[0]) &&
              (String(item.user1_id) === String(params[1]) || String(item.user2_id) === String(params[2])));
            return [conversation ? [clone(conversation)] : [], []];
          }
          if (normalized.startsWith('select id from blocked_users')) return [[], []];
          if (normalized.startsWith('insert into messages')) {
            const row = { id: this.state.nextMessageId++, conversation_id: params[0], sender_id: params[1], content: params[2], created_at: '2026-10-04 12:00:00' };
            this.state.messages.push(row);
            return [{ insertId: row.id, affectedRows: 1 }, []];
          }
          if (normalized.startsWith('update conversations set last_message_at')) {
            fail('update conversations set last_message_at');
            const conversation = this.state.conversations.find(item => String(item.id) === String(params[1]));
            if (conversation) {
              const message = this.state.messages.find(item => String(item.id) === String(params[0]));
              conversation.last_message_at = message ? message.created_at : null;
              conversation.updated_at = '2026-10-04 12:00:00';
            }
            return [{ affectedRows: conversation ? 1 : 0 }, []];
          }
          if (normalized.startsWith('select m.id, m.conversation_id, m.sender_id, m.content, m.is_read')) {
            const message = this.state.messages.find(item => String(item.id) === String(params[0]));
            return [message ? [{ ...clone(message), is_read: 0, read_at: null, sender_nickname: '测试用户', sender_avatar: '/avatar.png' }] : [], []];
          }
          throw new Error('unexpected SQL: ' + sql);
        }
      };
      pool.connections.push(connection);
      return connection;
    },
    async execute(sql) {
      throw new Error('unexpected pool SQL outside transaction: ' + sql);
    }
  };
  return pool;
}

function loadRouters(pool) {
  const auth = (req, res, next) => {
    req.user = { id: 7, username: '测试用户', nickname: '测试用户', role: 'user' };
    next();
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../config/database') return { pool };
    if (request === '../middleware/auth') return { auth, optionalAuth: auth, isStaffRole: role => role === 'admin' || role === 'super_admin' };
    if (request === '../services/ip-lookup') return { getIpRegion: async () => '', getClientIp: () => '127.0.0.1' };
    if (request === '../services/email') return {
      notifyNewComment: async () => {}, notifyNewLike: async () => {}, notifyMention: async () => {},
      notifyFollowPost: async () => {}, notifyAdminNewPostPending: async () => {}
    };
    if (request === '../services/notification') return { createNotification: async () => {} };
    if (request === '../services/baidu-push') return { pushPost: async () => {} };
    if (request === '../services/gamification') return { adjustUserPoints: async () => {} };
    if (request === '../services/async-utils') return { runBackgroundTask: (_name, task) => Promise.resolve().then(task) };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    for (const name of ['../routes/posts', '../routes/messages']) {
      const resolved = require.resolve(name);
      delete require.cache[resolved];
    }
    return {
      posts: require('../routes/posts'),
      messages: require('../routes/messages')
    };
  } finally {
    Module._load = originalLoad;
  }
}

async function startHttpServer(pool) {
  const routers = loadRouters(pool);
  const app = express();
  app.use(express.json());
  app.use('/api/posts', routers.posts);
  app.use('/api/messages', routers.messages);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(baseUrl + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function putJson(baseUrl, path, body) {
  const response = await fetch(baseUrl + path, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function deleteJson(baseUrl, path) {
  const response = await fetch(baseUrl + path, { method: 'DELETE' });
  return { status: response.status, body: await response.json() };
}

async function expectFailure(serverContext, pool, request, message) {
  const result = await request();
  assert(result.status === 200 || result.status === 500, message + ' should return an HTTP response');
  assert.strictEqual(result.body.code, 500, message + ' should return application error');
  assert(pool.connections.length > 0, message + ' should acquire a transaction connection');
  const connection = pool.connections[pool.connections.length - 1];
  assert(connection.begun && connection.rolledBack, message + ' should roll back the transaction');
  assert(!connection.committed && connection.released, message + ' should release without committing');
  pool.failure = null;
}

async function main() {
  const pool = createFakePool({
    posts: [{ id: 1, user_id: 7, title: '旧标题', content: '旧内容', status: 'approved', is_anonymous: 0, is_deleted: 0, poll_type: 'single', comments_count: 1 }],
    comments: [{ id: 11, post_id: 1, user_id: 7, content: '旧评论' }],
    pollOptions: [{ id: 21, post_id: 1, option_text: '旧选项 A', votes_count: 1 }, { id: 22, post_id: 1, option_text: '旧选项 B', votes_count: 0 }],
    pollVotes: [{ option_id: 21, user_id: 7 }],
    conversations: [{ id: 3, user1_id: 7, user2_id: 9, last_message_at: '2026-10-03 10:00:00', updated_at: '2026-10-03 10:00:00' }],
    messages: [],
    nextPostId: 2,
    nextCommentId: 12,
    nextPollOptionId: 23,
    nextMessageId: 1
  });
  const context = await startHttpServer(pool);
  const oldConsoleError = console.error;
  console.error = () => {};
  try {
    pool.failure = { needle: 'update posts set comments_count = comments_count + 1', nth: 1 };
    await expectFailure(context, pool,
      () => postJson(context.baseUrl, '/api/posts/1/comments', { content: '新评论' }),
      'comment create second-step failure');
    assert.strictEqual(pool.state.comments.length, 1, 'failed comment count update must not leave the inserted comment');
    assert.strictEqual(pool.state.posts[0].comments_count, 1, 'failed comment create must preserve the old count');

    pool.failure = { needle: 'update posts set comments_count = greatest', nth: 1 };
    await expectFailure(context, pool,
      () => deleteJson(context.baseUrl, '/api/posts/1/comments/11'),
      'comment delete second-step failure');
    assert.strictEqual(pool.state.comments.length, 1, 'failed comment delete count update must restore the comment');
    assert.strictEqual(pool.state.posts[0].comments_count, 1, 'failed comment delete must preserve the old count');

    pool.state.posts = [];
    pool.state.comments = [];
    pool.state.pollOptions = [];
    pool.state.pollVotes = [];
    pool.failure = { needle: 'insert into poll_options', nth: 2 };
    await expectFailure(context, pool,
      () => postJson(context.baseUrl, '/api/posts', { title: '新投票', content: '说明', pollOptions: ['选项 A', '选项 B'] }),
      'post poll second-option failure');
    assert.strictEqual(pool.state.posts.length, 0, 'failed poll create must not leave its post');
    assert.strictEqual(pool.state.pollOptions.length, 0, 'failed poll create must not leave partial options');

    pool.state.posts = [{ id: 1, user_id: 7, title: '旧标题', content: '旧内容', status: 'approved', is_anonymous: 0, is_deleted: 0, poll_type: 'single', comments_count: 0 }];
    pool.state.pollOptions = [{ id: 21, post_id: 1, option_text: '旧选项 A', votes_count: 1 }, { id: 22, post_id: 1, option_text: '旧选项 B', votes_count: 0 }];
    pool.state.pollVotes = [{ option_id: 21, user_id: 7 }];
    pool.failure = { needle: 'insert into poll_options', nth: 2 };
    await expectFailure(context, pool,
      () => putJson(context.baseUrl, '/api/posts/1', { title: '新标题', pollOptions: ['新选项 A', '新选项 B'], pollType: 'multiple' }),
      'post edit poll second-option failure');
    assert.strictEqual(pool.state.posts[0].title, '旧标题', 'failed poll edit must restore the post fields');
    assert.deepStrictEqual(pool.state.pollOptions.map(option => option.option_text), ['旧选项 A', '旧选项 B'], 'failed poll edit must restore old options');
    assert.strictEqual(pool.state.pollVotes.length, 1, 'failed poll edit must restore old votes');

    pool.failure = { needle: 'update conversations set last_message_at', nth: 1 };
    await expectFailure(context, pool,
      () => postJson(context.baseUrl, '/api/messages/conversations/3/messages', { content: '新消息' }),
      'message timestamp second-step failure');
    assert.strictEqual(pool.state.messages.length, 0, 'failed conversation timestamp update must not leave the message');
    assert.strictEqual(pool.state.conversations[0].last_message_at, '2026-10-03 10:00:00', 'failed message send must preserve the old activity time');
  } finally {
    console.error = oldConsoleError;
    await new Promise(resolve => context.server.close(resolve));
  }
  console.log('Content transaction tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
