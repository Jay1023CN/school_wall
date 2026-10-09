(function() {
  'use strict';
  var base = window.CAMPUS_DEMO_BASE;
  var nativeFetch = window.fetch.bind(window);
  var key = 'campus-wall-demo-v2';
  var avatar = base + 'demo/avatar.svg';
  var now = new Date().toISOString();
  function day(offset) { return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10); }
  function ago(minutes) { return new Date(Date.now() - minutes * 60000).toISOString(); }
  function portrait(name, color) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="' + color + '"/><text x="48" y="61" text-anchor="middle" font-family="sans-serif" font-size="38" fill="#fff">' + name.slice(0, 1) + '</text></svg>'); }
  var user = { id: 1, username: 'xiaolin', nickname: '小林同学', avatar: portrait('林', '#648b77'), role: 'user', points: 128, level: 3,
    email: 'xiaolin@example.com', bio: '喜欢拍照和听歌，偶尔在操场跑两圈。', created_at: ago(43200), post_count: 1, followers_count: 12, following_count: 5 };
  var peers = [user,
    { id: 2, username: 'orange', nickname: '橘子汽水', avatar: portrait('橘', '#cf9160'), role: 'user', points: 96, level: 2, created_at: ago(36000) },
    { id: 3, username: 'halfbeat', nickname: '慢半拍', avatar: portrait('慢', '#8a7db1'), role: 'user', points: 75, level: 2, created_at: ago(28000) },
    { id: 4, username: 'pagecorner', nickname: '书页折角', avatar: portrait('书', '#638da9'), role: 'user', points: 163, level: 3, created_at: ago(58000) },
    { id: 5, username: 'riceball', nickname: '饭团不加葱', avatar: portrait('饭', '#ad7d89'), role: 'user', points: 42, level: 1, created_at: ago(12000) },
    { id: 6, username: 'club', nickname: '社团活动部', avatar: portrait('社', '#768b53'), role: 'user', points: 216, level: 4, created_at: ago(86000) }];
  var categories = ['daily', 'daily', 'help', 'club', 'lost_found', 'poll'];
  var titles = ['这周的校园广播，想听什么？', '傍晚的操场，刚好有风', '有什么适合晚自习后的歌？', '图书馆阅读搭子招募', '失物招领：一只蓝色水杯', '周末社团活动，你选哪一个？'];
  var contents = ['广播站开始收这周的点歌啦。歌名和歌手记得都写上，也可以带一句想送给朋友的话。大家有想听的歌，去点歌页选好日期提交就行，排好后会在歌单里更新。',
    '今天体育课跑完最后一圈，坐在操场边缓了好一会儿。风吹过来的时候突然觉得，作业好像也没那么可怕了。有没有人拍到今天的晚霞？',
    '最近晚自习结束回宿舍，总想听点不太吵的歌。循环了几天《安静》和《温柔》，想换换口味，求大家的私藏歌单！',
    '周六下午想去图书馆读《我与地坛》，大概两点到四点。找一两个也喜欢读书的同学，读完可以聊聊，不用提前准备分享，安静看书也很好。',
    '今天中午在教学楼一层靠楼梯的长椅上捡到一个浅蓝色保温杯，杯身贴了小猫贴纸。已经交到门卫处了，失主记得去拿，认领时说一下杯盖颜色。',
    '活动部准备安排一次周末小活动，目前想到草坪音乐会、校园摄影散步和桌游。大家更想参加哪种？也欢迎直接在评论里提想法，我们按人数和场地再定。'];
  var seeds = titles.map(function(title, i) { return { id: i + 1, title: title, content: contents[i], category: categories[i],
    user_id: peers[i].id, author_id: peers[i].id, author_name: peers[i].nickname, nickname: peers[i].nickname,
    username: peers[i].username, author_avatar: peers[i].avatar, avatar: peers[i].avatar, author_level: peers[i].level, author_titles: [],
    images: '[]', is_anonymous: 0, is_pinned: i === 0 ? 1 : 0, status: i === 3 ? 'pending' : 'approved',
    likes: [23, 17, 9, 4, 6, 14][i], likes_count: [23, 17, 9, 4, 6, 14][i], like_count: [23, 17, 9, 4, 6, 14][i], comments: i === 2 ? 2 : 0, comments_count: i === 2 ? 2 : 0, comment_count: i === 2 ? 2 : 0, views: [186, 92, 64, 27, 48, 113][i], created_at: ago([35, 68, 126, 210, 315, 480][i]) }; });
  var initialSongs = ['晴天', '稻香', '平凡之路', '夜空中最亮的星'].map(function(name, i) { return { id: i + 1,
    song_name: name, artist: i < 2 ? '周杰伦' : i === 2 ? '朴树' : '逃跑计划', status: i === 3 ? 'pending' : 'approved',
    author_name: peers[i].nickname, nickname: peers[i].nickname, username: peers[i].username, user_id: peers[i].id,
    is_anonymous: 0, hot_score: [26, 19, 12, 7][i], votes: [26, 19, 12, 7][i], to_whom: ['同桌', '正在准备考试的大家', '篮球队的朋友们', '每个还没放弃的人'][i], message: ['谢谢你每次帮我留座位，明天见！', '慢慢来，我们都能走到想去的地方。', '下次比赛继续加油，场边还有我们。', '累的时候抬头看看，今晚的月亮很好看。'][i],
    play_date: day(i + 1), slot_id: 1, slot_date_id: 100 + i, slot_name: '傍晚点歌', start_time: '17:00:00', end_time: '17:10:00', created_at: ago(50 + i * 85) }; });
  var state;
  try { state = JSON.parse(localStorage.getItem(key)); } catch (_) {}
  if (!state || !Array.isArray(state.posts) || !Array.isArray(state.songs)) state = { posts: seeds, songs: initialSongs, comments: [
    { id: 1, post_id: 3, user_id: 2, nickname: peers[1].nickname, author_name: peers[1].nickname, avatar: peers[1].avatar, content: '推荐《稻香》，很适合放学路上听。', created_at: ago(91), replies: [], likes: 3 },
    { id: 2, post_id: 3, user_id: 3, nickname: peers[2].nickname, author_name: peers[2].nickname, avatar: peers[2].avatar, content: '谢谢推荐，已经加入歌单！', created_at: ago(83), replies: [], likes: 1 }
  ], messages: [{ id: 1, sender_id: 2, content: '你上次说的那本书我借到了，周六一起去图书馆吗？', created_at: ago(26) },
    { id: 2, sender_id: 1, content: '好呀，下午两点门口见，我带上笔记本。', created_at: ago(22) },
    { id: 3, sender_id: 2, content: '那就这么定了，看完一起去吃饭～', created_at: ago(20) }], feedbacks: [] };
  function persist() { try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) {} }
  function selectRole(role) {
    localStorage.setItem('campus-demo-role', role);
    var active = Object.assign({}, user, { role: role === 'admin' ? 'super_admin' : 'user', roleName: role === 'admin' ? '管理员' : '用户' });
    if (role === 'guest') { localStorage.removeItem('token'); localStorage.removeItem('user'); }
    else { localStorage.setItem('token', 'demo-local-only'); localStorage.setItem('user', JSON.stringify(active)); }
    sessionStorage.removeItem('token'); sessionStorage.removeItem('user');
    return active;
  }
  var role = localStorage.getItem('campus-demo-role') || 'user';
  if (location.pathname.indexOf('/admin/') !== -1) role = 'admin';
  var currentUser = selectRole(role);
  function ok(data, message) { return { code: 200, data: data, message: message || '操作成功' }; }
  function fail(message, code) { return { code: code || 501, message: message || '此功能需要真实后端，静态演示不执行外部操作' }; }
  function pagination(list, query, field) {
    var limit = Math.max(1, Number(query.get('limit')) || 10);
    var page = Math.max(1, Number(query.get('page')) || 1);
    var offset = Number(query.get('offset')) || (page - 1) * limit;
    var data = { total: list.length, page: page, totalPages: Math.max(1, Math.ceil(list.length / limit)), has_more: offset + limit < list.length,
      pagination: { page: page, limit: limit, total: list.length, pages: Math.max(1, Math.ceil(list.length / limit)) } };
    data[field] = list.slice(offset, offset + limit);
    return ok(data);
  }
  function filtered(list, query) {
    return list.filter(function(row) {
      var category = query.get('category'), status = query.get('status'), term = query.get('keyword') || query.get('search') || '';
      return (!category || category === 'all' || category === '全部' || row.category === category) && (!status || status === 'all' || row.status === status) &&
        (!term || JSON.stringify(row).toLowerCase().indexOf(term.toLowerCase()) !== -1);
    });
  }
  function slots() { return [{ id: 1, name: '傍晚点歌', start_time: '17:00', end_time: '17:10', max_songs: 10,
    weekdays: '1,2,3,4,5', dates: [1,2,3].map(function(i) { return { id: 99 + i, date: day(i), play_date: day(i), week: '周' + '日一二三四五六'[new Date(day(i)).getDay()],
      remaining: i === 3 ? 0 : 10 - state.songs.filter(function(s) { return s.slot_date_id === 99 + i; }).length }; }) }]; }
  function reply(p, method, body, query) {
    var match;
    if (p === '/site-info') return ok({ site_name: '校园墙', site_description: '分享校园生活，让每一个声音被听见', anon_post: false, anon_comment: false, anon_song: false, festival_mode: false, festival_enabled: false });
    if (p === '/auth/me') return role === 'guest' ? fail('请先登录', 401) : ok(Object.assign({}, currentUser, { user: currentUser }));
    if (p === '/auth/login') { role = body.username === 'admin' ? 'admin' : 'user'; currentUser = selectRole(role); return ok({ token: 'demo-local-only', user: currentUser }); }
    if (p === '/auth/login-status') return ok({ needCaptcha: false, attempts: 0 });
    if (p === '/auth/register-options') return ok({ emailRequired: false, emailCodeRequired: false, registrationEnabled: false });
    if (p === '/posts' && method === 'GET') return pagination(filtered(state.posts.filter(function(post) { return post.status === 'approved'; }), query), query, 'posts');
    if (p === '/posts' && method === 'POST') {
      var post = Object.assign({}, seeds[0], body, { id: Date.now(), user_id: 1, author_name: currentUser.nickname, status: 'approved', created_at: new Date().toISOString(), comments: 0, comment_count: 0 });
      state.posts.unshift(post); persist(); return ok({ id: post.id, post_id: post.id });
    }
    if ((match = p.match(/^\/posts\/(\d+)\/comments$/))) {
      var postId = Number(match[1]);
      if (method === 'GET') return pagination(state.comments.filter(function(c) { return c.post_id === postId; }), query, 'comments');
      if (method === 'POST') {
        var comment = { id: Date.now(), post_id: postId, content: body.content, user_id: 1, nickname: currentUser.nickname, author_name: currentUser.nickname, avatar: avatar, created_at: new Date().toISOString(), replies: [], likes: 0 };
        state.comments.push(comment);
        var owner = state.posts.find(function(row) { return row.id === postId; });
        if (owner) { owner.comments++; owner.comment_count++; }
        persist(); return ok(comment);
      }
    }
    if ((match = p.match(/^\/posts\/(\d+)$/))) {
      var found = state.posts.find(function(row) { return row.id === Number(match[1]); });
      if (!found) return fail('帖子不存在', 404);
      return ok(Object.assign({}, found, { comments: state.comments.filter(function(c) { return c.post_id === found.id; }), likes_list: [] }));
    }
    if ((match = p.match(/^\/posts\/(\d+)\/(like|favorite|view)$/))) {
      var row = state.posts.find(function(post) { return post.id === Number(match[1]); });
      if (row && match[2] === 'like') { row.is_liked = !row.is_liked; row.likes += row.is_liked ? 1 : -1; row.like_count = row.likes; row.likes_count = row.likes; }
      if (row && match[2] === 'favorite') row.is_favorited = !row.is_favorited;
      persist(); return ok({ liked: row && row.is_liked, is_liked: row && row.is_liked, likes: row && row.likes, likes_count: row && row.likes, favorited: row && row.is_favorited });
    }
    if (/^\/posts\/users\/\d+$/.test(p) || /^\/profile\/\d+$/.test(p)) return ok(Object.assign({}, peers[Number(p.split('/').pop()) - 1] || user, { posts: state.posts, titles: [] }));
    if (p === '/songs/slots') return ok(slots());
    if (p === '/songs/remaining') return ok({ remaining: Math.max(0, 3 - state.songs.filter(function(s) { return s.demo_submitted; }).length), limit: 3 });
    if (p === '/songs/list') return ok(state.songs.filter(function(s) { return s.status === 'approved'; }));
    if (p === '/songs/hot') return ok(state.songs.slice().sort(function(a, b) { return b.hot_score - a.hot_score; }));
    if (p === '/songs/my') return ok(state.songs.filter(function(s) { return s.user_id === 1; }));
    if (p === '/songs' && method === 'POST') {
      if (!body.song_name || !body.artist || !body.slot_date_id) return fail('请填写歌曲、歌手并选择播放日期', 400);
      var date = slots()[0].dates.find(function(d) { return d.id === Number(body.slot_date_id); });
      if (!date || date.remaining <= 0) return fail('这个日期已满，请选择其他日期', 400);
      if (state.songs.filter(function(s) { return s.demo_submitted; }).length >= 3) return fail('本周点歌次数已用完', 400);
      var song = Object.assign({}, initialSongs[0], body, { id: Date.now(), status: 'pending', author_name: currentUser.nickname, play_date: date.date, demo_submitted: true });
      state.songs.unshift(song); persist(); return ok({ id: song.id });
    }
    if ((match = p.match(/^\/songs\/(\d+)\/vote$/))) {
      var voted = state.songs.find(function(s) { return s.id === Number(match[1]); });
      if (voted) voted.hot_score++;
      persist(); return ok({ hot_score: voted && voted.hot_score });
    }
    if (p === '/messages/conversations') return ok({ conversations: [{ id: 1, partner_id: 2, partner_nickname: peers[1].nickname, partner_avatar: peers[1].avatar, last_message: state.messages[state.messages.length - 1].content, last_message_at: state.messages[state.messages.length - 1].created_at, unread_count: 0 }], conversation: { id: 1, partner_id: 2, partner_nickname: peers[1].nickname, partner_avatar: peers[1].avatar } });
    if ((match = p.match(/^\/messages\/conversations\/\d+\/messages$/))) {
      if (method === 'POST') { var msg = { id: Date.now(), sender_id: 1, content: body.content, created_at: new Date().toISOString() }; state.messages.push(msg); persist(); return ok({ message: msg }); }
      return ok({ messages: state.messages, pagination: { page: 1, pages: 1, total: state.messages.length } });
    }
    if (/^\/messages\/users/.test(p)) return ok({ users: peers.slice(1) });
    if (/\/unread(?:-count)?$/.test(p)) return ok({ count: 0, unread: 0, unread_count: 0 });
    if (/^\/messages\/conversations\/\d+\/(read|dnd)$/.test(p)) return ok({});
    if (/^\/messages\/settings/.test(p)) return ok({ enabled: true });
    if (p === '/feedback' && method === 'POST') { state.feedbacks.push(Object.assign({}, body, { id: Date.now(), user_id: 1, nickname: user.nickname, status: 'pending', created_at: now })); persist(); return ok({}); }
    if (p === '/feedback/my') return ok(state.feedbacks);
    if (p === '/notifications') return ok({ notifications: [], unread_count: 0 });
    if (p === '/notices') return ok([{ id: 1, title: '本周广播点歌开放啦', content: '选择播放日期，填好歌名、歌手和祝福语，审核通过后会加入广播歌单。失物招领记得写清捡到的地点，找到主人后也来更新一下。', created_at: ago(180) }]);
    if (/^\/checkin/.test(p)) return ok({ checked: false, checked_in: false, points: 128, streak: 3, total: 5, records: [], titles: [], leaderboard: [] });
    if (/^\/follows/.test(p)) return ok({ following: [], followers: [], is_following: false, count: 0 });
    if (p === '/proxy/hitokoto') return { hitokoto: '把普通的日子，过成值得记住的故事。', from: '校园墙', code: 200 };
    if (p === '/weather') return ok({ city: '校园', text: '晴', temp: '23', temperature: '23', humidity: '52', icon: '100', feelsLike: '23', windDir: '东风', windScale: '2' });
    if (p === '/hotsearch') return ok([]);
    if (p === '/history-today') return ok([]);
    if (p === '/admin/stats') return ok({ totalUsers: peers.length, totalPosts: state.posts.length, todayPosts: 2, pendingPosts: 1, pendingSongs: state.songs.filter(function(s) { return s.status === 'pending'; }).length, todayPostViews: 128 });
    if (p === '/admin/posts') return pagination(filtered(state.posts, query), query, 'posts');
    if (p === '/admin/users') return pagination(filtered(peers, query), query, 'users');
    if (p === '/admin/songs') return pagination(filtered(state.songs, query), query, 'songs');
    if (p === '/admin/daily-songs') return pagination(initialSongs.slice(0,2).map(function(s) { return Object.assign({}, s, { submitter: s.author_name, source: 'manual', intro: '一首歌的时间，在校园里与你分享。', lyrics: '', status: 'pending' }); }), query, 'songs');
    if (p === '/admin/settings') return ok({ site_name: '校园墙', anon_post: 'false', anon_comment: 'false', anon_song: 'false' });
    if (p === '/admin/song-reject-reasons') return ok(['名额已满，请换一个日期', '歌曲信息需要补充']);
    if (p === '/admin/slots' || p === '/admin/time-slots') return ok(slots());
    if (p === '/admin/feedbacks') return pagination(state.feedbacks, query, 'feedbacks');
    if ((match = p.match(/^\/admin\/(songs|posts)\/(\d+)\/status$/))) {
      var list = match[1] === 'songs' ? state.songs : state.posts;
      var item = list.find(function(row) { return row.id === Number(match[2]); });
      if (item) { item.status = body.status; persist(); return ok({}); }
      return fail('记录不存在', 404);
    }
    if (p === '/admin/release-notes') return ok([{ id: 'pages-demo', title: '校园墙更新', published_at: day(0), summary: '校园动态与广播点歌', changes: ['浏览动态、点歌、评论、私信及后台审核'] }]);
    if (/^\/admin\/(logs|post-views|trash|messages|email-logs)/.test(p)) return ok({ logs: [], records: [], posts: [], songs: [], users: [], messages: [], feedbacks: [], total: 0, totalPages: 1 });
    if (/^\/mp\//.test(p)) return fail('公众号预览可浏览页面；AI生成、媒体同步和发布需要真实后端，本演示不调用微信服务');
    if (p === '/health') return { code: 200, status: 'demo' };
    return fail();
  }
  window.fetch = async function(input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    var options = init || {}, method = String(options.method || (input && input.method) || 'GET').toUpperCase();
    if (url.origin !== location.origin) return new Response(JSON.stringify(fail()), { status: 501, headers: { 'Content-Type': 'application/json' } });
    var apiPath = url.pathname.replace(base.replace(/\/$/, ''), '');
    if (apiPath.indexOf('/api/') !== 0) return nativeFetch(input, init);
    var body = {};
    try { body = JSON.parse(options.body || '{}'); } catch (_) {}
    var result = reply(apiPath.slice(4), method, body, url.searchParams);
    return new Response(JSON.stringify(result), { status: result.code >= 400 ? result.code : 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  };
  if (navigator.sendBeacon) navigator.sendBeacon = function() { return false; };
  // Existing fallback image URLs refer to uploads which are never published.
  document.addEventListener('error', function(event) { var node = event.target; if (node && node.tagName === 'IMG' && node.src !== new URL(avatar, location.href).href) node.src = avatar; }, true);
  document.addEventListener('DOMContentLoaded', function() {
    var bar = document.createElement('div'); bar.id = 'campus-demo-bar';
    bar.innerHTML = '<strong>校园墙</strong>' +
      '<a href="' + base + '">首页</a><a href="' + base + 'radio.html">点歌</a><a href="' + base + 'messages.html">私信</a><a href="' + base + 'admin/">后台</a>' +
      '<button type="button" data-demo-role="guest">游客</button><button type="button" data-demo-role="user">登录体验</button><button type="button" id="demo-reset">重新体验</button>';
    document.body.prepend(bar);
    bar.querySelectorAll('[data-demo-role]').forEach(function(button) { button.onclick = function() { selectRole(button.dataset.demoRole); location.href = base; }; });
    bar.querySelector('#demo-reset').onclick = function() { localStorage.removeItem(key); location.reload(); };
  });
}());
