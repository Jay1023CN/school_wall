    // ===== 连载小说管理 =====
    var storiesData = { stories: [], currentIndex: 0, editingIndex: -1 };
    var currentNovelId = '';
    var novelsList = [];

    async function loadNovels() {
        try {
            var token = localStorage.getItem('token') || sessionStorage.getItem('token');
            var res = await fetch('/api/admin/novels', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var json = await res.json();
            if (json.code === 200) {
                novelsList = json.data.novels || [];
                currentNovelId = json.data.activeNovelId || '';
                renderNovelSelector();
                return novelsList;
            }
        } catch(e) {
            console.warn('加载小说列表失败:', e.message);
        }
        return [];
    }

    function renderNovelSelector() {
        var sel = document.getElementById('novel-selector');
        if (!sel) return;
        sel.innerHTML = '';
        novelsList.forEach(function(n) {
            var opt = document.createElement('option');
            opt.value = n.id;
            opt.textContent = n.title;
            if (n.id === currentNovelId) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    function switchNovel(novelId) {
        currentNovelId = novelId;
        localStorage.setItem('novelState', JSON.stringify({ novelId: novelId, chapterIndex: -1 }));
        // 切换小说后重新加载章节
        var loading = document.getElementById('stories-loading');
        if (loading) loading.style.display = 'block';
        document.getElementById('stories-chapter-list').innerHTML = '';
        loadStoriesForNovel(novelId);
    }

    async function loadStoriesForNovel(novelId) {
        try {
            var token = localStorage.getItem('token') || sessionStorage.getItem('token');
            var url = '/api/admin/stories';
            if (novelId) url += '?novelId=' + encodeURIComponent(novelId);
            var res = await fetch(url, {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var json = await res.json();
            var loading = document.getElementById('stories-loading');
            if (loading) loading.style.display = 'none';
            if (json.code === 200) {
                storiesData = json.data;
                renderChapterList();
                if (storiesData.stories.length > 0) {
                    // 优先恢复上次选中的章节
                    var savedState = localStorage.getItem('novelState');
                    var savedIdx = -1;
                    if (savedState) {
                        try {
                            var state = JSON.parse(savedState);
                            if (state.novelId === novelId && state.chapterIndex >= 0 && state.chapterIndex < storiesData.stories.length) {
                                savedIdx = state.chapterIndex;
                            }
                        } catch(e) {}
                    }
                    var idx = savedIdx >= 0 ? savedIdx : (storiesData.currentIndex >= 0 ? storiesData.currentIndex : 0);
                    storySelectForNovel(idx, novelId);
                }
                return storiesData;
            } else {
                showToast('加载小说失败: ' + (json.message || ''), 'error');
            }
        } catch(e) {
            var loading = document.getElementById('stories-loading');
            if (loading) loading.style.display = 'none';
            showToast('加载小说失败', 'error');
        }
    }

    function storySelectForNovel(index, novelId) {
        storySelect(index);
    }

    function showCreateNovel() {
        var title = prompt('请输入小说标题：');
        if (!title) return;
        var author = prompt('请输入作者（默认为嘉二校园墙编辑部）：') || '嘉二校园墙编辑部';
        var desc = prompt('请输入简介（可选）：') || '';
        createNovel(title, author, desc);
    }

    async function createNovel(title, author, desc) {
        try {
            var token = localStorage.getItem('token') || sessionStorage.getItem('token');
            var res = await fetch('/api/admin/novels/create', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ title: title, author: author, desc: desc })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ ' + (json.message || '创建成功'), 'success');
                await loadNovels();
                switchNovel(json.data.id);
            } else {
                showToast('创建失败: ' + (json.message || ''), 'error');
            }
        } catch(e) {
            showToast('创建失败: ' + e.message, 'error');
        }
    }

    async function deleteCurrentNovel() {
        if (novelsList.length <= 1) {
            showToast('至少保留一本小说', 'error');
            return;
        }
        if (!confirm('确定删除当前小说及其所有章节？此操作不可恢复！')) return;
        try {
            var token = localStorage.getItem('token') || sessionStorage.getItem('token');
            var res = await fetch('/api/admin/novels/delete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('已删除', 'success');
                await loadNovels();
                loadStoriesForNovel(currentNovelId);
            } else {
                showToast('删除失败: ' + (json.message || ''), 'error');
            }
        } catch(e) {
            showToast('删除失败: ' + e.message, 'error');
        }
    }

    async function loadStories() {
        // 先加载小说列表（会自动加载章节）
        await loadNovels();
        return loadStoriesForNovel(currentNovelId);
    }

    function renderChapterList() {
        var list = document.getElementById('stories-chapter-list');
        if (!storiesData.stories || storiesData.stories.length === 0) {
            list.innerHTML = '<div class="stories-empty"><div class="empty-icon">📭</div><div>暂无章节，点击"+ 新建"开始</div></div>';
            return;
        }
        var html = '';
        for (var i = 0; i < storiesData.stories.length; i++) {
            var s = storiesData.stories[i];
            var isActive = i === storiesData.editingIndex;
            var isCurrent = i === storiesData.currentIndex;
            html += '<div class="story-chapter-item' + (isActive ? ' active' : '') + '" data-admin-action="story-select" data-index="' + i + '">';
            html += '<div class="chap-num">' + (i + 1) + '</div>';
            html += '<div class="chap-title">' + (s.title || '无标题') + '</div>';
            if (isCurrent) html += '<div class="chap-current-badge">连载中</div>';
            if (s.published) html += '<div class="chap-current-badge" style="background:#43e97b;">已发布</div>';
            html += '</div>';
        }
        list.innerHTML = html;
    }

    function storySelect(index) {
        if (index < 0 || index >= storiesData.stories.length) return;
        storiesData.editingIndex = index;
        // 保存选中的章节
        try {
            var state = JSON.parse(localStorage.getItem('novelState') || '{}');
            state.chapterIndex = index;
            localStorage.setItem('novelState', JSON.stringify(state));
        } catch(e) {}
        var s = storiesData.stories[index];
        var body = document.getElementById('stories-editor-body');
        document.getElementById('stories-editor-title').textContent = '📝 编辑：第' + (index + 1) + '章 ' + (s.title || '');

        // 加载中占位
        body.innerHTML =
            '<div class="story-form-group">' +
                '<label>章节标题</label>' +
                '<input type="text" id="story-edit-title" value="' + escapeHtml(s.title || '') + '" placeholder="输入章节标题">' +
            '</div>' +
            '<div class="story-form-group">' +
                '<label>作者</label>' +
                '<input type="text" id="story-edit-author" value="' + escapeHtml(s.author || '嘉二校园墙编辑部') + '">' +
            '</div>' +
            '<div class="story-form-group">' +
                '<label>章节内容</label>' +
                '<textarea id="story-edit-content" placeholder="正在加载章节内容..." data-admin-action="story-auto-save">⏳ 加载中...</textarea>' +
                '<div class="char-count"><span id="story-char-count">加载中...</span><span id="story-auto-save-status" style="color:#bbb;font-size:12px;margin-left:8px;"></span></div>' +
            '</div>' +
            '<div class="story-actions">' +
                '<button class="story-btn story-btn-primary" data-admin-action="story-save">💾 保存修改</button>' +
                '<button class="story-btn story-btn-success" style="background:linear-gradient(135deg,#667eea,#764ba2);" data-admin-action="story-set-current" data-index="' + index + '">📌 设为当前连载</button>' +
                '<button class="story-btn story-btn-primary" style="background:linear-gradient(135deg,#43e97b,#38f9d7) !important;" data-admin-action="story-publish" data-index="' + index + '">📤 推送到公众号</button>' +
                '<button class="story-btn story-btn-danger" data-admin-action="story-delete" data-index="' + index + '">🗑 删除本章</button>' +
            '</div>';

        // 异步加载章节内容
        loadChapterContent(index);

        // 更新导航按钮
        document.getElementById('story-btn-prev').disabled = index <= 0;
        document.getElementById('story-btn-next').disabled = index >= storiesData.stories.length - 1;
    }

    async function loadChapterContent(index) {
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/chapter-content?index=' + index + '&novelId=' + encodeURIComponent(currentNovelId), {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var json = await res.json();
            if (json.code === 200) {
                var chapter = json.data;
                var ta = document.getElementById('story-edit-content');
                if (ta) {
                    ta.value = chapter.content || '';
                    var cc = document.getElementById('story-char-count');
                    if (cc) cc.textContent = (chapter.content || '').length + '字';
                }
                // 也更新 storiesData 中的缓存
                if (storiesData.stories[index]) {
                    storiesData.stories[index].content = chapter.content;
                }
            }
        } catch(e) {
            var ta = document.getElementById('story-edit-content');
            if (ta) ta.value = '加载内容失败，请重试';
        }
    }

    async function storySave() {
        var title = document.getElementById('story-edit-title').value.trim();
        var content = document.getElementById('story-edit-content').value;
        var author = document.getElementById('story-edit-author').value.trim();

        if (!title) { showToast('请输入章节标题', 'error'); return; }
        if (!content) { showToast('请输入章节内容', 'error'); return; }
        if (!author) author = '匿名';

        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");

            if (storiesData.editingIndex < 0) {
                // 没有选中章节 → 创建新章节
                var addRes = await fetch('/api/admin/stories/add', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ title: title, content: content, author: author, novelId: currentNovelId })
                });
                var addJson = await addRes.json();
                if (addJson.code === 200) {
                    await loadStories();
                    showToast('✅ 章节已创建并保存', 'success');
                    storySelect(storiesData.stories.length - 1);
                } else {
                    showToast('创建失败: ' + addJson.message, 'error');
                }
            } else {
                // 编辑已有章节
                var res = await fetch('/api/admin/stories/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ index: storiesData.editingIndex, title: title, content: content, author: author, novelId: currentNovelId })
                });
                var json = await res.json();
                if (json.code === 200) {
                    showToast('✅ 第' + (storiesData.editingIndex + 1) + '章保存成功', 'success');
                    storiesData.stories[storiesData.editingIndex] = { file: storiesData.stories[storiesData.editingIndex].file, title: title, content: content, author: author };
                    renderChapterList();
                } else {
                    showToast('保存失败: ' + json.message, 'error');
                }
            }
        } catch(e) {
            showToast('保存失败', 'error');
        }
    }

    var storyAutoSaveTimer = null;
    function storyAutoSave() {
        var textarea = document.getElementById('story-edit-content');
        var statusEl = document.getElementById('story-auto-save-status');
        document.getElementById('story-char-count').textContent = textarea.value.length + '字';
        if (statusEl) statusEl.textContent = '⏳ 自动保存...';
        if (storyAutoSaveTimer) clearTimeout(storyAutoSaveTimer);
        storyAutoSaveTimer = setTimeout(function() {
            var title = document.getElementById('story-edit-title').value.trim();
            if (!title || !textarea.value) {
                if (statusEl) statusEl.textContent = '';
                return;
            }
            storySaveSilent(title, textarea.value);
        }, 2000);
    }

    async function storySaveSilent(title, content) {
        if (storiesData.editingIndex < 0) return;
        var author = document.getElementById('story-edit-author').value.trim();
        var statusEl = document.getElementById('story-auto-save-status');
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ index: storiesData.editingIndex, title: title, content: content, author: author, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                storiesData.stories[storiesData.editingIndex] = { file: storiesData.stories[storiesData.editingIndex].file, title: title, content: content, author: author };
                renderChapterList();
                if (statusEl) statusEl.textContent = '✅ 已自动保存';
                setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 3000);
            } else {
                if (statusEl) statusEl.textContent = '❌ 保存失败';
            }
        } catch(e) {
            if (statusEl) statusEl.textContent = '❌ 保存失败';
        }
    }

    async function storyAddChapter() {
        // 先检查是否已登录
        var token = localStorage.getItem("token") || sessionStorage.getItem("token");
        if (!token) {
            showToast('请先登录', 'error');
            return;
        }
        var defaultTitle = '第' + (storiesData.stories.length + 1) + '章';
        var title = prompt('请输入新章节名称：', defaultTitle);
        if (!title) return;
        try {
            var res = await fetch('/api/admin/stories/add', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ title: title, content: '', author: '嘉二校园墙编辑部', novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ 已添加新章节', 'success');
                await loadStories();
                storySelect(json.data.index);
            } else {
                showToast('添加失败: ' + json.message, 'error');
            }
        } catch(e) {
            showToast('添加失败: ' + e.message, 'error');
        }
    }

    async function storyDelete(index) {
        if (!confirm('确定删除第' + (index + 1) + '章？')) return;
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/delete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ index: index, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ 已删除', 'success');
                storiesData.stories = json.data.stories;
                storiesData.currentIndex = json.data.currentIndex;
                storiesData.editingIndex = -1;
                renderChapterList();
                document.getElementById('stories-editor-body').innerHTML = '<div class="stories-empty"><div class="empty-icon">👈</div><div>点击左侧章节进行编辑</div></div>';
                document.getElementById('stories-editor-title').textContent = '📝 请选择一个章节';
                document.getElementById('story-btn-prev').disabled = true;
                document.getElementById('story-btn-next').disabled = true;
            } else {
                showToast('删除失败', 'error');
            }
        } catch(e) {
            showToast('删除失败', 'error');
        }
    }

    async function storySetCurrent(index) {
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/set-current', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ index: index, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ ' + json.message, 'success');
                storiesData.currentIndex = index;
                renderChapterList();
            } else {
                showToast('设置失败', 'error');
            }
        } catch(e) {
            showToast('设置失败', 'error');
        }
    }

    function storyNavigate(direction) {
        var newIndex = storiesData.editingIndex + direction;
        if (newIndex >= 0 && newIndex < storiesData.stories.length) {
            storySelect(newIndex);
        }
    }

    // 键盘快捷键
    document.addEventListener('keydown', function(e) {
        if (window.currentPanel !== 'stories') return;
        if (storiesData.editingIndex < 0) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); storySave(); return; }
            return;
        }
        if (e.key === 'ArrowLeft') { e.preventDefault(); storyNavigate(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); storyNavigate(1); }
        else if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); storySave(); }
    });

    async function storyGeneratePrompt() {
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/next-prompt?novelId=' + encodeURIComponent(currentNovelId), {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var json = await res.json();
            if (json.code === 200) {
                document.getElementById('stories-prompt-text').value = json.data.prompt;
                showToast('✅ 提示词已生成，可复制到 DeepSeek', 'success');
            } else {
                showToast('生成失败', 'error');
            }
        } catch(e) {
            showToast('生成失败', 'error');
        }
    }

    function copyPrompt() {
        var ta = document.getElementById('stories-prompt-text');
        if (!ta.value) { showToast('请先生成提示词', 'error'); return; }
        ta.select();
        document.execCommand('copy');
        showToast('📋 已复制到剪贴板', 'success');
    }

    async function storyPublishToWechat(index) {
        if (index === undefined) index = storiesData.editingIndex;
        if (index < 0) { showToast('请先选择一个章节', 'error'); return; }
        if (!confirm('确定将第' + (index + 1) + '章推送到公众号草稿箱？')) return;
        try {
            showToast('⏳ 正在生成文章并同步到公众号...', 'info');
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/publish-to-wechat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ chapterIndex: index, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ 已成功同步到公众号草稿箱！', 'success');
                renderChapterList();
                setTimeout(function() {
                    // 用 modal 显示跳转链接
                    var modalHtml = '<div class="modal-overlay show" id="wechat-push-modal" data-admin-action="close-wechat-push-overlay">' +
                        '<div class="modal" style="display:flex;max-width:420px;">' +
                        '<div class="modal-header"><h3>✅ 推送成功</h3>' +
                        '<button class="modal-close" data-admin-action="close-wechat-push">&times;</button></div>' +
                        '<div class="modal-body" style="text-align:center;padding:32px 24px;">' +
                        '<div style="font-size:48px;margin-bottom:16px;">🎉</div>' +
                        '<div style="font-size:16px;font-weight:600;margin-bottom:8px;color:var(--text-primary);">第' + (index + 1) + '章已同步到公众号</div>' +
                        '<div style="font-size:13px;color:var(--text-light);margin-bottom:20px;">media_id: ' + (json.data && json.data.media_id || '-') + '</div>' +
                        '<a href="https://mp.weixin.qq.com/" target="_blank" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#07C160,#06AD56);color:#fff;border-radius:12px;text-decoration:none;font-weight:600;font-size:15px;">📤 前往公众号草稿箱</a>' +
                        '<div style="font-size:12px;color:#999;margin-top:12px;">登录后 → 草稿箱 → 预览/发布</div>' +
                        '</div></div></div>';
                    document.body.insertAdjacentHTML('beforeend', modalHtml);
                }, 1000);
            } else {
                showToast('❌ 推送失败: ' + json.message, 'error');
            }
        } catch(e) {
            showToast('❌ 网络错误: ' + e.message, 'error');
        }
    }

    // 点击小说面板时加载配置
    document.addEventListener('panelChange', function(e) {
        if (e.detail && e.detail.panel === 'stories') {
            loadStories().then(function() { loadPromptConfig(); });
        }
    });

    // ===== 提示词模板设置 =====
    function loadPromptConfig() {
        var cfg = storiesData.promptConfig;
        if (!cfg) return;
        var fields = ['novelTitle','authorRole','wordCount','style','sceneRequirement','endingRequirement','extraRequirements'];
        fields.forEach(function(f) {
            var el = document.getElementById('pc-' + f);
            if (el && cfg[f] !== undefined) el.value = cfg[f];
        });
    }

    function togglePromptConfig() {
        var body = document.getElementById('prompt-config-body');
        var arrow = document.getElementById('prompt-config-arrow');
        if (body.style.display === 'none') {
            body.style.display = 'block';
            arrow.style.transform = 'rotate(90deg)';
        } else {
            body.style.display = 'none';
            arrow.style.transform = '';
        }
    }

    async function savePromptConfig() {
        var fields = ['novelTitle','authorRole','wordCount','style','sceneRequirement','endingRequirement','extraRequirements'];
        var cfg = {};
        fields.forEach(function(f) {
            var el = document.getElementById('pc-' + f);
            if (el) cfg[f] = el.value;
        });
        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            var res = await fetch('/api/admin/stories/save-prompt-config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ promptConfig: cfg, novelId: currentNovelId })
            });
            var json = await res.json();
            if (json.code === 200) {
                showToast('✅ AI 写作设置已保存', 'success');
                storiesData.promptConfig = cfg;
            } else {
                showToast('保存失败: ' + json.message, 'error');
            }
        } catch(e) {
            showToast('保存失败', 'error');
        }
    }

    // AI 自动生成章节（流式输出）
    var storyStreamController = null;
    async function storyGenerateByAI() {
        var btn = document.getElementById('storyGenBtn');
        var loading = document.getElementById('storyGenLoading');
        var ta = document.getElementById('stories-prompt-text');
        btn.disabled = true;
        btn.textContent = '⏳ 连接 AI 中...';
        loading.style.display = 'block';
        loading.innerHTML = '⏳ 正在连接 AI 服务...';
        ta.value = '';
        ta.style.display = 'none';

        try {
            var token = localStorage.getItem("token") || sessionStorage.getItem("token");
            btn.textContent = '⏳ 生成中...';
            loading.innerHTML = '🤖 AI 正在创作...<br><span id="streamContent" style="font-size:13px;color:var(--text-primary);display:block;margin-top:8px;text-align:left;background:rgba(255,255,255,0.5);padding:8px 12px;border-radius:6px;max-height:200px;overflow-y:auto;white-space:pre-wrap;"></span>';

            var streamDiv = document.getElementById('streamContent');
            var fullText = '';
            var doneMeta = null;
            var url = '/api/admin/stories/generate-chapter-stream?novelId=' + encodeURIComponent(currentNovelId);

            // 用 fetch 读取 SSE 流
            storyStreamController = new AbortController();
            var res = await fetch(url, {
                signal: storyStreamController.signal,
                headers: { 'Authorization': 'Bearer ' + token }
            });
            if (!res.ok) {
                loading.style.display = 'none';
                ta.style.display = '';
                showToast('❌ 服务器错误', 'error');
                return;
            }

            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            var currentEvent = '';

            while (true) {
                var result = await reader.read();
                if (result.done) break;

                buffer += decoder.decode(result.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (var li = 0; li < lines.length; li++) {
                    var line = lines[li];
                    if (line.startsWith('event: ')) {
                        currentEvent = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        var content = line.substring(6);
                        if (currentEvent === 'done') {
                            try { doneMeta = JSON.parse(content); } catch(e) {}
                            currentEvent = '';
                        } else if (currentEvent === 'error') {
                            showToast('❌ 生成失败: ' + content, 'error');
                            currentEvent = '';
                        } else if (content !== '__DONE__') {
                            var text = content.replace(/\\n/g, '\n');
                            fullText += text;
                            if (streamDiv) {
                                streamDiv.textContent = fullText;
                                streamDiv.scrollTop = streamDiv.scrollHeight;
                            }
                        }
                        currentEvent = '';
                    }
                }
            }

            // 解析标题（优先用 done 事件的元数据，否则从第一行提取）
            var aiTitle = '';
            var aiContent = fullText;

            if (doneMeta && doneMeta.title) {
                aiTitle = doneMeta.title;
                aiContent = doneMeta.content || fullText;
            } else {
                var contentLines = fullText.split('\n');
                if (contentLines.length > 0) {
                    var firstLine = contentLines[0].replace(/^#+\s*/, '').replace(/^第\d+章[：\s]*/, '').trim();
                    if (firstLine.length > 0 && firstLine.length < 30) {
                        aiTitle = firstLine;
                        aiContent = contentLines.slice(1).join('\n').trim();
                    }
                }
                if (!aiTitle) aiTitle = '第 ' + (parseInt(currentNovelChapterIndex || 0) + 1) + ' 章';
            }

            // 加载到编辑器
            loading.style.display = 'none';
            ta.style.display = '';
            ta.value = fullText;

            var titleInput = document.getElementById('story-edit-title');
            var contentInput = document.getElementById('story-edit-content');
            var authorInput = document.getElementById('story-edit-author');
            if (titleInput) titleInput.value = aiTitle;
            if (contentInput) contentInput.value = aiContent;
            if (authorInput) authorInput.value = 'AI 辅助创作';
            updateCharCount();
            showToast('✨ AI 生成完成，请确认后手动保存', 'success');

            // 切换到编辑面板
            var panelBtns = document.querySelectorAll('#panel-stories .tabs-header button');
            for (var pi = 0; pi < panelBtns.length; pi++) {
                if (panelBtns[pi].textContent.includes('编辑')) {
                    panelBtns[pi].click(); break;
                }
            }
        } catch(e) {
            if (e.name === 'AbortError') {
                showToast('已取消生成', 'info');
            } else {
                loading.style.display = 'none';
                ta.style.display = '';
                var errMsg = '❌ 生成失败: ' + e.message;
                ta.value = errMsg;
                showToast(errMsg, 'error');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = '✨ AI 生成章节';
            storyStreamController = null;
        }
    }
