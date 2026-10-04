        var PH = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect fill=%22%23e2e8f0%22 width=%22100%22 height=%22100%22/%3E%3Ctext x=%2250%22 y=%2256%22 text-anchor=%22middle%22 font-size=%2240%22 fill=%22%2394a3b8%22%3E%F0%9F%91%A4%3C/text%3E%3C/svg%3E';
        var selectedUserId = null;
        var selectedUserDisplay = null;
        var logPage = 1;

        function getToken() {
            return localStorage.getItem('token') || sessionStorage.getItem('token') || '';
        }

        function authHeaders() {
            return { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' };
        }

        function showToast(msg, type) {
            var t = document.createElement('div');
            t.className = 'toast toast-' + type;
            t.textContent = msg;
            document.body.appendChild(t);
            setTimeout(function() { t.remove(); }, 3000);
        }

        async function checkAuth() {
            var token = getToken();
            if (!token) { window.location.href = '/admin/'; return false; }
            try {
                var res = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.status === 401 || res.status === 403) { window.location.href = '/admin/'; return false; }
                var json = await res.json();
                if (json.code !== 200 || !json.data || json.data.role !== 'super_admin') { window.location.href = '/admin/'; return false; }
                return true;
            } catch (e) { window.location.href = '/admin/'; return false; }
        }

        function switchTab(name) {
            document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.tab === name); });
            document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.toggle('active', c.id === 'tab-' + name); });
            if (name === 'log') loadPointsLog();
        }

        function escapeHtml(s) {
            if (s == null) return '';
            return String(s).replace(/[&<>"']/g, function(m) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]; });
        }

        function setAmount(val) {
            document.getElementById('points-amount').value = val;
        }

        function formatTime(ts) {
            if (!ts) return '-';
            var d = new Date(ts);
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
        }

        // 用户搜索
        var searchTimer = null;
        document.getElementById('user-search-input').addEventListener('input', function() {
            clearTimeout(searchTimer);
            var val = this.value.trim();
            if (val.length < 1) { document.getElementById('user-search-results').style.display = 'none'; return; }
            searchTimer = setTimeout(function() { searchUsers(val); }, 300);
        });

        document.getElementById('user-search-input').addEventListener('blur', function() {
            setTimeout(function() { document.getElementById('user-search-results').style.display = 'none'; }, 200);
        });

        async function searchUsers(keyword) {
            try {
                var res = await fetch('/api/admin/users?search=' + encodeURIComponent(keyword) + '&limit=10', { headers: authHeaders() });
                if (!res.ok) return;
                var json = await res.json();
                if (json.code !== 200 || !json.data || !json.data.users) return;
                var results = document.getElementById('user-search-results');
                if (json.data.users.length === 0) {
                    results.style.display = 'none';
                    return;
                }
                var html = '';
                json.data.users.forEach(function(u) {
                    html += '<div class="result-item" data-id="' + u.id + '" data-nick="' + escapeHtml(u.nickname || u.username) + '" data-avatar="' + (u.avatar || '') + '">'
                        + '<img src="' + (u.avatar || PH) + '" data-hide-on-error>'
                        + '<span>' + escapeHtml(u.nickname || u.username) + '</span>'
                        + '<span style="color:#94a3b8;font-size:0.8rem;">@' + escapeHtml(u.username) + ' · ' + (u.points || 0) + '分</span>'
                        + '</div>';
                });
                results.innerHTML = html;
                results.style.display = 'block';
                results.querySelectorAll('.result-item').forEach(function(el) {
                    el.addEventListener('mousedown', function(e) {
                        e.preventDefault();
                        selectUser(this.dataset.id, this.dataset.nick, this.dataset.avatar);
                    });
                });
            } catch (e) {}
        }

        function selectUser(id, nick, avatar) {
            selectedUserId = id;
            document.getElementById('user-search-input').value = nick;
            document.getElementById('user-search-results').style.display = 'none';
            var display = document.getElementById('selected-user-display');
            display.innerHTML = '<div class="selected-user">'
                + '<img src="' + (avatar || PH) + '" data-hide-on-error>'
                + '<span><strong>' + escapeHtml(nick) + '</strong> (ID: ' + id + ')</span>'
                + '<span class="remove-btn" data-action="clear-selected-user" role="button" tabindex="0">✕</span></div>';
        }

        function clearSelectedUser() {
            selectedUserId = null;
            document.getElementById('selected-user-display').innerHTML = '';
            document.getElementById('user-search-input').value = '';
        }

        // 发放积分
        async function grantPoints() {
            if (!selectedUserId) { showToast('请先选择用户', 'error'); return; }
            var amount = parseInt(document.getElementById('points-amount').value);
            if (isNaN(amount) || amount === 0) { showToast('请输入有效的积分数量', 'error'); return; }
            var reason = document.getElementById('points-reason').value;
            var remark = document.getElementById('points-remark').value.trim();
            if (!confirm('确认' + (amount > 0 ? '发放' : '扣除') + ' ' + Math.abs(amount) + ' 积分给该用户？')) return;

            var btn = document.getElementById('grant-btn');
            btn.disabled = true; btn.textContent = '处理中...';
            try {
                var res = await fetch('/api/admin/points', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({ user_id: selectedUserId, points: amount, reason: reason })
                });
                if (res.status === 401 || res.status === 403) { window.location.href = '/admin/'; return; }
                var json = await res.json();
                if (json.code === 200) {
                    showToast('✅ ' + (amount > 0 ? '发放' : '扣除') + '成功！当前余额: ' + json.data.balance, 'success');
                    document.getElementById('points-amount').value = '';
                    document.getElementById('points-remark').value = '';
                    var resultDiv = document.getElementById('grant-result');
                    var logs = json.data.logs || [];
                    if (logs.length > 0) {
                        var html = '<h3>📋 最新积分记录</h3><table class="grant-result-table" style="width:100%;border-collapse:collapse;font-size:0.85rem;"><thead><tr>'
                            + '<th style="padding:8px 12px;text-align:left;font-weight:600;color:#64748b;border-bottom:2px solid #e8ecf4;">时间</th>'
                            + '<th style="padding:8px 12px;text-align:left;font-weight:600;color:#64748b;border-bottom:2px solid #e8ecf4;">变动</th>'
                            + '<th style="padding:8px 12px;text-align:left;font-weight:600;color:#64748b;border-bottom:2px solid #e8ecf4;">余额</th>'
                            + '<th style="padding:8px 12px;text-align:left;font-weight:600;color:#64748b;border-bottom:2px solid #e8ecf4;">原因</th></tr></thead><tbody>';
                        logs.forEach(function(l) {
                            html += '<tr><td data-label="时间" style="padding:8px 12px;border-bottom:1px solid #e8ecf4;">' + formatTime(l.created_at) + '</td>'
                                + '<td data-label="变动" style="padding:8px 12px;border-bottom:1px solid #e8ecf4;"><span class="' + (l.points > 0 ? 'pos-points' : 'neg-points') + '">' + (l.points > 0 ? '+' : '') + l.points + '</span></td>'
                                + '<td data-label="余额" style="padding:8px 12px;border-bottom:1px solid #e8ecf4;">' + l.balance + '</td>'
                                + '<td data-label="原因" style="padding:8px 12px;border-bottom:1px solid #e8ecf4;">' + escapeHtml(l.reason || '-') + '</td></tr>';
                        });
                        html += '</tbody></table>';
                        resultDiv.innerHTML = html;
                        resultDiv.style.display = 'block';
                    }
                    loadData();
                } else {
                    showToast('❌ ' + (json.message || '操作失败'), 'error');
                }
            } catch (e) {
                showToast('❌ 网络错误', 'error');
            }
            btn.disabled = false; btn.textContent = '确认发放';
        }

        // 加载积分日志
        async function loadPointsLog(p) {
            if (p !== undefined) logPage = p;
            var body = document.getElementById('log-body');
            body.innerHTML = '<tr class="loading-row"><td colspan="5"><span class="loading-spinner"></span>加载中...</td></tr>';
            var userId = document.getElementById('log-user-search').value.trim();
            try {
                var url = '/api/admin/points?page=' + logPage + '&limit=20';
                if (userId) url += '&user_id=' + parseInt(userId);
                var res = await fetch(url, { headers: authHeaders() });
                if (res.status === 401 || res.status === 403) { window.location.href = '/admin/'; return; }
                var json = await res.json();
                if (json.code !== 200) throw new Error(json.message || '加载失败');
                var d = json.data;
                if (d.logs && d.logs.length > 0) {
                    var html = '';
                    d.logs.forEach(function(l) {
                        html += '<tr><td data-label="时间" style="padding:10px 12px;border-bottom:1px solid #e8ecf4;">' + formatTime(l.created_at) + '</td>'
                            + '<td data-label="用户" style="padding:10px 12px;border-bottom:1px solid #e8ecf4;"><div class="user-cell"><span class="nickname">' + escapeHtml(l.nickname || l.username) + '</span></div></td>'
                            + '<td data-label="变动" style="padding:10px 12px;border-bottom:1px solid #e8ecf4;"><span class="' + (l.points > 0 ? 'pos-points' : 'neg-points') + '">' + (l.points > 0 ? '+' : '') + l.points + '</span></td>'
                            + '<td data-label="余额" style="padding:10px 12px;border-bottom:1px solid #e8ecf4;">' + (l.balance || '-') + '</td>'
                            + '<td data-label="原因" style="padding:10px 12px;border-bottom:1px solid #e8ecf4;">' + escapeHtml(l.reason || '-') + '</td></tr>';
                    });
                    body.innerHTML = html;
                } else {
                    body.innerHTML = '<tr class="empty-row"><td colspan="5">暂无日志</td></tr>';
                }
                var total = d.total || 0;
                var totalPages = Math.ceil(total / 20) || 1;
                var pagHtml = '';
                if (logPage > 1) pagHtml += '<button class="form-submit" data-action="log-page" data-page="' + (logPage-1) + '" style="padding:6px 16px;font-size:0.8rem;">← 上一页</button>';
                pagHtml += '<span style="padding:8px 12px;color:#94a3b8;">第 ' + logPage + '/' + totalPages + ' 页（共 ' + total + ' 条）</span>';
                if (logPage < totalPages) pagHtml += '<button class="form-submit" data-action="log-page" data-page="' + (logPage+1) + '" style="padding:6px 16px;font-size:0.8rem;">下一页 →</button>';
                document.getElementById('log-pagination').innerHTML = pagHtml;
            } catch (e) {
                body.innerHTML = '<tr class="error-row"><td colspan="5">错误: ' + escapeHtml(e.message) + '</td></tr>';
            }
        }

        // 加载概览数据
        async function loadData() {
            var ptBody = document.getElementById('points-body');
            var stBody = document.getElementById('streak-body');
            ptBody.innerHTML = '<tr class="loading-row"><td colspan="4"><span class="loading-spinner"></span>加载中...</td></tr>';
            stBody.innerHTML = '<tr class="loading-row"><td colspan="4"><span class="loading-spinner"></span>加载中...</td></tr>';

            try {
                var res = await fetch('/api/admin/gamification', { headers: authHeaders() });
                if (res.status === 401 || res.status === 403) { window.location.href = '/admin/'; return; }
                if (!res.ok) throw new Error('HTTP ' + res.status);
                var json = await res.json();
                if (json.code !== 200) throw new Error(json.message || '加载失败');
                var d = json.data;

                document.getElementById('g-today').textContent = d.today_checkins || 0;
                document.getElementById('g-total').textContent = d.total_checkins || 0;
                document.getElementById('g-active').textContent = (d.active_users_7d || 0) + ' 人';
                document.getElementById('g-weekly-star').textContent = d.weekly_star ? '🏆 ' + d.weekly_star.nickname : '暂无';

                if (d.top_points && d.top_points.length > 0) {
                    var html = '';
                    d.top_points.forEach(function(u, i) {
                        var rc = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
                        var ms = '-';
                        if (d.top_streak) {
                            var f = d.top_streak.find(function(s) { return '' + s.user_id === '' + u.id; });
                            if (f) ms = f.max_streak + ' 天';
                        }
                        html += '<tr><td data-label="排名"><span class="rank-badge ' + rc + '">' + (i + 1) + '</span></td>'
                            + '<td data-label="用户"><div class="user-cell"><img src="' + (u.avatar || PH) + '" class="avatar" data-hide-on-error><span class="nickname">' + escapeHtml(u.nickname || u.username) + '</span></div></td>'
                            + '<td data-label="积分"><strong style="color:#C084FC;">' + u.points + '</strong></td>'
                            + '<td data-label="最高连续签到"><span class="streak-badge">🔥 ' + ms + '</span></td></tr>';
                    });
                    ptBody.innerHTML = html;
                } else {
                    ptBody.innerHTML = '<tr class="empty-row"><td colspan="4">暂无数据</td></tr>';
                }

                if (d.top_streak && d.top_streak.length > 0) {
                    var shtml = '';
                    d.top_streak.forEach(function(s, i) {
                        var rl = i === 0 ? '1' : i === 1 ? '2' : i === 2 ? '3' : '' + (i + 1);
                        var badge = s.max_streak >= 30 ? '💪 签到达人' : s.max_streak >= 7 ? '🌟 连续签到' : '🌱 继续加油';
                        shtml += '<tr><td data-label="排名"><span class="rank-badge" style="background:' + (i === 0 ? '#fef3c7;color:#d97706' : i === 1 ? '#f1f5f9;color:#64748b' : i === 2 ? '#fef2f2;color:#dc2626' : '#f8fafc;color:#94a3b8') + '">' + rl + '</span></td>'
                            + '<td data-label="用户"><div class="user-cell"><span class="nickname">' + escapeHtml(s.nickname || s.username) + '</span></div></td>'
                            + '<td data-label="最高连续签到"><strong style="color:#16a34a;">' + s.max_streak + ' 天</strong></td>'
                            + '<td data-label="称号">' + badge + '</td></tr>';
                    });
                    stBody.innerHTML = shtml;
                } else {
                    stBody.innerHTML = '<tr class="empty-row"><td colspan="4">暂无数据</td></tr>';
                }
            } catch (e) {
                console.error('加载积分数据失败:', e);
                ptBody.innerHTML = '<tr class="error-row"><td colspan="4">错误: ' + escapeHtml(e.message) + '</td></tr>';
                stBody.innerHTML = '<tr class="error-row"><td colspan="4">错误: ' + escapeHtml(e.message) + '</td></tr>';
            }
        }

        window.cleanupPointsLog = async function(days) {
            if (!confirm('确定要删除 ' + days + ' 天前的所有积分日志吗？此操作不可恢复！')) return;
            try {
                var res = await fetch('/api/admin/points/cleanup?days=' + days, { method: 'DELETE', headers: authHeaders() });
                if (res.status === 401 || res.status === 403) { window.location.href = '/admin/'; return; }
                var json = await res.json();
                if (json.code === 200) {
                    showToast('✅ ' + json.message + '（共 ' + json.data.deleted + ' 条）', 'success');
                    loadPointsLog();
                } else {
                    showToast('❌ ' + (json.message || '操作失败'), 'error');
                }
            } catch (e) { showToast('❌ 网络错误', 'error'); }
        };

        window.awardWeeklyStar = async function() {
            if (!confirm('确定要颁发本周之星给近7天点赞最多的帖子作者吗？')) return;
            try {
                var res = await fetch('/api/checkin/weekly-star', { method: 'POST', headers: authHeaders() });
                if (res.status === 401 || res.status === 403) { window.location.href = '/admin/'; return; }
                var json = await res.json();
                if (json.code === 200) {
                    showToast('✅ ' + json.data.nickname + ' 获得本周之星！', 'success');
                    loadData();
                } else {
                    showToast('❌ ' + (json.message || '操作失败'), 'error');
                }
            } catch (e) { showToast('❌ 网络错误', 'error'); }
        };

        if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.setAttribute('data-theme', 'dark');
        }

        checkAuth().then(function(ok) { if (ok) loadData(); });

        // ─── 称号颁发系统 ───
        var awardModal = null;
        function createAwardModal() {
            if (awardModal) return;
            var div = document.createElement('div');
            div.id = 'award-modal';
            div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;';
            div.innerHTML = '<div style="background:white;border-radius:16px;width:560px;max-width:90vw;max-height:80vh;overflow-y:auto;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.2);position:relative;">'
                + '<button type="button" data-action="close-award" style="position:absolute;top:12px;right:16px;border:none;background:none;font-size:24px;cursor:pointer;color:#94a3b8;">×</button>'
                + '<h3 style="margin-bottom:16px;">🏆 颁发称号</h3>'
                + '<div class="form-group"><label>称号类型</label>'
                + '<select class="form-select" id="award-type" data-action="award-type-change">'
                + '<option value="weekly_star">本周之星🏆 — 近7天点赞最多的帖子作者</option>'
                + '<option value="checkin_star">签到之星⭐ — 近7天签到次数最多</option>'
                + '<option value="popular_star">人气之星🔥 — 近7天收到点赞最多</option>'
                + '<option value="custom">自定义 🎖️ — 手动指定称号</option>'
                + '</select></div>'
                + '<div id="award-custom-name-wrap" class="form-group" style="display:none;">'
                + '<label>称号名称</label>'
                + '<input type="text" class="form-input" id="award-custom-name" placeholder="输入称号名称（最多30字）">'
                + '</div>'
                + '<div id="award-candidates-wrap" class="form-group">'
                + '<label>候选人（点击选择）</label>'
                + '<div id="award-candidates" style="max-height:300px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:10px;"></div>'
                + '</div>'
                + '<div id="award-custom-search-wrap" class="form-group" style="display:none;">'
                + '<label>搜索用户</label>'
                + '<div class="user-search-wrap">'
                + '<input type="text" class="form-input" id="award-user-search" placeholder="输入用户名或昵称搜索..." autocomplete="off">'
                + '<div class="user-search-results" id="award-user-results"></div></div>'
                + '<div id="award-selected-user"></div>'
                + '</div>'
                + '<div id="award-selected" style="display:none;padding:10px 14px;background:#f0fdf4;border-radius:10px;margin-bottom:12px;">'
                + '已选: <strong id="award-selected-name"></strong>'
                + '</div>'
                + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
                + '<button class="form-submit" type="button" data-action="close-award" style="background:#94a3b8;">取消</button>'
                + '<button class="form-submit" type="button" id="award-confirm-btn" data-action="confirm-award" disabled>确认颁发</button>'
                + '</div></div>';
            document.body.appendChild(div);

            // 自定义称号的搜索
            var searchTimer2 = null;
            document.getElementById('award-user-search').addEventListener('input', function() {
                clearTimeout(searchTimer2);
                var val = this.value.trim();
                if (val.length < 1) { document.getElementById('award-user-results').style.display = 'none'; return; }
                searchTimer2 = setTimeout(function() { searchAwardUsers(val); }, 300);
            });
            document.getElementById('award-user-search').addEventListener('blur', function() {
                setTimeout(function() { document.getElementById('award-user-results').style.display = 'none'; }, 200);
            });
            awardModal = div;
        }

        function showAwardModal() {
            createAwardModal();
            awardModal.style.display = 'flex';
            onAwardTypeChange();
        }

        function closeAwardModal() {
            if (awardModal) awardModal.style.display = 'none';
        }

        function onAwardTypeChange() {
            var type = document.getElementById('award-type').value;
            var isCustom = type === 'custom';
            document.getElementById('award-custom-name-wrap').style.display = isCustom ? '' : 'none';
            document.getElementById('award-custom-search-wrap').style.display = isCustom ? '' : 'none';
            document.getElementById('award-candidates-wrap').style.display = isCustom ? 'none' : '';
            document.getElementById('award-selected').style.display = 'none';
            document.getElementById('award-confirm-btn').disabled = true;
            awardSelectedUserId = null;
            if (!isCustom) loadAwardCandidates(type);
        }

        var awardSelectedUserId = null;
        var awardSelectedName = null;

        async function loadAwardCandidates(type) {
            var container = document.getElementById('award-candidates');
            container.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;"><span class="loading-spinner"></span>加载中...</div>';
            try {
                var res = await fetch('/api/admin/award-title/candidates?type=' + type, { headers: authHeaders() });
                if (!res.ok) return;
                var json = await res.json();
                if (json.code !== 200) { container.innerHTML = '<div style="text-align:center;padding:20px;color:#ef4444;">' + escapeHtml(json.message) + '</div>'; return; }
                var data = json.data || [];
                if (data.length === 0) {
                    container.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;">暂无候选人</div>';
                    return;
                }
                var html = '';
                var rankEmojis = ['🥇','🥈','🥉'];
                data.forEach(function(c, i) {
                    var rank = i < 3 ? rankEmojis[i] : (i + 1);
                    html += '<div class="candidate-item" data-id="' + c.user_id + '" data-name="' + escapeHtml(c.nickname) + '" data-action="select-award" role="button" tabindex="0" style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f0f0;transition:background 0.2s;">'
                        + '<span style="font-size:1.1rem;width:28px;text-align:center;">' + rank + '</span>'
                        + '<img src="' + (c.avatar || PH) + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" data-hide-on-error>'
                        + '<div style="flex:1;"><strong>' + escapeHtml(c.nickname) + '</strong><br><span style="color:#94a3b8;font-size:0.8rem;">@' + escapeHtml(c.username) + ' · ' + escapeHtml(c.desc) + '</span></div>'
                        + '</div>';
                });
                container.innerHTML = html;
            } catch (e) {
                container.innerHTML = '<div style="text-align:center;padding:20px;color:#ef4444;">加载失败</div>';
            }
        }

        function selectAwardCandidate(el) {
            document.querySelectorAll('.candidate-item').forEach(function(e) { e.style.background = ''; e.style.borderLeft = ''; });
            el.style.background = 'rgba(192,132,252,0.12)';
            el.style.borderLeft = '3px solid #C084FC';
            awardSelectedUserId = el.dataset.id;
            awardSelectedName = el.dataset.name;
            document.getElementById('award-selected').style.display = '';
            document.getElementById('award-selected-name').textContent = awardSelectedName;
            document.getElementById('award-confirm-btn').disabled = false;
        }

        async function searchAwardUsers(keyword) {
            try {
                var res = await fetch('/api/admin/users?search=' + encodeURIComponent(keyword) + '&limit=10', { headers: authHeaders() });
                if (!res.ok) return;
                var json = await res.json();
                if (json.code !== 200 || !json.data || !json.data.users) return;
                var results = document.getElementById('award-user-results');
                if (json.data.users.length === 0) { results.style.display = 'none'; return; }
                var html = '';
                json.data.users.forEach(function(u) {
                    html += '<div class="result-item" data-id="' + u.id + '" data-nick="' + escapeHtml(u.nickname || u.username) + '" data-avatar="' + (u.avatar || '') + '">'
                        + '<img src="' + (u.avatar || PH) + '" data-hide-on-error>'
                        + '<span>' + escapeHtml(u.nickname || u.username) + '</span>'
                        + '<span style="color:#94a3b8;font-size:0.8rem;">@' + escapeHtml(u.username) + '</span>'
                        + '</div>';
                });
                results.innerHTML = html;
                results.style.display = 'block';
                results.querySelectorAll('.result-item').forEach(function(el) {
                    el.addEventListener('mousedown', function(e) {
                        e.preventDefault();
                        awardSelectedUserId = this.dataset.id;
                        awardSelectedName = this.dataset.nick;
                        document.getElementById('award-user-search').value = this.dataset.nick;
                        document.getElementById('award-user-results').style.display = 'none';
                        document.getElementById('award-selected').style.display = '';
                        document.getElementById('award-selected-name').textContent = awardSelectedName;
                        document.getElementById('award-confirm-btn').disabled = false;
                    });
                });
            } catch (e) {}
        }

        async function confirmAward() {
            if (!awardSelectedUserId) { showToast('请先选择用户', 'error'); return; }
            var type = document.getElementById('award-type').value;
            var body = { type: type, user_id: parseInt(awardSelectedUserId) };
            if (type === 'custom') {
                var customName = document.getElementById('award-custom-name').value.trim();
                if (!customName) { showToast('请输入称号名称', 'error'); return; }
                body.title_name = customName;
            }
            var btn = document.getElementById('award-confirm-btn');
            btn.disabled = true; btn.textContent = '颁发中...';
            try {
                var res = await fetch('/api/admin/award-title', {
                    method: 'POST', headers: authHeaders(),
                    body: JSON.stringify(body)
                });
                if (res.status === 401 || res.status === 403) { window.location.href = '/admin/'; return; }
                var json = await res.json();
                if (json.code === 200) {
                    showToast(json.message, 'success');
                    closeAwardModal();
                    loadData();
                } else {
                    showToast('❌ ' + (json.message || '操作失败'), 'error');
                }
            } catch (e) {
                showToast('❌ 网络错误', 'error');
            }
            btn.disabled = false; btn.textContent = '确认颁发';
        }

        // 集中处理页面和动态弹窗里的交互，避免在 HTML 字符串中拼接内联事件。
        document.addEventListener('click', function(e) {
            var actionEl = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
            if (!actionEl) return;
            var action = actionEl.dataset.action;
            if (action === 'switch-tab') switchTab(actionEl.dataset.tab);
            else if (action === 'set-amount') setAmount(Number(actionEl.dataset.amount));
            else if (action === 'grant-points') grantPoints();
            else if (action === 'query-log') loadPointsLog();
            else if (action === 'cleanup-log') cleanupPointsLog(Number(actionEl.dataset.days));
            else if (action === 'open-award') showAwardModal();
            else if (action === 'close-award') closeAwardModal();
            else if (action === 'confirm-award') confirmAward();
            else if (action === 'clear-selected-user') clearSelectedUser();
            else if (action === 'log-page') loadPointsLog(Number(actionEl.dataset.page));
            else if (action === 'select-award') selectAwardCandidate(actionEl);
        });

        document.addEventListener('change', function(e) {
            var action = e.target && e.target.dataset && e.target.dataset.action;
            if (action === 'award-type-change') onAwardTypeChange();
        });

        document.addEventListener('error', function(e) {
            if (e.target && e.target.matches && e.target.matches('img[data-hide-on-error]')) {
                e.target.style.display = 'none';
            }
        }, true);

        // 替换旧的 awardWeeklyStar
        window.awardWeeklyStar = showAwardModal;
