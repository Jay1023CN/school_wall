
    // ===== 全局错误捕获：JS 报错只影响出错的功能，不让后台整个挂掉 =====
    (function() {
      'use strict';

      // 收集错误（每分钟最多 5 条，避免刷屏）
      var _errLog = [];
      var _errCount = 0;
      function reportError(msg, source, line, col, error) {
        _errCount++;
        if (_errLog.length < 5) {
          _errLog.push({ msg: msg, source: source, line: line, col: col, time: Date.now() });
        }
      }
      window.addEventListener('error', function(e) {
        reportError(e.message, e.filename, e.lineno, e.colno, e.error);
      });
      window.addEventListener('unhandledrejection', function(e) {
        reportError('Unhandled Promise: ' + (e.reason && e.reason.message || e.reason), '', 0, 0, e.reason);
      });
      window.getJsErrorCount = function() { return _errCount; };
      window.getJsErrors = function() { return _errLog; };

      // ===== 工具函数 =====

      // 获取 token（兼容 localStorage 和 sessionStorage）
      function getToken() {
        try {
          return localStorage.getItem('token') || sessionStorage.getItem('token');
        } catch (e) { return ''; }
      }

      // 延后执行主逻辑，避免单点语法错误阻断页面渲染
      window.addEventListener('DOMContentLoaded', function() {
        try {
          initAdminApp();
        } catch (e) {
          reportError('initAdminApp 失败: ' + e.message, '', 0, 0, e);
          // 兜底：显示基础页面让用户至少能登录
          if (typeof showLoginRequired === 'function') showLoginRequired();
        }
      });

      function initAdminApp() {

        // ===== 后台主题 =====
        // data-theme 只表示明暗；data-admin-theme 是后台皮肤扩展点。
        // 新皮肤只能在 admin.css 映射语义 token，不能复制面板或移动端样式。
        (function initAdminTheme() {
            var root = document.documentElement;
            var savedMode = localStorage.getItem('admin-theme');
            var savedVariant = localStorage.getItem('admin-theme-variant') || 'default';
            if (savedMode === 'dark') root.setAttribute('data-theme', 'dark');
            if (savedVariant !== 'default') root.setAttribute('data-admin-theme', savedVariant);

            window.setAdminThemeVariant = function setAdminThemeVariant(variant) {
                var next = String(variant || 'default');
                if (next === 'default') root.removeAttribute('data-admin-theme');
                else root.setAttribute('data-admin-theme', next);
                localStorage.setItem('admin-theme-variant', next);
            };

            var btn = document.getElementById('themeToggle');
            if (!btn) return;
            function updateIcon() {
                var isDark = root.getAttribute('data-theme') === 'dark';
                btn.textContent = isDark ? '☀️' : '🌙';
                btn.title = isDark ? '切换浅色模式' : '切换深色模式';
                btn.setAttribute('aria-label', btn.title);
            }
            updateIcon();
            btn.addEventListener('click', function() {
                var isDark = root.getAttribute('data-theme') === 'dark';
                if (isDark) {
                    root.removeAttribute('data-theme');
                    localStorage.setItem('admin-theme', 'light');
                } else {
                    root.setAttribute('data-theme', 'dark');
                    localStorage.setItem('admin-theme', 'dark');
                }
                updateIcon();
            });
        })();

        // 获取当前用户（兼容 localStorage 和 sessionStorage）
        function getCurrentUser() {
            const user = localStorage.getItem('user') || sessionStorage.getItem('user');
            return JSON.parse(user || 'null');
        }

        // 获取存储对象（根据记住我状态）
        function getStorage(remember) {
            return remember ? localStorage : sessionStorage;
        }

        // 带认证的 fetch 请求
        async function authFetch(url, options = {}) {
            const token = getToken();
            const headers = {
                'Content-Type': 'application/json',
                ...options.headers
            };
            if (token) {
                headers['Authorization'] = 'Bearer ' + token;
            }
            const requestOptions = { ...options, headers };
            const timeoutValue = Number.parseInt(options.timeoutMs, 10);
            const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 15000;
            delete requestOptions.timeoutMs;
            const controller = typeof AbortController === 'function' && !requestOptions.signal ? new AbortController() : null;
            const timeoutId = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
            if (controller) requestOptions.signal = controller.signal;
            try {
                const res = await fetch(url, requestOptions);
                // 处理 401 未认证
                if (res.status === 401) {
                    showToast('登录已过期，请重新登录', 'error');
                    // 清除登录状态并显示登录表单
                    localStorage.removeItem('token');
                    localStorage.removeItem('user');
                    sessionStorage.removeItem('token');
                    sessionStorage.removeItem('user');
                    document.getElementById('adminLogin').style.display = 'flex';
                    document.getElementById('adminApp').style.display = 'none';
                    return null;
                }
                // 处理 403 权限错误
                if (res.status === 403) {
                    showToast('无操作权限', 'error');
                    return null;
                }
                return res;
            } catch (err) {
                showToast(err && err.name === 'AbortError' ? '请求超时，请重试' : '网络错误，请重试', 'error');
                return null;
            } finally {
                if (timeoutId) window.clearTimeout(timeoutId);
            }
        }

        // Toast 提示
        function showToast(message, type = 'success') {
            const container = document.getElementById('toast-container');
            const icons = {
                success: '✅',
                error: '❌',
                warning: '⚠️',
                info: 'ℹ️'
            };
            // Toast 左侧已经统一显示状态图标，避免调用方文案再带一个相同图标造成“双勾/双叉”。
            const toastIcon = icons[type] || icons.info;
            let displayMessage = message == null ? '' : String(message);
            const trimmedMessage = displayMessage.trimStart();
            if (trimmedMessage.startsWith(toastIcon)) {
                displayMessage = trimmedMessage.slice(toastIcon.length).trimStart();
            }
            const toast = document.createElement('div');
            toast.className = 'toast toast-' + type;
            toast.innerHTML = `
                <span class="toast-icon">${toastIcon}</span>
                <span class="toast-message">${displayMessage}</span>
            `;
            container.appendChild(toast);
            // 触发 CSS 过渡动画
            requestAnimationFrame(() => toast.classList.add('show'));
            // 成功提示显示5秒，其他3秒
            const duration = type === 'success' ? 5000 : 3000;
            setTimeout(() => {
                toast.classList.remove('show');
                toast.classList.add('removing');
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }

        // 暴露 showToast 到全局，供 IIFE 外部的函数使用
        window.showToast = showToast;

        // 按钮 loading 辅助：防止重复点击
        window.withLoading = async function(btn, fn) {
            if (btn.classList.contains('btn-loading')) return;
            var orig = btn.innerHTML;
            btn.classList.add('btn-loading');
            btn.disabled = true;
            try {
                await fn();
            } catch(e) {
                showToast(e.message || '操作失败', 'error');
            } finally {
                btn.classList.remove('btn-loading');
                btn.disabled = false;
            }
        };

        // 自定义确认框（替代浏览器confirm，移动端更友好）
        window.showConfirmModal = function(message, onConfirm, onCancel) {
            // 移除已存在的确认框
            const existing = document.getElementById('custom-confirm-modal');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'custom-confirm-modal';
            overlay.className = 'admin-runtime-overlay admin-confirm-overlay';
            overlay.innerHTML = `
                <div class="admin-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-message">
                    <div class="admin-confirm-dialog__icon" aria-hidden="true">⚠️</div>
                    <div class="admin-confirm-dialog__message" id="confirm-message">${message}</div>
                    <div class="admin-dialog-actions">
                        <button id="confirm-cancel-btn" class="btn btn-secondary">取消</button>
                        <button id="confirm-ok-btn" class="btn btn-primary">确定</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            document.getElementById('confirm-cancel-btn').onclick = function() {
                overlay.remove();
                if (onCancel) onCancel();
            };
            document.getElementById('confirm-ok-btn').onclick = function() {
                overlay.remove();
                if (onConfirm) onConfirm();
            };
            overlay.onclick = function(e) {
                if (e.target === overlay) {
                    overlay.remove();
                    if (onCancel) onCancel();
                }
            };
        };

        // ===== 系统设置自动保存（在IIFE内定义，通过window暴露） =====
        var _saveSettingsTimer = null;
        var _settingsLoaded = false; // 标记是否已加载过设置
        var _themeSavePending = false;
        var festivalThemeNames = { teachers_day: '教师节 / 黑板主题', '520': '520 告白季' };
        function getSelectedFestivalTheme() {
            var selected = document.querySelector('input[name="festival_theme"]:checked');
            return selected ? selected.value : 'teachers_day';
        }
        function updateFestivalThemeSummary(value) {
            var current = document.getElementById('festival-theme-current');
            if (current) current.textContent = festivalThemeNames[value] || '教师节 / 黑板主题';
        }
        function setFestivalTheme(value) {
            var safeValue = festivalThemeNames[value] ? value : 'teachers_day';
            document.querySelectorAll('input[name="festival_theme"]').forEach(function(input) {
                input.checked = input.value === safeValue;
            });
            updateFestivalThemeSummary(safeValue);
        }
        window.autoSaveSettings = async function() {
            // 还没加载到设置就触发了自动保存？跳过（防止保存空值）
            if (!_settingsLoaded) return;
            clearTimeout(_saveSettingsTimer);
            _saveSettingsTimer = setTimeout(async function() {
                var body = {
                    site_name: document.getElementById('setting-site-name').value.trim(),
                    allow_register: document.getElementById('setting-register-switch').classList.contains('active') ? 1 : 0,
                    post_review: document.getElementById('setting-review-switch').classList.contains('active') ? 1 : 0,
                    song_enabled: document.getElementById('setting-song-switch').classList.contains('active') ? 1 : 0,
                    daily_song_limit: parseInt(document.getElementById('setting-daily-song-limit').value) || 3,
                    anon_post: document.getElementById('setting-anon-post-switch').classList.contains('active') ? 1 : 0,
                    anon_comment: document.getElementById('setting-anon-comment-switch').classList.contains('active') ? 1 : 0,
                    anon_song: document.getElementById('setting-anon-song-switch').classList.contains('active') ? 1 : 0,
                    email_enabled: document.getElementById('setting-email-switch').classList.contains('active') ? 1 : 0,
                    register_email_verify_enabled: document.getElementById('setting-register-email-switch').classList.contains('active') ? 1 : 0,
                    song_pending_admin_notify: document.getElementById('setting-song-pending-admin-switch').classList.contains('active') ? 1 : 0,
                    smtp_host: document.getElementById('setting-smtp-host').value.trim(),
                    smtp_port: document.getElementById('setting-smtp-port').value.trim() || '587',
                    smtp_user: document.getElementById('setting-smtp-user').value.trim(),
                    smtp_from: document.getElementById('setting-smtp-from').value.trim(),
                    festival_enabled: document.getElementById('setting-festival-switch').classList.contains('active') ? 1 : 0,
                    festival_theme: getSelectedFestivalTheme()
                };
                var smtpPass = document.getElementById('setting-smtp-pass').value.trim();
                if (smtpPass) body.smtp_pass = smtpPass;
                try {
                    var res = await authFetch('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
                    if (!res) return;
                    var json = await res.json();
                    if (json.code === 200) {
                        var hint = document.getElementById('settings-save-hint');
                        if (hint) { hint.style.opacity = '1'; setTimeout(function() { hint.style.opacity = '0'; }, 2000); }
                        if (_themeSavePending) {
                            showToast('主题已保存，打开前台页面即可生效', 'success');
                            _themeSavePending = false;
                        }
                        recordLog('saveSettings', 0, null);
                    } else {
                        showToast(json.message || '保存失败', 'error');
                    }
                } catch (err) {
                    showToast('保存失败', 'error');
                }
            }, 500);
        };

        // 格式化时间
        function formatTime(dateStr) {
            if (!dateStr) return '-';
            try {
                const d = new Date(dateStr);
                if (isNaN(d.getTime())) return '-';
                const pad = n => String(n).padStart(2, '0');
                return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                       ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
            } catch (e) {
                return '-';
            }
        }

        // 状态标签 HTML
        function statusBadge(status) {
            const map = {
                pending:   { text: '待审核', cls: 'status-pending' },
                approved:  { text: '已发布', cls: 'status-approved' },
                published: { text: '已发布', cls: 'status-published' },
                rejected:  { text: '已拒绝', cls: 'status-rejected' },
                played:    { text: '已播放', cls: 'status-played' },
                active:    { text: '已启用', cls: 'status-active' },
                disabled:  { text: '已禁用', cls: 'status-disabled' },
                hidden:    { text: '已隐藏', cls: 'status-hidden' }
            };
            const info = map[status] || { text: status, cls: '' };
            return `<span class="status-badge ${info.cls}"><span class="status-dot"></span>${info.text}</span>`;
        }

        // 分类名称映射
        function categoryName(cat) {
            const map = {
                daily: '日常', confession: '表白', help: '求助',
                secondhand: '二手', club: '社团', lost_found: '失物招领', poll: '投票', lost: '寻物', other: '其他'
            };
            return map[cat] || cat || '-';
        }

        // 星期映射
        function weekdaysText(weekdays) {
            if (!weekdays) return '每天';
            const names = { '0': '周日', '1': '周一', '2': '周二', '3': '周三', '4': '周四', '5': '周五', '6': '周六' };
            return weekdays.split(',').map(d => names[d.trim()] || '').filter(Boolean).join('、');
        }

        // ===== 角色与权限配置 =====

        // 可进入后台的角色列表
        const STAFF_ROLES = ['reviewer', 'radio_admin', 'admin', 'super_admin'];

        // 角色名称映射
        const ROLE_NAMES = {
            user: '普通用户',
            reviewer: '审核员',
            radio_admin: '广播管理员',
            admin: '管理员',
            super_admin: '超级管理员'
        };

        // 角色标签样式映射
        const ROLE_TAG_CLASSES = {
            user: 'tag-default',
            reviewer: 'tag-green',
            radio_admin: 'tag-blue',
            admin: 'tag-purple',
            super_admin: 'tag-red'
        };

        // 角色权限映射
        const ROLE_PERMISSIONS = {
            reviewer:    ['posts:review'],
            radio_admin: ['songs:review', 'songs:delete', 'slots:manage', 'stats:view'],
            admin:       ['posts:review', 'posts:delete', 'songs:review', 'songs:delete', 'slots:manage', 'users:view', 'users:status', 'notices:manage', 'feedbacks:manage'],
            super_admin: ['stats:view', 'posts:review', 'posts:delete', 'songs:review', 'songs:delete', 'slots:manage', 'users:view', 'users:status', 'users:role', 'admin:manage', 'logs:view', 'notices:manage', 'settings:view', 'feedbacks:manage', 'stories:review', 'post-views:view', 'wechat:review']
        };

        // 角色对应的默认面板
        const ROLE_DEFAULT_PANELS = {
            reviewer:    'posts',
            radio_admin: 'songs',
            admin:       'posts',
            super_admin: 'overview'
        };

        // 当前登录用户信息（全局）
        let currentUser = null;

        // 检查当前用户是否拥有指定权限
        function hasPermission(permission) {
            if (!currentUser) return false;
            const perms = ROLE_PERMISSIONS[currentUser.role] || [];
            return perms.includes(permission);
        }

        // ===== 登录检查 =====
        function checkAuth() {
            const user = getCurrentUser();
            const token = getToken();
            if (!token || !user || !STAFF_ROLES.includes(user.role)) {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                sessionStorage.removeItem('token');
                sessionStorage.removeItem('user');
                // 显示登录表单，隐藏后台
                document.getElementById('adminLogin').style.display = 'flex';
                document.getElementById('adminApp').style.display = 'none';
                return false;
            }

            // 隐藏登录表单，显示后台
            document.getElementById('adminLogin').style.display = 'none';
            document.getElementById('adminApp').style.display = 'flex';

            // 保存当前用户信息到全局变量
            currentUser = user;

            // 设置侧边栏用户信息
            document.getElementById('sidebar-avatar').src = user.avatar || '/images/default-avatar.png';
            document.getElementById('sidebar-nickname').textContent = user.nickname || user.username;
            document.getElementById('sidebar-role').textContent = user.roleName || ROLE_NAMES[user.role] || '管理员';

            // 设置顶部栏用户信息
            document.getElementById('topbar-avatar').src = user.avatar || '/images/default-avatar.png';
            document.getElementById('topbar-username').textContent = user.nickname || user.username;
            document.getElementById('dropdown-avatar').src = user.avatar || '/images/default-avatar.png';
            document.getElementById('dropdown-name').textContent = user.nickname || user.username;
            document.getElementById('dropdown-role').textContent = user.roleName || ROLE_NAMES[user.role] || '管理员';

            // 根据权限显示/隐藏侧边栏菜单项
            applyMenuPermissions();

            return true;
        }

        // 根据权限控制侧边栏菜单可见性
        function applyMenuPermissions() {
            const menuLinks = document.querySelectorAll('.sidebar-link[data-permission], .sidebar-link[data-super-admin-only]');
            menuLinks.forEach(link => {
                const perm = link.dataset.permission;
                const superAdminOnly = link.dataset.superAdminOnly === 'true';
                const allowed = superAdminOnly
                    ? Boolean(currentUser && currentUser.role === 'super_admin')
                    : (!perm || hasPermission(perm));
                if (allowed) {
                    link.style.display = '';
                } else {
                    link.style.display = 'none';
                }
            });
        }

        // ===== 侧边栏导航切换 =====
        const sidebarLinks = document.querySelectorAll('.sidebar-link[data-panel]');
        const panels = document.querySelectorAll('.admin-panel');
        const panelTitle = document.getElementById('panel-title');
        const panelTitles = {
            overview: '数据概览',
            posts: '帖子管理',
            users: '用户管理',
            songs: '点歌管理',
            'daily-songs': '推歌候选曲库',
            slots: '时段设置',
            logs: '操作日志',
            notices: '公告管理',
            feedbacks: '反馈管理',
            postviews: '浏览记录',
            settings: '系统设置',
            wechattest: '微信测试',
            messages: '私信管理',
            stories: '连载小说',
            trash: '回收站',
            email: '邮件群发'
        };

        function switchPanel(panelName) {
            // 权限检查：如果面板对应的菜单项有 data-permission，检查是否拥有权限
            const menuLink = document.querySelector(`.sidebar-link[data-panel="${panelName}"]`);
            if (menuLink && menuLink.dataset.superAdminOnly === 'true' && (!currentUser || currentUser.role !== 'super_admin')) {
                showToast('仅超级管理员可使用推歌功能', 'warning');
                return;
            }
            if (menuLink && menuLink.dataset.permission && !hasPermission(menuLink.dataset.permission)) {
                showToast('无操作权限', 'warning');
                return;
            }

            sidebarLinks.forEach(link => link.classList.remove('active'));
            panels.forEach(panel => panel.classList.remove('active'));

            if (menuLink) menuLink.classList.add('active');
            const activePanel = document.getElementById('panel-' + panelName);
            if (activePanel) activePanel.classList.add('active');
            panelTitle.textContent = panelTitles[panelName] || '';

            // 移动端关闭侧边栏
            closeSidebar();

            // 保存当前面板到localStorage（页面停留记忆）
            try {
                localStorage.setItem('admin_last_panel', panelName);
            } catch (e) {}

            // 加载对应面板数据
            loadPanelData(panelName);

            // 触发面板切换事件（用于某些面板懒加载）
            try {
                document.dispatchEvent(new CustomEvent('panelChange', { detail: { panel: panelName } }));
            } catch(e) {}
        }

        sidebarLinks.forEach(link => {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                switchPanel(this.dataset.panel);
            });
        });

        // ===== 移动端侧边栏 =====
        const sidebar = document.getElementById('admin-sidebar');
        const sidebarOverlay = document.getElementById('sidebar-overlay');
        const mobileToggle = document.getElementById('admin-mobile-toggle');

        function isMobileDrawerViewport() {
            return window.matchMedia('(max-width: 768px)').matches;
        }

        function openSidebar() {
            if (!isMobileDrawerViewport()) return;
            sidebar.classList.add('sidebar-open');
            sidebarOverlay.classList.add('show');
            mobileToggle.setAttribute('aria-expanded', 'true');
        }

        function closeSidebar() {
            sidebar.classList.remove('sidebar-open');
            sidebarOverlay.classList.remove('show');
            mobileToggle.setAttribute('aria-expanded', 'false');
        }

        mobileToggle.addEventListener('click', openSidebar);
        sidebarOverlay.addEventListener('click', closeSidebar);
        window.addEventListener('resize', function() {
            if (!isMobileDrawerViewport()) closeSidebar();
        });
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') closeSidebar();
        });

        // ===== 侧边栏折叠/展开 =====
        const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        const adminSidebar = document.getElementById('admin-sidebar');
        const adminMain = document.querySelector('.admin-main');
        let sidebarCollapsed = false;

        sidebarCollapseBtn.addEventListener('click', function() {
            sidebarCollapsed = !sidebarCollapsed;
            adminSidebar.classList.toggle('sidebar-collapsed', sidebarCollapsed);
            adminMain.classList.toggle('main-expanded', sidebarCollapsed);
            // Rotate the collapse icon
            this.style.transform = sidebarCollapsed ? 'rotate(180deg)' : 'rotate(0deg)';
        });

        // ===== 顶部栏用户下拉菜单 =====
        const topbarUser = document.getElementById('topbar-user');
        const userDropdown = document.getElementById('user-dropdown');

        topbarUser.addEventListener('click', function(e) {
            e.stopPropagation();
            userDropdown.classList.toggle('show');
        });

        document.addEventListener('click', function(e) {
            if (!topbarUser.contains(e.target)) {
                userDropdown.classList.remove('show');
            }
        });

        document.getElementById('dropdown-logout').addEventListener('click', function() {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            sessionStorage.removeItem('token');
            sessionStorage.removeItem('user');
            window.location.href = '/login';
        });

        // 移动端退出登录按钮
        document.getElementById('topbar-logout-btn').addEventListener('click', function() {
            if (confirm('确定要退出登录吗？')) {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
                sessionStorage.removeItem('token');
                sessionStorage.removeItem('user');
                window.location.href = '/login';
            }
        });

        // ===== 顶部栏搜索 =====
        const searchInput = document.getElementById('topbar-search-input');
        searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                const query = this.value.trim().toLowerCase();
                if (!query) return;
                // Search through menu items
                const menuItems = document.querySelectorAll('.sidebar-link[data-panel]');
                for (const item of menuItems) {
                    const text = item.querySelector('.link-text').textContent.toLowerCase();
                    if (text.includes(query)) {
                        const panel = item.dataset.panel;
                        if (item.style.display !== 'none') {
                            switchPanel(panel);
                            this.value = '';
                            this.blur();
                            break;
                        }
                    }
                }
            }
        });

        // ===== 通知铃铛 - 显示待审核总数 =====
        function updateBellBadge() {
            const postsBadge = document.getElementById('badge-pending-posts');
            const songsBadge = document.getElementById('badge-pending-songs');
            const feedbacksBadge = document.getElementById('badge-pending-feedbacks');
            const bellBadge = document.getElementById('bell-badge');
            if (!bellBadge) return;
            let total = 0;
            [postsBadge, songsBadge, feedbacksBadge].forEach((badge) => {
                if (badge && badge.style.display !== 'none') {
                    total += Number(badge.dataset.count || badge.textContent) || 0;
                }
            });
            if (total > 0) {
                bellBadge.style.display = 'flex';
                bellBadge.textContent = total > 99 ? '99+' : total;
            } else {
                bellBadge.style.display = 'none';
            }
        }

        // 铃声按钮点击事件 - 跳转到待审核帖子
        const bellBtn = document.getElementById('topbar-bell');
        if (bellBtn) {
            bellBtn.addEventListener('click', function() {
                const postsBadge = document.getElementById('badge-pending-posts');
                const songsBadge = document.getElementById('badge-pending-songs');

                const hasPendingPosts = postsBadge && postsBadge.style.display !== 'none' && parseInt(postsBadge.textContent) > 0;
                const hasPendingSongs = songsBadge && songsBadge.style.display !== 'none' && parseInt(songsBadge.textContent) > 0;

                if (hasPendingPosts) {
                    // 有待审核帖子，跳转到帖子管理并筛选待审核
                    switchPanel('posts');
                    // 点击待审核筛选按钮（增加延迟确保面板已切换）
                    setTimeout(() => {
                        const pendingBtn = document.querySelector('#panel-posts .filter-btn[data-status="pending"]');
                        if (pendingBtn) {
                            pendingBtn.click();
                        } else {
                            console.error('❌ 找不到待审核按钮');
                        }
                    }, 300);
                } else if (hasPendingSongs) {
                    // 有待审核点歌，跳转到点歌管理并筛选待审核
                    switchPanel('songs');
                    setTimeout(() => {
                        const pendingBtn = document.querySelector('#panel-songs .filter-btn[data-status="pending"]');
                        if (pendingBtn) {
                            pendingBtn.click();
                        } else {
                            console.error('❌ 找不到待审核按钮');
                        }
                    }, 300);
                } else {
                    showToast('暂无新通知', 'info');
                }
            });
        } else {
            console.error('❌ 找不到铃声按钮元素 #topbar-bell');
        }

        // ===== 退出登录 =====
        document.getElementById('btn-logout').addEventListener('click', function() {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            sessionStorage.removeItem('token');
            sessionStorage.removeItem('user');
            window.location.href = '/login';
        });

        // ===== 数据加载 =====

        let currentPanel = 'overview';
        window.currentPanel = currentPanel;
        let postsPage = 1;
        let postsStatus = 'all';
        let usersPage = 1;
        let songsPage = 1;
        let songsStatus = 'all';
        let songsKeyword = '';
        const DEFAULT_SONG_REJECT_REASONS = [
            '当前播放时段名额已满，请选择其他时段再点歌。',
            '本周暂未开放点歌，请下周再来。',
            '歌曲内容不适合校园广播，请更换其他歌曲。',
            '歌曲信息不完整，请补充歌名或歌手后重新提交。',
            '该歌曲已重复点歌，请选择其他歌曲。',
            '当前歌曲暂时无法播放，请更换其他歌曲。'
        ];
        let songRejectReasons = DEFAULT_SONG_REJECT_REASONS.slice();
        // 点歌列表已包含详情字段，先用缓存即时打开，再静默刷新最新数据。
        const songDetailCache = Object.create(null);
        const songDetailRequests = Object.create(null);

        function loadPanelData(panel) {
            currentPanel = panel;
            window.currentPanel = panel;
            switch (panel) {
                case 'overview': loadOverview(); break;
                case 'posts': loadPosts(); break;
                case 'users': loadUsers(); break;
                case 'songs':
                    loadSongs();
                    loadSongRejectReasonTemplates();
                    break;
                case 'daily-songs': loadDailySongs(); break;
                case 'slots': loadSlots(); break;
                case 'logs': loadLogs(); break;
                case 'notices': loadNotices(); break;
                case 'trash': loadTrash(); break;
                case 'feedbacks': loadFeedbacks(); break;
                case 'postviews': loadPostViews(); break;
                case 'settings': loadSettings(); break;
                case 'email': loadEmailPanel(); break;
                case 'wechattest': loadWechatTest(); break;
                case 'messages': loadAdminMessages(); break;
                case 'stories': loadStories().then(function() { loadPromptConfig(); }); break;
            }
        }

        // ----- 数据概览 -----
        async function loadOverview() {
            try {
                const res = await authFetch('/api/admin/stats');
                const json = await res.json();
                if (json.code === 200) {
                    const d = json.data;
                    document.getElementById('stat-total-users').textContent = d.totalUsers;
                    document.getElementById('stat-total-posts').textContent = d.totalPosts;
                    document.getElementById('stat-today-posts').textContent = d.todayPosts;
                    document.getElementById('stat-pending-songs').textContent = d.pendingSongs;
                    document.getElementById('stat-today-views').textContent = d.todayPostViews || 0;

                    // 更新侧边栏徽章
                    updateBadge('badge-pending-posts', d.pendingPosts);
                    updateBadge('badge-pending-songs', d.pendingSongs);
                    // 更新通知铃铛
                    updateBellBadge();
                }
            } catch (err) {
                showToast('加载统计数据失败', 'error');
            }

            // 加载待审核帖子
            try {
                const res = await authFetch('/api/admin/posts?status=pending&limit=5');
                const json = await res.json();
                const container = document.getElementById('overview-pending-posts');
                if (json.code === 200 && json.data.posts.length > 0) {
                    container.innerHTML = json.data.posts.map((p, i) => `
                        <div class="overview-list-item">
                            <span class="item-index">${i + 1}</span>
                            <div class="item-content">
                                <div class="item-title">${escapeHtml(p.title || '无标题')}</div>
                                <div class="item-meta">${escapeHtml(p.nickname || p.username || '匿名')} · ${formatTime(p.created_at)}</div>
                            </div>
                            <div class="item-actions">
                                <button class="btn btn-sm btn-primary" data-admin-action="admin-action" data-action-name="approvePost" data-id="${p.id}">通过</button>
                                <button class="btn btn-sm btn-ghost" style="color: #DC2626;" data-admin-action="admin-action" data-action-name="rejectPost" data-id="${p.id}">拒绝</button>
                            </div>
                        </div>
                    `).join('');
                } else {
                    container.innerHTML = '<div class="admin-empty"><span class="empty-emoji">🎉</span><span>暂无待审核帖子</span></div>';
                }
            } catch (err) {
                // ignore
            }

            // 加载待审核点歌
            try {
                const res = await authFetch('/api/admin/songs?status=pending&limit=50');
                const json = await res.json();
                const container = document.getElementById('overview-pending-songs');
                if (json.code === 200 && json.data.songs.length > 0) {
                    container.innerHTML = json.data.songs.map((s, i) => `
                        <div class="overview-list-item">
                            <span class="item-index">${i + 1}</span>
                            <div class="item-content">
                                <div class="item-title">🎵 ${escapeHtml(s.song_name)} - ${escapeHtml(s.artist)}</div>
                                <div class="item-meta">点歌人：${escapeHtml(s.nickname || s.username || '匿名')} · ${formatTime(s.created_at)}</div>
                            </div>
                            <div class="item-actions">
                                <button class="btn btn-sm btn-primary" data-admin-action="admin-action" data-action-name="approveSong" data-id="${s.id}">通过</button>
                                <button class="btn btn-sm btn-ghost" style="color: #DC2626;" data-admin-action="admin-action" data-action-name="rejectSong" data-id="${s.id}">拒绝</button>
                            </div>
                        </div>
                    `).join('');
                } else {
                    container.innerHTML = '<div class="admin-empty"><span class="empty-emoji">🎉</span><span>暂无待审核点歌</span></div>';
                }
            } catch (err) {
                // ignore
            }
        }

        function updateBadge(id, count) {
            const badge = document.getElementById(id);
            if (!badge) return;
            const normalizedCount = Math.max(0, Number(count) || 0);
            badge.dataset.count = String(normalizedCount);
            if (normalizedCount > 0) {
                badge.textContent = normalizedCount > 99 ? '99+' : normalizedCount;
                badge.style.display = 'inline';
            } else {
                badge.textContent = '0';
                badge.style.display = 'none';
            }
            updateBellBadge();
        }

        // 刷新侧边栏徽章（重新请求统计数据）
        async function loadSidebarBadges() {
            try {
                const res = await authFetch('/api/admin/stats');
                if (!res) return;
                const json = await res.json();
                if (json.code === 200 && json.data) {
                    const d = json.data;
                    updateBadge('badge-pending-posts', d.pendingPosts || 0);
                    updateBadge('badge-pending-songs', d.pendingSongs || 0);
                }
                // 更新每日推歌徽章
                updateDailySongsBadge();
            } catch (err) {
                // ignore
            }
        }
        window.loadSidebarBadges = function() {
            // 加防抖：3秒内只调用一次
            if (window._sidebarBadgeTimer) clearTimeout(window._sidebarBadgeTimer);
            window._sidebarBadgeTimer = setTimeout(loadSidebarBadges, 3000);
        };
        // 数据发生删除/审核等变更后立即刷新，避免列表已是 0 条但徽章仍停留在旧的 99+。
        window.refreshSidebarBadgesNow = function() {
            if (window._sidebarBadgeTimer) {
                clearTimeout(window._sidebarBadgeTimer);
                window._sidebarBadgeTimer = null;
            }
            return loadSidebarBadges();
        };

        // ===== 侧边栏徽章自动刷新（仅切回 tab 时刷新，不主动轮询）=====
        // 切回 tab 时立即刷新
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden) loadSidebarBadges();
        });
        // 页面加载完启动（仅一次，不设 interval）
        if (document.readyState === 'complete') {
            loadSidebarBadges();
        } else {
            window.addEventListener('load', function() { loadSidebarBadges(); });
        }

        // ----- 帖子管理 -----
        async function loadPosts() {
            const params = new URLSearchParams({ page: postsPage, limit: 15 });
            if (postsStatus !== 'all') params.set('status', postsStatus);

            // 显示骨架屏
            document.getElementById('posts-tbody').innerHTML = '<tr><td colspan="8"><div class="skeleton" style="height:320px;border-radius:8px;"></div></td></tr>';

            try {
                const res = await authFetch('/api/admin/posts?' + params);
                const json = await res.json();
                if (json.code === 200) {
                    const { posts, total, totalPages } = json.data;
                    document.getElementById('posts-count').textContent = '共 ' + total + ' 条';
                    renderPostsTable(posts);
                    renderPagination('posts-pagination', postsPage, totalPages, (page) => {
                        postsPage = page;
                        loadPosts();
                    });
                }
            } catch (err) {
                showToast('加载帖子列表失败', 'error');
            }
        }

        function renderPostsTable(posts) {
            const tbody = document.getElementById('posts-tbody');
            if (!posts || posts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8"><div class="admin-empty"><span class="empty-emoji">📭</span><span>暂无数据</span></div></td></tr>';
                return;
            }
            tbody.innerHTML = posts.map((p, i) => `
                <tr>
                    <td><input type="checkbox" class="post-checkbox" value="${p.id}" data-admin-action="update-post-batch" style="accent-color:#FF6B9D;cursor:pointer;"></td>
                    <td data-label="序号">${i + 1}</td>
                    <td data-label="标题" style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(p.title || '无标题')}</td>
                    <td data-label="作者">${escapeHtml(p.nickname || p.username || '匿名')}</td>
                    <td data-label="分类"><span class="tag tag-default">${categoryName(p.category)}</span></td>
                    <td data-label="状态">${statusBadge(p.status)}</td>
                    <td data-label="时间" style="white-space: nowrap; font-size: 0.8rem; color: var(--text-light);">${formatTime(p.created_at)}${p.ip_region ? '<br><span style="color:var(--text-secondary);font-size:0.75rem;">📍 ' + escapeHtml(p.ip_region) + '</span>' : ''}</td>
                    <td data-label="操作">
                        <div class="table-actions">
                            <button class="action-btn action-btn-text" title="查看" data-admin-action="view-post" data-id="${p.id}">👁 查看</button>
                            ${p.status === 'pending' ? `
                                <button class="action-btn action-btn-text btn-approve" title="通过" data-admin-action="admin-action" data-action-name="approvePost" data-id="${p.id}">✓ 通过</button>
                                <button class="action-btn action-btn-text btn-reject" title="拒绝" data-admin-action="admin-action" data-action-name="rejectPost" data-id="${p.id}">✕ 拒绝</button>
                            ` : ''}
                            <button class="action-btn action-btn-text" data-admin-action="toggle-pin" data-id="${p.id}" data-pinned="${p.is_pinned || 0}" title="${p.is_pinned ? '取消置顶' : '置顶'}">${p.is_pinned ? '📌' : '📍'}</button>
                            <button class="action-btn action-btn-text btn-delete" title="删除" data-admin-action="admin-action" data-action-name="deletePost" data-id="${p.id}">🗑 删除</button>
                        </div>
                    </td>
                </tr>
            `).join('');
        }

        // 全选 / 取消全选
        function toggleAllPosts(checked) {
            document.querySelectorAll('.post-checkbox').forEach(cb => cb.checked = checked);
            updatePostBatchBtn();
        }

        function updatePostBatchBtn() {
            var ids = Array.from(document.querySelectorAll('.post-checkbox:checked')).map(cb => parseInt(cb.value));
            var btn = document.getElementById('post-batch-approve-btn');
            var count = document.getElementById('post-batch-count');
            var rejectBtn = document.getElementById('post-batch-reject-btn');
            if (ids.length > 0) {
                btn.style.display = 'inline-block';
                rejectBtn.style.display = 'inline-block';
                count.style.display = 'inline-block';
                count.textContent = '已选 ' + ids.length + ' 条';
            } else {
                btn.style.display = 'none';
                rejectBtn.style.display = 'none';
                count.style.display = 'none';
            }
        }

        async function batchPostAction(status) {
            var ids = Array.from(document.querySelectorAll('.post-checkbox:checked')).map(cb => parseInt(cb.value));
            if (ids.length === 0) { showToast('请先选择帖子', 'warning'); return; }
            if (!confirm('确定' + (status === 'approved' ? '通过' : '拒绝') + '选中的 ' + ids.length + ' 条帖子？')) return;
            var btn = document.getElementById(status === 'approved' ? 'post-batch-approve-btn' : 'post-batch-reject-btn');
            if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
            try {
                var token = localStorage.getItem("token") || sessionStorage.getItem("token");
                var res = await fetch('/api/admin/posts/batch-status', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ ids, status })
                });
                var json = await res.json();
                if (json.code === 200) {
                    showToast(json.message, 'success');
                    loadPosts();
                } else {
                    showToast('操作失败: ' + json.message, 'error');
                }
            } catch(e) {
                showToast('操作失败', 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
            }
        }

        // 帖子筛选
        document.querySelectorAll('#panel-posts .filter-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('#panel-posts .filter-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                postsStatus = this.dataset.status;
                postsPage = 1;
                loadPosts();
            });
        });

                // 查看帖子详情（美化版）
        window.viewPostDetail = async function(postId) {
            try {
                const res = await authFetch('/api/admin/posts/' + postId);
                const json = await res.json();
                if (json.code === 200) {
                    const p = json.data;
                    const images = p.images ? (typeof p.images === 'string' ? JSON.parse(p.images) : p.images) : [];
                    var catColors = { daily:'#10B981', confession:'#F43F5E', help:'#F59E0B', secondhand:'#8B5CF6', club:'#3B82F6', lost_found:'#F97316', poll:'#EC4899', other:'#6B7280' };
                    var catBg = { daily:'#ECFDF5', confession:'#FFF1F2', help:'#FFFBEB', secondhand:'#F5F3FF', club:'#EFF6FF', lost_found:'#FFF7ED', poll:'#FDF2F8', other:'#F3F4F6' };
                    var catName = p.category;
                    var cc = catColors[catName] || '#6B7280';
                    var cb = catBg[catName] || '#F3F4F6';

                    const modalHtml = `
                        <div class="modal-overlay show" id="post-detail-overlay" data-admin-action="close-modal-overlay" data-modal-id="post-detail-modal" style="display:flex;align-items:center;justify-content:center;">
                            <div class="modal admin-post-detail-modal" id="post-detail-modal" style="display:flex;max-width:820px;width:94vw;margin:20px;border:none;border-radius:20px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.25);">

                                <!-- 顶部渐变区 -->
                                <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:32px 36px 26px;position:relative;">
                                    <button class="modal-close" data-admin-action="close-modal" data-modal-id="post-detail-modal" style="position:absolute;top:16px;right:20px;color:rgba(255,255,255,0.7);background:rgba(255,255,255,0.15);border:none;width:32px;height:32px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;line-height:1;">&times;</button>
                                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
                                        <div style="flex:1;min-width:0;">
                                            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                                                <span style="background:rgba(255,255,255,0.2);padding:3px 10px;border-radius:12px;font-size:11px;color:rgba(255,255,255,0.9);font-weight:500;"># ${p.id}</span>
                                                ${statusBadge(p.status).replace(/style="/, 'style="background:rgba(255,255,255,0.2);color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;')}
                                            </div>
                                            <h2 style="margin:0;color:#fff;font-size:20px;font-weight:700;line-height:1.4;word-break:break-word;">${escapeHtml(p.title || '无标题')}</h2>
                                        </div>
                                    </div>
                                </div>

                                <div class="modal-body" style="padding:0;max-height:68vh;overflow-y:auto;background:#fff;">

                                    <!-- 元数据行 -->
                                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:#f0f0f0;border-bottom:1px solid #f0f0f0;">
                                        <div style="padding:16px 22px;background:#fff;">
                                            <div style="font-size:11px;color:#999;margin-bottom:3px;">👤 作者</div>
                                            <div style="font-size:14px;font-weight:600;color:#333;">${escapeHtml(p.nickname || p.username || '匿名')}</div>
                                        </div>
                                        <div style="padding:14px 18px;background:#fff;">
                                            <div style="font-size:11px;color:#999;margin-bottom:3px;">🏷️ 分类</div>
                                            <span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600;color:${cc};background:${cb};">${categoryName(p.category)}</span>
                                        </div>
                                        <div style="padding:14px 18px;background:#fff;">
                                            <div style="font-size:11px;color:#999;margin-bottom:3px;">🕒 发布时间</div>
                                            <div style="font-size:13px;color:#555;font-weight:500;">${formatTime(p.created_at)}</div>
                                        </div>
                                        ${p.ip_region ? `
                                        <div style="padding:14px 18px;background:#fff;">
                                            <div style="font-size:11px;color:#999;margin-bottom:3px;">📍 IP归属</div>
                                            <div style="font-size:13px;color:#555;font-weight:500;">${escapeHtml(p.ip_region)}</div>
                                        </div>` : ''}
                                    </div>

                                    <!-- 统计卡片 -->
                                    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:22px 26px;background:#F9FAFB;border-bottom:1px solid #f0f0f0;">
                                        <div style="text-align:center;background:#fff;padding:12px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
                                            <div style="font-size:22px;font-weight:800;color:#F43F5E;">${p.likes_count || 0}</div>
                                            <div style="font-size:11px;color:#999;margin-top:2px;">❤️ 点赞</div>
                                        </div>
                                        <div style="text-align:center;background:#fff;padding:12px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
                                            <div style="font-size:22px;font-weight:800;color:#3B82F6;">${p.views || 0}</div>
                                            <div style="font-size:11px;color:#999;margin-top:2px;">👁️ 浏览</div>
                                        </div>
                                        <div style="text-align:center;background:#fff;padding:12px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
                                            <div style="font-size:22px;font-weight:800;color:#10B981;">${p.comments_count || 0}</div>
                                            <div style="font-size:11px;color:#999;margin-top:2px;">💬 评论</div>
                                        </div>
                                    </div>

                                    <!-- 内容区 -->
                                    <div style="padding:24px 28px;border-bottom:1px solid #f0f0f0;">
                                        <div style="font-size:13px;font-weight:600;color:#666;margin-bottom:10px;">📄 正文内容</div>
                                        <div style="padding:16px 18px;background:#FAF9FE;border-left:3px solid #667eea;border-radius:8px;font-size:14px;color:#444;line-height:1.8;white-space:pre-wrap;word-break:break-word;">${escapeHtml(p.content || '（无内容）')}</div>
                                    </div>

                                    <!-- 图片区 -->
                                    ${images.length > 0 ? `
                                    <div style="padding:24px 28px;border-bottom:1px solid #f0f0f0;">
                                        <div style="font-size:13px;font-weight:600;color:#666;margin-bottom:10px;">🖼️ 图片（${images.length}张）</div>
                                        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;">
                                            ${images.map(function(img,idx) { var safeImg = escapeHtml(img); return '<div class="admin-detail-image-tile" data-admin-action="open-image" data-url="' + safeImg + '" style="border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);cursor:pointer;transition:transform 0.2s,box-shadow 0.2s;position:relative;"><img src="' + safeImg + '" style="width:100%;height:200px;object-fit:cover;display:block;" alt="图片' + (idx+1) + '"><div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.5));padding:6px 10px;text-align:right;font-size:11px;color:rgba(255,255,255,0.8);">🔍</div></div>'; }).join('')}
                                        </div>
                                    </div>` : ''}

                                    <!-- 操作按钮 -->
                                    <div style="padding:22px 26px;display:flex;gap:12px;flex-wrap:wrap;${p.status === 'pending' ? '' : 'justify-content:flex-end;'}">
                                        ${p.status === 'pending' ? `
                                            <button class="admin-detail-approve-btn" style="flex:1;min-width:100px;padding:10px 20px;border-radius:12px;font-weight:600;border:none;cursor:pointer;background:linear-gradient(135deg,#10B981,#059669);color:#fff;font-size:14px;transition:transform 0.15s,box-shadow 0.15s;" data-admin-action="admin-action-close-modal" data-action-name="approvePost" data-id="${p.id}" data-modal-id="post-detail-modal">✓ 通过审核</button>
                                            <button class="admin-detail-reject-btn" style="flex:1;min-width:100px;padding:10px 20px;border-radius:12px;font-weight:600;border:1.5px solid #FCA5A5;cursor:pointer;background:#fff;color:#DC2626;font-size:14px;transition:all 0.15s;" data-admin-action="admin-action-close-modal" data-action-name="rejectPost" data-id="${p.id}" data-modal-id="post-detail-modal">✕ 拒绝</button>
                                        ` : ''}
                                        <button class="admin-detail-close-btn" style="padding:10px 22px;border-radius:12px;font-weight:500;border:1px solid #e0e0e0;cursor:pointer;background:#fff;color:#666;font-size:13px;transition:all 0.15s;" data-admin-action="close-modal" data-modal-id="post-detail-modal">关闭</button>
                                    </div>

                                </div>
                            </div>
                        </div>
                    `;

                    document.body.insertAdjacentHTML('beforeend', modalHtml);
                }
            } catch (err) {
                showToast('加载帖子详情失败', 'error');
            }
        }

        // 点歌详情优化：缓存先展示，接口只负责静默刷新；即使详情接口慢也不会阻塞弹窗。
        function renderSongDetailModalFast(song, state) {
            const s = song || {};
            const songId = s.id || '';
            let bodyHtml = '';

            if (state === 'loading') {
                bodyHtml = '<div style="display:flex;align-items:center;gap:12px;padding:28px 4px;color:var(--text-secondary);"><span class="loading"></span><span>正在加载点歌详情…</span></div>';
            } else if (state === 'error') {
                bodyHtml = '<div style="padding:28px 4px;color:var(--text-secondary);">暂时无法加载详情，请稍后重试。</div>';
            } else {
                bodyHtml = `
                    <div style="margin-bottom: 16px;"><strong>歌曲：</strong>${escapeHtml(s.song_name || '-')}</div>
                    <div style="margin-bottom: 16px;"><strong>歌手：</strong>${escapeHtml(s.artist || '-')}</div>
                    <div style="margin-bottom: 16px;"><strong>状态：</strong>${statusBadge(s.status)}</div>
                    <div style="margin-bottom: 16px;"><strong>点歌人：</strong>${escapeHtml(s.nickname || s.username || '匿名')}</div>
                    <div style="margin-bottom: 16px;"><strong>预约播放：</strong><span class="tag tag-purple">${escapeHtml(formatSongSchedule(s))}</span></div>
                    <div style="margin-bottom: 16px;"><strong>播放时段：</strong>${escapeHtml(s.slot_name || '-')}</div>
                    <div style="margin-bottom: 16px;"><strong>点歌时间：</strong>${formatTime(s.created_at)}</div>
                    ${s.message ? `<div style="margin-bottom: 16px;"><strong>留言：</strong><div style="margin-top: 8px; padding: 12px; background: var(--bg-section); border-radius: 8px;">${escapeHtml(s.message)}</div></div>` : ''}
                    ${s.status === 'rejected' && s.reject_reason ? `<div style="margin-bottom: 16px;"><strong>拒绝理由：</strong><div style="margin-top: 8px; padding: 12px; background: #FEF3C7; color: #92400E; border-radius: 8px;">${escapeHtml(s.reject_reason)}</div></div>` : ''}
                    ${s.status === 'pending' ? `<div style="margin-top: 20px; display: flex; gap: 12px;"><button class="btn btn-primary" data-admin-action="open-song-approval" data-id="${s.id}">✓ 选择时段并通过</button><button class="btn btn-ghost" style="color: #DC2626;" data-admin-action="admin-action-close-modal" data-action-name="rejectSong" data-id="${s.id}" data-modal-id="song-detail-modal">✕ 拒绝</button></div>` : ''}
                    ${s.status === 'approved' ? `<div style="margin-top: 20px; display: flex; flex-wrap: wrap; gap: 10px;"><button class="btn btn-primary" data-admin-action="open-song-reschedule" data-id="${s.id}">调整播放时间</button><button class="btn btn-ghost" style="color: #DC2626;" data-admin-action="admin-action-close-modal" data-action-name="rejectSong" data-id="${s.id}" data-modal-id="song-detail-modal">打回并通知</button><button class="btn btn-ghost" data-admin-action="admin-action-close-modal" data-action-name="playSong" data-id="${s.id}" data-modal-id="song-detail-modal">标记已播放</button></div>` : ''}
                `;
            }

            let overlay = document.getElementById('song-detail-overlay');
            if (!overlay) {
                document.body.insertAdjacentHTML('beforeend', `
                    <div class="modal-overlay show" id="song-detail-overlay" data-admin-action="close-modal-overlay" data-modal-id="song-detail-modal">
                        <div class="modal" id="song-detail-modal" style="display: flex; max-width: 600px;">
                            <div class="modal-header"><h3 id="song-detail-title"></h3><button class="modal-close" data-admin-action="close-modal" data-modal-id="song-detail-modal">&times;</button></div>
                            <div class="modal-body" id="song-detail-body" style="max-height: 70vh; overflow-y: auto;"></div>
                        </div>
                    </div>
                `);
                overlay = document.getElementById('song-detail-overlay');
            }
            overlay.dataset.songId = String(songId);
            document.getElementById('song-detail-title').textContent = '🎵 点歌详情 #' + songId;
            document.getElementById('song-detail-body').innerHTML = bodyHtml;
        }

        // 覆盖旧的等待式打开逻辑：点击后立即显示列表数据，后台再刷新一次。
        window.viewSongDetail = async function(songId) {
            const key = String(songId);
            const cached = songDetailCache[key];
            renderSongDetailModalFast(cached || { id: songId }, cached ? 'ready' : 'loading');

            if (songDetailRequests[key]) return songDetailRequests[key];
            songDetailRequests[key] = (async function() {
                try {
                    const res = await authFetch('/api/admin/songs/' + encodeURIComponent(songId));
                    if (!res) return;
                    const json = await res.json();
                    if (json.code !== 200 || !json.data) {
                        if (!cached && document.getElementById('song-detail-overlay')?.dataset.songId === key) {
                            renderSongDetailModalFast({ id: songId }, 'error');
                        }
                        showToast(json.message || '加载点歌详情失败', 'error');
                        return;
                    }
                    songDetailCache[key] = Object.assign({}, songDetailCache[key] || {}, json.data);
                    const currentOverlay = document.getElementById('song-detail-overlay');
                    if (currentOverlay && currentOverlay.dataset.songId === key) {
                        renderSongDetailModalFast(songDetailCache[key], 'ready');
                    }
                } catch (err) {
                    if (!cached && document.getElementById('song-detail-overlay')?.dataset.songId === key) {
                        renderSongDetailModalFast({ id: songId }, 'error');
                    }
                    showToast('加载点歌详情失败', 'error');
                } finally {
                    delete songDetailRequests[key];
                }
            })();
            return songDetailRequests[key];
        };

        function formatSongApprovalOption(option) {
            const date = option && option.play_date ? String(option.play_date).split('T')[0] : '日期待确认';
            const start = option && option.start_time ? String(option.start_time).slice(0, 5) : '';
            const end = option && option.end_time ? String(option.end_time).slice(0, 5) : '';
            const range = start && end ? start + '–' + end : (start || end || '时间待确认');
            return date + ' · ' + (option.slot_name || '未命名时段') + ' · ' + range;
        }

        // 所有“通过”入口都会先到这里。时段列表只是选择器，最终容量和日期状态仍由后端事务重新校验。
        window.openSongApprovalModal = async function(songId) {
            const oldOverlay = document.getElementById('song-approval-overlay');
            if (oldOverlay) oldOverlay.remove();
            try {
                const res = await authFetch('/api/admin/songs/' + encodeURIComponent(songId) + '/reschedule-options');
                if (!res) return;
                const json = await res.json();
                if (json.code !== 200 || !json.data) {
                    showToast(json.message || '获取可用播放时段失败', 'error');
                    return;
                }
                const song = json.data.song || {};
                const options = Array.isArray(json.data.options) ? json.data.options : [];
                const slotChoices = Array.isArray(json.data.slot_choices) ? json.data.slot_choices : [];
                if (options.length === 0 && slotChoices.length === 0) {
                    showToast('没有可用的未来播放时段，暂时不能通过该点歌', 'warning');
                    return;
                }
                const currentSlotDateId = String(song.slot_date_id || '');
                const currentIsAvailable = options.some(function(option) { return String(option.id) === currentSlotDateId; });
                const optionHtml = options.map(function(option) {
                    const isCurrent = String(option.id) === currentSlotDateId;
                    const label = formatSongApprovalOption(option) + (option.is_full ? ' · 已满（可勾选超额）' : ' · 剩余 ' + option.remaining + '/' + option.max_songs) + (isCurrent ? '（当前预约）' : '');
                    return '<option value="' + Number(option.id) + '"' + (isCurrent ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
                }).join('') || '<option value="" disabled selected>暂无预生成日期，请使用下方自定义日期</option>';
                const original = formatSongApprovalOption(song);
                const changeHint = options.length === 0
                    ? '这条点歌只有原定时段，没有预约日期；请选择一个播放日期，系统会自动建立单日播放安排。'
                    : currentIsAvailable
                    ? '默认保留当前预约；如需改期，请选择另一个仍有名额的日期/时段。'
                    : '原预约已不可用或已关闭，请在下方重新选择一个可用时段后再通过。';
                // 无论是否已有预生成日期，都保留自定义入口，避免只有一个日期时无法灵活改排。
                const needsCustomDate = true;
                const customSlotHtml = slotChoices.map(function(slot, index) {
                    const selected = String(slot.id) === String(song.slot_id || '') || (!song.slot_id && index === 0);
                    const label = (slot.slot_name || '未命名时段') + ' · ' + String(slot.start_time || '').slice(0, 5) + '–' + String(slot.end_time || '').slice(0, 5);
                    return '<option value="' + Number(slot.id) + '"' + (selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
                }).join('');
                const customDateBlock = needsCustomDate ? `
                                <div class="song-approval-custom-date">
                                    <label class="song-approval-label" for="song-approval-custom-date">需要指定其他日期？</label>
                                    <div class="song-approval-custom-grid">
                                        <div class="song-approval-date-field">
                                            <span class="song-approval-date-placeholder" aria-hidden="true">请选择播放日期</span>
                                            <input id="song-approval-custom-date" class="song-approval-input" type="date" aria-describedby="song-approval-custom-note" data-admin-action="toggle-date-value">
                                        </div>
                                        <select id="song-approval-custom-slot" class="song-approval-select">${customSlotHtml}</select>
                                    </div>
                                    <p class="song-approval-note" id="song-approval-custom-note">填写后将优先使用这里的日期；可安排今天起未来一年的任意日期，并选择实际播放时段。</p>
                                </div>` : '';

                document.body.insertAdjacentHTML('beforeend', `
                    <div class="modal-overlay show" id="song-approval-overlay" data-admin-action="close-modal-overlay" data-modal-id="song-approval-modal">
                        <div class="modal song-approval-modal" id="song-approval-modal" role="dialog" aria-modal="true" aria-labelledby="song-approval-title">
                            <div class="modal-header song-approval-modal-header">
                                <div>
                                    <div class="song-approval-kicker">点歌审核</div>
                                    <h3 id="song-approval-title">确认播放安排</h3>
                                </div>
                                <button class="modal-close" type="button" data-admin-action="close-modal" data-modal-id="song-approval-modal" aria-label="关闭确认播放安排">&times;</button>
                            </div>
                            <div class="modal-body song-approval-modal-body">
                                <div class="song-approval-original">
                                    <span>原预约播放</span>
                                    <strong>${escapeHtml(original)}</strong>
                                </div>
                                <p class="song-approval-hint">${escapeHtml(changeHint)}</p>
                                ${options.length > 0 ? `<label class="song-approval-label" for="song-approval-slot-date">通过后的播放日期与时段</label>
                                 <select id="song-approval-slot-date" class="song-approval-select">${optionHtml}</select>
                                 <label class="song-approval-overbook"><input id="song-approval-allow-overbook" type="checkbox"> 允许管理员超出名额排入</label>
                                <p class="song-approval-note">时段容量会在提交时再次校验；若刚好被其他审核占用，会提示你重新选择。</p>` : ''}
                                ${customDateBlock}
                            </div>
                            <div class="modal-footer song-approval-modal-footer">
                                <button class="btn btn-ghost" type="button" data-admin-action="close-modal" data-modal-id="song-approval-modal">取消</button>
                                <button class="btn btn-primary" type="button" id="song-approval-confirm" data-admin-action="confirm-song-approval" data-id="${Number(songId)}">确认通过并通知</button>
                            </div>
                        </div>
                    </div>
                `);
            } catch (err) {
                showToast('获取可用播放时段失败，请稍后重试', 'error');
            }
        };

        window.confirmSongApproval = async function(songId) {
            const select = document.getElementById('song-approval-slot-date');
            const customDateInput = document.getElementById('song-approval-custom-date');
            const customSlotSelect = document.getElementById('song-approval-custom-slot');
            const confirmButton = document.getElementById('song-approval-confirm');
            const slotDateId = select ? Number(select.value) : 0;
            const customDate = customDateInput ? String(customDateInput.value || '').trim() : '';
                const customSlotId = customSlotSelect ? Number(customSlotSelect.value) : 0;
                const allowOverbook = Boolean(document.getElementById('song-approval-allow-overbook')?.checked);
            if ((!Number.isSafeInteger(slotDateId) || slotDateId <= 0) && !/^\d{4}-\d{2}-\d{2}$/.test(customDate)) {
                showToast('请选择播放日期与时段', 'warning');
                return;
            }
            if (confirmButton) {
                confirmButton.disabled = true;
                confirmButton.textContent = '正在确认…';
            }
            try {
                const approvalBody = { status: 'approved' };
                if (customDate) {
                    approvalBody.play_date = customDate;
                    if (Number.isSafeInteger(customSlotId) && customSlotId > 0) approvalBody.slot_id = customSlotId;
                } else if (Number.isSafeInteger(slotDateId) && slotDateId > 0) {
                    approvalBody.slot_date_id = slotDateId;
                }
                if (allowOverbook) approvalBody.allow_overbook = true;
                const res = await authFetch('/api/admin/songs/' + encodeURIComponent(songId) + '/status', {
                    method: 'PUT',
                    body: JSON.stringify(approvalBody)
                });
                if (!res) return;
                const json = await res.json();
                if (json.code !== 200) {
                    showToast(json.message || '审核通过失败', 'error');
                    return;
                }
                showToast(json.message || '已通过点歌并发送通知', 'success');
                delete songDetailCache[String(songId)];
                window.closeModal('song-approval-modal');
                window.closeModal('song-detail-modal');
                window.refreshSidebarBadgesNow();
                loadSongs();
            } catch (err) {
                showToast('网络错误，请重试', 'error');
            } finally {
                if (confirmButton && document.body.contains(confirmButton)) {
                    confirmButton.disabled = false;
                    confirmButton.textContent = '确认通过并通知';
                }
            }
        };

        // 已通过、尚未播放的点歌仍可调整到其他可用日期/时段；与首次审核共用选择器，
        // 但提交走后端专用 reschedule 接口，避免误把已通过记录再次当成 pending 审核。
        window.openSongRescheduleModal = async function(songId) {
            const oldOverlay = document.getElementById('song-approval-overlay');
            if (oldOverlay) oldOverlay.remove();
            try {
                const res = await authFetch('/api/admin/songs/' + encodeURIComponent(songId) + '/reschedule-options');
                if (!res) return;
                const json = await res.json();
                if (json.code !== 200 || !json.data) {
                    showToast(json.message || '获取可用播放时段失败', 'error');
                    return;
                }
                const song = json.data.song || {};
                if (song.status !== 'approved') {
                    showToast('只有已通过、尚未播放的点歌可以调整时间', 'warning');
                    return;
                }
                const options = Array.isArray(json.data.options) ? json.data.options : [];
                const slotChoices = Array.isArray(json.data.slot_choices) ? json.data.slot_choices : [];
                if (options.length === 0 && slotChoices.length === 0) {
                    showToast('没有可用的未来播放时段，请先在时段设置中开放日期', 'warning');
                    return;
                }
                const currentSlotDateId = String(song.slot_date_id || '');
                const optionHtml = options.map(function(option) {
                    const isCurrent = String(option.id) === currentSlotDateId;
                    const label = formatSongApprovalOption(option) + (option.is_full ? ' · 已满（可勾选超额）' : ' · 剩余 ' + option.remaining + '/' + option.max_songs) + (isCurrent ? '（当前安排）' : '');
                    return '<option value="' + Number(option.id) + '"' + (isCurrent ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
                }).join('') || '<option value="" disabled selected>暂无预生成日期，请使用下方自定义日期</option>';
                const customSlotHtml = slotChoices.map(function(slot, index) {
                    const selected = String(slot.id) === String(song.slot_id || '') || (!song.slot_id && index === 0);
                    const label = (slot.slot_name || '未命名时段') + ' · ' + String(slot.start_time || '').slice(0, 5) + '–' + String(slot.end_time || '').slice(0, 5);
                    return '<option value="' + Number(slot.id) + '"' + (selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
                }).join('');
                const customDateBlock = `
                                <div class="song-approval-custom-date">
                                    <label class="song-approval-label" for="song-approval-custom-date">需要指定其他日期？</label>
                                    <div class="song-approval-custom-grid">
                                        <div class="song-approval-date-field">
                                            <span class="song-approval-date-placeholder" aria-hidden="true">请选择播放日期</span>
                                            <input id="song-approval-custom-date" class="song-approval-input" type="date" aria-describedby="song-approval-custom-note" data-admin-action="toggle-date-value">
                                        </div>
                                        <select id="song-approval-custom-slot" class="song-approval-select">${customSlotHtml}</select>
                                    </div>
                                    <p class="song-approval-note" id="song-approval-custom-note">填写后将优先使用这里的日期；可安排今天起未来一年的任意日期，并选择实际播放时段。</p>
                                </div>`;
                document.body.insertAdjacentHTML('beforeend', `
                    <div class="modal-overlay show" id="song-approval-overlay" data-admin-action="close-modal-overlay" data-modal-id="song-approval-modal">
                        <div class="modal song-approval-modal" id="song-approval-modal" role="dialog" aria-modal="true" aria-labelledby="song-approval-title">
                            <div class="modal-header song-approval-modal-header">
                                <div><div class="song-approval-kicker">播放安排调整</div><h3 id="song-approval-title">调整点歌播放时间</h3></div>
                                <button class="modal-close" type="button" data-admin-action="close-modal" data-modal-id="song-approval-modal" aria-label="关闭调整播放时间">&times;</button>
                            </div>
                            <div class="modal-body song-approval-modal-body">
                                <div class="song-approval-original"><span>当前播放安排</span><strong>${escapeHtml(formatSongApprovalOption(song))}</strong></div>
                                <p class="song-approval-hint">歌曲保持“已通过”状态；请选择另一个仍开放且有名额的播放日期/时段。保存后会把新安排发送到点歌用户邮箱。</p>
                                ${options.length > 0 ? `<label class="song-approval-label" for="song-approval-slot-date">新的播放日期与时段</label>
                                 <select id="song-approval-slot-date" class="song-approval-select">${optionHtml}</select>
                                 <label class="song-approval-overbook"><input id="song-approval-allow-overbook" type="checkbox"> 允许管理员超出名额排入</label>
                                <p class="song-approval-note">提交时后端会再次校验周期、启用状态和容量。</p>` : ''}
                                ${customDateBlock}
                            </div>
                            <div class="modal-footer song-approval-modal-footer">
                                <button class="btn btn-ghost" type="button" data-admin-action="close-modal" data-modal-id="song-approval-modal">取消</button>
                                <button class="btn btn-primary" type="button" id="song-reschedule-confirm" data-admin-action="confirm-song-reschedule" data-id="${Number(songId)}">保存调整并通知</button>
                            </div>
                        </div>
                    </div>
                `);
            } catch (err) {
                showToast('获取可用播放时段失败，请稍后重试', 'error');
            }
        };

        window.confirmSongReschedule = async function(songId) {
            const select = document.getElementById('song-approval-slot-date');
            const customDateInput = document.getElementById('song-approval-custom-date');
            const customSlotSelect = document.getElementById('song-approval-custom-slot');
            const confirmButton = document.getElementById('song-reschedule-confirm');
            const slotDateId = select ? Number(select.value) : 0;
            const customDate = customDateInput ? String(customDateInput.value || '').trim() : '';
                const customSlotId = customSlotSelect ? Number(customSlotSelect.value) : 0;
                const allowOverbook = Boolean(document.getElementById('song-approval-allow-overbook')?.checked);
            if ((!Number.isSafeInteger(slotDateId) || slotDateId <= 0) && !/^\d{4}-\d{2}-\d{2}$/.test(customDate)) {
                showToast('请选择新的播放日期与时段', 'warning');
                return;
            }
            if (confirmButton) {
                confirmButton.disabled = true;
                confirmButton.textContent = '正在保存…';
            }
            try {
                const body = customDate
                    ? { play_date: customDate, slot_id: customSlotId, ...(allowOverbook ? { allow_overbook: true } : {}) }
                    : { slot_date_id: slotDateId, ...(allowOverbook ? { allow_overbook: true } : {}) };
                const encodedBody = JSON.stringify(body);
                if (confirmButton && window.crypto && window.crypto.randomUUID && confirmButton.dataset.writeBody !== encodedBody) {
                    confirmButton.dataset.writeBody = encodedBody;
                    confirmButton.dataset.writeKey = window.crypto.randomUUID();
                }
                const res = await authFetch('/api/admin/songs/' + encodeURIComponent(songId) + '/reschedule', {
                    method: 'PUT',
                    headers: confirmButton && confirmButton.dataset.writeKey ? { 'Idempotency-Key': confirmButton.dataset.writeKey } : {},
                    body: encodedBody
                });
                if (!res) return;
                const json = await res.json();
                if (json.code !== 200) {
                    showToast(json.message || '调整播放时间失败', 'error');
                    return;
                }
                if (json.data) {
                    songDetailCache[String(songId)] = Object.assign({}, songDetailCache[String(songId)] || {}, json.data);
                }
                showToast(json.message || '播放时间已调整并发送通知', 'success');
                window.closeModal('song-approval-modal');
                window.closeModal('song-detail-modal');
                loadSongs();
            } catch (err) {
                showToast('网络错误，请重试', 'error');
            } finally {
                if (confirmButton && document.body.contains(confirmButton)) {
                    confirmButton.disabled = false;
                    confirmButton.textContent = '保存调整并通知';
                }
            }
        };

        // 置顶/取消置顶帖子
        window.togglePin = async function(postId, isPinned) {
          if (!confirm(isPinned ? '确定取消置顶？' : '确定置顶该帖子？')) return;
          try {
            const res = await authFetch('/api/admin/posts/' + postId + '/pin', { method: 'PUT' });
            if (!res) return; // 401或403错误
            const data = await res.json();
            if (data.code === 200) {
              showToast(data.message, 'success');
              loadPosts();
            } else {
              showToast(data.message || '操作失败', 'error');
            }
          } catch (e) {
            console.error('置顶操作失败:', e);
            showToast('操作失败', 'error');
          }
        }

        // ----- 用户管理 -----
        let usersPageSize = 50;
        let usersSearchKeyword = '';
        let usersRoleFilter = 'all';

        async function loadUsers() {
            const tbody = document.getElementById('users-tbody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="9"><div class="loading-text"><span class="loading-spinner"></span>加载中...</div></td></tr>';
            const params = new URLSearchParams({
                page: usersPage,
                limit: usersPageSize
            });
            if (usersSearchKeyword) {
                params.append('search', usersSearchKeyword);
            }
            if (usersRoleFilter !== 'all') {
                params.append('role', usersRoleFilter);
            }

            try {
                const res = await authFetch('/api/admin/users?' + params);
                const json = await res.json();
                if (json.code === 200) {
                    const { users, total, totalPages } = json.data;
                    const filterLabels = [];
                    if (usersSearchKeyword) filterLabels.push('搜索结果');
                    if (usersRoleFilter !== 'all') filterLabels.push(ROLE_NAMES[usersRoleFilter] || '身份筛选');
                    document.getElementById('users-count').textContent = filterLabels.length
                        ? `共 ${total} 人（${filterLabels.join(' · ')}）`
                        : '共 ' + total + ' 人';
                    renderUsersTable(users);
                    renderPagination('users-pagination', usersPage, totalPages, (page) => {
                        usersPage = page;
                        loadUsers();
                    });
                }
            } catch (err) {
                showToast('加载用户列表失败', 'error');
            }
        }

        // 搜索用户
        function searchUsers() {
            const keyword = document.getElementById('users-search-input').value.trim();
            usersSearchKeyword = keyword;
            usersPage = 1;
            loadUsers();
        }
        window.searchUsers = searchUsers;

        function changeUsersRoleFilter(role) {
            usersRoleFilter = Object.prototype.hasOwnProperty.call(ROLE_NAMES, role) ? role : 'all';
            usersPage = 1;
            loadUsers();
        }
        window.changeUsersRoleFilter = changeUsersRoleFilter;

        // 修改每页显示数量
        function changeUsersPageSize(size) {
            usersPageSize = parseInt(size);
            usersPage = 1;
            loadUsers();
        }

        function renderUsersTable(users) {
            const tbody = document.getElementById('users-tbody');
            if (!users || users.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9"><div class="admin-empty"><span class="empty-emoji">📭</span><span>暂无数据</span></div></td></tr>';
                return;
            }
            const isSuperAdmin = currentUser && currentUser.role === 'super_admin';
            tbody.innerHTML = users.map(u => {
                const isActive = u.status === 1 || u.status === 'active';
                const roleText = ROLE_NAMES[u.role] || '普通用户';
                const roleTag = ROLE_TAG_CLASSES[u.role] || 'tag-default';
                // 格式化上次登录时间
                function fmtLogin(t) {
                    if (!t) return '<span style="color:var(--text-light);font-size:0.78rem;">—</span>';
                    return '<span style="font-size:0.78rem;white-space:nowrap;">' + formatTime(t) + '</span>';
                }
                // 格式化登录IP
                function fmtIp(ip, region) {
                    if (!ip) return '<span style="color:var(--text-light);font-size:0.78rem;">—</span>';
                    var display = region && region !== ip ? region : ip;
                    var hasRegion = region && region !== ip;
                    return '<span title="' + escapeHtml(ip) + '" style="font-size:0.78rem;white-space:nowrap;">' + escapeHtml(display) + '</span>' +
                           (!hasRegion ? ' <button class="action-btn action-btn-text" style="padding:0 4px;font-size:0.7rem;vertical-align:middle;" title="查询IP归属地" data-admin-action="lookup-ip" data-ip="' + escapeHtml(ip) + '">📍</button>' : '');
                }
                // 构建角色选择下拉框（仅超管可见）
                let roleSelectHtml = '';
                if (isSuperAdmin && u.id !== currentUser.id) {
                    const roleOptions = ['user', 'reviewer', 'radio_admin', 'admin', 'super_admin'].map(r =>
                        `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_NAMES[r]}</option>`
                    ).join('');
                    roleSelectHtml = `
                        <select class="role-select" data-admin-action="change-role" data-id="${u.id}" title="修改角色">
                            ${roleOptions}
                        </select>
                    `;
                }
                return `
                <tr>
                    <td>${u.id}</td>
                    <td>${escapeHtml(u.username)}</td>
                    <td>${escapeHtml(u.nickname || '-')}</td>
                    <td style="font-size:0.8rem;color:var(--text-light);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(u.email || '')}">${escapeHtml(u.email || '-')}</td>
                    <td><span class="tag ${roleTag}">${roleText}</span></td>
                    <td>${isActive ? statusBadge('active') : statusBadge('disabled')}</td>
                    <td style="white-space: nowrap; font-size: 0.8rem; color: var(--text-light);">
                      <div>${formatTime(u.created_at)}</div>
                      ${fmtIp(u.last_login_ip, u.last_login_region)}
                    </td>
                    <td style="white-space: nowrap;">${fmtLogin(u.last_login_at)}</td>
                    <td>
                        <div class="table-actions">
                            ${isActive ?
                                `<button class="action-btn action-btn-text btn-disable" title="封禁" data-admin-action="ban-user" data-id="${u.id}" data-name="${escapeHtml(u.nickname || u.username)}">🔒 封禁</button>` :
                                `<button class="action-btn action-btn-text btn-enable" title="启用" data-admin-action="admin-action" data-action-name="enableUser" data-id="${u.id}">🔓 解封</button>`
                            }
                            ${isSuperAdmin && u.id !== currentUser.id ? `
                                <button class="action-btn action-btn-text" title="一键登录" data-admin-action="login-as-user" data-id="${u.id}" data-name="${escapeHtml(u.nickname || u.username)}">🔑 登录</button>
                                <button class="action-btn action-btn-text btn-play" title="重置密码" data-admin-action="reset-user-password" data-id="${u.id}" data-name="${escapeHtml(u.username)}">🔑 改密</button>
                                <button class="action-btn action-btn-text btn-delete" title="删除用户" data-admin-action="delete-user" data-id="${u.id}" data-name="${escapeHtml(u.username)}">🗑 删除</button>
                            ` : ''}
                            ${isSuperAdmin ? `
                                <button class="action-btn action-btn-text btn-primary" title="设置头衔" data-admin-action="user-title" data-id="${u.id}" data-name="${escapeHtml(u.nickname || u.username)}">🏷 头衔</button>
                            ` : ''}
                            ${roleSelectHtml}
                        </div>
                    </td>
                </tr>
            `}).join('');
        }

        // 超级管理员一键登录用户账号
        window.loginAsUser = async function(userId, userName) {
            if (!confirm('确定要登录到「' + userName + '」的账号吗？')) return;
            var res = await authFetch('/api/admin/login-as-user', {
                method: 'POST',
                body: JSON.stringify({ user_id: userId })
            });
            if (!res) return;
            var data = await res.json();
            if (data.code === 200) {
                localStorage.setItem('token', data.data.token);
                localStorage.setItem('user', JSON.stringify(data.data.user));
                showToast('✅ 已登录到 ' + userName + ' 的账号，即将跳转...', 'success');
                setTimeout(function() { window.location.href = '/'; }, 1000);
            } else {
                showToast('❌ ' + (data.message || '登录失败'), 'error');
            }
        };

        // 删除用户（仅超管）
        window.deleteUser = function(userId, username) {
            if (!confirm('确定要删除用户「' + username + '」吗？\n该用户的所有帖子和点歌记录也将被删除，此操作不可撤销！')) return;
            authFetch('/api/admin/users/' + userId, { method: 'DELETE' })
                .then(r => r.json())
                .then(json => {
                    if (json.code === 200) {
                        showToast('用户已删除', 'success');
                        recordLog('deleteUser', userId, '删除用户: ' + username);
                        loadUsers();
                    } else {
                        showToast(json.message || '删除失败', 'error');
                    }
                })
                .catch(() => showToast('删除失败', 'error'));
        };

        // 重置用户密码（仅超管）
        window.resetUserPassword = function(userId, username) {
            const newPwd = prompt('请为用户「' + username + '」设置新密码（至少6位）：');
            if (!newPwd) return;
            if (newPwd.length < 6) {
                showToast('密码至少6位', 'warning');
                return;
            }
            authFetch('/api/admin/users/' + userId + '/password', {
                method: 'PUT',
                body: JSON.stringify({ new_password: newPwd })
            })
                .then(r => r.json())
                .then(json => {
                    if (json.code === 200) {
                        showToast('密码已重置', 'success');
                        recordLog('resetPassword', userId, '重置用户密码: ' + username);
                    } else {
                        showToast(json.message || '重置失败', 'error');
                    }
                })
                .catch(() => showToast('重置失败', 'error'));
        };

        // ----- 点歌管理 -----
        // songsPage, songsStatus, songsKeyword 已在上面声明
        async function loadSongs() {
            const tbody = document.getElementById('songs-tbody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="7"><div class="skeleton" style="height:320px;border-radius:8px;"></div></td></tr>';

            // 回收站使用不同的API
            if (songsStatus === 'trash') {
                await loadSongTrash();
                return;
            }

            const pageSize = document.getElementById('songs-page-size')?.value || 50;
            const params = new URLSearchParams({ page: songsPage, limit: pageSize });
            if (songsStatus !== 'all') params.set('status', songsStatus);
            if (songsKeyword) params.set('keyword', songsKeyword);

            try {
                const res = await authFetch('/api/admin/songs?' + params);
                const json = await res.json();
                if (json.code === 200) {
                    const { songs, total, totalPages } = json.data;
                    document.getElementById('songs-count').textContent = '共 ' + total + ' 条';
                    renderSongsTable(songs);
                    renderPagination('songs-pagination', songsPage, totalPages, (page) => {
                        songsPage = page;
                        loadSongs();
                    });
                }
            } catch (err) {
                showToast('加载点歌列表失败', 'error');
            }
        }

        function searchSongs() {
            songsKeyword = document.getElementById('songs-search-input')?.value.trim() || '';
            songsPage = 1;
            loadSongs();
        }

        function filterSongsBtn(btn) {
            const nextStatus = btn && btn.dataset ? btn.dataset.status : 'all';
            if (!btn || (songsStatus === nextStatus && btn.classList.contains('active'))) return;
            document.querySelectorAll('#panel-songs .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            songsStatus = nextStatus;
            document.getElementById('panel-songs')?.classList.toggle('song-trash-mode', songsStatus === 'trash');
            songsPage = 1;
            loadSongs();
        }
        // 筛选按钮使用内联 onclick，初始化逻辑在闭包内时必须显式暴露到 window。
        window.filterSongsBtn = filterSongsBtn;

        function getSongRejectReasonTemplates() {
            return songRejectReasons.length > 0 ? songRejectReasons.slice(0, 20) : DEFAULT_SONG_REJECT_REASONS.slice();
        }

        async function saveSongRejectReasonTemplates(reasons, message) {
            var normalized = reasons.map(function(reason) { return String(reason || '').trim(); }).filter(Boolean).slice(0, 20);
            if (normalized.length === 0) {
                showToast('至少保留一个拒绝理由预设', 'error');
                return false;
            }
            try {
                var res = await authFetch('/api/admin/song-reject-reasons', {
                    method: 'PUT',
                    body: JSON.stringify({ reasons: normalized })
                });
                if (!res) return false;
                var json = await res.json();
                if (json.code !== 200) {
                    showToast(json.message || '保存拒绝理由失败', 'error');
                    return false;
                }
                songRejectReasons = (json.data && json.data.song_reject_reasons) || normalized;
                renderSongRejectReasonEditor();
                showToast(message || '拒绝理由预设已保存', 'success');
                return true;
            } catch (err) {
                showToast('保存拒绝理由失败', 'error');
                return false;
            }
        }

        // 点歌预约使用业务日期 + 时段范围展示，避免后台只看到一个笼统时段名。
        function formatSongSchedule(song) {
            const date = song && song.play_date ? String(song.play_date).split('T')[0] : '';
            const start = song && song.start_time ? String(song.start_time).slice(0, 5) : '';
            const end = song && song.end_time ? String(song.end_time).slice(0, 5) : '';
            const range = start && end ? start + '–' + end : (start || end);
            if (date && range) return date + ' ' + range;
            return date || range || '未选择播放时间';
        }

        function renderSongRejectReasonEditor() {
            var container = document.getElementById('song-reject-reason-list');
            if (!container) return;
            container.innerHTML = '';
            getSongRejectReasonTemplates().forEach(function(reason, index) {
                var item = document.createElement('div');
                item.className = 'song-reject-reason-item';

                var head = document.createElement('div');
                head.className = 'song-reject-reason-head';

                var label = document.createElement('div');
                label.className = 'song-reject-reason-label';

                var number = document.createElement('span');
                number.className = 'song-reject-reason-index';
                number.textContent = String(index + 1).padStart(2, '0');

                var labelText = document.createElement('div');
                var title = document.createElement('strong');
                title.textContent = '预设 ' + (index + 1);
                var note = document.createElement('span');
                note.textContent = '审核时可直接选择';
                labelText.append(title, note);
                label.append(number, labelText);

                var actions = document.createElement('div');
                actions.className = 'song-reject-reason-actions';

                var input = document.createElement('textarea');
                input.className = 'song-reject-reason-input';
                input.rows = 2;
                input.maxLength = 500;
                input.value = reason;
                input.setAttribute('aria-label', '第' + (index + 1) + '条打回理由');

                var save = document.createElement('button');
                save.type = 'button';
                save.className = 'song-reject-reason-action';
                save.textContent = '保存修改';
                save.onclick = async function() {
                    var nextReason = input.value.trim();
                    if (!nextReason) { showToast('理由不能为空', 'error'); return; }
                    var next = getSongRejectReasonTemplates();
                    next[index] = nextReason;
                    await saveSongRejectReasonTemplates(next, '第' + (index + 1) + '条预设已保存');
                };

                var remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'song-reject-reason-action delete';
                remove.textContent = '删除预设';
                remove.onclick = async function() {
                    var next = getSongRejectReasonTemplates();
                    if (next.length <= 1) { showToast('至少保留一条打回理由', 'error'); return; }
                    next.splice(index, 1);
                    await saveSongRejectReasonTemplates(next, '已删除该预设');
                };
                actions.append(save, remove);
                head.append(label, actions);
                item.append(head, input);
                container.appendChild(item);
            });
        }

        async function loadSongRejectReasonTemplates() {
            try {
                var res = await authFetch('/api/admin/song-reject-reasons');
                if (!res) return;
                var json = await res.json();
                if (json.code === 200 && json.data && Array.isArray(json.data.song_reject_reasons)) {
                    songRejectReasons = json.data.song_reject_reasons.slice(0, 20);
                }
            } catch (err) {
                // 网络异常时仍保留本地默认预设，不阻塞审核。
            }
            renderSongRejectReasonEditor();
        }

        async function addSongRejectReasonTemplate() {
            var input = document.getElementById('song-reject-reason-new');
            var reason = input && input.value.trim();
            if (!reason) { showToast('请先写一条打回理由', 'error'); return; }
            var next = getSongRejectReasonTemplates();
            if (next.some(function(item) { return item === reason; })) { showToast('这条理由已经在预设里了', 'info'); return; }
            if (next.length >= 20) { showToast('最多保存 20 条预设', 'error'); return; }
            next.push(reason);
            if (await saveSongRejectReasonTemplates(next, '已新增打回理由预设')) input.value = '';
        }
        window.addSongRejectReasonTemplate = addSongRejectReasonTemplate;

        function chooseSongRejectReason() {
            var reasons = getSongRejectReasonTemplates();
            return new Promise(function(resolve) {
                var old = document.getElementById('song-reject-reason-modal');
                if (old) old.remove();

                var overlay = document.createElement('div');
                overlay.className = 'modal-overlay show';
                overlay.id = 'song-reject-reason-modal';
                overlay.style.zIndex = '100001';
                overlay.innerHTML = `
                    <div class="modal song-reject-modal" style="display:flex;width:100%;">
                        <div class="modal-header song-reject-modal-header">
                            <div>
                                <span class="song-reject-modal-kicker">点歌审核</span>
                                <h3>拒绝点歌</h3>
                            </div>
                            <button type="button" class="modal-close song-reject-modal-close" id="song-reject-cancel" aria-label="关闭拒绝点歌弹窗" title="关闭">&times;</button>
                        </div>
                        <div class="modal-body song-reject-modal-body">
                            <p class="song-reject-modal-intro">选择常用理由后仍可直接修改；确认后会把最终内容发送到同学的邮箱。</p>
                            <div class="song-reject-modal-field">
                                <div class="song-reject-modal-label-row">
                                    <label for="song-reject-preset">常用理由预设</label>
                                    <span class="song-reject-modal-label-note">选择后可继续编辑</span>
                                </div>
                                <select id="song-reject-preset" class="song-reject-preset-select"><option value="">不使用预设，手动填写</option></select>
                            </div>
                            <div class="song-reject-modal-field">
                                <div class="song-reject-modal-label-row">
                                    <label for="song-reject-reason-input">发送给同学的理由</label>
                                    <span class="song-reject-modal-label-note">最多 500 字</span>
                                </div>
                                <textarea id="song-reject-reason-input" class="song-reject-reason-textarea" maxlength="500" rows="4" placeholder="请清楚说明本次无法通过的原因"></textarea>
                            </div>
                            <div class="song-reject-preset-actions">
                                <button type="button" class="btn song-reject-preset-action" id="song-reject-update-preset">保存到当前预设</button>
                                <button type="button" class="btn song-reject-preset-action primary" id="song-reject-save-preset">另存为新预设</button>
                            </div>
                            <p class="song-reject-preset-footnote">保存预设不会拒绝当前点歌；点击下方“确认拒绝并通知”后才会执行审核。</p>
                        </div>
                        <div class="modal-footer song-reject-modal-footer" style="display:flex;gap:8px;justify-content:flex-end;">
                            <button type="button" class="btn btn-ghost" id="song-reject-cancel-footer">取消</button>
                            <button type="button" class="btn btn-danger" id="song-reject-confirm">确认拒绝并通知</button>
                        </div>
                    </div>`;
                document.body.appendChild(overlay);

                var select = document.getElementById('song-reject-preset');
                var textarea = document.getElementById('song-reject-reason-input');
                var updateBtn = document.getElementById('song-reject-update-preset');
                var selectedIndex = reasons.length > 0 ? 0 : -1;
                reasons.forEach(function(reason, index) {
                    var option = document.createElement('option');
                    option.value = String(index);
                    option.textContent = reason;
                    select.appendChild(option);
                });
                if (selectedIndex >= 0) {
                    select.value = String(selectedIndex);
                    textarea.value = reasons[selectedIndex];
                }

                function updatePresetButton() {
                    updateBtn.disabled = selectedIndex < 0;
                    updateBtn.style.opacity = selectedIndex < 0 ? '0.5' : '1';
                }
                function close(value) {
                    overlay.remove();
                    resolve(value);
                }
                select.addEventListener('change', function() {
                    selectedIndex = this.value === '' ? -1 : parseInt(this.value, 10);
                    textarea.value = selectedIndex >= 0 ? reasons[selectedIndex] : '';
                    updatePresetButton();
                });
                document.getElementById('song-reject-cancel').onclick = function() { close(null); };
                document.getElementById('song-reject-cancel-footer').onclick = function() { close(null); };
                overlay.addEventListener('click', function(event) { if (event.target === overlay) close(null); });
                updatePresetButton();

                document.getElementById('song-reject-save-preset').onclick = async function() {
                    var reason = textarea.value.trim();
                    if (!reason) { showToast('请先填写理由', 'error'); return; }
                    var next = reasons.slice();
                    if (next.some(function(item) { return item === reason; })) { showToast('该理由已经存在', 'info'); return; }
                    next.push(reason);
                    var saved = await saveSongRejectReasonTemplates(next, '已保存为新的拒绝理由预设');
                    if (saved) {
                        reasons = songRejectReasons.slice();
                        select.innerHTML = '<option value="">自定义理由</option>';
                        reasons.forEach(function(item, index) {
                            var option = document.createElement('option');
                            option.value = String(index);
                            option.textContent = item;
                            select.appendChild(option);
                        });
                        selectedIndex = reasons.length - 1;
                        select.value = String(selectedIndex);
                        textarea.value = reason;
                        updatePresetButton();
                    }
                };
                updateBtn.onclick = async function() {
                    if (selectedIndex < 0) return;
                    var reason = textarea.value.trim();
                    if (!reason) { showToast('请先填写理由', 'error'); return; }
                    var next = reasons.slice();
                    next[selectedIndex] = reason;
                    var saved = await saveSongRejectReasonTemplates(next, '当前拒绝理由预设已更新');
                    if (saved) {
                        reasons = songRejectReasons.slice();
                        select.options[selectedIndex].textContent = reason;
                    }
                };
                document.getElementById('song-reject-confirm').onclick = function() {
                    var reason = textarea.value.trim();
                    if (!reason) { showToast('请填写或选择拒绝理由', 'error'); return; }
                    close(reason);
                };
                textarea.focus();
            });
        }

        // ===== 每日推歌管理 =====
        var dailySongsPage = 1;
        var dailySongsStatus = '';
        var dailySongsCandidateState = 'active';
        var dailySongsPageSize = 20;
        var dailySongsTotal = 0;
        var dailySongsTotalPages = 1;

        async function loadDailySongs(page) {
            if (page) dailySongsPage = page;
            const tbody = document.getElementById('daily-songs-tbody');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="3"><div class="loading-text"><span class="loading-spinner"></span>加载中...</div></td></tr>';

            const keyword = document.getElementById('dailySongsKeyword')?.value || '';
            const status = dailySongsStatus;
            const pageSizeInput = document.getElementById('dailySongsPageSize');
            dailySongsPageSize = Math.min(100, Math.max(10, parseInt(pageSizeInput?.value, 10) || 20));
            const candidateQuery = dailySongsCandidateState === 'hidden'
                ? '&candidate_state=hidden'
                : '&candidate=1';

            try {
                const res = await authFetch('/api/admin/daily-songs?page=' + dailySongsPage + '&limit=' + dailySongsPageSize + '&status=' + status + candidateQuery + '&keyword=' + encodeURIComponent(keyword));
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    const songs = json.data.songs || [];
                    dailySongsTotal = Number(json.data.total) || 0;
                    dailySongsTotalPages = json.data.totalPages || 1;
                    renderDailySongsTable(songs, dailySongsTotal);
                    renderPagination('daily-songs-pagination', dailySongsPage, dailySongsTotalPages, loadDailySongs);
                } else {
                    tbody.innerHTML = '<tr><td colspan="3" class="admin-empty"><span>加载失败</span></td></tr>';
                }
            } catch (e) {
                console.error('[每日推歌] 加载失败:', e);
                tbody.innerHTML = '<tr><td colspan="3" class="admin-empty"><span>网络错误</span></td></tr>';
            }
        }
        window.loadDailySongs = loadDailySongs;

        // 打开添加推歌模态框
        function openAddDailySongModal() {
            document.getElementById('addSongName').value = '';
            document.getElementById('addSongArtist').value = '';
            document.getElementById('addSongToWhom').value = '';
            document.getElementById('addSongMessage').value = '';
            document.getElementById('addDailySongModal').style.display = 'flex';
        }
        window.openAddDailySongModal = openAddDailySongModal;

        // 关闭添加推歌模态框
        function closeAddDailySongModal() {
            document.getElementById('addDailySongModal').style.display = 'none';
        }
        window.closeAddDailySongModal = closeAddDailySongModal;

        // 保存推歌
        async function saveDailySong() {
            var songName = document.getElementById('addSongName').value.trim();
            var artist = document.getElementById('addSongArtist').value.trim();
            var toWhom = document.getElementById('addSongToWhom').value.trim();
            var message = document.getElementById('addSongMessage').value.trim();

            if (!songName) {
                showToast('请填写歌曲名', 'error');
                return;
            }
            if (!artist) {
                showToast('请填写歌手', 'error');
                return;
            }

            try {
                var res = await authFetch('/api/admin/daily-songs', {
                    method: 'POST',
                    body: JSON.stringify({ song_name: songName, artist: artist, to_whom: toWhom, message: message })
                });
                var json = await res.json();
                if (json.code === 200) {
                    showToast('添加成功', 'success');
                    closeAddDailySongModal();
                    loadDailySongs(1);
                } else {
                    showToast(json.message || '添加失败', 'error');
                }
            } catch (e) {
                showToast('网络错误', 'error');
            }
        }
        window.saveDailySong = saveDailySong;

        function filterDailySongs(btn) {
            document.querySelectorAll('#panel-daily-songs .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            dailySongsStatus = btn.dataset.status || '';
            dailySongsCandidateState = btn.dataset.candidateState || 'active';
            dailySongsPage = 1;
            loadDailySongs();
        }
        window.filterDailySongs = filterDailySongs;

        function renderDailySongsTable(songs, total) {
            const tbody = document.getElementById('daily-songs-tbody');
            if (!tbody) return;
            renderDailySongsSummary(total, songs ? songs.length : 0);
            if (!songs || songs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" class="admin-empty"><div class="admin-empty"><span class="empty-emoji">🎵</span><span>暂无数据</span></div></td></tr>';
                return;
            }
            tbody.innerHTML = songs.map(s => {
                var sourceTag = s.source === 'wechat' ? '<span class="song-tag-wechat">📱 微信</span>' : '<span class="song-tag-manual">✏️ 手动</span>';
                var statusTag = s.status === 'published' ? '<span class="song-tag-published">已发布</span>' : '<span class="song-tag-pending">未发布</span>';
                var hiddenTag = s.candidate_hidden_at ? '<span class="song-tag-hidden">已移出候选</span>' : '';
                // 候选曲库只负责整理；已发布歌曲在三天复用期内仍由公众号页面统一选择和同步。
                var publishBtn = s.status === 'published'
                    ? '<span class="song-status-note song-published-hint">已同步，无需再次推送 · 三天内可在公众号页复用</span>'
                    : '<span class="song-status-note song-pending-hint">待在公众号页统一推送</span>';
                var actionClass = 'song-cell-actions' + (s.status === 'published' || s.status === 'pending' ? ' has-status-note' : '');
                // 解析intro
                var introText = s.intro || '';
                if (introText.startsWith('{')) {
                    try { var p = JSON.parse(introText); introText = p.intro || ''; } catch(e) {}
                }
                introText = introText.replace(/【介绍】/g, '').replace(/【歌词】/g, '').trim();
                var introLine = introText ? escapeHtml(introText.substring(0, 60)) + (introText.length > 60 ? '...' : '') : '';
                var tagsHtml = sourceTag + statusTag + hiddenTag;
                if (s.lyrics) tagsHtml += '<span class="song-tag-lyrics">📝 歌词</span>';
                if (s.song_info) tagsHtml += '<span class="song-tag-info">ℹ️ 信息</span>';

                return `<tr class="song-row" data-song-id="${s.id}" data-song-status="${s.status}" data-admin-action="toggle-song-checkbox" data-id="${s.id}" style="cursor:pointer;">
                    <td data-admin-action="stop-propagation"><input type="checkbox" class="daily-song-checkbox" value="${s.id}" data-admin-action="update-daily-song-batch"></td>
                    <td>
                        <div class="song-cell-main">
                            <div class="song-cell-name">${escapeHtml(s.song_name || '')}</div>
                            <div class="song-cell-artist">${escapeHtml(s.artist || '未知歌手')}</div>
                            <div class="song-cell-meta">👤 ${escapeHtml(s.submitter || '匿名')}</div>
                            ${introLine ? '<div class="song-cell-intro">' + introLine + '</div>' : ''}
                            <div class="song-cell-tags">${tagsHtml}</div>
                        </div>
                    </td>
                    <td data-admin-action="stop-propagation">
                        <div class="${actionClass}">
                            ${publishBtn}
                            <button class="song-action-btn song-action-edit" data-admin-action="open-song-intro-editor" data-id="${s.id}">编辑全部</button>
                            <button class="song-action-btn song-action-delete" data-admin-action="delete-daily-song" data-id="${s.id}">删除</button>
                        </div>
                    </td>
                </tr>`;
            }).join('');
        }

        function renderDailySongsSummary(total, shown) {
            const summary = document.getElementById('daily-song-list-summary');
            if (!summary) return;
            const label = dailySongsCandidateState === 'hidden' ? '已移出候选' : '公众号候选';
            summary.textContent = label + '共 ' + (Number(total) || 0) + ' 首，本页显示 ' + (Number(shown) || 0) + ' 首';
        }

        function changeDailySongsPageSize(size) {
            dailySongsPageSize = Math.min(100, Math.max(10, parseInt(size, 10) || 20));
            dailySongsPage = 1;
            loadDailySongs();
        }
        window.changeDailySongsPageSize = changeDailySongsPageSize;

        // 更新每日推歌徽章
        async function updateDailySongsBadge() {
            try {
                const res = await authFetch('/api/admin/daily-songs?status=pending&candidate=1&limit=1');
                const json = await res.json();
                const badge = document.getElementById('badge-daily-songs');
                if (badge && json.code === 200 && json.data?.total > 0) {
                    badge.textContent = json.data.total;
                    badge.style.display = 'inline-flex';
                } else if (badge) {
                    badge.style.display = 'none';
                }
            } catch (e) {}
        }
        window.updateDailySongsBadge = updateDailySongsBadge;

        // 全选每日推歌
        function toggleAllDailySongs(checked) {
            document.querySelectorAll('.daily-song-checkbox').forEach(cb => cb.checked = checked);
            updateDailySongBatchBtn();
        }
        window.toggleAllDailySongs = toggleAllDailySongs;

        function toggleSongCheckbox(songId, event) {
            var row = event.target && event.target.closest ? event.target.closest('.song-row') : null;
            var cb = row ? row.querySelector('.daily-song-checkbox') : document.querySelector('.song-row[data-song-id="' + songId + '"] .daily-song-checkbox');
            if (cb) {
                cb.checked = !cb.checked;
                updateDailySongBatchBtn();
            }
        }
        window.toggleSongCheckbox = toggleSongCheckbox;

        // 更新批量按钮显示
        function updateDailySongBatchBtn() {
            var ids = Array.from(document.querySelectorAll('.daily-song-checkbox:checked')).map(cb => parseInt(cb.value));
            var batchBar = document.getElementById('dailySongBatchBar');
            var countEl = document.getElementById('daily-song-batch-count');
            var candidateToggle = document.getElementById('daily-song-candidate-toggle');
            if (ids.length > 0) {
                if (batchBar) batchBar.style.display = 'flex';
                if (countEl) countEl.textContent = '已选 ' + ids.length + ' 首';
                if (candidateToggle) candidateToggle.textContent = dailySongsCandidateState === 'hidden' ? '取消移出' : '移出候选';
            } else {
                if (batchBar) batchBar.style.display = 'none';
            }
            // 同步全选checkbox
            var selectAllCb = document.getElementById('dailySongSelectAll');
            if (selectAllCb) {
                var allCbs = document.querySelectorAll('.daily-song-checkbox');
                selectAllCb.checked = allCbs.length > 0 && Array.from(allCbs).every(cb => cb.checked);
            }
        }
        window.updateDailySongBatchBtn = updateDailySongBatchBtn;

        // “已发布”只能由公众号草稿同步成功后写入，候选曲库不再提供绕过同步的发布/撤回操作。
        function goToMpDraft() {
            window.location.href = '/admin/mp-draft.html#daily';
        }
        window.goToMpDraft = goToMpDraft;

        function getSelectedDailySongIds() {
            return Array.from(document.querySelectorAll('.daily-song-checkbox:checked'))
                .map(cb => parseInt(cb.value, 10))
                .filter(Number.isSafeInteger);
        }

        function updateDailySongsBadgeAfterRemoval(pendingRemoved) {
            const badge = document.getElementById('badge-daily-songs');
            if (!badge || !pendingRemoved) return;
            const current = parseInt(badge.textContent, 10);
            if (!Number.isFinite(current)) return;
            const next = Math.max(0, current - pendingRemoved);
            badge.textContent = next;
            badge.style.display = next > 0 ? 'inline-flex' : 'none';
        }

        // 请求成功后立即移除当前卡片、更新总数与未发布徽章；不用等下一次整页刷新才给反馈。
        function removeDailySongsFromCurrentView(ids) {
            const idSet = new Set(ids.map(Number));
            const rows = Array.from(document.querySelectorAll('#daily-songs-tbody tr[data-song-id]'));
            let removed = 0;
            let pendingRemoved = 0;
            rows.forEach(row => {
                if (!idSet.has(Number(row.dataset.songId))) return;
                if (row.dataset.songStatus === 'pending') pendingRemoved++;
                row.remove();
                removed++;
            });
            if (!removed) return { removed: 0, pendingRemoved: 0 };

            dailySongsTotal = Math.max(0, dailySongsTotal - removed);
            dailySongsTotalPages = Math.max(1, Math.ceil(dailySongsTotal / dailySongsPageSize));
            const remainingRows = document.querySelectorAll('#daily-songs-tbody tr[data-song-id]').length;
            renderDailySongsSummary(dailySongsTotal, remainingRows);
            updateDailySongsBadgeAfterRemoval(pendingRemoved);
            document.getElementById('dailySongSelectAll').checked = false;
            updateDailySongBatchBtn();

            if (remainingRows === 0) {
                const tbody = document.getElementById('daily-songs-tbody');
                tbody.innerHTML = '<tr><td colspan="3" class="admin-empty"><div class="admin-empty"><span class="empty-emoji">🎵</span><span>暂无数据</span></div></td></tr>';
            }
            renderPagination('daily-songs-pagination', Math.min(dailySongsPage, dailySongsTotalPages), dailySongsTotalPages, loadDailySongs);
            return { removed, pendingRemoved };
        }

        async function requestDailySongDeletion(ids, confirmationText) {
            if (ids.length === 0) return;
            if (!confirm(confirmationText)) return;
            try {
                const res = await authFetch('/api/admin/daily-songs', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: ids })
                });
                if (!res) return;
                const json = await res.json();
                if (json.code !== 200) {
                    showToast(json.message || '删除失败', 'error');
                    return;
                }
                const result = removeDailySongsFromCurrentView(ids);
                showToast('已删除 ' + (json.data?.deleted ?? result.removed) + ' 首，列表已即时更新', 'success');
                // 徽章此前已按当前卡片立即扣减，再向服务端对账，处理其他管理员并发操作。
                updateDailySongsBadge();
            } catch (e) {
                showToast('删除失败，请稍后重试', 'error');
            }
        }

        // 批量删除
        async function batchDeleteDailySongs() {
            var ids = getSelectedDailySongIds();
            await requestDailySongDeletion(ids, '确定要删除这 ' + ids.length + ' 首歌曲吗？此操作不可恢复！');
        }
        window.batchDeleteDailySongs = batchDeleteDailySongs;

        async function deleteDailySong(id) {
            await requestDailySongDeletion([id], '确定要删除这条推歌吗？此操作不可恢复！');
        }
        window.deleteDailySong = deleteDailySong;

        // “移出候选”是管理可见性操作，不会把 pending 改成 published，也不会修改 published_at。
        async function batchToggleDailySongCandidate() {
            var ids = getSelectedDailySongIds();
            if (ids.length === 0) return;
            var hidden = dailySongsCandidateState !== 'hidden';
            var verb = hidden ? '移出公众号候选' : '取消移出标记';
            if (!confirm('确定要将这 ' + ids.length + ' 首歌曲' + verb + '吗？这不会修改它们的发布状态。')) return;
            try {
                const res = await authFetch('/api/admin/daily-songs/candidate-visibility', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: ids, hidden: hidden })
                });
                if (!res) return;
                const json = await res.json();
                if (json.code !== 200) {
                    showToast(json.message || '操作失败', 'error');
                    return;
                }
                const result = removeDailySongsFromCurrentView(ids);
                showToast((hidden ? '已移出候选 ' : '已取消移出标记 ') + (json.data?.updated ?? result.removed) + ' 首；发布状态未改变', 'success');
                updateDailySongsBadge();
            } catch (e) {
                showToast('更新候选状态失败，请稍后重试', 'error');
            }
        }
        window.batchToggleDailySongCandidate = batchToggleDailySongCandidate;

        // 批量清空AI数据（介绍词+歌词+歌曲信息）
        async function batchClearDailySongs() {
            var ids = Array.from(document.querySelectorAll('.daily-song-checkbox:checked')).map(cb => parseInt(cb.value));
            if (ids.length === 0) return;
            if (!confirm('确定要清空这 ' + ids.length + ' 首歌曲的介绍词、歌词和歌曲信息吗？')) return;
            try {
                for (var i = 0; i < ids.length; i++) {
                    await authFetch('/api/admin/daily-songs/' + ids[i] + '/intro', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ intro: '', lyrics: '', song_info: null })
                    });
                }
                showToast('清空成功', 'success');
                loadDailySongs(dailySongsPage);
            } catch (e) {
                showToast('操作失败', 'error');
            }
        }
        window.batchClearDailySongs = batchClearDailySongs;

        // 批量AI生成（介绍词+歌词+歌曲信息）
        async function batchAiGenerateIntros() {
            var btn = document.getElementById('daily-song-batch-ai-btn');
            btn.disabled = true;
            btn.innerHTML = '<span>⏳</span> 生成中...';
            try {
                var res = await authFetch('/api/admin/daily-songs?status=&limit=100');
                var json = await res.json();
                if (json.code !== 200 || !json.data.songs || json.data.songs.length === 0) {
                    showToast('暂无推歌', 'info');
                    btn.disabled = false;
                    btn.innerHTML = '<span>🤖</span> 一键AI填充';
                    return;
                }
                var songs = json.data.songs;
                var total = songs.length;
                var done = 0;
                var failed = 0;
                var failedNames = [];
                for (var i = 0; i < songs.length; i++) {
                    var s = songs[i];
                    // 跳过已有介绍词+歌词+歌曲信息的
                    var hasInfo = s.song_info;
                    if (s.intro && s.intro.trim() && s.lyrics && s.lyrics.trim() && hasInfo) {
                        done++;
                        continue;
                    }
                    btn.innerHTML = '<span>⏳</span> (' + (done+failed+1) + '/' + total + ') ' + (s.song_name || '');
                    var introData = null;
                    var songInfoData = null;
                    // 1. 生成介绍词+歌词（重试2次）
                    for (var retry = 0; retry < 3; retry++) {
                        try {
                            if (retry > 0) {
                                btn.innerHTML = '<span>⏳</span> 重试(' + retry + '/2) ' + (s.song_name || '');
                                await new Promise(r => setTimeout(r, 3000 * retry));
                            }
                            var genRes = await authFetch('/api/admin/generate-song-intro', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ song_name: s.song_name, artist: s.artist || '' })
                            });
                            var genJson = await genRes.json();
                            if (genJson.code === 200 && (genJson.data.intro || genJson.data.lyrics)) {
                                introData = genJson.data;
                                break;
                            }
                        } catch(e) {}
                    }
                    // 2. 搜索歌曲信息（重试2次）
                    for (var retry = 0; retry < 3; retry++) {
                        try {
                            if (retry > 0) await new Promise(r => setTimeout(r, 2000 * retry));
                            var infoRes = await authFetch('/api/admin/search-song-info', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ song_name: s.song_name, artist: s.artist || '' })
                            });
                            var infoJson = await infoRes.json();
                            if (infoJson.code === 200 && infoJson.data) {
                                songInfoData = infoJson.data;
                                break;
                            }
                        } catch(e) {}
                    }
                    // 3. 搜索歌词（重试2次，从网易云/QQ音乐获取）
                    var lyricsData = s.lyrics || '';
                    if (!lyricsData) {
                        for (var retry = 0; retry < 3; retry++) {
                            try {
                                if (retry > 0) await new Promise(r => setTimeout(r, 2000 * retry));
                                var lyricsRes = await authFetch('/api/admin/search-song-lyrics', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ song_name: s.song_name, artist: s.artist || '' })
                                });
                                var lyricsJson = await lyricsRes.json();
                                if (lyricsJson.code === 200 && lyricsJson.data && lyricsJson.data.lyrics) {
                                    lyricsData = lyricsJson.data.lyrics;
                                    break;
                                }
                            } catch(e) {}
                        }
                    }
                    // 3. 保存到数据库
                    if (introData || songInfoData) {
                        try {
                            // 确保 intro 和 lyrics 是纯文本，不是 JSON 对象
                            var cleanIntro = '';
                            var cleanLyrics = '';
                            if (introData) {
                                // introData 可能是 {intro, lyrics} 对象或字符串
                                if (typeof introData === 'string') {
                                    try { introData = JSON.parse(introData); } catch(e) {}
                                }
                                if (typeof introData === 'object' && introData.intro) {
                                    cleanIntro = String(introData.intro).replace(/【介绍】/g,'').replace(/【歌词】/g,'').trim();
                                    cleanLyrics = String(introData.lyrics || '').replace(/【歌词】/g,'').trim();
                                } else if (typeof introData === 'string') {
                                    cleanIntro = introData.replace(/【介绍】/g,'').trim();
                                }
                            }
                            // 如果没有新生成的介绍，保留原有的
                            if (!cleanIntro && s.intro) {
                                var oldIntro = s.intro;
                                if (typeof oldIntro === 'string' && oldIntro.startsWith('{')) {
                                    try { var oi = JSON.parse(oldIntro); cleanIntro = oi.intro || ''; cleanLyrics = oi.lyrics || ''; } catch(e) { cleanIntro = oldIntro; }
                                } else {
                                    cleanIntro = oldIntro;
                                }
                            }
                            await authFetch('/api/admin/daily-songs/' + s.id + '/intro', {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    intro: cleanIntro,
                                    lyrics: lyricsData || cleanLyrics || s.lyrics || '',
                                    song_info: songInfoData || s.song_info || null
                                })
                            });
                            done++;
                        } catch(e) {
                            failed++;
                            failedNames.push(s.song_name || '未知');
                        }
                    } else {
                        failed++;
                        failedNames.push(s.song_name || '未知');
                    }
                    // 每首之间间隔2秒
                    if (i < songs.length - 1) await new Promise(r => setTimeout(r, 2000));
                }
                var msg = '批量填充完成：' + done + '首成功';
                if (failed > 0) msg += '，' + failed + '首失败（' + failedNames.join('、') + '）';
                showToast(msg, failed > 0 ? 'warning' : 'success');
                loadDailySongs(dailySongsPage);
            } catch(e) {
                showToast('操作失败', 'error');
            }
            btn.disabled = false;
            btn.innerHTML = '<span>🤖</span> 一键AI填充';
        }
        window.batchAiGenerateIntros = batchAiGenerateIntros;

        function changeSongsPageSize(size) {
            songsPage = 1;
            loadSongs();
        }

        // ===== 推歌介绍编辑器 =====
        var currentIntroEditorSongId = null;
        var currentEditorSongInfo = null;
        var currentEditorSong = null;

        function setEditorInfoField(id, value) {
            var el = document.getElementById(id);
            if (el) el.value = value == null ? '' : String(value);
        }

        function getEditorInfo() {
            var info = (currentEditorSongInfo && typeof currentEditorSongInfo === 'object') ? Object.assign({}, currentEditorSongInfo) : {};
            var album = (document.getElementById('editorInfoAlbum')?.value || '').trim();
            var year = (document.getElementById('editorInfoYear')?.value || '').trim();
            var duration = (document.getElementById('editorInfoDuration')?.value || '').trim();
            if (album) info.album = album; else delete info.album;
            if (year) info.year = year; else delete info.year;
            if (duration) info.duration = duration; else delete info.duration;
            return Object.keys(info).length ? info : null;
        }

        function updateIntroEditorHeading() {
            var name = (document.getElementById('editorSongName')?.value || '').trim() || '未命名歌曲';
            var artist = (document.getElementById('editorArtist')?.value || '').trim();
            var title = document.getElementById('introEditorTitle');
            if (title) title.textContent = '🎵 编辑推歌 · ' + name + (artist ? ' — ' + artist : '');
        }

        function openSongIntroEditor(songId, songName, artist) {
            currentIntroEditorSongId = songId;
            currentEditorSongInfo = null;
            currentEditorSong = null;
            setEditorInfoField('editorSongName', songName || '');
            setEditorInfoField('editorArtist', artist || '');
            setEditorInfoField('editorToWhom', '');
            setEditorInfoField('editorMessage', '');
            ['editorInfoAlbum', 'editorInfoYear', 'editorInfoDuration'].forEach(function(id) { setEditorInfoField(id, ''); });
            document.getElementById('editorIntroText').value = '';
            document.getElementById('editorLyricsText').value = '';
            updateIntroEditorHeading();
            ['editorSongName', 'editorArtist'].forEach(function(id) {
                var field = document.getElementById(id);
                if (field) field.oninput = updateIntroEditorHeading;
            });
            document.getElementById('songIntroEditorModal').style.display = 'flex';
            loadSongIntroData(songId);
        }
        window.openSongIntroEditor = openSongIntroEditor;

        async function loadSongIntroData(songId) {
            try {
                var res = await authFetch('/api/admin/daily-songs?status=&limit=100');
                var json = await res.json();
                if (json.code === 200) {
                    var song = (json.data.songs || []).find(s => s.id == songId);
                    if (song) {
                        currentEditorSong = song;
                        setEditorInfoField('editorSongName', song.song_name || '');
                        setEditorInfoField('editorArtist', song.artist || '');
                        setEditorInfoField('editorToWhom', song.to_whom || '');
                        setEditorInfoField('editorMessage', song.message || '');
                        updateIntroEditorHeading();
                        document.getElementById('editorIntroText').value = song.intro || '';
                        document.getElementById('editorLyricsText').value = song.lyrics || '';
                        var info = null;
                        if (song.song_info) {
                            try { info = typeof song.song_info === 'string' ? JSON.parse(song.song_info) : song.song_info; } catch(e) {}
                        }
                        if (info) {
                            currentEditorSongInfo = info;
                            setEditorInfoField('editorInfoAlbum', info.album || '');
                            setEditorInfoField('editorInfoYear', info.year || '');
                            setEditorInfoField('editorInfoDuration', info.duration || '');
                        }
                    }
                }
            } catch(e) {}
        }

        async function aiGenerateIntroInEditor() {
            if (!currentIntroEditorSongId) return;
            var introTextarea = document.getElementById('editorIntroText');
            var lyricsTextarea = document.getElementById('editorLyricsText');
            var btn = document.getElementById('introAiBtn');
            btn.textContent = '生成中...';
            btn.disabled = true;
            // 先删除旧的提示框
            var oldBox = document.getElementById('aiPromptFallbackBox');
            if (oldBox) oldBox.remove();
            try {
                var songName = (document.getElementById('editorSongName')?.value || '').trim();
                var artist = (document.getElementById('editorArtist')?.value || '').trim();
                if (!songName || !artist) {
                    showToast('请先填写歌曲名和歌手，再生成介绍', 'error');
                    btn.textContent = '🤖 AI生成';
                    btn.disabled = false;
                    return;
                }
                var res = await authFetch('/api/admin/generate-song-intro', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ song_name: songName, artist: artist })
                });
                var json = await res.json();
                if (json.code === 200 && (json.data.intro || json.data.lyrics)) {
                    if (json.data.intro) {
                        // 去掉【介绍】等标签
                        var cleanIntro = json.data.intro.replace(/【介绍】/g, '').replace(/【歌词】/g, '').replace(/---LYRICS---/g, '').replace(/---END---/g, '').trim();
                        introTextarea.value = cleanIntro;
                    }
                    if (json.data.lyrics) {
                        var cleanLyrics = json.data.lyrics.replace(/【歌词】/g, '').replace(/---LYRICS---/g, '').replace(/---END---/g, '').trim();
                        lyricsTextarea.value = cleanLyrics;
                    }
                    showToast('AI生成成功', 'success');
                    } else if (json.data && json.data.prompt) {
                        var promptBox = document.createElement('div');
                        promptBox.id = 'aiPromptFallbackBox';
                    promptBox.className = 'admin-ai-prompt';
                    promptBox.innerHTML = '<b>AI 不可用</b>，请复制提示词到 <a href="https://chat.deepseek.com" target="_blank" rel="noopener">DeepSeek</a>：<br>';
                    var promptTextarea = document.createElement('textarea');
                    promptTextarea.readOnly = true;
                    promptTextarea.value = json.data.prompt;
                    var copyPromptBtn = document.createElement('button');
                    copyPromptBtn.textContent = '复制';
                    copyPromptBtn.onclick = function() { navigator.clipboard.writeText(promptTextarea.value); showToast('已复制', 'success'); };
                    promptBox.appendChild(promptTextarea);
                    promptBox.appendChild(copyPromptBtn);
                    btn.parentNode.appendChild(promptBox);
                    showToast(json.message || '请复制提示词手动生成', 'info');
                } else {
                    showToast(json.message || '生成失败', 'error');
                }
            } catch(e) {
                showToast('网络错误', 'error');
            }
            btn.textContent = '🤖 AI生成';
            btn.disabled = false;
        }
        window.aiGenerateIntroInEditor = aiGenerateIntroInEditor;

        async function searchSongInfoInEditor() {
            if (!currentIntroEditorSongId) return;
            // 清除旧的AI不可用提示框
            var oldBox = document.getElementById('aiPromptFallbackBox');
            if (oldBox) oldBox.remove();
            var btn = document.getElementById('searchSongInfoBtn');
            btn.textContent = '搜索中...';
            btn.disabled = true;
            // 先清空显示，避免看到旧数据
            ['editorInfoAlbum','editorInfoYear','editorInfoDuration'].forEach(function(id) {
                setEditorInfoField(id, '搜索中…');
            });
            var songName = (document.getElementById('editorSongName')?.value || '').trim();
            var artist = (document.getElementById('editorArtist')?.value || '').trim();
            if (!songName || !artist) {
                showToast('请先填写歌曲名和歌手', 'error');
                btn.textContent = '🔍 搜索资料';
                btn.disabled = false;
                return;
            }
            try {
                var res = await authFetch('/api/admin/search-song-info', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ song_name: songName, artist: artist })
                });
                var json = await res.json();
                if (json.code === 200 && json.data) {
                    currentEditorSongInfo = json.data;
                    setEditorInfoField('editorInfoAlbum', json.data.album || '');
                    setEditorInfoField('editorInfoYear', json.data.year || '');
                    setEditorInfoField('editorInfoDuration', json.data.duration || '');
                    showToast('歌曲信息搜索成功', 'success');
                } else {
                    showToast('搜索失败', 'error');
                }
            } catch(e) {
                showToast('网络错误', 'error');
            }
            btn.textContent = '🔍 搜索资料';
            btn.disabled = false;
        }
        window.searchSongInfoInEditor = searchSongInfoInEditor;

        async function searchLyricsInEditor() {
            if (!currentIntroEditorSongId) return;
            var lyricsTextarea = document.getElementById('editorLyricsText');
            var btn = document.getElementById('searchLyricsBtn');
            btn.textContent = '搜索中...';
            btn.disabled = true;
            var songName = (document.getElementById('editorSongName')?.value || '').trim();
            var artist = (document.getElementById('editorArtist')?.value || '').trim();
            if (!songName || !artist) {
                showToast('请先填写歌曲名和歌手', 'error');
                btn.textContent = '🔍 搜索歌词';
                btn.disabled = false;
                return;
            }
            try {
                var res = await authFetch('/api/admin/search-song-lyrics', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ song_name: songName, artist: artist })
                });
                var json = await res.json();
                if (json.code === 200 && json.data.lyrics && json.data.lyrics !== '暂无歌词') {
                    lyricsTextarea.value = json.data.lyrics;
                    showToast('歌词搜索成功', 'success');
                } else {
                    showToast('未找到歌词，请手动输入', 'info');
                }
            } catch(e) {
                showToast('网络错误', 'error');
            }
            btn.textContent = '🔍 搜索歌词';
            btn.disabled = false;
        }
        window.searchLyricsInEditor = searchLyricsInEditor;

        async function saveSongIntroFromEditor() {
            if (!currentIntroEditorSongId) return;
            var songName = (document.getElementById('editorSongName')?.value || '').trim();
            var artist = (document.getElementById('editorArtist')?.value || '').trim();
            if (!songName) {
                showToast('请填写歌曲名', 'error');
                document.getElementById('editorSongName')?.focus();
                return;
            }
            if (!artist) {
                showToast('请填写歌手', 'error');
                document.getElementById('editorArtist')?.focus();
                return;
            }
            var saveBtn = document.querySelector('#songIntroEditorModal .modal-footer .btn-primary');
            if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }
            try {
                var res = await authFetch('/api/admin/daily-songs/' + currentIntroEditorSongId, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        song_name: songName,
                        artist: artist,
                        to_whom: (document.getElementById('editorToWhom')?.value || '').trim(),
                        message: (document.getElementById('editorMessage')?.value || '').trim(),
                        intro: document.getElementById('editorIntroText').value,
                        lyrics: document.getElementById('editorLyricsText').value,
                        song_info: getEditorInfo()
                    })
                });
                var json = await res.json();
                if (json.code === 200) {
                    showToast('保存成功', 'success');
                    closeSongIntroEditor();
                    loadDailySongs(dailySongsPage);
                } else {
                    showToast(json.message || '保存失败', 'error');
                }
            } catch(e) {
                showToast('网络错误', 'error');
            } finally {
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
            }
        }
        window.saveSongIntroFromEditor = saveSongIntroFromEditor;

        function closeSongIntroEditor() {
            document.getElementById('songIntroEditorModal').style.display = 'none';
            currentIntroEditorSongId = null;
            currentEditorSong = null;
            currentEditorSongInfo = null;
        }
        window.closeSongIntroEditor = closeSongIntroEditor;

        // 点歌回收站
        async function loadSongTrash() {
            const tbody = document.getElementById('songs-tbody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="8"><div class="loading-text"><span class="loading-spinner"></span>加载中...</div></td></tr>';

            try {
                const res = await authFetch('/api/admin/trash/songs');
                const json = await res.json();
                if (json.code === 200) {
                    const songs = json.data.songs || [];
                    document.getElementById('songs-count').textContent = '回收站 ' + songs.length + ' 条';
                    renderSongTrashTable(songs);
                    // 回收站不需要分页
                    document.getElementById('songs-pagination').innerHTML = '';
                }
            } catch (err) {
                showToast('加载回收站失败', 'error');
            }
        }

        function renderSongTrashTable(songs) {
            const tbody = document.getElementById('songs-tbody');
            if (!songs || songs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8"><div class="admin-empty"><span class="empty-emoji">📭</span><span>回收站为空</span></div></td></tr>';
                return;
            }
            tbody.innerHTML = songs.map((s, i) => `
                <tr style="opacity:0.7;">
                    <td data-label="序号">${i + 1}</td>
                    <td data-label="歌曲名">${escapeHtml(s.song_name || '-')}</td>
                    <td data-label="歌手">${escapeHtml(s.artist || '-')}</td>
                    <td data-label="点歌人">${escapeHtml(s.nickname || s.username || '匿名')}</td>
                    <td data-label="删除时间"><span class="tag tag-red">${s.deleted_at ? new Date(s.deleted_at).toLocaleString('zh-CN') : '-'}</span></td>
                    <td data-label="播放时段">${escapeHtml(s.slot_name || '-')}</td>
                    <td data-label="状态"><span class="tag tag-red">已删除</span></td>
                    <td data-label="操作">
                        <div class="table-actions">
                            <button class="action-btn action-btn-text" style="color:#10B981;" data-admin-action="restore-song-trash" data-id="${s.id}">🔄 恢复</button>
                            <button class="action-btn action-btn-text" style="color:#DC2626;" data-admin-action="perm-delete-song" data-id="${s.id}">🗑 永久删除</button>
                        </div>
                    </td>
                </tr>
            `).join('');
        }

        // 从回收站恢复
        window.restoreSongFromTrash = async function(songId) {
            if (!confirm('确定要恢复这条点歌记录吗？')) return;
            try {
                const res = await authFetch('/api/admin/trash/songs/' + songId + '/restore', { method: 'PUT' });
                const json = await res.json();
                if (json.code === 200) {
                    showToast('✅ 已恢复', 'success');
                    loadSongs(); // 重新加载回收站
                } else {
                    showToast(json.message || '恢复失败', 'error');
                }
            } catch (err) {
                showToast('恢复失败', 'error');
            }
        };

        // 永久删除点歌
        window.permDeleteSong = async function(songId) {
            if (!confirm('确定要永久删除这条点歌记录吗？此操作不可恢复！')) return;
            try {
                const res = await authFetch('/api/admin/trash/songs/' + songId, { method: 'DELETE' });
                const json = await res.json();
                if (json.code === 200) {
                    showToast('✅ 已永久删除', 'success');
                    loadSongs(); // 重新加载回收站
                } else {
                    showToast(json.message || '删除失败', 'error');
                }
            } catch (err) {
                showToast('删除失败', 'error');
            }
        };

        function renderSongsTable(songs) {
            const tbody = document.getElementById('songs-tbody');
            if (!songs || songs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7"><div class="admin-empty"><span class="empty-emoji">📭</span><span>暂无数据</span></div></td></tr>';
                return;
            }
            songs.forEach((s) => {
                if (s && s.id != null) songDetailCache[String(s.id)] = s;
            });
            tbody.innerHTML = songs.map((s, i) => {
                const hotScore = s.hot_score || 0;
                const hotColor = hotScore > 50 ? '#EF4444' : hotScore > 20 ? '#F59E0B' : hotScore > 0 ? '#10B981' : '#9CA3AF';
                const hotBg = hotScore > 50 ? 'rgba(239,68,68,0.1)' : hotScore > 20 ? 'rgba(245,158,11,0.1)' : hotScore > 0 ? 'rgba(16,185,129,0.08)' : 'rgba(156,163,175,0.05)';
                // 状态对应的操作按钮
                var actionBtns = '';
                if (s.status === 'pending') {
                    actionBtns = '<button class="action-btn action-btn-sm action-approve" title="通过" data-admin-action="admin-action" data-action-name="approveSong" data-id="' + s.id + '">通过</button>' +
                                 '<button class="action-btn action-btn-sm action-reject" title="暂不安排" data-admin-action="admin-action" data-action-name="rejectSong" data-id="' + s.id + '">暂不安排</button>';
                } else if (s.status === 'approved') {
                    actionBtns = '<button class="action-btn action-btn-sm action-reschedule" title="调整播放时间" data-admin-action="open-song-reschedule" data-id="' + s.id + '">调时间</button>' +
                                 '<button class="action-btn action-btn-sm action-reject-approved" title="打回并通知" data-admin-action="admin-action" data-action-name="rejectSong" data-id="' + s.id + '">打回</button>' +
                                 '<button class="action-btn action-btn-sm action-play" title="标记已播放" data-admin-action="admin-action" data-action-name="playSong" data-id="' + s.id + '">已播</button>';
                } else if (s.status === 'rejected') {
                    actionBtns = '<button class="action-btn action-btn-sm action-restore" title="恢复" data-admin-action="restore-song" data-id="' + s.id + '">恢复</button>';
                }
                return `
                <tr class="song-row">
                    <td class="song-cell-check"><input type="checkbox" class="song-checkbox" value="${s.id}" data-admin-action="update-song-batch"></td>
                    <td class="song-cell-id">${i + 1}</td>
                    <td class="song-cell-name">
                        <div class="song-name-wrap" data-admin-action="view-song" data-id="${s.id}">
                            <strong class="song-name-text">${escapeHtml(s.song_name)}</strong>
                            ${s.artist ? '<span class="song-artist">— ' + escapeHtml(s.artist) + '</span>' : ''}
                        </div>
                        <div class="song-meta">
                            <span>${escapeHtml(s.nickname || s.username || '匿名')}</span>
                            <span class="song-meta-dot">·</span>
                            <span>预约 ${escapeHtml(formatSongSchedule(s))}</span>
                            <span class="song-meta-dot">·</span>
                            <span>${escapeHtml(s.slot_name || '未命名时段')}</span>
                        </div>
                    </td>
                    <td class="song-cell-msg">${s.message ? '<span class="song-msg-preview" title="' + escapeHtml(s.message) + '">' + escapeHtml(s.message).substring(0, 30) + (s.message.length > 30 ? '…' : '') + '</span>' : '<span style="color:#ccc">-</span>'}</td>
                    <td class="song-cell-hot">
                        <span class="song-hot-badge" style="background:${hotBg};color:${hotColor};" data-admin-action="edit-song-hot" data-id="${s.id}" data-score="${hotScore}">🔥 ${hotScore}</span>
                    </td>
                    <td class="song-cell-status">${statusBadge(s.status)}</td>
                    <td class="song-cell-actions">
                        <div class="table-actions-compact">
                            <button class="action-btn action-btn-sm action-view" title="查看" data-admin-action="view-song" data-id="${s.id}">查看</button>
                            ${actionBtns}
                            <button class="action-btn action-btn-sm action-delete" title="删除" data-admin-action="admin-action" data-action-name="deleteSong" data-id="${s.id}">删除</button>
                        </div>
                    </td>
                </tr>
            `;
            }).join('');
        }

        // 点歌全选 / 批量
        function toggleAllSongs(checked) {
            document.querySelectorAll('.song-checkbox').forEach(cb => cb.checked = checked);
            updateSongBatchBtn();
        }

        function updateSongBatchBtn() {
            var ids = Array.from(document.querySelectorAll('.song-checkbox:checked')).map(cb => parseInt(cb.value));
            var btn = document.getElementById('song-batch-approve-btn');
            var rejectBtn = document.getElementById('song-batch-reject-btn');
            var count = document.getElementById('song-batch-count');
            if (ids.length > 0) {
                btn.style.display = 'inline-block';
                rejectBtn.style.display = 'inline-block';
                count.style.display = 'inline-block';
                count.textContent = '已选 ' + ids.length + ' 条';
            } else {
                btn.style.display = 'none';
                rejectBtn.style.display = 'none';
                count.style.display = 'none';
            }
        }

        async function batchSongAction(status) {
            var ids = Array.from(document.querySelectorAll('.song-checkbox:checked')).map(cb => parseInt(cb.value));
            if (ids.length === 0) { showToast('请先选择点歌', 'warning'); return; }
            var reason = status === 'rejected' ? await chooseSongRejectReason() : '';
            if (status === 'rejected' && reason === null) return;
            if (!confirm('确定' + (status === 'approved' ? '通过' : '拒绝') + '选中的 ' + ids.length + ' 条点歌？')) return;
            var btn = document.getElementById(status === 'approved' ? 'song-batch-approve-btn' : 'song-batch-reject-btn');
            if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
            try {
                var token = localStorage.getItem("token") || sessionStorage.getItem("token");
                var res = await fetch('/api/admin/songs/batch-status', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ ids, status, reason, expected_statuses: Object.fromEntries(ids.map(id => [id, songDetailCache[String(id)]?.status || 'pending'])) })
                });
                var json = await res.json();
                if (json.code === 200) {
                    showToast(json.message, 'success');
                    loadSongs();
                } else {
                    showToast('操作失败: ' + json.message, 'error');
                }
            } catch(e) {
                showToast('操作失败', 'error');
            } finally {
                if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
            }
        }

        // 点歌筛选
        document.querySelectorAll('#panel-songs .filter-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                filterSongsBtn(this);
            });
        });

        // ----- 时段管理 -----
        async function loadSlots() {
            try {
                const res = await authFetch('/api/admin/slots');
                const json = await res.json();
                if (json.code === 200) {
                    renderSlotsGrid(json.data);
                }
            } catch (err) {
                showToast('加载时段列表失败', 'error');
            }
        }

        function renderSlotsGrid(slots) {
            const grid = document.getElementById('slots-grid');
            if (!slots || slots.length === 0) {
                grid.innerHTML = '<div class="admin-empty" style="grid-column: 1 / -1;"><span class="empty-emoji">📭</span><span>暂无时段，点击上方按钮添加</span></div>';
                return;
            }
            grid.innerHTML = slots.map(s => {
                const isActive = s.is_active === 1 || s.is_active === true;
                const dates = s.dates || [];
                const openDates = dates.filter(d => Number(d.is_active) === 1);
                const datesHtml = openDates.length > 0
                    ? openDates.map(d => {
                        let dateStr = d.play_date;
                        if (dateStr instanceof Date) {
                            const y = dateStr.getFullYear();
                            const m = String(dateStr.getMonth() + 1).padStart(2, '0');
                            const day = String(dateStr.getDate()).padStart(2, '0');
                            dateStr = `${y}-${m}-${day}`;
                        } else if (typeof dateStr === 'string') {
                            dateStr = dateStr.split('T')[0];
                        }
                        const weekDays = ['周日','周一','周二','周三','周四','周五','周六'];
                        const parts = dateStr.split('-').map(Number);
                        const week = weekDays[new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay()];
                        return `<span class="tag tag-blue" style="margin:2px;">${dateStr}(${week})</span>`;
                    }).join('')
                    : '<span style="color:var(--text-light);font-size:0.8rem;">暂无开放日期</span>';

                return `
                <div class="slot-admin-card">
                    <div class="slot-card-header">
                        <div class="slot-card-name">
                            <span>⏰</span>
                            <span>${escapeHtml(s.name)}</span>
                        </div>
                        ${isActive ? statusBadge('active') : statusBadge('disabled')}
                    </div>
                    <div class="slot-card-info">
                        <div class="info-row">
                            <span class="info-icon">🎵</span>
                            <span>播放时间：${s.start_time || '-'} ~ ${s.end_time || '-'}</span>
                        </div>
                        <div class="info-row">
                            <span class="info-icon">📅</span>
                            <span>未来 ${dates.filter(d => Number(d.is_active) === 1).length} 个开放日 / ${dates.filter(d => Number(d.is_active) !== 1).length} 个已关闭</span>
                        </div>
                        ${s.weekdays ? `<div class="info-row"><span class="info-icon">🔄</span><span>周期：${formatWeekdays(s.weekdays)}</span></div>` : ''}
                        <div class="info-row"><span class="info-icon">▶️</span><span>生效：${s.effective_start_date ? String(s.effective_start_date).split('T')[0] + ' 起' : '立即'}</span></div>
                        <div class="info-row" style="flex-wrap:wrap;">
                            <span class="info-icon">📆</span>
                            <span>${datesHtml}</span>
                        </div>
                    </div>
                    <div class="slot-card-actions">
                        <button class="btn btn-sm btn-accent" data-admin-action="edit-slot" data-id="${s.id}" data-name="${escapeHtml(s.name)}" data-start="${escapeHtml(s.start_time || '')}" data-end="${escapeHtml(s.end_time || '')}" data-active="${isActive ? 1 : 0}" data-weekdays="${escapeHtml(s.weekdays || '')}" data-effective-start="${escapeHtml(s.effective_start_date ? String(s.effective_start_date).split('T')[0] : '')}" data-max-songs="${s.max_songs || 10}">✏️ 编辑</button>
                        <button class="btn btn-sm btn-ghost" style="color: #DC2626;" data-admin-action="admin-action" data-action-name="deleteSlot" data-id="${s.id}">🗑 删除</button>
                    </div>
                </div>
            `}).join('');
        }

        // ----- 分页渲染 -----
        function renderPagination(containerId, currentPage, totalPages, onPageChange) {
            const container = document.getElementById(containerId);
            if (totalPages <= 1) {
                container.innerHTML = '';
                return;
            }

            let html = '';
            html += `<button class="page-btn ${currentPage <= 1 ? 'disabled' : ''}" ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">‹</button>`;

            const maxVisible = 5;
            let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
            let end = Math.min(totalPages, start + maxVisible - 1);
            if (end - start + 1 < maxVisible) {
                start = Math.max(1, end - maxVisible + 1);
            }

            if (start > 1) {
                html += `<button class="page-btn" data-page="1">1</button>`;
                if (start > 2) html += `<span style="padding: 0 4px; color: var(--text-light);">...</span>`;
            }

            for (let i = start; i <= end; i++) {
                html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
            }

            if (end < totalPages) {
                if (end < totalPages - 1) html += `<span style="padding: 0 4px; color: var(--text-light);">...</span>`;
                html += `<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
            }

            html += `<button class="page-btn ${currentPage >= totalPages ? 'disabled' : ''}" ${currentPage >= totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">›</button>`;

            container.innerHTML = html;

            container.querySelectorAll('.page-btn:not(.disabled)').forEach(btn => {
                btn.addEventListener('click', function() {
                    const page = parseInt(this.dataset.page);
                    if (page >= 1 && page <= totalPages) {
                        onPageChange(page);
                    }
                });
            });
        }

        // ===== 通用模态框关闭函数 =====
        window.closeModal = function(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) {
                modal.remove();
            }
            const overlay = document.getElementById(modalId.replace('-modal', '-overlay'));
            if (overlay) {
                overlay.remove();
            }
        };

        // ===== IP归属地查询 =====
        window.lookupIp = async function(ip, btn) {
            btn.disabled = true;
            btn.textContent = '⋯';
            try {
                var res = await authFetch('/api/admin/lookup-ip', {
                    method: 'POST',
                    body: JSON.stringify({ ip: ip })
                });
                if (res && res.code === 200 && res.data) {
                    var region = res.data.region || res.data || ip;
                    btn.parentElement.innerHTML = '<span title="' + escapeHtml(ip) + '" style="font-size:0.78rem;white-space:nowrap;">' + escapeHtml(region) + '</span>';
                    showToast('📍 ' + region, 'success');
                } else {
                    btn.textContent = '📍';
                    btn.disabled = false;
                    showToast('查询失败: ' + (res && res.message ? res.message : '未知错误'), 'error');
                }
            } catch(e) {
                btn.textContent = '📍';
                btn.disabled = false;
                showToast('网络错误', 'error');
            }
        };

        // ===== 封禁用户 =====
        const BAN_TEMPLATES = [
            { label: '📧 邮箱乱填', reason: '邮箱乱填 — 注册邮箱无效或无法联系' },
            { label: '💬 不当言论', reason: '发布不当言论 — 帖子内容违反社区规范' },
            { label: '🗨 不当评论', reason: '发布不当评论 — 评论内容违规' },
            { label: '📢 恶意刷屏', reason: '恶意刷屏 — 频繁发布相似内容' },
            { label: '👤 冒充他人', reason: '冒充他人 — 冒用他人身份信息' },
            { label: '⚠️ 账号异常', reason: '账号异常 — 检测到异常登录或操作行为' },
        ];

        window.banUser = function(userId, username) {
            document.getElementById('ban-user-id').value = userId;
            document.getElementById('ban-username').textContent = username;
            document.getElementById('ban-custom-reason').value = '';
            var container = document.getElementById('ban-reason-templates');
            container.innerHTML = BAN_TEMPLATES.map(function(t, i) {
                return '<button class="ban-reason-btn" data-reason="' + escapeHtml(t.reason) + '" data-admin-action="select-ban-reason" style="padding:10px 12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-section);color:var(--text-primary);cursor:pointer;font-size:0.82rem;text-align:left;transition:all 0.15s;">' + t.label + '</button>';
            }).join('');
            document.getElementById('ban-modal').classList.add('show');
            document.getElementById('ban-modal').style.display = 'flex';
        };

        window.selectBanReason = function(btn) {
            document.querySelectorAll('.ban-reason-btn').forEach(function(b) { b.style.borderColor = 'var(--border-color)'; b.style.background = 'var(--bg-section)'; });
            btn.style.borderColor = '#EF4444';
            btn.style.background = '#fef2f2';
            document.getElementById('ban-custom-reason').value = btn.dataset.reason;
        };

        window.closeBanModal = function() {
            document.getElementById('ban-modal').classList.remove('show');
            document.getElementById('ban-modal').style.display = 'none';
        };

        window.confirmBan = function() {
            var userId = document.getElementById('ban-user-id').value;
            var reason = document.getElementById('ban-custom-reason').value.trim();
            if (!reason) { showToast('请选择或输入封禁理由', 'error'); return; }
            authFetch('/api/admin/users/' + userId + '/status', {
                method: 'PUT',
                body: JSON.stringify({ status: 0, ban_reason: reason })
            }).then(function(r) {
                if (!r) return;
                r.json().then(function(d) {
                    if (d.code === 200) {
                        showToast('已封禁', 'success');
                        closeBanModal();
                        loadUsers();
                    } else {
                        showToast('❌ ' + (d.message || '操作失败'), 'error');
                    }
                });
            });
        };

        // ===== 管理操作 =====
        window.adminAction = async function(action, id, extra) {
            let url, options;

            if (action === 'rejectSong') {
                extra = await chooseSongRejectReason();
                if (extra === null) return;
            }

            switch (action) {
                case 'approvePost':
                    url = '/api/admin/posts/' + id + '/status';
                    options = { method: 'PUT', body: JSON.stringify({ status: 'approved' }) };
                    break;
                case 'rejectPost':
                    url = '/api/admin/posts/' + id + '/status';
                    options = { method: 'PUT', body: JSON.stringify({ status: 'rejected' }) };
                    break;
                case 'deletePost':
                    url = '/api/admin/posts/' + id;
                    options = { method: 'DELETE' };
                    // 显示自定义确认对话框
                    showConfirmModal('确定要删除这条帖子吗？<br>删除后将移入回收站。', async () => {
                        try {
                            const res = await authFetch(url, options);
                            if (!res) return;
                            const json = await res.json();
                            if (json.code === 200) {
                                showToast('✅ 删除成功', 'success');
                                recordLog(action, id, extra);
                                // 刷新列表
                                if (currentPanel === 'trash') {
                                    loadTrashPosts();
                                } else {
                                    loadPosts();
                                }
                                window.refreshSidebarBadgesNow();
                                // 如果详情modal开着，关掉
                                const detailModal = document.getElementById('post-detail-modal');
                                if (detailModal && detailModal.closest('.modal-overlay.show')) {
                                    window.closeModal('post-detail-modal');
                                }
                            } else {
                                showToast(json.message || '删除失败', 'error');
                            }
                        } catch (err) {
                            showToast('网络错误，请重试', 'error');
                            console.error('删除失败:', err);
                        }
                    });
                    return;
                case 'enableUser':
                    url = '/api/admin/users/' + id + '/status';
                    options = { method: 'PUT', body: JSON.stringify({ status: 1 }) };
                    break;
                case 'disableUser':
                    url = '/api/admin/users/' + id + '/status';
                    options = { method: 'PUT', body: JSON.stringify({ status: 0 }) };
                    break;
                case 'changeRole':
                    // 修改用户角色（仅超管可操作）
                    const newRole = extra;
                    if (!newRole || !ROLE_NAMES[newRole]) {
                        showToast('无效的角色', 'error');
                        return;
                    }
                    if (!confirm('确定要将该用户角色修改为「' + ROLE_NAMES[newRole] + '」吗？')) return;
                    url = '/api/admin/users/' + id + '/role';
                    options = { method: 'PUT', body: JSON.stringify({ role: newRole }) };
                    break;
                case 'approveSong':
                    window.openSongApprovalModal(id);
                    return;
                case 'rejectSong':
                    url = '/api/admin/songs/' + id + '/status';
                    options = { method: 'PUT', body: JSON.stringify({ status: 'rejected', reason: extra, expected_status: songDetailCache[String(id)]?.status || 'pending' }) };
                    break;
                case 'playSong':
                    url = '/api/admin/songs/' + id + '/status';
                    options = { method: 'PUT', body: JSON.stringify({ status: 'played', expected_status: 'approved' }) };
                    break;
                case 'deleteSong':
                    if (!confirm('确定要删除这条点歌吗？')) return;
                    url = '/api/admin/songs/' + id;
                    options = { method: 'DELETE' };
                    break;
                case 'publishDailySong':
                    goToMpDraft();
                    return;
                case 'unpublishDailySong':
                    goToMpDraft();
                    return;
                case 'deleteDailySong':
                    if (!confirm('确定要删除这条推歌吗？')) return;
                    url = '/api/admin/daily-songs/' + id;
                    options = { method: 'DELETE' };
                    break;
                case 'deleteSlot':
                    if (!confirm('确定要删除这个时段吗？删除后不可恢复。')) return;
                    url = '/api/admin/slots/' + id;
                    options = { method: 'DELETE' };
                    break;
                case 'deleteNotice':
                    if (!confirm('确定要删除这条公告吗？')) return;
                    url = '/api/admin/notices/' + id;
                    options = { method: 'DELETE' };
                    break;
                default:
                    return;
            }

            try {
                const res = await authFetch(url, options);
                if (!res) return; // authFetch返回null表示401或403错误

                const json = await res.json();
                if (json.code === 200) {
                    showToast(json.message || '操作成功', 'success');
                    // 记录操作日志
                    recordLog(action, id, extra);
                    loadPanelData(currentPanel);
                    // 更新侧边栏徽章
                    if (action === 'approvePost' || action === 'rejectPost' || action === 'deletePost') {
                        window.refreshSidebarBadgesNow();
                        loadPosts();
                    }
                    if (action === 'approveSong' || action === 'rejectSong' || action === 'deleteSong') {
                        window.refreshSidebarBadgesNow();
                        loadSongs();
                    }
                } else {
                    showToast(json.message || '操作失败', 'error');
                }
            } catch (err) {
                console.error('操作失败:', err);
                showToast('网络错误，请重试', 'error');
            }
        };

        // ===== 恢复被拒绝的点歌 =====
        window.restoreSong = async function(songId) {
            if (!confirm('确定要恢复这条点歌吗？恢复后将回到待审核状态。')) return;
            try {
                const res = await authFetch('/api/admin/songs/' + songId + '/status', {
                    method: 'PUT',
                    body: JSON.stringify({ status: 'pending', expected_status: 'rejected' })
                });
                if (!res) {
                    showToast('请求失败，请重新登录后再试', 'error');
                    return;
                }
                const json = await res.json();
                if (json.code === 200) {
                    showToast('✅ 已恢复', 'success');
                    loadSongs();
                } else {
                    showToast(json.message || '恢复失败', 'error');
                }
            } catch (err) {
                showToast('恢复失败', 'error');
            }
        };

        // 修改歌曲热度（超级管理员）- 使用自定义模态框
        let editingSongId = null;

        window.editSongHot = function(songId, currentHot) {
            if (currentUser.role !== 'super_admin') {
                showToast('只有超级管理员才能修改热度', 'error');
                return;
            }
            editingSongId = songId;

            // 检测是否为移动端
            var isMobile = window.innerWidth <= 768;

            if (isMobile) {
                // 移动端：使用自定义弹窗
                document.getElementById('hotEditCurrent').textContent = currentHot;
                document.getElementById('hotEditInput').value = currentHot;
                document.getElementById('hotEditModal').style.display = 'flex';
                document.getElementById('hotEditInput').focus();
            } else {
                // 电脑端：使用浏览器自带 prompt
                var newVal = prompt('请输入新热度值（0-99999）：', String(currentHot));
                if (newVal === null) return;
                var val = parseInt(newVal);
                if (isNaN(val) || val < 0 || val > 99999) {
                    showToast('请输入 0-99999 之间的有效数字', 'error');
                    return;
                }
                confirmHotEditDirect(val);
            }
        };

        window.closeHotEditModal = function() {
            document.getElementById('hotEditModal').style.display = 'none';
            editingSongId = null;
        };

        window.confirmHotEdit = async function() {
            if (!editingSongId) return;
            var input = document.getElementById('hotEditInput');
            var val = parseInt(input.value);
            await confirmHotEditDirect(val);
        };

        async function confirmHotEditDirect(val) {
            if (isNaN(val) || val < 0 || val > 99999) {
                showToast('请输入 0-99999 之间的有效数字', 'error');
                return;
            }
            try {
                var res = await authFetch('/api/songs/admin/update-score', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ song_request_id: editingSongId, score: val })
                });
                var json = await res.json();
                if (json.code === 200) {
                    showToast('✅ 热度已修改为 ' + val, 'success');
                    closeHotEditModal();
                    loadSongs();
                } else {
                    showToast(json.message || '修改失败', 'error');
                }
            } catch (err) {
                showToast('修改失败', 'error');
            }
        }

        // ===== 时段模态框 =====
        const slotModal = document.getElementById('slot-modal');
        const slotActiveSwitch = document.getElementById('slot-active-switch');
        const slotActiveLabel = document.getElementById('slot-active-label');
        let slotStartDateCalendarOffset = 0;
        let slotEditCalendarDates = [];
        let slotEditCalendarSlotId = null;
        let slotEditCalendarDirty = new Map();

        function slotStartDateToString(date) {
            return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
        }

        function selectedSlotWeekdays() {
            return Array.from(document.querySelectorAll('.weekday-btn.selected'))
                .map(btn => Number(btn.dataset.day))
                .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
        }

        function renderSlotStartDateCalendar() {
            const calendar = document.getElementById('slot-start-date-calendar');
            const input = document.getElementById('slot-effective-start-date');
            if (!calendar || !input) return;

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const start = new Date(today);
            start.setDate(today.getDate() + slotStartDateCalendarOffset);
            const allowedDays = selectedSlotWeekdays();
            const dateMap = new Map(slotEditCalendarDates.map(item => [String(item.play_date || '').split('T')[0], item]));
            const headers = ['日', '一', '二', '三', '四', '五', '六'];
            const cells = headers.map(day => '<span class="slot-start-weekday">' + day + '</span>');
            for (let i = 0; i < start.getDay(); i++) cells.push('<span></span>');
            for (let i = 0; i < 28; i++) {
                const date = new Date(start);
                date.setDate(start.getDate() + i);
                const dateStr = slotStartDateToString(date);
                const record = dateMap.get(dateStr);
                const isCycleDay = (!input.value || dateStr >= input.value) && (allowedDays.length === 0 || allowedDays.includes(date.getDay()));
                const isPlaying = record ? (Number(record.is_active) === 1 || record.is_active === true) : isCycleDay;
                const classes = ['slot-start-date-day'];
                if (isCycleDay) classes.push('is-cycle-day');
                if (isPlaying) classes.push('is-selected');
                if (record && Number(record.manual_override) === 1) classes.push('is-manual');
                const note = isPlaying ? '播放' : '不播放';
                cells.push('<button type="button" class="' + classes.join(' ') + '" data-date="' + dateStr + '"><span class="slot-start-date-num">' + (date.getMonth() + 1) + '/' + date.getDate() + '</span><span class="slot-start-date-note">' + note + '</span></button>');
            }
            calendar.innerHTML = cells.join('');
        }

        document.getElementById('slot-start-date-calendar').addEventListener('click', function(event) {
            const button = event.target.closest('button[data-date]');
            if (button) toggleSlotEditCalendarDate(button.dataset.date);
        });

        async function loadSlotEditCalendarDates(slotId) {
            slotEditCalendarSlotId = slotId || null;
            slotEditCalendarDates = [];
            slotEditCalendarDirty = new Map();
            renderSlotStartDateCalendar();
            if (!slotId) return;
            try {
                const res = await authFetch('/api/admin/slots');
                if (!res) return;
                const json = await res.json();
                const slot = json.code === 200 && Array.isArray(json.data) ? json.data.find(item => String(item.id) === String(slotId)) : null;
                if (slot) slotEditCalendarDates = (slot.dates || []).map(item => ({ ...item }));
                renderSlotStartDateCalendar();
            } catch (error) {
                showToast('日期安排加载失败，请稍后重试', 'error');
            }
        }

        function toggleSlotEditCalendarDate(dateStr) {
            if (!slotEditCalendarSlotId) {
                showToast('请先保存时段名称和时间，再设置单日播放安排', 'info');
                return;
            }
            const existing = slotEditCalendarDates.find(item => String(item.play_date || '').split('T')[0] === dateStr);
            const allowedDays = selectedSlotWeekdays();
            const date = new Date(dateStr + 'T00:00:00');
            const defaultPlaying = (!document.getElementById('slot-effective-start-date').value || dateStr >= document.getElementById('slot-effective-start-date').value) && (allowedDays.length === 0 || allowedDays.includes(date.getDay()));
            const playing = existing ? (Number(existing.is_active) === 1 || existing.is_active === true) : defaultPlaying;
            const nextActive = playing ? 0 : 1;
            const draft = existing || { id: null, play_date: dateStr, max_songs: Number(document.getElementById('slot-max-songs').value) || 10 };
            draft.is_active = nextActive;
            draft.manual_override = 1;
            if (!existing) slotEditCalendarDates.push(draft);
            slotEditCalendarDirty.set(dateStr, nextActive);
            renderSlotStartDateCalendar();
            showToast(nextActive ? '已暂存为当天播放' : '已暂存为当天不播放', 'info');
        }

        async function persistSlotEditCalendarDraft(slotId) {
            const dates = Array.from(slotEditCalendarDirty.entries()).map(([play_date, is_active]) => ({ play_date, is_active }));
            if (!slotId || dates.length === 0) return true;
            const res = await authFetch('/api/admin/slots/' + slotId + '/calendar-dates', {
                method: 'PUT',
                body: JSON.stringify({ dates })
            });
            if (!res) throw new Error('日期调整保存失败，请重新登录');
            const json = await res.json();
            if (json.code !== 200) throw new Error(json.message || '日期调整保存失败，请重试');
            if (json.data && Array.isArray(json.data.dates)) {
                const savedByDate = new Map(json.data.dates.map(item => [String(item.play_date || '').split('T')[0], item]));
                slotEditCalendarDates = slotEditCalendarDates.map(item => savedByDate.get(String(item.play_date || '').split('T')[0]) || item);
            }
            slotEditCalendarDirty.clear();
            return true;
        }

        // 初始化时间下拉选择
        function initTimeSelects() {
            ['slot-start-hour', 'slot-end-hour'].forEach(id => {
                const sel = document.getElementById(id);
                if (!sel) return;
                for (let h = 0; h < 24; h++) {
                    const opt = document.createElement('option');
                    opt.value = String(h).padStart(2, '0');
                    opt.textContent = String(h).padStart(2, '0');
                    sel.appendChild(opt);
                }
            });
            ['slot-start-min', 'slot-end-min'].forEach(id => {
                const sel = document.getElementById(id);
                if (!sel) return;
                [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = String(m).padStart(2, '0');
                    opt.textContent = String(m).padStart(2, '0');
                    sel.appendChild(opt);
                });
            });
        }
        initTimeSelects();

        // 从下拉获取时间字符串 HH:MM:SS
        function getTimeFromSelects(prefix) {
            const h = document.getElementById(prefix + '-hour').value;
            const m = document.getElementById(prefix + '-min').value;
            return h + ':' + m + ':00';
        }
        // 设置下拉的值
        function setTimeToSelects(prefix, timeStr) {
            if (!timeStr) return;
            const parts = timeStr.split(':');
            const hSel = document.getElementById(prefix + '-hour');
            const mSel = document.getElementById(prefix + '-min');
            if (!hSel || !mSel) return;
            if (parts[0] !== undefined) hSel.value = parts[0].padStart(2, '0');
            if (parts[1] !== undefined) {
                const min = parseInt(parts[1]);
                const rounded = Math.round(min / 5) * 5;
                mSel.value = String(rounded % 60).padStart(2, '0');
            }
        }
        // 重置时间下拉
        function resetTimeSelects(prefix, defH, defM) {
            const hSel = document.getElementById(prefix + '-hour');
            const mSel = document.getElementById(prefix + '-min');
            if (hSel) hSel.value = String(defH).padStart(2, '0');
            if (mSel) mSel.value = String(defM).padStart(2, '0');
        }

        // 打开添加模态框
        document.getElementById('btn-add-slot').addEventListener('click', function() {
            document.getElementById('slot-modal-title').textContent = '添加时段';
            document.getElementById('slot-edit-id').value = '';
            document.getElementById('slot-name').value = '';
            resetTimeSelects('slot-start', 12, 0);
            resetTimeSelects('slot-end', 13, 0);
            setActiveSwitch(true);
            document.getElementById('slot-max-songs').value = 10;
            document.getElementById('slot-effective-start-date').value = '';
            document.querySelectorAll('.weekday-btn').forEach(function(b) { b.classList.remove('selected'); });
            slotStartDateCalendarOffset = 0;
            loadSlotEditCalendarDates(null);
            slotModal.classList.add('show');
        });

        // 关闭模态框
        function closeSlotModal() {
            slotModal.classList.remove('show');
        }

        window.closeSlotModal = closeSlotModal;

        document.getElementById('slot-modal-close').addEventListener('click', closeSlotModal);
        document.getElementById('slot-modal-cancel').addEventListener('click', closeSlotModal);
        slotModal.addEventListener('click', function(e) {
            if (e.target === slotModal) closeSlotModal();
        });

        // 开关切换
        slotActiveSwitch.addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            slotActiveLabel.textContent = isActive ? '已启用' : '已禁用';
        });

        function setActiveSwitch(active) {
            if (active) {
                slotActiveSwitch.classList.add('active');
                slotActiveLabel.textContent = '已启用';
            } else {
                slotActiveSwitch.classList.remove('active');
                slotActiveLabel.textContent = '已禁用';
            }
        }

        // 编辑时段
        window.editSlot = function(id, name, start, end, isActive, weekdays, effectiveStartDate, maxSongs) {
            document.getElementById('slot-modal-title').textContent = '编辑时段';
            document.getElementById('slot-edit-id').value = id;
            document.getElementById('slot-name').value = name;
            setTimeToSelects('slot-start', start);
            setTimeToSelects('slot-end', end);
            setActiveSwitch(isActive);
            document.getElementById('slot-max-songs').value = maxSongs || 10;
            document.getElementById('slot-effective-start-date').value = effectiveStartDate || '';

            // 设置星期选择
            document.querySelectorAll('.weekday-btn').forEach(btn => btn.classList.remove('selected'));
            if (weekdays) {
                weekdays.split(',').forEach(d => {
                    const btn = document.querySelector('.weekday-btn[data-day="' + d + '"]');
                    if (btn) btn.classList.add('selected');
                });
            }

            slotStartDateCalendarOffset = 0;
            loadSlotEditCalendarDates(id);

            slotModal.classList.add('show');
        };

        // 星期按钮点击
        document.querySelectorAll('.weekday-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                this.classList.toggle('selected');
                renderSlotStartDateCalendar();
            });
        });

        // 提交时段表单
        window.saveSlotForm = async function() {
            const saveButton = document.getElementById('slot-modal-submit');
            if (saveButton && saveButton.disabled) return;
            if (saveButton) saveButton.disabled = true;
            try {
                const editId = document.getElementById('slot-edit-id');
                const slotNameEl = document.getElementById('slot-name');
                const maxSongsEl = document.getElementById('slot-max-songs');
                const effectiveStartDateEl = document.getElementById('slot-effective-start-date');

                const editIdVal = editId ? editId.value : '';
                const slotName = slotNameEl ? slotNameEl.value.trim() : '';
                const startTime = getTimeFromSelects('slot-start');
                const endTime = getTimeFromSelects('slot-end');
                const isActive = slotActiveSwitch && slotActiveSwitch.classList.contains('active');
                const maxSongs = maxSongsEl ? (parseInt(maxSongsEl.value) || 10) : 10;
                const effectiveStartDate = effectiveStartDateEl ? effectiveStartDateEl.value : '';

                // 获取选中的星期
                const selectedDays = Array.from(document.querySelectorAll('.weekday-btn.selected'))
                    .map(btn => parseInt(btn.dataset.day));
                const weekdays = selectedDays.length > 0 ? selectedDays.sort().join(',') : '';

                if (!slotName || !startTime || !endTime) {
                    showToast('请填写完整信息', 'warning');
                    return;
                }

                const body = {
                    name: slotName,
                    start_time: startTime,
                    end_time: endTime,
                    is_active: isActive ? 1 : 0,
                    weekdays: weekdays,
                    effective_start_date: effectiveStartDate,
                    max_songs: maxSongs
                };

                let url, method;
                if (editIdVal) {
                    url = '/api/admin/slots/' + editIdVal;
                    method = 'PUT';
                } else {
                    url = '/api/admin/slots';
                    method = 'POST';
                }

                const res = await authFetch(url, {
                    method: method,
                    body: JSON.stringify(body)
                });
                if (!res) {
                    showToast('请求失败，请重新登录', 'error');
                    return;
                }
                const json = await res.json();
                if (json.code === 200) {
                    const savedSlotId = editIdVal || (json.data && json.data.id);
                    await persistSlotEditCalendarDraft(savedSlotId);
                    showToast(editIdVal ? '修改成功' : '添加成功', 'success');
                    closeSlotModal();
                    loadSlots();
                } else {
                    showToast(json.message || '操作失败', 'error');
                }
            } catch (err) {
                showToast(err && err.message ? err.message : '网络错误，请重试', 'error');
            } finally {
                if (saveButton) saveButton.disabled = false;
            }
        };

        // ===== 格式化星期显示 =====
        function formatWeekdays(weekdaysStr) {
            if (!weekdaysStr) return '';
            const days = weekdaysStr.split(',').map(d => parseInt(d));
            const dayNames = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' };
            return days.map(d => dayNames[d] || d).join('、');
        }

        // ===== HTML 转义 =====
        function escapeHtml(str) {
            if (!str) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        // 暴露 escapeHtml 到全局，供 IIFE 外部的函数使用
        window.escapeHtml = escapeHtml;

        // ===== 用户头衔设置 =====
        async function showUserTitleModal(userId, username) {
            document.getElementById('user-title-user-id').value = userId;
            document.getElementById('user-title-username').textContent = username;
            document.getElementById('user-title-modal').classList.add('show');

            // 加载用户当前头衔和可选头衔
            await loadUserTitles(userId);
            await loadAvailableTitles(userId);
        }

        async function loadUserTitles(userId) {
            const container = document.getElementById('user-current-titles');
            try {
                const res = await authFetch('/api/admin/users/' + userId + '/titles');
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    const titles = json.data;
                    if (!titles || titles.length === 0) {
                        container.innerHTML = '<span style="color: var(--text-light); font-size: 0.85rem;">暂无头衔</span>';
                        return;
                    }
                    container.innerHTML = titles.map(t =>
                        '<span class="title-badge" style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:0.75rem;font-weight:600;background:' + escapeHtml(t.title_bg || 'rgba(255,107,157,0.1)') + ';color:' + escapeHtml(t.title_color || '#FF6B9D') + ';margin-right:6px;margin-bottom:6px;">' + escapeHtml(t.icon || '') + ' ' + escapeHtml(t.title_name) + ' <button type="button" class="title-remove-btn" data-admin-action="remove-user-title" data-user-id="' + userId + '" data-title-id="' + t.id + '" aria-label="移除头衔">✕</button></span>'
                    ).join('');
                }
            } catch (err) {
                container.innerHTML = '<span style="color: var(--text-light); font-size: 0.85rem;">加载失败</span>';
            }
        }

        async function loadAvailableTitles(userId) {
            const container = document.getElementById('user-available-titles');
            try {
                const res = await authFetch('/api/admin/titles');
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    const titles = json.data;
                    if (!titles || titles.length === 0) {
                        container.innerHTML = '<span style="color: var(--text-light); font-size: 0.85rem;">暂无可选头衔</span>';
                        return;
                    }
                    // 获取用户当前头衔 ID 列表
                    const userRes = await authFetch('/api/admin/users/' + userId + '/titles');
                    const userJson = await userRes.json();
                    const userTitleIds = (userJson.data || []).map(t => t.id);

                    container.innerHTML = titles.map(t => {
                        const hasTitle = userTitleIds.includes(t.id);
                        return '<button class="btn btn-sm ' + (hasTitle ? 'btn-ghost' : 'btn-primary') + '" ' +
                            'style="padding:6px 12px;border-radius:20px;font-size:0.8rem;' +
                            'background:' + (hasTitle ? 'transparent' : escapeHtml(t.title_bg || 'rgba(255,107,157,0.1)')) + ';' +
                            'color:' + (hasTitle ? 'var(--text-secondary)' : escapeHtml(t.title_color || '#FF6B9D')) + ';' +
                            'border:1.5px solid ' + escapeHtml(t.title_color || '#FF6B9D') + ';" ' +
                            'data-admin-action="' + (hasTitle ? 'remove-user-title' : 'add-user-title') + '" data-user-id="' + userId + '" data-title-id="' + t.id + '">' +
                            escapeHtml(t.icon || '') + ' ' + escapeHtml(t.title_name) +
                            '</button>';
                    }).join('');
                }
            } catch (err) {
                container.innerHTML = '<span style="color: var(--text-light); font-size: 0.85rem;">加载失败</span>';
            }
        }

        async function addUserTitle(userId, titleId) {
            try {
                const res = await authFetch('/api/admin/users/' + userId + '/titles', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title_id: titleId })
                });
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    showToast('添加成功', 'success');
                    await loadUserTitles(userId);
                    await loadAvailableTitles(userId);
                } else {
                    showToast(json.message || '添加失败', 'error');
                }
            } catch (err) {
                showToast('网络错误', 'error');
            }
        }

        async function removeUserTitle(userId, titleId) {
            if (!confirm('确认移除该头衔？')) return;
            try {
                const res = await authFetch('/api/admin/users/' + userId + '/titles/' + titleId, { method: 'DELETE' });
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    showToast('移除成功', 'success');
                    await loadUserTitles(userId);
                    await loadAvailableTitles(userId);
                } else {
                    showToast(json.message || '移除失败', 'error');
                }
            } catch (err) {
                showToast('网络错误', 'error');
            }
        }

        // ===== 头衔颜色选择 =====
        var selectedTitleColor = '#FF6B9D';
        var selectedTitleBg = 'rgba(255,107,157,0.12)';

        document.getElementById('title-color-presets').addEventListener('click', function(e) {
          var dot = e.target.closest('.title-color-option');
          if (!dot) return;
          document.querySelectorAll('.title-color-option').forEach(function(d) {
            d.style.border = '2px solid transparent';
            d.style.boxShadow = 'none';
          });
          dot.style.border = '2px solid ' + dot.dataset.color;
          dot.style.boxShadow = '0 0 0 2px #FFF';
          selectedTitleColor = dot.dataset.color;
          selectedTitleBg = dot.dataset.bg;
          document.getElementById('new-title-color-picker').value = selectedTitleColor;
          updateTitlePreview();
        });

        document.getElementById('new-title-color-picker').addEventListener('input', function() {
          selectedTitleColor = this.value;
          selectedTitleBg = 'rgba(' + hexToRgb(this.value) + ',0.12)';
          document.querySelectorAll('.title-color-option').forEach(function(d) {
            d.style.border = '2px solid transparent';
            d.style.boxShadow = 'none';
          });
          updateTitlePreview();
        });

        function hexToRgb(hex) {
          var r = parseInt(hex.slice(1,3), 16);
          var g = parseInt(hex.slice(3,5), 16);
          var b = parseInt(hex.slice(5,7), 16);
          return r + ',' + g + ',' + b;
        }

        function updateTitlePreview() {
          var name = document.getElementById('new-title-name').value.trim();
          var icon = document.getElementById('new-title-icon').value.trim() || '⭐';
          var el = document.getElementById('new-title-preview');
          if (name) {
            el.innerHTML = '预览：<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:0.8rem;font-weight:600;background:' + selectedTitleBg + ';color:' + selectedTitleColor + ';">' + escapeHtml(icon) + ' ' + escapeHtml(name) + '</span>';
          } else {
            el.textContent = '';
          }
        }

        document.getElementById('new-title-name').addEventListener('input', updateTitlePreview);
        document.getElementById('new-title-icon').addEventListener('input', updateTitlePreview);

        // ===== 创建头衔并添加给当前用户 =====
        window.createNewTitle = async function() {
          var userId = document.getElementById('user-title-user-id').value;
          var name = document.getElementById('new-title-name').value.trim();
          var icon = document.getElementById('new-title-icon').value.trim() || '⭐';
          if (!name) { showToast('请输入头衔名称', 'error'); return; }

          var btn = event.target;
          btn.textContent = '创建中...';
          btn.disabled = true;

          try {
            // 先创建头衔
            var res = await authFetch('/api/admin/titles', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title_name: name, title_color: selectedTitleColor, title_bg: selectedTitleBg, icon: icon, sort_order: 0 })
            });
            if (!res) return;
            var json = await res.json();
            if (json.code === 200) {
              var titleId = json.data.id;
              // 再给用户添加该头衔
              var addRes = await authFetch('/api/admin/users/' + userId + '/titles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title_id: titleId })
              });
              if (!addRes) return;
              var addJson = await addRes.json();
              if (addJson.code === 200) {
                showToast('头衔创建并添加成功', 'success');
                document.getElementById('new-title-name').value = '';
                updateTitlePreview();
                await loadUserTitles(userId);
                await loadAvailableTitles(userId);
                // 记录日志
                recordLog('createTitle', titleId, '创建头衔并添加给用户: ' + name);
              } else {
                showToast(addJson.message || '添加失败', 'error');
              }
            } else {
              showToast(json.message || '创建失败', 'error');
            }
          } catch (err) {
            showToast('网络错误', 'error');
          }
          btn.textContent = '➕ 创建并添加';
          btn.disabled = false;
        };

        // 用户头衔模态框事件
        const userTitleModal = document.getElementById('user-title-modal');
        if (userTitleModal) {
            function closeUserTitleModal() {
                userTitleModal.classList.remove('show');
            }
            document.getElementById('user-title-modal-close').addEventListener('click', closeUserTitleModal);
            document.getElementById('user-title-modal-cancel').addEventListener('click', closeUserTitleModal);
            userTitleModal.addEventListener('click', function(e) {
                if (e.target === userTitleModal) closeUserTitleModal();
            });
        }
        window.showUserTitleModal = showUserTitleModal;
        window.addUserTitle = addUserTitle;
        window.removeUserTitle = removeUserTitle;

        // ===== 回收站 =====
        let trashPage = 1;

        async function loadTrash() {
            const params = new URLSearchParams({ page: trashPage, limit: 20 });
            try {
                const res = await authFetch('/api/admin/trash/posts?' + params);
                const json = await res.json();
                if (json.code === 200) {
                    const { posts, total, totalPages } = json.data;
                    document.getElementById('trash-count').textContent = '共 ' + total + ' 条';
                    renderTrashTable(posts);
                    renderPagination('trash-pagination', trashPage, totalPages, (page) => {
                        trashPage = page;
                        loadTrash();
                    });
                }
            } catch (err) {
                showToast('加载回收站失败', 'error');
            }
        }

        function renderTrashTable(posts) {
            const tbody = document.getElementById('trash-tbody');
            if (!posts || posts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5"><div class="admin-empty"><span class="empty-emoji">📭</span><span>回收站为空</span></div></td></tr>';
                return;
            }
            tbody.innerHTML = posts.map((p, i) => `
                <tr>
                    <td data-label="序号">${i + 1}</td>
                    <td data-label="标题" style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(p.title || '无标题')}</td>
                    <td data-label="作者">${escapeHtml(p.nickname || p.username || '匿名')}</td>
                    <td data-label="删除时间" style="white-space: nowrap;">${formatTime(p.deleted_at)}</td>
                    <td data-label="操作">
                        <div class="table-actions">
                            <button class="action-btn action-btn-text" title="查看详情" data-admin-action="view-trash-post" data-id="${p.id}">👁️ 查看</button>
                            <button class="action-btn action-btn-text" title="恢复" data-admin-action="restore-post" data-id="${p.id}">🔄 恢复</button>
                            <button class="action-btn action-btn-text btn-delete" title="永久删除" data-admin-action="permanent-delete-post" data-id="${p.id}">🗑 永久删除</button>
                        </div>
                    </td>
                </tr>
            `).join('');
        }

        window.restorePost = async function(postId) {
            if (!confirm('确定要恢复这篇帖子吗？')) return;
            try {
                const res = await authFetch('/api/admin/trash/posts/' + postId + '/restore', { method: 'PUT' });
                const json = await res.json();
                if (json.code === 200) {
                    showToast('恢复成功', 'success');
                    loadTrash();
                    window.refreshSidebarBadgesNow();
                } else {
                    showToast(json.message || '恢复失败', 'error');
                }
            } catch (err) {
                showToast('网络错误', 'error');
            }
        };

        window.permanentDelete = async function(postId) {
            if (!confirm('确定要永久删除这篇帖子吗？此操作不可恢复！')) return;
            try {
                const res = await authFetch('/api/admin/trash/posts/' + postId, { method: 'DELETE' });
                const json = await res.json();
                if (json.code === 200) {
                    showToast('已永久删除', 'success');
                    loadTrash();
                } else {
                    showToast(json.message || '删除失败', 'error');
                }
            } catch (err) {
                showToast('网络错误', 'error');
            }
        };

        window.viewTrashPost = async function(postId) {
            try {
                const res = await authFetch('/api/admin/trash/posts/' + postId);
                const json = await res.json();
                if (json.code === 200) {
                    const p = json.data;
                    const images = p.images ? (typeof p.images === 'string' ? JSON.parse(p.images) : p.images) : [];

                    const modalHtml = `
                        <div class="modal-overlay show" id="trash-post-detail-overlay" data-admin-action="close-modal-overlay" data-modal-id="trash-post-detail-modal">
                            <div class="modal" id="trash-post-detail-modal" style="display: flex; max-width: 800px;">
                                <div class="modal-header">
                                    <h3>🗑️ 已删除帖子详情 #${p.id}</h3>
                                    <button class="modal-close" data-admin-action="close-modal" data-modal-id="trash-post-detail-modal">&times;</button>
                                </div>
                                <div class="modal-body" style="max-height: 70vh; overflow-y: auto;">
                                    <div style="margin-bottom: 16px;">
                                        <strong>标题：</strong>${escapeHtml(p.title || '无标题')}
                                    </div>
                                    <div style="margin-bottom: 16px;">
                                        <strong>分类：</strong><span class="tag tag-default">${categoryName(p.category)}</span>
                                    </div>
                                    <div style="margin-bottom: 16px;">
                                        <strong>作者：</strong>${escapeHtml(p.nickname || p.username || '匿名')}
                                    </div>
                                    <div style="margin-bottom: 16px;">
                                        <strong>发布时间：</strong>${formatTime(p.created_at)}
                                    </div>
                                    <div style="margin-bottom: 16px;">
                                        <strong>删除时间：</strong><span style="color: #DC2626;">${formatTime(p.deleted_at)}</span>
                                    </div>
                                    ${p.ip_region ? `<div style="margin-bottom: 16px;"><strong>IP归属：</strong>📍 ${escapeHtml(p.ip_region)}</div>` : ''}
                                    <div style="margin-bottom: 16px;">
                                        <strong>内容：</strong>
                                        <div style="margin-top: 8px; padding: 12px; background: var(--bg-section); border-radius: 8px; white-space: pre-wrap;">${escapeHtml(p.content || '')}</div>
                                    </div>
                                    ${images.length > 0 ? `
                                        <div style="margin-bottom: 16px;">
                                            <strong>图片：</strong>
                                            <div style="margin-top: 8px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px;">
                                                ${images.map(img => `<img src="${escapeHtml(img)}" data-admin-action="open-image" data-url="${escapeHtml(img)}" style="width: 100%; border-radius: 8px; cursor: pointer;">`).join('')}
        </div>
    </div>

                                    ` : ''}
                                    <div style="margin-top: 20px; display: flex; gap: 12px;">
                                        <button class="btn btn-primary" data-admin-action="restore-post-close-modal" data-id="${p.id}" data-modal-id="trash-post-detail-modal">🔄 恢复帖子</button>
                                        <button class="btn btn-ghost" style="color: #DC2626;" data-admin-action="permanent-delete-post-close-modal" data-id="${p.id}" data-modal-id="trash-post-detail-modal"> 永久删除</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;

                    document.body.insertAdjacentHTML('beforeend', modalHtml);
                } else {
                    showToast(json.message || '加载失败', 'error');
                }
            } catch (err) {
                showToast('加载帖子详情失败', 'error');
            }
        };

        window.emptyTrash = async function() {
            if (!confirm('确定要清空回收站吗？此操作不可恢复！')) return;
            try {
                const res = await authFetch('/api/admin/trash/posts', { method: 'DELETE' });
                const json = await res.json();
                if (json.code === 200) {
                    showToast('回收站已清空', 'success');
                    loadTrash();
                } else {
                    showToast(json.message || '清空失败', 'error');
                }
            } catch (err) {
                showToast('网络错误', 'error');
            }
        }

        // ===== 操作日志 =====
        let logsPage = 1;

        // 标签页切换
        window.switchLogTab = function(tab) {
            document.querySelectorAll('#panel-logs .log-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('#panel-logs .log-tab-content').forEach(c => c.classList.remove('active'));
            document.querySelector('#panel-logs .log-tab[data-logtab="' + tab + '"]').classList.add('active');
            document.getElementById('logtab-' + tab).classList.add('active');
            // 按需加载数据
            if (tab === 'email') loadEmailLogs();
        };

        async function loadLogs() {
            const tbody = document.getElementById('logs-tbody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="7"><div class="loading-text"><span class="loading-spinner"></span>加载中...</div></td></tr>';
            const params = new URLSearchParams({ page: logsPage, limit: 20 });
            try {
                const res = await authFetch('/api/admin/logs?' + params);
                const json = await res.json();
                if (json.code === 200) {
                    const { logs, total, totalPages } = json.data;
                    document.getElementById('logs-count').textContent = '共 ' + total + ' 条';
                    renderLogsTable(logs);
                    renderPagination('logs-pagination', logsPage, totalPages, (page) => {
                        logsPage = page;
                        loadLogs();
                    });
                } else {
                    document.getElementById('logs-count').textContent = '共 0 条';
                }
            } catch (err) {
                showToast('加载操作日志失败', 'error');
            }
        }

        function renderLogsTable(logs) {
            const tbody = document.getElementById('logs-tbody');
            if (!logs || logs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7"><div class="admin-empty"><span class="empty-emoji">📭</span><span>暂无日志记录</span></div></td></tr>';
                return;
            }
            const actionNames = {
                approvePost: '审核通过帖子', rejectPost: '拒绝帖子', deletePost: '删除帖子',
                enableUser: '启用用户', disableUser: '禁用用户', changeRole: '修改用户角色',
                approveSong: '审核通过点歌', rejectSong: '拒绝点歌', playSong: '标记已播放', deleteSong: '删除点歌',
                deleteSlot: '删除时段', saveSettings: '保存系统设置', addNotice: '发布公告', editNotice: '编辑公告', deleteNotice: '删除公告'
            };
            tbody.innerHTML = logs.map(log => `
                <tr>
                    <td>${log.id}</td>
                    <td>${escapeHtml(log.admin_name || log.username || '-')}</td>
                    <td style="font-weight: 600; color: var(--text-primary);">${actionNames[log.action] || log.action || '-'}</td>
                    <td style="max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.82rem; color: var(--text-secondary);">${escapeHtml(log.detail || '-')}</td>
                    <td><span class="log-level ${log.level || 'info'}">${log.level || 'info'}</span></td>
                    <td style="white-space: nowrap; font-size: 0.8rem; color: var(--text-light);">${formatTime(log.created_at)}</td>
                    <td>
                        <button class="btn btn-sm btn-ghost" style="color: #DC2626;" data-admin-action="delete-log" data-id="${log.id}" title="删除">🗑</button>
                    </td>
                </tr>
            `).join('');
        }

        // 清空N天前的日志
        window.cleanOldLogs = async function() {
            const daysSelect = document.getElementById('log-clean-days');
            const days = daysSelect ? daysSelect.value : 30;
            if (!confirm('确定要清空 ' + days + ' 天前的所有日志吗？')) return;
            try {
                const res = await authFetch('/api/admin/logs/old?days=' + days, { method: 'DELETE' });
                if (!res) return;
                const data = await res.json();
                if (data.code === 200) {
                    showToast('已删除 ' + days + ' 天前的日志（共 ' + data.data.deleted + ' 条）');
                    loadLogs();
                } else {
                    showToast(data.message || '清空失败', 'error');
                }
            } catch (err) {
                showToast('清空失败', 'error');
            }
        }

        // 清空所有日志
        window.cleanAllLogs = async function() {
            if (!confirm('确定要清空所有日志吗？此操作不可恢复！')) return;
            try {
                const res = await authFetch('/api/admin/logs/all', { method: 'DELETE' });
                if (!res) return;
                const data = await res.json();
                if (data.code === 200) {
                    showToast('已清空所有日志（共 ' + data.data.deleted + ' 条）');
                    loadLogs();
                } else {
                    showToast(data.message || '清空失败', 'error');
                }
            } catch (err) {
                showToast('清空失败', 'error');
            }
        }

        // 删除单条日志
        window.deleteLog = async function(logId) {
            if (!confirm('确定要删除这条日志吗？')) return;
            try {
                const res = await authFetch('/api/admin/logs/' + logId, { method: 'DELETE' });
                if (!res) return;
                const data = await res.json();
                if (data.code === 200) {
                    showToast('删除成功', 'success');
                    loadLogs();
                } else {
                    showToast(data.message || '删除失败', 'error');
                }
            } catch (err) {
                showToast('删除失败', 'error');
            }
        }

        // 记录操作日志（静默调用，不影响主流程）
        function recordLog(action, id, extra) {
            if (!currentUser) return;
            try {
                const detail = buildLogDetail(action, id, extra);
                authFetch('/api/admin/logs', {
                    method: 'POST',
                    body: JSON.stringify({
                        action: action,
                        detail: detail,
                        level: getLogLevel(action)
                    })
                });
            } catch (e) {
                // 静默失败，不影响主操作
            }
        }

        function buildLogDetail(action, id, extra) {
            const actionMap = {
                approvePost: '通过帖子#' + id,
                rejectPost: '拒绝帖子#' + id,
                deletePost: '删除帖子#' + id,
                enableUser: '启用用户#' + id,
                disableUser: '禁用用户#' + id,
                changeRole: '修改用户#' + id + '角色为' + (extra || ''),
                approveSong: '通过点歌#' + id,
                rejectSong: '拒绝点歌#' + id,
                playSong: '标记点歌#' + id + '为已播放',
                deleteSong: '删除点歌#' + id,
                deleteSlot: '删除时段#' + id,
                saveSettings: '修改系统设置',
                addNotice: '发布公告',
                editNotice: '编辑公告#' + id,
                deleteNotice: '删除公告#' + id
            };
            return actionMap[action] || action + '#' + id;
        }

        function getLogLevel(action) {
            if (action.startsWith('delete') || action === 'disableUser') return 'warn';
            if (action === 'changeRole') return 'warn';
            return 'info';
        }

        // ===== 公告管理 =====
        async function loadNotices() {
            try {
                const res = await authFetch('/api/admin/notices');
                const json = await res.json();
                if (json.code === 200 && json.data && json.data.notices) {
                    renderNoticesTable(json.data.notices);
                }
            } catch (err) {
                showToast('加载公告列表失败', 'error');
            }
        }

        function renderNoticesTable(notices) {
            const container = document.getElementById('notices-list');
            if (!notices || notices.length === 0) {
                container.innerHTML = '<div class="admin-empty"><span class="empty-emoji">📭</span><span>暂无公告</span></div>';
                return;
            }
            container.innerHTML = notices.map(n => `
                <div class="notice-item">
                    <div style="font-size: 1.5rem; flex-shrink: 0;">${n.is_top ? '📌' : '📢'}</div>
                    <div class="notice-content">
                        <div class="notice-title">${escapeHtml(n.title)}</div>
                        <div class="notice-body">${escapeHtml(n.content)}</div>
                        <div class="notice-meta">
                            ${n.is_top ? '<span style="color: #D97706; font-weight: 600;">[置顶]</span> ' : ''}
                            发布于 ${formatTime(n.created_at)}
                        </div>
                    </div>
                    <div class="notice-actions">
                         <button class="btn btn-sm btn-accent" data-admin-action="edit-notice" data-id="${n.id}" data-title="${escapeHtml(n.title)}" title="编辑">✏️</button>
                         <button class="btn btn-sm btn-ghost" style="color: #DC2626;" data-admin-action="admin-action" data-action-name="deleteNotice" data-id="${n.id}" title="删除">🗑</button>
                    </div>
                </div>
            `).join('');
        }

        // 公告模态框逻辑
        const noticeModal = document.getElementById('notice-modal');
        const noticeTopSwitch = document.getElementById('notice-top-switch');
        const noticeTopLabel = document.getElementById('notice-top-label');

        document.getElementById('btn-add-notice').addEventListener('click', function() {
            document.getElementById('notice-modal-title').textContent = '发布公告';
            document.getElementById('notice-edit-id').value = '';
            document.getElementById('notice-form').reset();
            noticeTopSwitch.classList.remove('active');
            noticeTopLabel.textContent = '不置顶';
            noticeModal.classList.add('show');
        });

        function closeNoticeModal() {
            noticeModal.classList.remove('show');
        }

        document.getElementById('notice-modal-close').addEventListener('click', closeNoticeModal);
        document.getElementById('notice-modal-cancel').addEventListener('click', closeNoticeModal);
        noticeModal.addEventListener('click', function(e) {
            if (e.target === noticeModal) closeNoticeModal();
        });

        noticeTopSwitch.addEventListener('click', function() {
            const isTop = this.classList.toggle('active');
            noticeTopLabel.textContent = isTop ? '置顶' : '不置顶';
        });

        window.editNotice = function(id, title, btn) {
            document.getElementById('notice-modal-title').textContent = '编辑公告';
            document.getElementById('notice-edit-id').value = id;
            // 获取公告内容
            const noticeItem = btn.closest('.notice-item');
            const bodyEl = noticeItem.querySelector('.notice-body');
            const isTopEl = noticeItem.querySelector('.notice-title');
            document.getElementById('notice-title-input').value = title;
            document.getElementById('notice-content-input').value = bodyEl ? bodyEl.textContent : '';
            const isTop = noticeItem.querySelector('.notice-meta') && noticeItem.querySelector('.notice-meta').textContent.includes('[置顶]');
            if (isTop) {
                noticeTopSwitch.classList.add('active');
                noticeTopLabel.textContent = '置顶';
            } else {
                noticeTopSwitch.classList.remove('active');
                noticeTopLabel.textContent = '不置顶';
            }
            noticeModal.classList.add('show');
        };

        document.getElementById('notice-modal-submit').addEventListener('click', async function() {
            const editId = document.getElementById('notice-edit-id').value;
            const title = document.getElementById('notice-title-input').value.trim();
            const content = document.getElementById('notice-content-input').value.trim();
            const isTop = noticeTopSwitch.classList.contains('active');

            if (!title || !content) {
                showToast('请填写标题和内容', 'warning');
                return;
            }

            try {
                let url, method;
                if (editId) {
                    url = '/api/admin/notices/' + editId;
                    method = 'PUT';
                } else {
                    url = '/api/admin/notices';
                    method = 'POST';
                }

                const res = await authFetch(url, {
                    method: method,
                    body: JSON.stringify({ title, content, is_top: isTop ? 1 : 0 })
                });
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    showToast(editId ? '修改成功' : '发布成功', 'success');
                    recordLog(editId ? 'editNotice' : 'addNotice', editId || 0, null);
                    closeNoticeModal();
                    loadNotices();
                } else {
                    showToast(json.message || '操作失败', 'error');
                }
            } catch (err) {
                console.error('发布公告失败:', err);
                showToast('网络错误，请重试', 'error');
            }
        });

        // ===== 浏览记录（超级管理员专用）=====
        let postviewsPage = 1;
        let postviewsPostId = null;

        async function loadPostViews(postId) {
            try {
                const tbody = document.getElementById('postviews-list');
                if (!tbody) return;

                tbody.innerHTML = '<tr><td colspan="8"><div class="loading-text"><span class="loading-spinner"></span>加载中...</div></td></tr>';

                if (postId) postviewsPostId = postId;

                const limitSelect = document.getElementById('postviews-limit');
                const limit = limitSelect ? parseInt(limitSelect.value) || 20 : 20;
                const params = new URLSearchParams({ page: postviewsPage, limit: limit });
                if (postviewsPostId) params.set('post_id', postviewsPostId);

                const searchInput = document.getElementById('postviews-search');
                if (searchInput && searchInput.value.trim()) {
                    params.set('keyword', searchInput.value.trim());
                }

                const res = await authFetch('/api/admin/post-views?' + params.toString());
                if (!res) {
                    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#999;">加载失败</td></tr>';
                    return;
                }

                const json = await res.json();
                if (json.code === 200) {
                    const { records, total, totalPages } = json.data;
                    renderPostViewsTable(records);
                    renderPagination('postviews-pagination', postviewsPage, totalPages, (page) => {
                        postviewsPage = page;
                        loadPostViews();
                    });
                } else if (json.code === 403) {
                    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#999;">无权限访问浏览记录</td></tr>';
                } else {
                    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#999;">加载失败</td></tr>';
                }
            } catch (err) {
                console.error('加载浏览记录失败:', err);
                const tbody = document.getElementById('postviews-list');
                if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#999;">网络错误</td></tr>';
            }
        }
        window.loadPostViews = loadPostViews;

        function renderPostViewsTable(records) {
            const tbody = document.getElementById('postviews-list');
            if (!records || records.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8"><div class="admin-empty"><span class="empty-emoji">👁️</span><span>暂无浏览记录</span></div></td></tr>';
                return;
            }

            tbody.innerHTML = records.map(r => {
                const postTitle = r.post_title ? (r.post_title.length > 30 ? r.post_title.substring(0, 30) + '...' : r.post_title) : '(无标题)';
                let viewer = '游客';
                if (r.viewer_nickname) {
                    viewer = escapeHtml(r.viewer_nickname);
                } else if (r.user_id) {
                    viewer = '用户#' + r.user_id;
                }
                const viewerDisplay = r.user_id
                    ? '<span style="color:#3B82F6;cursor:pointer;text-decoration:underline;" data-admin-action="viewer-profile" data-id="' + r.user_id + '">' + escapeHtml(viewer) + '</span>'
                    : escapeHtml(viewer);

                var region = r.ip_region || '';
                var regionDisplay = region
                    ? '<span style="font-size:0.8rem;color:#666;">' + escapeHtml(region) + '</span>'
                    : '<span style="font-size:0.8rem;color:#ccc;">解析中...</span>';

                var isIPv6 = r.viewer_ip && r.viewer_ip.indexOf(':') >= 0;
                var ipDisplay = '-';
                if (r.viewer_ip) {
                  ipDisplay = isIPv6
                    ? '<span style="font-size:0.78rem;color:#999;" title="' + escapeHtml(r.viewer_ip) + '">IPv6</span>'
                    : '<span style="font-size:0.78rem;color:#999;font-family:monospace;">' + escapeHtml(r.viewer_ip) + '</span>';
                }

                return '<tr>' +
                    '<td>' + r.post_id + '</td>' +
                    '<td style="max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + escapeHtml(postTitle) + '</td>' +
                    '<td style="white-space: nowrap;">' + viewerDisplay + '</td>' +
                    '<td style="font-size: 0.8rem; color: #888; white-space: nowrap;">' + (r.user_email || '-') + '</td>' +
                    '<td style="white-space: nowrap;">' + ipDisplay + '</td>' +
                    '<td style="white-space: nowrap;">' + regionDisplay + '</td>' +
                    '<td style="white-space: nowrap; font-size: 0.8rem; color: #666;">' + formatTime(r.viewed_at) + '</td>' +
                    '<td><button class="btn btn-sm btn-ghost" data-admin-action="open-post" data-id="' + r.post_id + '">查看帖子</button></td>' +
                '</tr>';
            }).join('');
        }

        // 清空N天前的浏览记录
        window.clearOldPostViews = async function clearOldPostViews() {
            const days = prompt('要清空多少天前的浏览记录？', '30');
            if (days === null) return;
            const daysNum = Number(days.trim());
            if (!/^\d+$/.test(days.trim()) || daysNum < 1 || daysNum > 36500) {
                showToast('请输入 1 到 36500 之间的天数', 'error');
                return;
            }

            try {
                const res = await authFetch('/api/admin/post-views/old?days=' + daysNum, { method: 'DELETE' });
                const json = await res.json();
                if (json.code === 200) {
                    showToast(`已清空 ${json.data.deleted} 条记录`, 'success');
                    loadPostViews();
                } else {
                    showToast(json.message || '操作失败', 'error');
                }
            } catch (err) {
                showToast('网络错误，请重试', 'error');
            }
        }

        // 清空所有浏览记录
        window.clearAllPostViews = async function clearAllPostViews() {
            if (!confirm('确认清空所有浏览记录？此操作不可恢复！')) return;
            if (!confirm('再次确认：真的要清空全部浏览记录吗？')) return;

            try {
                const res = await authFetch('/api/admin/post-views/all', { method: 'DELETE' });
                const json = await res.json();
                if (json.code === 200) {
                    showToast('已清空所有浏览记录', 'success');
                    loadPostViews();
                } else {
                    showToast(json.message || '操作失败', 'error');
                }
            } catch (err) {
                showToast('网络错误，请重试', 'error');
            }
        }

        // ===== 用户资料弹窗 =====
        window.showViewerProfile = async function showViewerProfile(userId) {
            const modal = document.getElementById('viewer-profile-modal');
            const content = document.getElementById('viewer-profile-content');
            modal.style.display = 'flex';
            content.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">加载中...</div>';

            try {
                const res = await authFetch('/api/admin/users/' + userId + '/profile');
                if (!res) {
                    content.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">加载失败</div>';
                    return;
                }
                const json = await res.json();
                if (json.code !== 200) {
                    content.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">' + (json.message || '加载失败') + '</div>';
                    return;
                }
                const u = json.data;
                const roleNames = { user: '普通用户', reviewer: '审核员', radio_admin: '广播管理员', admin: '管理员', super_admin: '超级管理员' };
                const statusText = u.status === 1 ? '<span style="color:#10B981;">● 正常</span>' : '<span style="color:#EF4444;">● 已禁用</span>';
                var banInfo = '';
                if (u.status === 0 && u.ban_reason) {
                    banInfo = '<div style="margin-top:12px;padding:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;">'
                        + '<div style="font-size:0.8rem;color:#dc2626;font-weight:600;margin-bottom:6px;">🔒 封禁信息</div>'
                        + '<div style="font-size:0.82rem;color:#991b1b;"><span style="color:#b91c1c;">原因：</span>' + escapeHtml(u.ban_reason) + '</div>'
                        + (u.ban_attempt_ip ? '<div style="font-size:0.82rem;color:#991b1b;margin-top:4px;"><span style="color:#b91c1c;">最后尝试IP：</span>' + escapeHtml(u.ban_attempt_ip) + '（' + (u.ban_attempt_count || 1) + '次）</div>' : '')
                        + '</div>';
                }
                const avatar = u.avatar || '/uploads/avatars/default.png';
                const nickname = escapeHtml(u.nickname || u.username || '未设置');
                const email = escapeHtml(u.email || '-');
                const role = roleNames[u.role] || u.role || '-';
                const joinedAt = u.created_at ? formatTime(new Date(u.created_at)) : '-';
                const bio = u.bio ? '<div style="margin-top:12px;padding:10px;background:#F9FAFB;border-radius:8px;"><div style="font-size:0.8rem;color:#999;margin-bottom:4px;">个人简介</div><div style="font-size:0.85rem;color:#555;">' + escapeHtml(u.bio) + '</div></div>' : '';
                const location = u.location ? '<div><span style="font-size:0.8rem;color:#999;">位置</span> ' + escapeHtml(u.location) + '</div>' : '';
                const birthday = u.birthday ? '<div><span style="font-size:0.8rem;color:#999;">生日</span> ' + escapeHtml(String(u.birthday)) + '</div>' : '';

                content.innerHTML = '<div style="text-align:center;padding:20px 0;">' +
                    '<img src="' + escapeHtml(avatar) + '" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid #F3F4F6;">' +
                    '<div style="font-size:1.1rem;font-weight:600;margin-top:8px;">' + nickname + '</div>' +
                    '<div style="font-size:0.85rem;color:#6B7280;margin-top:4px;">' + role + '</div>' +
                '</div>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:16px 0;">' +
                    '<div style="text-align:center;padding:12px;background:#F9FAFB;border-radius:10px;">' +
                        '<div style="font-size:1.3rem;font-weight:700;color:#3B82F6;">' + (u.post_count || 0) + '</div>' +
                        '<div style="font-size:0.75rem;color:#999;margin-top:2px;">帖子</div>' +
                    '</div>' +
                    '<div style="text-align:center;padding:12px;background:#F9FAFB;border-radius:10px;">' +
                        '<div style="font-size:1.3rem;font-weight:700;color:#10B981;">' + (u.view_count || 0) + '</div>' +
                        '<div style="font-size:0.75rem;color:#999;margin-top:2px;">浏览</div>' +
                    '</div>' +
                    '<div style="text-align:center;padding:12px;background:#F9FAFB;border-radius:10px;">' +
                        '<div style="font-size:0.85rem;font-weight:600;color:#666;">' + statusText + '</div>' +
                        '<div style="font-size:0.75rem;color:#999;margin-top:2px;">状态</div>' +
                    '</div>' +
                '</div>' +
                '<div style="font-size:0.85rem;color:#555;line-height:1.8;">' +
                    '<div><span style="font-size:0.8rem;color:#999;">用户名</span> ' + escapeHtml(u.username || '-') + '</div>' +
                    '<div><span style="font-size:0.8rem;color:#999;">邮箱</span> ' + email + '</div>' +
                    '<div><span style="font-size:0.8rem;color:#999;">ID</span> #' + u.id + '</div>' +
                    '<div><span style="font-size:0.8rem;color:#999;">注册时间</span> ' + joinedAt + '</div>' +
                    (location || birthday ? '<div style="display:flex;gap:16px;margin-top:4px;">' + location + birthday + '</div>' : '') +
                '</div>' +
                bio + banInfo;
            } catch (err) {
                console.error('加载用户资料失败:', err);
                content.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">网络错误</div>';
            }
        }

        window.closeViewerProfile = function closeViewerProfile() {
            document.getElementById('viewer-profile-modal').style.display = 'none';
        }

        // ===== 反馈管理 =====
        let feedbacksPage = 1;
        let feedbacksStatus = 'all';

        async function loadFeedbacks() {
            try {
                const statusFilter = document.getElementById('feedback-status-filter');
                if (statusFilter) feedbacksStatus = statusFilter.value;

                const params = new URLSearchParams({ page: feedbacksPage, limit: 15 });
                if (feedbacksStatus !== 'all') params.set('status', feedbacksStatus);

                const res = await authFetch('/api/admin/feedbacks?' + params.toString());
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    const { feedbacks, total, totalPages } = json.data;
                    document.getElementById('feedbacks-count').textContent = '共 ' + total + ' 条';
                    renderFeedbacksTable(feedbacks);
                    renderPagination('feedbacks-pagination', feedbacksPage, totalPages, (page) => {
                        feedbacksPage = page;
                        loadFeedbacks();
                    });
                }
            } catch (err) {
                showToast('加载反馈列表失败', 'error');
            }
        }

        function renderFeedbacksTable(feedbacks) {
            const tbody = document.getElementById('feedbacks-tbody');
            if (!feedbacks || feedbacks.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7"><div class="admin-empty"><span class="empty-emoji">📭</span><span>暂无反馈</span></div></td></tr>';
                return;
            }

            const typeMap = {
                'suggest': { icon: '💡', text: '建议', color: '#3B82F6' },
                'bug': { icon: '🐛', text: 'Bug', color: '#EF4444' },
                'complaint': { icon: '📢', text: '投诉', color: '#F59E0B' },
                'other': { icon: '📝', text: '其他', color: '#6B7280' }
            };

            const statusMap = {
                'pending': { text: '待处理', color: '#F59E0B', bg: '#FEF3C7' },
                'processing': { text: '处理中', color: '#3B82F6', bg: '#DBEAFE' },
                'resolved': { text: '已解决', color: '#10B981', bg: '#D1FAE5' },
                'accepted': { text: '已采纳 · 已奖励20积分', color: '#7C3AED', bg: '#EDE9FE' },
                'closed': { text: '已关闭', color: '#6B7280', bg: '#F3F4F6' }
            };

            tbody.innerHTML = feedbacks.map(f => {
                const type = typeMap[f.type] || typeMap['other'];
                const status = statusMap[f.status] || statusMap['pending'];
                const submitter = f.nickname || f.username || '匿名用户';

                return '<tr>' +
                    '<td>' + f.id + '</td>' +
                    '<td><span style="color: ' + type.color + ';">' + type.icon + ' ' + type.text + '</span></td>' +
                    '<td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + escapeHtml(f.title) + '</td>' +
                    '<td>' + escapeHtml(submitter) + '</td>' +
                    '<td><span style="background: ' + status.bg + '; color: ' + status.color + '; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600;">' + status.text + '</span></td>' +
                    '<td style="white-space: nowrap; font-size: 0.8rem; color: var(--text-light);">' + formatTime(f.created_at) + '</td>' +
                    '<td>' +
                        '<button class="btn btn-sm btn-accent" data-admin-action="view-feedback" data-id="' + f.id + '" title="查看/回复">👁 查看</button> ' +
                        '<button class="btn btn-sm btn-ghost" style="color: #DC2626;" data-admin-action="admin-action" data-action-name="deleteFeedback" data-id="' + f.id + '" title="删除">🗑</button>' +
                    '</td>' +
                '</tr>';
            }).join('');
        }

        window.viewFeedback = async function(id) {
            try {
                const res = await authFetch('/api/admin/feedbacks/' + id);
                if (!res) {
                    showToast('加载失败，请重试', 'error');
                    return;
                }
                const json = await res.json();
                if (json.code === 200) {
                    const f = json.data;
                    const typeMap = { 'suggest': '💡 建议', 'bug': '🐛 Bug', 'complaint': '📢 投诉', 'other': '📝 其他' };
                    const statusMap = { 'pending': '待处理', 'processing': '处理中', 'resolved': '已解决', 'accepted': '已采纳（奖励20积分）', 'closed': '已关闭' };

                    // 先移除已存在的模态框
                    const existingModal = document.getElementById('feedback-detail-modal');
                    if (existingModal) existingModal.remove();

                    const modalHtml = `
                    <div class="modal-overlay show" id="feedback-modal-overlay" data-admin-action="close-feedback-overlay">
                        <div class="modal" id="feedback-detail-modal">
                            <div class="modal-header">
                                <h3>💬 反馈详情 #${f.id}</h3>
                                <button class="modal-close" data-admin-action="close-feedback">×</button>
                            </div>
                            <div class="modal-body">
                                <div class="feedback-info-item"><strong>类型：</strong><span class="feedback-type-badge">${typeMap[f.type] || f.type}</span></div>
                                <div class="feedback-info-item"><strong>标题：</strong>${escapeHtml(f.title)}</div>
                                <div class="feedback-info-item"><strong>提交者：</strong>${escapeHtml(f.nickname || f.username || '匿名用户')}</div>
                                <div class="feedback-info-item"><strong>联系方式：</strong>${escapeHtml(f.contact || '未填写')}</div>
                                <div class="feedback-info-item"><strong>当前状态：</strong><span class="feedback-status-badge status-${f.status}">${statusMap[f.status] || f.status}</span></div>
                                <div class="feedback-info-item"><strong>提交时间：</strong>${formatTime(f.created_at)}</div>
                                <div class="feedback-content-section">
                                    <strong>反馈内容：</strong>
                                    <div class="feedback-content">${escapeHtml(f.content)}</div>
                                </div>
                                ${f.reply ? `
                                <div class="feedback-reply-section">
                                    <strong>管理员回复：</strong>
                                    <div class="feedback-reply">${escapeHtml(f.reply)}</div>
                                </div>` : ''}
                                <div class="feedback-action-section">
                                    <div class="form-group">
                                        <label>回复内容：</label>
                                        <textarea id="feedback-reply-content" class="form-input" rows="3" placeholder="请输入回复内容...">${f.reply || ''}</textarea>
                                    </div>
                                    <div class="form-group">
                                        <label>处理状态：</label>
                                        <select id="feedback-reply-status" class="form-input">
                                            <option value="pending" ${f.status === 'pending' ? 'selected' : ''}>待处理</option>
                                            <option value="processing" ${f.status === 'processing' ? 'selected' : ''}>处理中</option>
                                            <option value="resolved" ${f.status === 'resolved' ? 'selected' : ''}>已解决</option>
                                            <option value="accepted" ${f.status === 'accepted' ? 'selected' : ''}>已采纳（奖励20积分）</option>
                                            <option value="closed" ${f.status === 'closed' ? 'selected' : ''}>已关闭</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button class="btn btn-ghost" data-admin-action="close-feedback">取消</button>
                                <button class="btn btn-primary" data-admin-action="submit-feedback-reply" data-id="${f.id}">💾 保存回复</button>
                            </div>
                        </div>
                    </div>`;

                    document.body.insertAdjacentHTML('beforeend', modalHtml);
                } else {
                    showToast(json.message || '加载反馈详情失败', 'error');
                }
            } catch (err) {
                console.error('加载反馈详情失败:', err);
                showToast('加载失败，请重试', 'error');
            }
        };

        window.closeFeedbackModal = function() {
            const modal = document.getElementById('feedback-detail-modal');
            const overlay = document.getElementById('feedback-modal-overlay');
            if (modal) {
                modal.classList.remove('show');
                setTimeout(() => modal.remove(), 200);
            }
            if (overlay) {
                overlay.classList.remove('show');
                setTimeout(() => overlay.remove(), 200);
            }
            document.body.style.overflow = '';
        };

        window.submitFeedbackReply = async function(id) {
            const reply = document.getElementById('feedback-reply-content').value.trim();
            const status = document.getElementById('feedback-reply-status').value;

            try {
                const res = await authFetch('/api/admin/feedbacks/' + id + '/reply', {
                    method: 'PUT',
                    body: JSON.stringify({ reply: reply || '', status })
                });
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    showToast(json.message || '回复成功', 'success');
                    closeFeedbackModal();
                    loadFeedbacks();
                } else {
                    showToast(json.message || '回复失败', 'error');
                }
            } catch (err) {
                showToast('网络错误，请重试', 'error');
            }
        };

        // 添加删除反馈到adminAction
        const originalAdminAction = window.adminAction;
        window.adminAction = async function(action, id, extra) {
            if (action === 'deleteFeedback') {
                if (!confirm('确定要删除这条反馈吗？')) return;
                try {
                    const res = await authFetch('/api/admin/feedbacks/' + id, { method: 'DELETE' });
                    if (!res) return;
                    const json = await res.json();
                    if (json.code === 200) {
                        showToast('删除成功', 'success');
                        loadFeedbacks();
                    } else {
                        showToast(json.message || '删除失败', 'error');
                    }
                } catch (err) {
                    showToast('网络错误，请重试', 'error');
                }
                return;
            }
            originalAdminAction(action, id, extra);
        };

        // ===== 系统设置 =====
        async function loadSettings() {
            loadDeploymentStatus(false);
            loadAdminReleaseNotes(false);
            try {
                const res = await authFetch('/api/admin/settings');
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    const s = json.data;
                    document.getElementById('setting-site-name').value = s.site_name || '';

                    const registerSwitch = document.getElementById('setting-register-switch');
                    const registerLabel = document.getElementById('setting-register-label');
                    if (s.allow_register) {
                        registerSwitch.classList.add('active');
                        registerLabel.textContent = '已开启';
                    } else {
                        registerSwitch.classList.remove('active');
                        registerLabel.textContent = '已关闭';
                    }

                    const reviewSwitch = document.getElementById('setting-review-switch');
                    const reviewLabel = document.getElementById('setting-review-label');
                    if (s.post_review) {
                        reviewSwitch.classList.add('active');
                        reviewLabel.textContent = '已开启';
                    } else {
                        reviewSwitch.classList.remove('active');
                        reviewLabel.textContent = '已关闭';
                    }

                    const songSwitch = document.getElementById('setting-song-switch');
                    const songLabel = document.getElementById('setting-song-label');
                    if (s.song_enabled) {
                        songSwitch.classList.add('active');
                        songLabel.textContent = '已开启';
                    } else {
                        songSwitch.classList.remove('active');
                        songLabel.textContent = '已关闭';
                    }

                    // 每日点歌上限
                    const dailySongLimitInput = document.getElementById('setting-daily-song-limit');
                    if (dailySongLimitInput && s.daily_song_limit !== undefined) {
                        dailySongLimitInput.value = s.daily_song_limit || 3;
                    }

                    const anonPostSwitch = document.getElementById('setting-anon-post-switch');
                    const anonPostLabel = document.getElementById('setting-anon-post-label');
                    if (s.anon_post) {
                        anonPostSwitch.classList.add('active');
                        anonPostLabel.textContent = '已开启';
                    } else {
                        anonPostSwitch.classList.remove('active');
                        anonPostLabel.textContent = '已关闭';
                    }

                    const anonCommentSwitch = document.getElementById('setting-anon-comment-switch');
                    const anonCommentLabel = document.getElementById('setting-anon-comment-label');
                    if (s.anon_comment) {
                        anonCommentSwitch.classList.add('active');
                        anonCommentLabel.textContent = '已开启';
                    } else {
                        anonCommentSwitch.classList.remove('active');
                        anonCommentLabel.textContent = '已关闭';
                    }

                    const anonSongSwitch = document.getElementById('setting-anon-song-switch');
                    const anonSongLabel = document.getElementById('setting-anon-song-label');
                    if (s.anon_song) {
                        anonSongSwitch.classList.add('active');
                        anonSongLabel.textContent = '已开启';
                    } else {
                        anonSongSwitch.classList.remove('active');
                        anonSongLabel.textContent = '已关闭';
                    }

                    // 邮件配置
                    const emailSwitch = document.getElementById('setting-email-switch');
                    const emailLabel = document.getElementById('setting-email-label');
                    if (s.email_enabled) {
                        emailSwitch.classList.add('active');
                        emailLabel.textContent = '已开启';
                    } else {
                        emailSwitch.classList.remove('active');
                        emailLabel.textContent = '已关闭';
                    }
                    const registerEmailSwitch = document.getElementById('setting-register-email-switch');
                    const registerEmailLabel = document.getElementById('setting-register-email-label');
                    if (s.register_email_verify_enabled) {
                        registerEmailSwitch.classList.add('active');
                        registerEmailLabel.textContent = '已开启';
                    } else {
                        registerEmailSwitch.classList.remove('active');
                        registerEmailLabel.textContent = '已关闭';
                    }
                    const songPendingAdminSwitch = document.getElementById('setting-song-pending-admin-switch');
                    const songPendingAdminLabel = document.getElementById('setting-song-pending-admin-label');
                    if (s.song_pending_admin_notify) {
                        songPendingAdminSwitch.classList.add('active');
                        songPendingAdminLabel.textContent = '已开启';
                    } else {
                        songPendingAdminSwitch.classList.remove('active');
                        songPendingAdminLabel.textContent = '已关闭';
                    }
                    document.getElementById('setting-smtp-host').value = s.smtp_host || '';
                    document.getElementById('setting-smtp-port').value = s.smtp_port || '587';
                    document.getElementById('setting-smtp-user').value = s.smtp_user || '';
                    const smtpPassInput = document.getElementById('setting-smtp-pass');
                    if (smtpPassInput) {
                        smtpPassInput.value = '';
                        smtpPassInput.placeholder = s.smtp_pass_configured ? '已配置（留空保持不变）' : '输入密码或授权码';
                    }
                    document.getElementById('setting-smtp-from').value = s.smtp_from || '';

                    // 节日主题：开关与预设分开保存，避免切换预设时误开启主题
                    const festivalSwitch = document.getElementById('setting-festival-switch');
                    const festivalLabel = document.getElementById('setting-festival-label');
                    if (s.festival_enabled) {
                        festivalSwitch.classList.add('active');
                        festivalLabel.textContent = '已开启';
                    } else {
                        festivalSwitch.classList.remove('active');
                        festivalLabel.textContent = '已关闭';
                    }
                    setFestivalTheme(s.festival_theme || 'teachers_day');

                    _settingsLoaded = true; // 标记设置已加载
                }
            } catch (err) {
                showToast('加载系统设置失败', 'error');
            }
        }

        async function loadDeploymentStatus(showFeedback) {
            const stateEl = document.getElementById('deployment-state');
            const revisionEl = document.getElementById('deployment-revision');
            const detailEl = document.getElementById('deployment-version-detail');
            const refreshBtn = document.getElementById('deployment-refresh-btn');
            if (!stateEl || !revisionEl || !detailEl) return;
            if (refreshBtn) refreshBtn.disabled = true;
            stateEl.textContent = '读取中';
            stateEl.className = 'tag tag-default';
            try {
                const response = await authFetch('/api/admin/deployment-status?ts=' + Date.now());
                if (!response) throw new Error('请求失败');
                const json = await response.json();
                if (json.code !== 200) throw new Error(json.message || '读取失败');
                const data = json.data || {};
                const stateMap = {
                    starting: { text: '准备部署', className: 'tag tag-blue' },
                    success: { text: '部署成功', className: 'tag tag-green' },
                    running: { text: '部署中', className: 'tag tag-blue' },
                    failed: { text: '部署失败', className: 'tag tag-red' },
                    unknown: { text: '暂无记录', className: 'tag tag-default' }
                };
                const display = stateMap[data.state] || stateMap.unknown;
                stateEl.textContent = display.text;
                stateEl.className = display.className;
                revisionEl.textContent = data.revision ? data.revision.slice(0, 12) : '--';
                revisionEl.title = data.revision || '';
                let updatedText = '暂无部署时间';
                if (data.updatedAt) {
                    const parsed = new Date(data.updatedAt);
                    if (!Number.isNaN(parsed.getTime())) updatedText = parsed.toLocaleString('zh-CN', { hour12: false });
                }
                detailEl.textContent = '应用版本 ' + (data.appVersion || '--') + ' · 最近更新 ' + updatedText + (data.exitCode === null || data.exitCode === undefined ? '' : ' · 退出码 ' + data.exitCode);
                if (showFeedback) showToast('部署状态已刷新', 'success');
            } catch (error) {
                stateEl.textContent = '读取失败';
                stateEl.className = 'tag tag-red';
                revisionEl.textContent = '--';
                detailEl.textContent = error.message || '部署状态读取失败';
                if (showFeedback) showToast('部署状态读取失败', 'error');
            } finally {
                if (refreshBtn) refreshBtn.disabled = false;
            }
        }

        function formatAdminReleaseDate(value) {
            var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
            if (!match) return '';
            return Number(match[2]) + '月' + Number(match[3]) + '日';
        }

        function renderAdminReleaseNotes(notes) {
            var container = document.getElementById('admin-release-notes');
            if (!container) return;
            container.textContent = '';

            if (!notes.length) {
                var empty = document.createElement('div');
                empty.className = 'admin-release-notes-empty';
                empty.textContent = '暂时还没有更新记录。';
                container.appendChild(empty);
                return;
            }

            function createAdminReleaseNote(note) {
                var item = document.createElement('article');
                item.className = 'admin-release-note';

                var header = document.createElement('div');
                header.className = 'admin-release-note-header';
                var title = document.createElement('h3');
                title.className = 'admin-release-note-title';
                title.textContent = note.title;
                var date = document.createElement('time');
                date.className = 'admin-release-note-date';
                date.dateTime = note.published_at;
                date.textContent = formatAdminReleaseDate(note.published_at);
                header.appendChild(title);
                header.appendChild(date);

                var summary = document.createElement('p');
                summary.className = 'admin-release-note-summary';
                summary.textContent = note.summary;

                var changes = document.createElement('ul');
                changes.className = 'admin-release-note-changes';
                note.changes.forEach(function(change) {
                    var changeItem = document.createElement('li');
                    changeItem.textContent = change;
                    changes.appendChild(changeItem);
                });

                item.appendChild(header);
                item.appendChild(summary);
                item.appendChild(changes);
                return item;
            }

            container.appendChild(createAdminReleaseNote(notes[0]));
            if (notes.length > 1) {
                var older = document.createElement('details');
                older.className = 'admin-release-notes-more';
                var olderSummary = document.createElement('summary');
                olderSummary.textContent = '查看更早的 ' + (notes.length - 1) + ' 条更新';
                older.appendChild(olderSummary);
                notes.slice(1).forEach(function(note) {
                    older.appendChild(createAdminReleaseNote(note));
                });
                container.appendChild(older);
            }
        }

        async function loadAdminReleaseNotes(showFeedback) {
            var container = document.getElementById('admin-release-notes');
            var refreshBtn = document.getElementById('admin-release-notes-refresh-btn');
            if (!container) return;
            if (refreshBtn) refreshBtn.disabled = true;
            try {
                var response = await authFetch('/api/admin/release-notes?ts=' + Date.now());
                if (!response) throw new Error('请求失败');
                var json = await response.json();
                if (json.code !== 200) throw new Error(json.message || '读取失败');
                var notes = json.data && Array.isArray(json.data.notes)
                    ? json.data.notes.filter(function(note) {
                        return note && typeof note.title === 'string' && typeof note.summary === 'string' && Array.isArray(note.changes);
                    })
                    : [];
                renderAdminReleaseNotes(notes);
                if (showFeedback) showToast('更新记录已刷新', 'success');
            } catch (error) {
                container.textContent = '';
                var message = document.createElement('div');
                message.className = 'admin-release-notes-empty';
                message.textContent = error.message || '更新记录读取失败';
                container.appendChild(message);
                if (showFeedback) showToast('更新记录读取失败', 'error');
            } finally {
                if (refreshBtn) refreshBtn.disabled = false;
            }
        }

        // 设置面板开关绑定（切换后自动保存）
        document.getElementById('setting-register-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-register-label').textContent = isActive ? '已开启' : '已关闭';
            autoSaveSettings();
        });
        document.getElementById('setting-review-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-review-label').textContent = isActive ? '已开启' : '已关闭';
            autoSaveSettings();
        });
        document.getElementById('setting-song-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-song-label').textContent = isActive ? '已开启' : '已关闭';
            autoSaveSettings();
        });
        document.getElementById('setting-anon-post-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-anon-post-label').textContent = isActive ? '已开启' : '已关闭';
            autoSaveSettings();
        });
        document.getElementById('setting-anon-comment-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-anon-comment-label').textContent = isActive ? '已开启' : '已关闭';
            autoSaveSettings();
        });
        document.getElementById('setting-anon-song-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-anon-song-label').textContent = isActive ? '已开启' : '已关闭';
            autoSaveSettings();
        });
        document.getElementById('setting-email-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-email-label').textContent = isActive ? '已开启' : '已关闭';
            saveEmailConfig();
        });
        document.getElementById('setting-register-email-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-register-email-label').textContent = isActive ? '已开启' : '已关闭';
            saveEmailConfig();
        });
        document.getElementById('setting-song-pending-admin-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-song-pending-admin-label').textContent = isActive ? '已开启' : '已关闭';
            saveEmailConfig();
        });
        document.getElementById('setting-festival-switch').addEventListener('click', function() {
            const isActive = this.classList.toggle('active');
            document.getElementById('setting-festival-label').textContent = isActive ? '已开启' : '已关闭';
            autoSaveSettings();
        });
        document.getElementById('festival-theme-toggle').addEventListener('click', function() {
            const options = document.getElementById('festival-theme-options');
            const isOpen = this.getAttribute('aria-expanded') === 'true';
            this.setAttribute('aria-expanded', String(!isOpen));
            options.hidden = isOpen;
        });
        document.querySelectorAll('input[name="festival_theme"]').forEach(function(input) {
            input.addEventListener('change', function() {
                updateFestivalThemeSummary(this.value);
                _themeSavePending = true;
                var options = document.getElementById('festival-theme-options');
                var toggle = document.getElementById('festival-theme-toggle');
                if (options) options.hidden = true;
                if (toggle) toggle.setAttribute('aria-expanded', 'false');
                autoSaveSettings();
            });
        });

        // 邮件配置显式保存按钮（用户看到 + 点击确认）
        window.saveEmailConfig = async function() {
            var btn = document.getElementById('setting-save-email-btn');
            btn.disabled = true;
            btn.textContent = '⏳ 保存中...';
            try {
                // 先加载现有全部设置，合并保存避免覆盖
                var res = await authFetch('/api/admin/settings');
                if (!res) { btn.disabled = false; btn.textContent = '💾 保存邮件配置'; return; }
                var data = await res.json();
                var cur = (data.code === 200 && data.data) ? data.data : {};
                var body = { ...cur };
                body.email_enabled = document.getElementById('setting-email-switch').classList.contains('active') ? 1 : 0;
                body.register_email_verify_enabled = document.getElementById('setting-register-email-switch').classList.contains('active') ? 1 : 0;
                body.song_pending_admin_notify = document.getElementById('setting-song-pending-admin-switch').classList.contains('active') ? 1 : 0;
                body.smtp_host = document.getElementById('setting-smtp-host').value.trim();
                body.smtp_port = document.getElementById('setting-smtp-port').value.trim() || '587';
                body.smtp_user = document.getElementById('setting-smtp-user').value.trim();
                // 密码不会由接口回传；留空时不提交，避免误覆盖服务器上的现有密码。
                delete body.smtp_pass;
                var smtpPass = document.getElementById('setting-smtp-pass').value.trim();
                if (smtpPass) body.smtp_pass = smtpPass;
                body.smtp_from = document.getElementById('setting-smtp-from').value.trim();
                body.festival_theme = getSelectedFestivalTheme();

                var saveRes = await authFetch('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
                if (!saveRes) { btn.disabled = false; btn.textContent = '💾 保存邮件配置'; return; }
                var saveData = await saveRes.json();
                if (saveData.code === 200) {
                    showToast('✅ 邮件配置保存成功！', 'success');
                    var hint = document.getElementById('settings-save-hint');
                    if (hint) { hint.style.opacity = '1'; setTimeout(function() { hint.style.opacity = '0'; }, 2000); }
                } else {
                    showToast('❌ ' + (saveData.message || '保存失败'), 'error');
                }
            } catch (err) {
                showToast('❌ 保存失败: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = '💾 保存邮件配置';
            }
        };

        // 测试邮件发送
        window.testEmailSend = async function() {
            var testEmail = document.getElementById('setting-test-email').value.trim();
            if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
                showToast('请输入有效的测试邮箱地址', 'warning');
                return;
            }
            var btn = document.getElementById('setting-test-btn');
            btn.disabled = true;
            btn.textContent = '⏳ 发送中...';
            try {
                var res = await authFetch('/api/admin/test-email', {
                    method: 'POST',
                    body: JSON.stringify({ email: testEmail })
                });
                if (!res) return;
                var data = await res.json();
                if (data.code === 200) {
                    showToast('✅ 测试邮件已发送到 ' + testEmail + '，请检查收件箱！', 'success');
                } else {
                    showToast('❌ ' + (data.message || '发送失败，请检查SMTP配置'), 'error');
                }
            } catch (err) {
                showToast('❌ 发送失败: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = '✈️ 发送测试';
            }
        };

        // ===== 加载邮件发送记录 =====
        window.loadEmailLogs = async function() {
            var container = document.getElementById('emailLogsContainer');
            if (!container) return;
            container.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">加载中...</div>';
            try {
                var token = localStorage.getItem('token') || sessionStorage.getItem('token') || '';
                var res = await fetch('/api/admin/email-logs', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                var data = await res.json();
                if (data.code !== 200 || !data.data || !data.data.logs) {
                    container.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">暂无记录</div>';
                    return;
                }
                var logs = data.data.logs;
                if (logs.length === 0) {
                    container.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">暂无邮件发送记录</div>';
                    return;
                }
                var html = '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
                html += '<tr style="background:#667eea;color:#fff;">' +
                    '<th style="padding:6px 8px;text-align:left;">时间</th>' +
                    '<th style="padding:6px 8px;text-align:left;">收件人</th>' +
                    '<th style="padding:6px 8px;text-align:left;">主题</th>' +
                    '<th style="padding:6px 8px;text-align:left;">用户</th>' +
                    '<th style="padding:6px 8px;text-align:left;">状态</th>' +
                    '<th style="padding:6px 8px;text-align:left;">操作</th></tr>';
                for (var i = 0; i < logs.length; i++) {
                    var l = logs[i];
                    var time = l.created_at ? l.created_at.replace('T', ' ').substring(0, 19) : '';
                    var st = l.status === 'success' ? '✅ 成功' : '❌ 失败';
                    var sc = l.status === 'success' ? '#10B981' : '#EF4444';
                    html += '<tr style="border-bottom:1px solid #f0f0f0;">' +
                        '<td style="padding:6px 8px;color:#888;white-space:nowrap;">' + time + '</td>' +
                        '<td style="padding:6px 8px;max-width:160px;overflow:hidden;text-overflow:ellipsis;">' + (l.to_email||'') + '</td>' +
                        '<td style="padding:6px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="' + (l.content_preview||l.subject||'') + '">' + (l.subject||'') + '</td>' +
                        '<td style="padding:6px 8px;color:#888;">' + (l.target_user_name||'') + '</td>' +
                        '<td style="padding:6px 8px;color:' + sc + ';">' + st + '<br><span style="font-size:11px;color:#999;">' + (l.error_msg||l.type||'') + '</span></td>' +
                        '<td style="padding:6px 8px;"><button style="background:#EF4444;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;" data-admin-action="delete-email-log" data-id="' + l.id + '">🗑 删除</button></td></tr>';
                }
                html += '</table>';
                container.innerHTML = html;
            } catch(e) {
                container.innerHTML = '<div style="text-align:center;padding:20px;color:#EF4444;">加载失败</div>';
            }
        };

        // 删除单条邮件记录
        window.deleteEmailLog = async function(logId) {
            if (!confirm('确定要删除这条邮件记录吗？')) return;
            try {
                var token = localStorage.getItem('token') || sessionStorage.getItem('token') || '';
                var res = await fetch('/api/admin/email-logs/' + logId, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                var data = await res.json();
                if (data.code === 200) {
                    showToast('删除成功', 'success');
                    loadEmailLogs();
                } else {
                    showToast(data.message || '删除失败', 'error');
                }
            } catch(e) {
                showToast('删除失败', 'error');
            }
        };

        // 清空N天前的邮件记录
        window.clearOldEmailLogs = async function() {
            var daysSelect = document.getElementById('email-log-clean-days');
            var days = daysSelect ? parseInt(daysSelect.value) : 30;
            if (!confirm('确定要清空 ' + days + ' 天前的所有邮件记录吗？')) return;
            try {
                var token = localStorage.getItem('token') || sessionStorage.getItem('token') || '';
                var res = await fetch('/api/admin/email-logs/old?days=' + days, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                var data = await res.json();
                if (data.code === 200) {
                    showToast('已删除 ' + days + ' 天前的邮件记录（共 ' + data.data.deleted + ' 条）', 'success');
                    loadEmailLogs();
                } else {
                    showToast(data.message || '清空失败', 'error');
                }
            } catch(e) {
                showToast('清空失败', 'error');
            }
        };

        // 清空所有邮件记录
        window.clearAllEmailLogs = async function() {
            if (!confirm('确定要清空所有邮件记录吗？此操作不可恢复！')) return;
            try {
                var token = localStorage.getItem('token') || sessionStorage.getItem('token') || '';
                var res = await fetch('/api/admin/email-logs/all', {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                var data = await res.json();
                if (data.code === 200) {
                    showToast('已清空所有邮件记录（共 ' + data.data.deleted + ' 条）', 'success');
                    loadEmailLogs();
                } else {
                    showToast(data.message || '清空失败', 'error');
                }
            } catch(e) {
                showToast('清空失败', 'error');
            }
        };

        // ===== 邮件群发功能 =====
        let emailRecipientType = 'all';

        // 加载邮件群发面板
        async function loadEmailPanel() {
            // 更新收件人数量
            updateEmailRecipientCount();
            // 加载发送历史
            loadEmailHistory();
        }

        // 更新收件人数量
        async function updateEmailRecipientCount() {
            try {
                const res = await authFetch('/api/admin/email/recipients?type=' + emailRecipientType);
                if (!res) return;
                const json = await res.json();
                if (json.code === 200) {
                    const countEl = document.getElementById('emailRecipientCount');
                    if (countEl) {
                        if (json.data.emailCount !== undefined) {
                            countEl.innerHTML = '共 <span class="count-number">' + json.data.count + '</span> 人（其中 <span class="count-number">' + json.data.emailCount + '</span> 人有邮箱）';
                        } else {
                            countEl.innerHTML = '预计发送：<span class="count-number">' + json.data.count + '</span> 人';
                        }
                    }
                }
            } catch (err) {
                console.error('获取收件人数量失败:', err);
            }
        }

        // 监听收件人类型切换（使用事件委托，确保面板动态渲染后也生效）
        document.getElementById('panel-email').addEventListener('change', function(e) {
            if (e.target && e.target.name === 'emailRecipient') {
                emailRecipientType = e.target.value;
                updateEmailRecipientCount();
            }
        });

        // 预览邮件
        window.previewEmail = function() {
            const subject = document.getElementById('emailSubject').value.trim();
            const content = document.getElementById('emailContent').value.trim();

            if (!subject || !content) {
                showToast('请填写标题和内容', 'warning');
                return;
            }

            // 创建预览弹窗
            const previewHtml = `
                <div id="email-preview-modal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;">
                    <div style="background:#fff;border-radius:20px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
                        <div style="padding:20px 24px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
                            <h3 style="margin:0;font-size:1.1rem;color:#333;">📧 邮件预览</h3>
                            <button data-admin-action="close-email-preview" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#999;">&times;</button>
                        </div>
                        <div style="padding:24px;">
                            <div style="background:linear-gradient(135deg,#FF9ABF 0%,#C084FC 50%,#93C5FD 100%);padding:24px;text-align:center;border-radius:16px 16px 0 0;">
                                <div style="font-size:36px;margin-bottom:8px;">💌</div>
                                <h2 style="color:#fff;margin:0;font-size:1.3rem;">${escapeHtml(subject)}</h2>
                                <div style="color:rgba(255,255,255,0.8);font-size:0.85rem;margin-top:8px;">来自 嘉二の墙墙 的一封信</div>
                            </div>
                            <div style="padding:20px;background:#FFFCFA;">
                                <p style="font-size:14px;color:#4A3F5C;line-height:1.8;margin:0 0 12px;">亲爱的同学：</p>
                                <div style="font-size:14px;color:#4A3F5C;line-height:1.8;white-space:pre-wrap;">${escapeHtml(content)}</div>
                                <p style="font-size:14px;color:#B8A9D4;margin:16px 0 0;"> 来自 嘉二の墙墙 的温馨提醒</p>
                            </div>
                            <div style="padding:16px;text-align:center;background:#F8F5FF;border-top:1px solid rgba(255,107,157,0.06);">
                                <div style="color:#B8A9D4;font-size:12px;">🪄 嘉二の墙墙 — 校园信息交流平台</div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', previewHtml);
        };

        // 发送邮件
        window.sendBatchEmail = async function() {
            const subject = document.getElementById('emailSubject').value.trim();
            const content = document.getElementById('emailContent').value.trim();
            const link = document.getElementById('emailLink').value.trim();

            if (!subject) {
                showToast('请填写邮件标题', 'warning');
                return;
            }
            if (!content) {
                showToast('请填写邮件内容', 'warning');
                return;
            }

            var typeLabels = {
                'all': '全部', 'active': '活跃', 'role_user': '普通用户',
                'role_reviewer': '审核员', 'role_radio_admin': '广播管理员',
                'role_admin': '管理员', 'role_super_admin': '超级管理员'
            };
            if (!confirm(`确定要向 ${typeLabels[emailRecipientType] || ''}用户发送邮件吗？`)) {
                return;
            }

            // 显示进度区域
            const progressSection = document.getElementById('emailProgressSection');
            const progressFill = document.getElementById('emailProgressFill');
            const progressStatus = document.getElementById('emailProgressStatus');
            const progressDetail = document.getElementById('emailProgressDetail');
            const progressLog = document.getElementById('emailProgressLog');

            progressSection.style.display = 'block';
            progressFill.style.width = '0%';
            progressStatus.textContent = '准备发送...';
            progressDetail.textContent = '已发送 0 / --';
            progressLog.innerHTML = '';

            // 禁用按钮
            const sendBtn = document.querySelector('.email-btn-send');
            sendBtn.disabled = true;
            sendBtn.textContent = '⏳ 发送中...';

            try {
                const res = await authFetch('/api/admin/email/send-batch', {
                    method: 'POST',
                    body: JSON.stringify({
                        subject,
                        content,
                        link: link || null,
                        recipientType: emailRecipientType
                    })
                });

                if (!res) return;
                const json = await res.json();

                if (json.code === 200) {
                    const data = json.data;
                    progressFill.style.width = '100%';
                    progressStatus.textContent = data.status === 'success' ? '✅ 发送完成' : (data.status === 'partial' ? '⚠️ 部分失败' : '❌ 发送失败');
                    progressDetail.textContent = `已发送 ${data.success} / ${data.total}，失败 ${data.fail}`;

                    // 添加日志
                    if (data.status === 'success') {
                        progressLog.innerHTML = '<div class="email-log-success">✅ 全部发送成功！</div>';
                    } else if (data.status === 'partial') {
                        progressLog.innerHTML = `<div class="email-log-success">✅ 成功 ${data.success} 封</div><div class="email-log-fail">❌ 失败 ${data.fail} 封</div>`;
                    } else {
                        progressLog.innerHTML = '<div class="email-log-fail">❌ 发送失败，请检查邮件配置</div>';
                    }

                    showToast(json.message, data.status === 'success' ? 'success' : 'warning');

                    // 清空表单
                    document.getElementById('emailSubject').value = '';
                    document.getElementById('emailContent').value = '';
                    document.getElementById('emailLink').value = '';

                    // 刷新历史
                    loadEmailHistory();
                } else {
                    showToast(json.message || '发送失败', 'error');
                    progressStatus.textContent = '❌ 发送失败';
                }
            } catch (err) {
                showToast('网络错误: ' + err.message, 'error');
                progressStatus.textContent = '❌ 网络错误';
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = ' 发送邮件';
            }
        };

        // 加载发送历史
        async function loadEmailHistory() {
            try {
                const res = await authFetch('/api/admin/email/history?page=1&limit=10');
                if (!res) return;
                const json = await res.json();

                const historyList = document.getElementById('emailHistoryList');
                if (!historyList) return;

                if (json.code === 200 && json.data && json.data.history && json.data.history.length > 0) {
                    historyList.innerHTML = json.data.history.map(h => {
                        const statusMap = {
                            'success': { text: '全部成功', cls: 'email-status-success' },
                            'partial': { text: '部分失败', cls: 'email-status-partial' },
                            'fail': { text: '发送失败', cls: 'email-status-fail' },
                            'sending': { text: '发送中', cls: 'email-status-partial' }
                        };
                        const statusInfo = statusMap[h.status] || { text: h.status, cls: '' };

                        return `
                            <div class="email-history-item">
                                <div class="email-history-info">
                                    <div class="email-history-title">${escapeHtml(h.subject)}</div>
                                    <div class="email-history-meta">
                                        ${h.admin_nickname || '管理员'} · ${formatTime(h.created_at)} ·
                                        成功 ${h.sent_count || 0} / 失败 ${h.fail_count || 0} / 总计 ${h.total_count}
                                    </div>
                                </div>
                                <span class="email-history-status ${statusInfo.cls}">${statusInfo.text}</span>
                            </div>
                        `;
                    }).join('');
                } else {
                    historyList.innerHTML = '<div class="admin-empty"><span class="empty-emoji">📭</span><span>暂无发送记录</span></div>';
                }
            } catch (err) {
                console.error('加载发送历史失败:', err);
            }
        }

        // ===== 微信测试 =====
        async function loadWechatTest() {
            var list = document.getElementById('wechatUserList');
            if (!list) return;
            try {
                var resp = await authFetch('/api/admin/wechat/users');
                if (!resp) {
                    list.innerHTML = '<p style="color:#888;font-size:14px;">请求失败</p>';
                    return;
                }
                var res;
                try { res = await resp.json(); } catch(jsonErr) {
                    list.innerHTML = '<p style="color:#e74c3c;font-size:14px;">JSON 解析失败: ' + escapeHtml(String(jsonErr.message)) + ' (HTTP ' + resp.status + ')</p>';
                    return;
                }
                if (res.code !== 200) {
                    list.innerHTML = '<p style="color:#e74c3c;font-size:14px;">加载失败: ' + escapeHtml(res.message || ('HTTP ' + resp.status)) + '</p>';
                    return;
                }
                if (!Array.isArray(res.data)) {
                    list.innerHTML = '<p style="color:#888;font-size:14px;">数据格式错误 (期望数组,实际 ' + typeof res.data + ')</p>';
                    return;
                }
                if (res.data.length === 0) {
                    list.innerHTML = '<div class="admin-empty"><span class="empty-emoji">📭</span><span>暂无用户绑定微信</span></div>';
                    return;
                }
                var html = '<div class="wechat-user-table-wrap"><table class="wechat-user-table"><thead><tr>' +
                    '<th>ID</th><th>昵称</th><th>角色</th><th>OpenID</th><th>绑定时间</th><th>操作</th>' +
                    '</tr></thead><tbody>';
                for (var i = 0; i < res.data.length; i++) {
                    var u = res.data[i];
                    var openidDisplay = u.openid || '-';
                    var boundAt = u.bound_at ? new Date(u.bound_at).toLocaleString('zh-CN') : '-';
                    html += '<tr>' +
                        '<td>' + u.id + '</td>' +
                        '<td><strong>' + escapeHtml(u.nickname || u.username) + '</strong></td>' +
                        '<td>' + escapeHtml(u.role || 'user') + '</td>' +
                        '<td><span class="openid-text">' + escapeHtml(openidDisplay) + '</span></td>' +
                        '<td style="font-size:12px;color:#888;">' + boundAt + '</td>' +
                        '<td>' +
                            (u.openid
                                ? '<button class="btn-test-msg" data-uid="' + u.id + '" data-openid="' + u.openid + '">✉️ 测试推送</button>'
                                : '<span style="color:#999;font-size:12px;">无法推送</span>'
                            ) +
                        '</td>' +
                        '</tr>';
                }
                html += '</tbody></table></div>';
                list.innerHTML = html;
                list.querySelectorAll('.btn-test-msg').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        testMessage(this);
                    });
                });
            } catch (e) {
                list.innerHTML = '<p style="color:#e74c3c;font-size:14px;">加载失败: ' + e.message + '</p>';
            }
        }

        async function testMessage(btn) {
            var openid = btn.dataset.openid;
            var uid = btn.dataset.uid;
            btn.disabled = true;
            btn.textContent = '⏳ 发送中...';

            // 移除旧的提示
            var oldResult = document.getElementById('wechatTestResult');
            if (oldResult) oldResult.remove();

            var resultDiv = document.createElement('div');
            resultDiv.id = 'wechatTestResult';
            resultDiv.className = 'wechat-test-result';
            document.getElementById('wechatUserList').after(resultDiv);

            try {
                var resp = await authFetch('/api/admin/wechat/test-message', {
                    method: 'POST',
                    body: JSON.stringify({ openid: openid, user_id: uid })
                });
                if (!resp) {
                    resultDiv.className = 'wechat-test-result error';
                    resultDiv.innerHTML = '❌ 请求失败';
                    btn.disabled = false;
                    btn.textContent = '✉️ 测试推送';
                    return;
                }
                var res = await resp.json();
                if (res.code === 200) {
                    resultDiv.className = 'wechat-test-result success';
                    resultDiv.innerHTML = '✅ 测试消息发送成功！openid: ' + openid;
                } else {
                    resultDiv.className = 'wechat-test-result error';
                    resultDiv.innerHTML = '❌ 发送失败: ' + (res.message || '未知错误');
                }
            } catch (e) {
                resultDiv.className = 'wechat-test-result error';
                resultDiv.innerHTML = '❌ 发送失败: ' + e.message;
            }

            btn.disabled = false;
            btn.textContent = '✉️ 测试推送';
        }

        // ===== 私信管理 =====
        async function loadAdminMessages() {
            document.getElementById('msg-conversation-list').style.display = 'block';
            document.getElementById('msg-detail-view').style.display = 'none';
            var tbody = document.getElementById('msg-conv-tbody');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="8"><div class="loading-text"><span class="loading-spinner"></span>加载中...</div></td></tr>';
            try {
                var resp = await authFetch('/api/admin/messages');
                if (!resp) return;
                var json = await resp.json();
                if (json.code !== 200) { tbody.innerHTML = '<tr><td colspan="8"><div class="admin-empty"><span class="empty-emoji">😢</span>加载失败</div></td></tr>'; return; }
                var convs = json.data.conversations;
                var messageCount = convs.reduce(function(total, conv) { return total + (Number(conv.total_msgs) || 0); }, 0);
                document.getElementById('msg-count').textContent = convs.length;
                document.getElementById('msg-message-count').textContent = messageCount;
                document.getElementById('msg-list-summary').textContent = '共 ' + convs.length + ' 个会话';
                if (!convs.length) { tbody.innerHTML = '<tr><td colspan="8"><div class="admin-empty"><span class="empty-emoji">💬</span>暂无私信记录</div></td></tr>'; return; }
                tbody.innerHTML = convs.map(function(c) {
                    var cleared = '';
                    if (c.user1_cleared_at) cleared += '<span class="cleared-badge">' + c.u1_name + ' 已清空</span> ';
                    if (c.user2_cleared_at) cleared += '<span class="cleared-badge">' + c.u2_name + ' 已清空</span> ';
                    if (!cleared) cleared = '<span style="color:#bbb;font-size:12px;">正常</span>';
                    return '<tr>' +
                        '<td>' + c.id + '</td>' +
                        '<td>' + escapeHtml(c.u1_name || c.u1_username) + '</td>' +
                        '<td>' + escapeHtml(c.u2_name || c.u2_username) + '</td>' +
                        '<td class="msg-last-message">' + escapeHtml(c.last_msg || '无') + '</td>' +
                        '<td>' + c.total_msgs + '</td>' +
                        '<td>' + c.deleted_msgs + '</td>' +
                        '<td>' + cleared + '</td>' +
                        '<td><div class="msg-row-actions"><button class="btn-xs secondary" data-admin-action="view-message-conversation" data-id="' + c.id + '">查看</button>' +
                        '<button class="btn-xs danger" data-admin-action="purge-message-conversation" data-id="' + c.id + '">清空</button></div></td>' +
                        '</tr>';
                }).join('');
            } catch(e) {
                tbody.innerHTML = '<tr><td colspan="8"><div class="admin-empty"><span class="empty-emoji">😢</span>加载失败: ' + escapeHtml(e.message) + '</div></td></tr>';
            }
        }

        async function viewMsgConversation(convId) {
            document.getElementById('msg-conversation-list').style.display = 'none';
            document.getElementById('msg-detail-view').style.display = 'block';
            var content = document.getElementById('msg-detail-content');
            content.innerHTML = '<div class="loading-text"><span class="loading-spinner"></span>加载中...</div>';
            try {
                var resp = await authFetch('/api/admin/messages/' + convId + '/messages');
                if (!resp) return;
                var json = await resp.json();
                if (json.code !== 200) { content.innerHTML = '<div class="admin-empty"><span class="empty-emoji">😢</span>加载失败</div>'; return; }
                var msgs = json.data.messages;
                var conv = json.data.conversation;
                if (!conv) { content.innerHTML = '<div class="admin-empty"><span class="empty-emoji">😢</span>会话不存在</div>'; return; }
                var html = '<div class="msg-thread-header"><div><span class="msg-thread-kicker">私信会话</span><strong>💬 ' + escapeHtml(conv.u1_name) + ' ↔ ' + escapeHtml(conv.u2_name) + '</strong></div><span class="msg-thread-count">共 ' + msgs.length + ' 条消息</span></div>';
                html += '<div class="msg-thread-meta">';
                if (conv.user1_cleared_at) html += ' &nbsp;|&nbsp; ' + escapeHtml(conv.u1_name) + ' 于 ' + new Date(conv.user1_cleared_at).toLocaleString() + ' 清空';
                if (conv.user2_cleared_at) html += ' &nbsp;|&nbsp; ' + escapeHtml(conv.u2_name) + ' 于 ' + new Date(conv.user2_cleared_at).toLocaleString() + ' 清空';
                html += '</div>';
                msgs.forEach(function(m) {
                    var isDeleted = !!m.deleted_at;
                    var deletedClass = isDeleted ? 'deleted-msg' : '';
                    html += '<div class="msg-item ' + deletedClass + '">';
                    html += '<div class="msg-message-meta">';
                    html += '<strong>' + escapeHtml(m.sender_name || m.sender_username || '用户' + m.sender_id) + '</strong>';
                    html += ' · ' + new Date(m.created_at).toLocaleString();
                    if (isDeleted) html += ' · <span style="color:#EF4444;">已软删除</span>';
                    if (m.is_read) html += ' · 已读';
                    html += '</div>';
                    html += '<div class="msg-message-main"><div class="msg-bubble-wrap"><div class="msg-bubble ' + (m.sender_id === m.conversation_id ? 'sent' : 'received') + '">' + escapeHtml(m.content) + '</div></div>';
                    html += '<div class="msg-delete-action"><button class="btn-xs danger" data-admin-action="perm-delete-message" data-id="' + m.id + '">永久删除</button></div></div>';
                    html += '</div>';
                });
                content.innerHTML = html;
            } catch(e) {
                content.innerHTML = '<div class="admin-empty"><span class="empty-emoji">😢</span>加载失败: ' + escapeHtml(e.message) + '</div>';
            }
        }

        function backToMsgList() {
            document.getElementById('msg-conversation-list').style.display = 'block';
            document.getElementById('msg-detail-view').style.display = 'none';
        }

        async function purgeMsgConversation(convId) {
            if (!confirm('确定永久删除该会话的所有消息吗？不可恢复！')) return;
            try {
                var resp = await authFetch('/api/admin/conversations/' + convId + '/purge', { method: 'POST' });
                if (!resp) return;
                var json = await resp.json();
                if (json.code === 200) { showToast('✅ 已清空', 'success'); loadAdminMessages(); }
                else showToast(json.message || '失败', 'error');
            } catch(e) { showToast('失败', 'error'); }
        }

        async function permDeleteMsg(msgId, btn) {
            if (!confirm('确定永久删除此消息？不可恢复！')) return;
            try {
                var resp = await authFetch('/api/admin/messages/' + msgId, { method: 'DELETE' });
                if (!resp) return;
                var json = await resp.json();
                if (json.code === 200) {
                    showToast('✅ 已永久删除', 'success');
                    if (btn) { var row = btn.closest('.msg-item'); if (row) row.classList.add('deleted-msg'); btn.disabled = true; btn.textContent = '已删除'; }
                } else showToast(resp.message || '失败', 'error');
            } catch(e) { showToast('失败', 'error'); }
        }

        // 确保 inline onclick 能访问到
        window.viewMsgConversation = viewMsgConversation;
        window.backToMsgList = backToMsgList;
        window.purgeMsgConversation = purgeMsgConversation;
        window.permDeleteMsg = permDeleteMsg;

        // ===== 初始化 =====
        if (checkAuth()) {
            // 根据角色决定默认显示面板
            const defaultPanel = ROLE_DEFAULT_PANELS[currentUser.role] || 'overview';

            // 优先使用上次停留的面板（页面停留记忆功能）
            let lastPanel = null;
            try {
                lastPanel = localStorage.getItem('admin_last_panel');
            } catch (e) {}

            // 检查上次的面板是否仍然有效（有权限访问）
            if (lastPanel) {
                const menuLink = document.querySelector(`.sidebar-link[data-panel="${lastPanel}"]`);
                if (menuLink && menuLink.dataset.superAdminOnly === 'true' && (!currentUser || currentUser.role !== 'super_admin')) {
                    lastPanel = null; // 推歌候选仅超级管理员可见
                } else if (menuLink && menuLink.dataset.permission && !hasPermission(menuLink.dataset.permission)) {
                    lastPanel = null; // 权限变更，回退到默认
                }
            }

            switchPanel(lastPanel || defaultPanel);
        }

        // ===== 管理后台登录 =====
        // 管理后台登录验证码
        var adminCaptchaKey = '';
        function loadAdminCaptcha() {
            fetch('/api/auth/captcha').then(function(r) { return r.json(); }).then(function(data) {
                if (data.code === 200) {
                    adminCaptchaKey = data.data.key;
                    var img = document.getElementById('adminCaptchaImg');
                    if (img) img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data.data.captcha)));
                }
            }).catch(function() {});
        }

        document.getElementById('adminLoginBtn').addEventListener('click', function() {
            const username = document.getElementById('adminUsername').value.trim();
            const password = document.getElementById('adminPassword').value;
            const remember = document.getElementById('adminRemember').checked;
            const errorDiv = document.getElementById('adminLoginError');
            errorDiv.classList.remove('show');

            if (!username || !password) {
                errorDiv.textContent = '💦 请输入用户名和密码呀~';
                errorDiv.classList.add('show');
                return;
            }

            this.disabled = true;
            this.classList.add('loading');

            var body = { username: username, password: password };
            var captchaGroup = document.getElementById('adminLoginCaptchaGroup');
            if (captchaGroup.classList.contains('show')) {
                body.captchaKey = adminCaptchaKey;
                body.captchaCode = document.getElementById('adminCaptchaCode').value.trim();
            }

            fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(function(r) { return r.json(); }).then(function(data) {
                var btn = document.getElementById('adminLoginBtn');
                btn.disabled = false;
                btn.classList.remove('loading');

                if (data.code === 200) {
                    const user = data.data && data.data.user;
                    if (!user || !STAFF_ROLES.includes(user.role)) {
                        errorDiv.textContent = '当前账号没有管理员权限，请使用管理员账号登录。';
                        errorDiv.classList.add('show');
                        return;
                    }

                    const storage = getStorage(remember);
                    storage.setItem('token', data.data.token);
                    storage.setItem('user', JSON.stringify(user));
                    showToast('登录成功！');
                    setTimeout(function() {
                        if (checkAuth()) {
                            const defaultPanel = ROLE_DEFAULT_PANELS[user.role] || 'overview';
                            let lastPanel = null;
                            try { lastPanel = localStorage.getItem('admin_last_panel'); } catch (e) {}
                            if (lastPanel) {
                                const menuLink = document.querySelector('.sidebar-link[data-panel="' + lastPanel + '"]');
                                if (menuLink && menuLink.dataset.superAdminOnly === 'true' && user.role !== 'super_admin') {
                                    lastPanel = null;
                                } else if (menuLink && menuLink.dataset.permission && !hasPermission(menuLink.dataset.permission)) {
                                    lastPanel = null;
                                }
                            }
                            switchPanel(lastPanel || defaultPanel);
                        }
                    }, 300);
                } else {
                    if (data.needCaptcha) {
                        document.getElementById('adminLoginCaptchaGroup').classList.add('show');
                        loadAdminCaptcha();
                    }
                    if (data.ban_reason) {
                        showBanNotice(data.ban_reason);
                    } else {
                        errorDiv.textContent = '😅 ' + (data.message || '登录失败');
                        errorDiv.classList.add('show');
                    }
                }
            }).catch(function() {
                var btn = document.getElementById('adminLoginBtn');
                btn.disabled = false;
                btn.classList.remove('loading');
                errorDiv.textContent = '😱 网络错误，稍后再试试~';
                errorDiv.classList.add('show');
            });
        });

        document.getElementById('adminPassword').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') document.getElementById('adminLoginBtn').click();
        });
        document.getElementById('adminUsername').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') document.getElementById('adminPassword').focus();
        });
        // 页面加载时检查是否需要验证码
        fetch('/api/auth/login-status').then(function(r) { return r.json(); }).then(function(d) {
            if (d.code === 200 && d.data.needCaptcha) {
                document.getElementById('adminLoginCaptchaGroup').classList.add('show');
                loadAdminCaptcha();
            }
        }).catch(function() {});

        // 封禁提示卡片
        window.showBanNotice = function(reason) {
            var existing = document.getElementById('ban-notice-overlay');
            if (existing) existing.remove();
            var overlay = document.createElement('div');
            overlay.id = 'ban-notice-overlay';
            overlay.className = 'admin-runtime-overlay admin-ban-overlay';
            overlay.innerHTML = '<div class="admin-ban-dialog" role="dialog" aria-modal="true" aria-labelledby="ban-notice-title">'
                + '<div class="admin-ban-dialog__icon" aria-hidden="true">🔒</div>'
                + '<h2 class="admin-ban-dialog__title" id="ban-notice-title">账号已被封禁</h2>'
                + '<div class="admin-ban-dialog__reason">'
                + '<div class="admin-ban-dialog__label">封禁原因</div>'
                + '<div class="admin-ban-dialog__value">' + reason.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>'
                + '</div>'
                + '<p class="admin-ban-dialog__hint">如有疑问，请联系管理员申诉</p>'
                + '<div class="admin-ban-dialog__contact">'
                + '<span>📧 2108474355@qq.com</span>'
                + '<button data-admin-action="copy-admin-email">📋复制</button>'
                + '</div>'
                + '<button class="admin-ban-dialog__close" data-admin-action="close-ban-notice">我知道了</button>'
                + '</div>';
            document.body.appendChild(overlay);
        };

        // ===== 积分运营面板（已迁移到独立页面 gamification.html）=====
        // 监听面板切换（在脚本末尾还有对stories的监听）
        // gamification 面板已迁移到独立页面 gamification.html

        // 管理后台统一事件委托：静态页面和运行时表格都只声明 data-admin-action。
        document.addEventListener('click', function (event) {
            var target = event.target && event.target.closest ? event.target.closest('[data-admin-action]') : null;
            if (!target) return;
            var action = target.getAttribute('data-admin-action');
            var id = Number(target.getAttribute('data-id'));
            var status = target.getAttribute('data-status');
            var modalId = target.getAttribute('data-modal-id');
            switch (action) {
                case 'admin-action': window.adminAction(status || target.getAttribute('data-action-name'), id); break;
                case 'admin-action-close-modal':
                    window.adminAction(target.getAttribute('data-action-name'), id);
                    if (window.closeModal) window.closeModal(modalId);
                    break;
                case 'batch-post': batchPostAction(status); break;
                case 'toggle-all-posts': if (target.tagName !== 'INPUT') toggleAllPosts(target.checked); break;
                case 'search-users': searchUsers(); break;
                case 'close-hot-edit-overlay': if (event.target === target) window.closeHotEditModal(); break;
                case 'close-hot-edit': window.closeHotEditModal(); break;
                case 'confirm-hot-edit': window.confirmHotEdit(); break;
                case 'search-songs': searchSongs(); break;
                case 'filter-songs': filterSongsBtn(target); break;
                case 'batch-song': batchSongAction(status); break;
                case 'add-song-reject-reason': addSongRejectReasonTemplate(); break;
                case 'open-add-daily-song': window.openAddDailySongModal(); break;
                case 'batch-ai-intros': window.batchAiGenerateIntros(); break;
                case 'load-daily-songs': window.loadDailySongs(1); break;
                case 'batch-clear-daily-songs': batchClearDailySongs(); break;
                case 'batch-toggle-daily-candidate': batchToggleDailySongCandidate(); break;
                case 'batch-delete-daily-songs': batchDeleteDailySongs(); break;
                case 'filter-daily-songs': filterDailySongs(target); break;
                case 'toggle-all-daily-songs': if (target.tagName !== 'INPUT') toggleAllDailySongs(target.checked); break;
                case 'switch-log-tab': window.switchLogTab(target.getAttribute('data-logtab')); break;
                case 'clean-old-logs': window.cleanOldLogs(); break;
                case 'clean-all-logs': window.cleanAllLogs(); break;
                case 'load-email-logs': window.loadEmailLogs(); break;
                case 'clear-old-email-logs': window.clearOldEmailLogs(); break;
                case 'clear-all-email-logs': window.clearAllEmailLogs(); break;
                case 'preview-email': window.previewEmail(); break;
                case 'send-batch-email': window.sendBatchEmail(); break;
                case 'create-novel': if (window.showCreateNovel) window.showCreateNovel(); break;
                case 'delete-current-novel': if (window.deleteCurrentNovel) window.deleteCurrentNovel(); break;
                case 'story-add-chapter': if (window.storyAddChapter) window.storyAddChapter(); break;
                case 'story-navigate': if (window.storyNavigate) window.storyNavigate(Number(target.getAttribute('data-step'))); break;
                case 'story-select': if (window.storySelect) window.storySelect(Number(target.getAttribute('data-index'))); break;
                case 'story-save': if (window.storySave) window.storySave(); break;
                case 'story-set-current': if (window.storySetCurrent) window.storySetCurrent(Number(target.getAttribute('data-index'))); break;
                case 'story-publish': if (window.storyPublishToWechat) window.storyPublishToWechat(Number(target.getAttribute('data-index'))); break;
                case 'story-delete': if (window.storyDelete) window.storyDelete(Number(target.getAttribute('data-index'))); break;
                case 'close-wechat-push-overlay': if (event.target === target) target.remove(); break;
                case 'close-wechat-push': var wechatPushModal = document.getElementById('wechat-push-modal'); if (wechatPushModal) wechatPushModal.remove(); break;
                case 'toggle-prompt-config': if (window.togglePromptConfig) window.togglePromptConfig(); break;
                case 'save-prompt-config': if (window.savePromptConfig) window.savePromptConfig(); break;
                case 'story-generate-ai': if (window.storyGenerateByAI) window.storyGenerateByAI(); break;
                case 'back-to-message-list': backToMsgList(); break;
                case 'empty-trash': emptyTrash(); break;
                case 'clear-old-postviews': window.clearOldPostViews(); break;
                case 'clear-all-postviews': window.clearAllPostViews(); break;
                case 'load-postviews': postviewsPage = 1; loadPostViews(); break;
                case 'refresh-deployment': window.loadDeploymentStatus(true); break;
                case 'refresh-release-notes': window.loadAdminReleaseNotes(true); break;
                case 'save-email-config': saveEmailConfig(); break;
                case 'test-email-send': testEmailSend(); break;
                case 'save-slot-form': if (window.saveSlotForm) window.saveSlotForm(); break;
                case 'close-viewer-profile-overlay': if (event.target === target) window.closeViewerProfile(); break;
                case 'close-viewer-profile': window.closeViewerProfile(); break;
                case 'close-ban-modal': window.closeBanModal(); break;
                case 'confirm-ban': window.confirmBan(); break;
                case 'create-new-title': window.createNewTitle(); break;
                case 'close-add-daily-song': window.closeAddDailySongModal(); break;
                case 'save-daily-song': window.saveDailySong(); break;
                case 'close-song-intro-editor': window.closeSongIntroEditor(); break;
                case 'search-song-info': window.searchSongInfoInEditor(); break;
                case 'ai-generate-intro': window.aiGenerateIntroInEditor(); break;
                case 'search-lyrics': window.searchLyricsInEditor(); break;
                case 'save-song-intro-editor': window.saveSongIntroFromEditor(); break;
                case 'close-modal-overlay': if (event.target === target && window.closeModal) window.closeModal(modalId); break;
                case 'close-modal': if (window.closeModal) window.closeModal(modalId); break;
                case 'open-image': window.open(target.getAttribute('data-url'), '_blank', 'noopener,noreferrer'); break;
                case 'open-song-approval': window.openSongApprovalModal(id); break;
                case 'open-song-reschedule': window.openSongRescheduleModal(id); break;
                case 'confirm-song-approval': window.confirmSongApproval(id); break;
                case 'confirm-song-reschedule': window.confirmSongReschedule(id); break;
                case 'lookup-ip': window.lookupIp(target.getAttribute('data-ip'), target); break;
                case 'ban-user': window.banUser(id, target.getAttribute('data-name') || ''); break;
                case 'login-as-user': window.loginAsUser(id, target.getAttribute('data-name') || ''); break;
                case 'reset-user-password': window.resetUserPassword(id, target.getAttribute('data-name') || ''); break;
                case 'delete-user': window.deleteUser(id, target.getAttribute('data-name') || ''); break;
                case 'user-title': window.showUserTitleModal(id, target.getAttribute('data-name') || ''); break;
                case 'toggle-song-checkbox': toggleSongCheckbox(id, event); break;
                case 'stop-propagation': event.stopPropagation(); break;
                case 'open-song-intro-editor': window.openSongIntroEditor(id); break;
                case 'delete-daily-song': window.deleteDailySong(id); break;
                case 'restore-song-trash': window.restoreSongFromTrash(id); break;
                case 'perm-delete-song': window.permDeleteSong(id); break;
                case 'view-song': window.viewSongDetail(id); break;
                case 'toggle-pin': window.togglePin(id, Number(target.getAttribute('data-pinned')) || 0); break;
                case 'edit-song-hot': window.editSongHot(id, Number(target.getAttribute('data-score')) || 0); break;
                case 'restore-song': window.restoreSong(id); break;
                case 'edit-slot': window.editSlot(id, target.getAttribute('data-name') || '', target.getAttribute('data-start') || '', target.getAttribute('data-end') || '', Number(target.getAttribute('data-active')) || 0, target.getAttribute('data-weekdays') || '', target.getAttribute('data-effective-start') || '', Number(target.getAttribute('data-max-songs')) || 10); break;
                case 'select-ban-reason': window.selectBanReason(target); break;
                case 'remove-user-title': window.removeUserTitle(Number(target.getAttribute('data-user-id')), Number(target.getAttribute('data-title-id'))); break;
                case 'add-user-title': window.addUserTitle(Number(target.getAttribute('data-user-id')), Number(target.getAttribute('data-title-id'))); break;
                case 'view-trash-post': window.viewTrashPost(id); break;
                case 'restore-post': window.restorePost(id); break;
                case 'permanent-delete-post': window.permanentDelete(id); break;
                case 'restore-post-close-modal': window.restorePost(id); if (window.closeModal) window.closeModal(modalId); break;
                case 'permanent-delete-post-close-modal': window.permanentDelete(id); if (window.closeModal) window.closeModal(modalId); break;
                case 'delete-log': window.deleteLog(id); break;
                case 'edit-notice': window.editNotice(id, target.getAttribute('data-title') || '', target); break;
                case 'viewer-profile': window.showViewerProfile(id); break;
                case 'open-post': window.open('/post/' + id, '_blank', 'noopener,noreferrer'); break;
                case 'view-feedback': window.viewFeedback(id); break;
                case 'close-feedback-overlay': if (event.target === target) window.closeFeedbackModal(); break;
                case 'close-feedback': window.closeFeedbackModal(); break;
                case 'submit-feedback-reply': window.submitFeedbackReply(id); break;
                case 'delete-email-log': window.deleteEmailLog(id); break;
                case 'close-email-preview': var emailPreview = document.getElementById('email-preview-modal'); if (emailPreview) emailPreview.remove(); break;
                case 'view-message-conversation': window.viewMsgConversation(id); break;
                case 'purge-message-conversation': window.purgeMsgConversation(id); break;
                case 'perm-delete-message': window.permDeleteMsg(id, target); break;
                case 'copy-admin-email':
                    navigator.clipboard.writeText('2108474355@qq.com').then(function () { target.textContent = '✓已复制'; setTimeout(function () { target.textContent = '📋复制'; }, 2000); });
                    break;
                case 'close-ban-notice': var banNotice = document.getElementById('ban-notice-overlay'); if (banNotice) banNotice.remove(); break;
                default: return;
            }
            if (target.tagName === 'BUTTON' || target.tagName === 'A') event.preventDefault();
        });

        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            var target = event.target && event.target.closest ? event.target.closest('[data-admin-action]') : null;
            if (!target) return;
            switch (target.getAttribute('data-admin-action')) {
                case 'search-users': searchUsers(); event.preventDefault(); break;
                case 'search-songs': searchSongs(); event.preventDefault(); break;
                case 'load-daily-songs': window.loadDailySongs(1); event.preventDefault(); break;
                default: break;
            }
        });

        document.addEventListener('change', function (event) {
            var target = event.target && event.target.closest ? event.target.closest('[data-admin-action]') : null;
            if (!target) return;
            switch (target.getAttribute('data-admin-action')) {
                case 'toggle-all-posts': toggleAllPosts(target.checked); break;
                case 'users-role-filter': changeUsersRoleFilter(target.value); break;
                case 'change-role': window.adminAction('changeRole', Number(target.getAttribute('data-id')), target.value); break;
                case 'users-page-size': changeUsersPageSize(target.value); break;
                case 'songs-page-size': changeSongsPageSize(target.value); break;
                case 'daily-songs-page-size': changeDailySongsPageSize(target.value); break;
                case 'toggle-all-daily-songs': toggleAllDailySongs(target.checked); break;
                case 'load-feedbacks': loadFeedbacks(); break;
                case 'switch-novel': if (window.switchNovel) window.switchNovel(target.value); break;
                case 'postviews-limit': postviewsPage = 1; loadPostViews(); break;
                case 'toggle-date-value': target.parentElement.classList.toggle('has-value', !!target.value); break;
                case 'update-post-batch': updatePostBatchBtn(); break;
                case 'update-daily-song-batch': updateDailySongBatchBtn(); break;
                case 'update-song-batch': updateSongBatchBtn(); break;
                default: break;
            }
        });

        document.addEventListener('input', function (event) {
            var target = event.target && event.target.closest ? event.target.closest('[data-admin-action="auto-save-settings"]') : null;
            if (target) autoSaveSettings();
            var storyContent = event.target && event.target.closest ? event.target.closest('[data-admin-action="story-auto-save"]') : null;
            if (storyContent && window.storyAutoSave) window.storyAutoSave();
        });

        document.addEventListener('submit', function (event) {
            var form = event.target && event.target.closest ? event.target.closest('form[data-admin-no-submit]') : null;
            if (form) event.preventDefault();
        });

    }

    })();

document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-action="reload-admin-captcha"]') : null;
    if (!target) return;
    if (typeof window.loadAdminCaptcha === 'function') window.loadAdminCaptcha();
    event.preventDefault();
});
