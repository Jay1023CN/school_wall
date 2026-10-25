// 首页自绘图标；SVG 内容来自本地受控符号表。
function renderHomeIcon(name) {
  return '<svg class="home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="/images/home-icons.svg?v=2026102501#' + name + '"></use></svg>';
}


function renderBookmarkIcon(active) {
  return '<svg class="ui-action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h10a2 2 0 0 1 2 2v16l-7-4-7 4V5a2 2 0 0 1 2-2Z"' + (active ? ' fill="currentColor"' : '') + '></path><path d="M9 7h6"></path></svg>';
}

var emptyStateEl = null;
var currentPage = 1;
var currentCategory = '全部';
var currentSort = 'latest';
var currentKeyword = '';
var isLoading = false;
var isLiking = false;
var emptyStateEl = null;
var skeletonShown = false;
var pageInitialized = false;
var totalLoaded = 0;
var hasMore = true;
var HOME_PAGE_SIZE = 10;
var loadMoreObserver = null;
var loadMoreWrapperEl = null;
var latestFeedRequestId = 0;

function getFeedPayload(data) {
  return data && data.data && typeof data.data === 'object' ? data.data : {};
}

function hasUsableTotal(total) {
  if (typeof total === 'number') return isFinite(total) && total >= 0;
  return typeof total === 'string' && total.trim() !== '' && isFinite(Number(total)) && Number(total) >= 0;
}

function resolveHasMore(payload, loadedCount) {
  if (typeof payload.has_more === 'boolean') return payload.has_more;
  if (typeof payload.hasMore === 'boolean') return payload.hasMore;
  if (hasUsableTotal(payload.total)) return totalLoaded < Number(payload.total);
  return loadedCount >= HOME_PAGE_SIZE;
}

function rearmLoadMoreObserver() {
  if (!loadMoreObserver || !loadMoreWrapperEl) return;
  loadMoreObserver.unobserve(loadMoreWrapperEl);
  loadMoreObserver.observe(loadMoreWrapperEl);
}

function checkHomeLoadMore() {
  if (!pageInitialized || isLoading || !hasMore || !loadMoreWrapperEl) return;
  var rect = loadMoreWrapperEl.getBoundingClientRect();
  if (rect.top <= window.innerHeight + 320) loadPosts(true);
}

function showSkeleton(count) {
  var postListEl = document.getElementById('postList');
  if (!postListEl) return;
  
  postListEl.innerHTML = '<div class="feed-state feed-state-loading" role="status" aria-live="polite">' +
    '<div class="feed-state-icon" aria-hidden="true">⏳</div>' +
    '<div>加载中...</div>' +
  '</div>';
  skeletonShown = true;
}

function hideSkeleton() {
  skeletonShown = false;
}


function recordPostView(postId) {
  var key = 'viewed_' + postId;
  var lastView = localStorage.getItem(key);
  var now = Date.now();

  if (lastView && (now - parseInt(lastView)) < 60000) {
    return;
  }

  localStorage.setItem(key, now);
  fetch('/api/posts/' + postId + '/view', {
    method: 'POST',
    credentials: 'include'
  }).catch(function() {});
}

var viewObserver = null;
function initViewObserver() {
  if (viewObserver) {
    viewObserver.disconnect();
  }

  viewObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var postCard = entry.target.closest('.post-card[data-id]');
        if (postCard) {
          var postId = postCard.dataset.id;
          if (postId) {
            recordPostView(postId);
            viewObserver.unobserve(entry.target);
          }
        }
      }
    });
  }, {
    threshold: 0.5,
    rootMargin: '0px 0px -50px 0px'
  });

  document.querySelectorAll('.post-card[data-id]').forEach(function(card) {
    viewObserver.observe(card);
  });
}

window.addEventListener('scroll', function() {
  if (viewObserver) {
    document.querySelectorAll('.post-card[data-id]:not([data-view-observed])').forEach(function(card) {
      card.setAttribute('data-view-observed', 'true');
      viewObserver.observe(card);
    });
  }
}, { passive: true });

async function loadPosts(append) {
  if (!hasMore) return false;

  if (append && isLoading) return false;

  var requestId = ++latestFeedRequestId;
  isLoading = true;

  var postListEl = document.getElementById('postList');
  var loadMoreWrapper = document.querySelector('.load-more-wrapper');
  var loadMoreBtn = document.getElementById('loadMoreBtn');

  if (!append && !skeletonShown && postListEl) showSkeleton(1);

  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = '加载中...';
  }

  try {
    var url = '/api/posts?limit=10&offset=' + totalLoaded + '&category=' + encodeURIComponent(currentCategory) + '&sort=' + currentSort;
    if (currentKeyword) url += '&keyword=' + encodeURIComponent(currentKeyword);
    var data = await authFetch(url);

    if (requestId !== latestFeedRequestId) return false;

    isLoading = false;
    hideSkeleton();

    if (data && data.code === 200) {
      var payload = getFeedPayload(data);
      var posts = Array.isArray(payload.posts) ? payload.posts : [];

      if (posts.length === 0) {
        if (postListEl) {
          if (!append) postListEl.innerHTML = '';
        }
        if (!append && emptyStateEl) emptyStateEl.style.display = 'block';
        hasMore = false;
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        return true;
      }

      if (emptyStateEl) emptyStateEl.style.display = 'none';

      posts.forEach(function(post) {
        if (typeof post.images === 'string') {
          try { post._cachedImages = JSON.parse(post.images); } catch(e) { post._cachedImages = []; }
        } else {
          post._cachedImages = post.images || [];
        }
        post._cachedImagesJson = JSON.stringify(post._cachedImages).replace(/"/g, '&quot;');
      });

      var html = '';
      posts.forEach(function(post) {
        html += renderPostCard(post);
      });
      
      if (postListEl) {
        if (append) {
          postListEl.insertAdjacentHTML('beforeend', html);
        } else {
          postListEl.innerHTML = html;
        }
      }

      totalLoaded += posts.length;

      initViewObserver();

      hasMore = resolveHasMore(payload, posts.length);

      if (loadMoreWrapper) {
        loadMoreWrapper.style.display = 'block';
        if (loadMoreBtn) loadMoreBtn.style.display = hasMore ? 'block' : 'none';
      }
      rearmLoadMoreObserver();
      window.setTimeout(checkHomeLoadMore, 0);
      return true;
    } else {
      var errorMessage = data && data.message ? data.message : '加载失败';
      if (!append) {
        hasMore = false;
        if (postListEl) renderFeedError(errorMessage || '帖子暂时无法加载');
      } else {
        hasMore = false;
      }
      showToast(errorMessage, 'error');
      if (loadMoreBtn) {
        loadMoreBtn.textContent = '加载失败,点击重试';
        loadMoreBtn.disabled = false;
      }
      return false;
    }
  } catch (err) {
    if (requestId !== latestFeedRequestId) return false;
    console.error('加载帖子失败:', err);
    if (append && totalLoaded > 0) {
      hasMore = false;
      setTimeout(function() {
        hasMore = true;
        loadPosts(true);
      }, 2000);
    } else {
      if (!append && postListEl) renderFeedError('网络不稳定，请稍后重试');
      if (typeof showToast === 'function') showToast('网络不稳定,请稍后重试', 'error');
    }
    if (loadMoreBtn) {
      loadMoreBtn.textContent = '加载失败,点击重试';
      loadMoreBtn.disabled = false;
    }
    return false;
  } finally {
    if (requestId !== latestFeedRequestId) return;
    isLoading = false;
    hideSkeleton();
    if (loadMoreBtn && hasMore) {
      loadMoreBtn.textContent = '加载更多';
      loadMoreBtn.disabled = false;
    }
  }
}

function renderFeedError(message) {
  var postListEl = document.getElementById('postList');
  if (!postListEl) return;
  var loadMoreWrapper = document.querySelector('.load-more-wrapper');
  if (loadMoreWrapper) loadMoreWrapper.style.display = 'block';
  postListEl.innerHTML = '<div class="feed-state feed-state-error" role="alert">' +
    '<div class="feed-state-icon" aria-hidden="true">⚠️</div>' +
    '<div class="feed-state-title">' + escapeHtml(message || '帖子暂时无法加载') + '</div>' +
    '<button type="button" class="feed-state-retry" onclick="window.retryPostFeed()">重新加载</button>' +
  '</div>';
}

window.retryPostFeed = function() {
  totalLoaded = 0;
  hasMore = true;
  if (emptyStateEl) emptyStateEl.style.display = 'none';
  loadPosts(false);
};

function getRoleBadge(role) {
  if (!role || role === 'user') return '';
  
  var roleMap = {
    'super_admin': { text: '👑 超级管理员', class: 'role-badge role-super-admin' },
    'admin': { text: '🛡️ 管理员', class: 'role-badge role-admin' },
    'reviewer': { text: '✅ 审核员', class: 'role-badge role-reviewer' },
    'radio_admin': { text: '📻 广播管理员', class: 'role-badge role-radio-admin' }
  };
  
  var roleInfo = roleMap[role];
  if (!roleInfo) return '';
  
  return '<span class="' + roleInfo.class + '">' + roleInfo.text + '</span>';
}

function getUserTitlesHtml(titles) {
  if (!titles || titles.length === 0) return '';
  
  return titles.map(function(t) {
    var safeColor = t.title_color || '#FF6B9D';
    var safeBg = t.title_bg || 'rgba(255,107,157,0.1)';
    var safeIcon = t.icon || '⭐';
    var safeName = escapeHtml(t.title_name);
    return '<span class="title-badge" style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.7rem;font-weight:600;background:' + safeBg + ';color:' + safeColor + ';margin-right:4px;white-space:nowrap;">' + safeIcon + ' ' + safeName + '</span>';
  }).join('');
}

function renderPostCard(post) {
  var images = post._cachedImages || (post.images || []);
  if (typeof images === 'string') {
    try {
      images = JSON.parse(images);
    } catch (e) {
      images = [];
    }
    post._cachedImages = images;
  }

  var authorName = post.is_anonymous ? '匿名用户' : (post.author_name || '未知用户');
  var authorAvatar = post.is_anonymous ? '/uploads/avatars/default.png' : (post.author_avatar || '/uploads/avatars/default.png');

  var roleBadge = post.is_anonymous ? '' : getRoleBadge(post.author_role);

  var titleBadges = post.is_anonymous ? '' : getUserTitlesHtml(post.author_titles);

  var imageHtml = '';
  if (images.length > 0) {
    var displayImages = images.slice(0, 3);
    var imageCount = displayImages.length;
    var gridClass = 'image-count-' + (imageCount <= 3 ? imageCount : 'many');
    imageHtml = '<div class="post-images ' + gridClass + '">';
    displayImages.forEach(function(img) {
      imageHtml += '<div class="post-image-wrapper" onclick="event.stopPropagation();previewImage(\'' + escapeHtml(img).replace(/'/g, "\\'") + '\', ' + post._cachedImagesJson + ', 0)">' +
        '<img class="post-image" src="' + escapeHtml(img) + '" loading="lazy" decoding="async" fetchpriority="low">' +
      '</div>';
    });
    if (images.length > 3) {
      imageHtml += '<div class="post-image-more" onclick="event.stopPropagation();previewImage(\'' + escapeHtml(images[0]).replace(/'/g, "\\'") + '\', ' + post._cachedImagesJson + ', 0)">+' + (images.length - 3) + '</div>';
    }
    imageHtml += '</div>';
  }
  var videoHtml = '';
  if (post.video_url && /^\/uploads\/videos\/video_[A-Za-z0-9_-]+\.(?:mp4|webm|ogv)$/i.test(post.video_url)) {
    var posterAttr = post.video_poster && /^\/uploads\/posts\/post_[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(post.video_poster)
      ? ' poster="' + escapeHtml(post.video_poster) + '"'
      : '';
    videoHtml = '<div class="post-video-wrap" onclick="event.stopPropagation()"><video class="post-video" controls preload="metadata" playsinline' + posterAttr + ' src="' + escapeHtml(post.video_url) + '"></video></div>';
  }

  var pollPreviewHtml = '';
  if (post.poll_type) {
    var pollLabel = post.poll_type === 'multiple' ? '多选' : '单选';
    pollPreviewHtml = '<div class="profile-poll-preview">📊 投票 <span class="profile-poll-label">' + pollLabel + '</span></div>';
  }

  var safePostId = post.id || 0;
  var likesCount = Number(post.likes_count) || 0;
  var commentsCount = Number(post.comments_count) || 0;
  var viewsCount = Number(post.views) || 0;
  var cachedLikeStatus = getCachedLikeStatus(safePostId);
  var isLiked = cachedLikeStatus !== null ? cachedLikeStatus : (post.is_liked || false);

  var commentsPreviewHtml = '';
  if (post.preview_comments && post.preview_comments.length > 0) {
    var commentItems = [];
    post.preview_comments.forEach(function(comment) {
      var cAuthor = comment.is_anonymous ? '匿名用户' : (comment.author_name || '未知用户');
      var cRole = comment.is_anonymous ? '' : getRoleBadge(comment.author_role);
      var cTitles = comment.is_anonymous ? '' : getUserTitlesHtml(comment.author_titles);
      var cClass = !comment.is_anonymous && comment.author_id ? ' user-card-trigger' : '';
      var cAttr = !comment.is_anonymous && comment.author_id ? ' data-user-id="' + comment.author_id + '" style="cursor:pointer;"' : '';
      commentItems.push('<div class="comment-preview-item"><span class="comment-preview-author' + cClass + '"' + cAttr + '>' + escapeHtml(cAuthor) + cRole + cTitles + '</span><span class="comment-preview-text">' + escapeHtml(comment.content) + '</span></div>');
    });
    if (commentsCount > post.preview_comments.length) {
      commentItems.push('<div class="comment-preview-more">查看全部 ' + commentsCount + ' 条评论</div>');
    }
    commentsPreviewHtml = '<div class="post-comments-preview">' + commentItems.join('') + '</div>';
  }

  var titleHtml = post.title ? '<div class="post-title">' + escapeHtml(post.title) + '</div>' : '';
  var authorCardClass = !post.is_anonymous && post.author_id ? ' user-card-trigger' : '';
  var authorCardAttr = !post.is_anonymous && post.author_id ? ' data-user-id="' + post.author_id + '" style="cursor:pointer;"' : '';

  return '<article class="post-card" data-id="' + safePostId + '" onclick="openPostDetail(' + safePostId + ')">' +
    '<div class="post-user">' +
      '<img class="user-avatar' + authorCardClass + '" src="' + escapeHtml(authorAvatar) + '" loading="lazy" decoding="async"' + authorCardAttr + '>' +
      '<div class="user-info">' +
        '<div class="user-name' + authorCardClass + '"' + authorCardAttr + '>' + escapeHtml(authorName) + roleBadge + titleBadges + '</div>' +
        '<div class="post-time">' + (post.time_ago || '') + (post.ip_region ? ' · 📍' + escapeHtml(post.ip_region) : '') + '</div>' +
      '</div>' +
    '</div>' +
    titleHtml +
    '<div class="post-content">' + (post.is_pinned ? '<span style="margin-right:4px;">📌</span>' : '') + convertContentWithLinks(post.content) + '</div>' +
    imageHtml +
    videoHtml +
    pollPreviewHtml +
    commentsPreviewHtml +
    '<div class="post-actions">' +
      '<button type="button" class="action-btn ' + (isLiked ? 'liked' : '') + '" aria-label="' + (isLiked ? '取消点赞' : '点赞') + '" aria-pressed="' + (isLiked ? 'true' : 'false') + '" title="' + (isLiked ? '取消点赞' : '点赞') + '" onclick="event.stopPropagation();toggleLike(' + safePostId + ',this)">' +
        '<span class="action-icon" aria-hidden="true">' + renderHomeIcon('heart') + '</span>' +
        '<span class="action-count">' + likesCount + '</span>' +
      '</button>' +
      '<button type="button" class="action-btn" aria-label="查看评论，共 ' + commentsCount + ' 条" title="查看评论" onclick="event.stopPropagation();openPostDetail(' + safePostId + ')">' +
        '<span class="action-icon" aria-hidden="true">' + renderHomeIcon('chat') + '</span>' +
        '<span class="action-count">' + commentsCount + '</span>' +
      '</button>' +
      '<button type="button" class="action-btn" aria-label="查看动态，共浏览 ' + viewsCount + ' 次" title="查看动态" onclick="event.stopPropagation();openPostDetail(' + safePostId + ')">' +
        '<span class="action-icon" aria-hidden="true">' + renderHomeIcon('eye') + '</span>' +
        '<span class="action-count">' + viewsCount + '</span>' +
      '</button>' +
      '<button type="button" class="action-btn ' + (post.is_favorited ? 'favorited' : '') + '" aria-label="' + (post.is_favorited ? '取消收藏' : '收藏') + '" aria-pressed="' + (post.is_favorited ? 'true' : 'false') + '" title="' + (post.is_favorited ? '取消收藏' : '收藏') + '" onclick="event.stopPropagation();toggleFavorite(' + safePostId + ',this)">' +
        '<span class="action-icon" aria-hidden="true">' + renderBookmarkIcon(!!post.is_favorited) + '</span>' +
      '</button>' +
    '</div>' +
  '</article>';
}

function openPostDetail(postId) {
  saveHomeState();
  window.location.href = '/post/' + postId;
}

async function toggleLike(postId, btn) {
  if (!requireLogin()) { isLiking = false; return; }
  if (isLiking) return;
  isLiking = true;

  var icon = btn.querySelector('.action-icon');
  var count = btn.querySelector('span:last-child');
  var wasLiked = btn.classList.contains('liked');
  var prevCount = parseInt(count.textContent, 10) || 0;
  if (wasLiked) {
    btn.classList.remove('liked');
    icon.innerHTML = renderHomeIcon('heart');
    count.textContent = Math.max(0, prevCount - 1);
  } else {
    btn.classList.add('liked');
    icon.innerHTML = renderHomeIcon('heart');
    count.textContent = prevCount + 1;
    btn.classList.add('like-animate');
    setTimeout(function() { btn.classList.remove('like-animate'); }, 400);
  }

  try {
    var data = await authFetch('/api/posts/' + postId + '/like', { method: 'POST' });
    if (data.code === 200 && data.data && data.data.liked !== undefined) {
      if (data.data.liked) {
        btn.classList.add('liked');
        icon.innerHTML = renderHomeIcon('heart');
      } else {
        btn.classList.remove('liked');
        icon.innerHTML = renderHomeIcon('heart');
      }
      if (data.data.likes_count !== undefined) {
        count.textContent = data.data.likes_count;
      }
      cacheLikeStatus(postId, data.data.liked);
    } else {
      rollbackLike(btn, icon, count, wasLiked, prevCount);
      showToast(data.message || '操作失败', 'error');
    }
  } catch (err) {
    rollbackLike(btn, icon, count, wasLiked, prevCount);
    console.error('点赞失败:', err);
    if (typeof showToast === 'function') showToast('网络不稳定,请稍后重试', 'error');
  }
  isLiking = false;
}

function rollbackLike(btn, icon, count, wasLiked, prevCount) {
  if (wasLiked) {
    btn.classList.add('liked');
    icon.innerHTML = renderHomeIcon('heart');
  } else {
    btn.classList.remove('liked');
    icon.innerHTML = renderHomeIcon('heart');
  }
  count.textContent = prevCount;
}

function cacheLikeStatus(postId, isLiked) {
  try {
    var cache = JSON.parse(localStorage.getItem('likeCache') || '{}');
    cache[postId] = {
      isLiked: isLiked,
      timestamp: Date.now()
    };
    localStorage.setItem('likeCache', JSON.stringify(cache));
  } catch (e) {
    console.error('缓存点赞状态失败:', e);
  }
}

function getCachedLikeStatus(postId) {
  try {
    var cache = JSON.parse(localStorage.getItem('likeCache') || '{}');
    var cached = cache[postId];
    if (cached && Date.now() - cached.timestamp < 3600000) {
      return cached.isLiked;
    }
  } catch (e) {}
  return null;
}

async function toggleFavorite(postId, btn) {
  if (!requireLogin()) return;

  var data = await authFetch('/api/posts/' + postId + '/favorite', { method: 'POST' });
  if (data.code === 200) {
    var icon = btn.querySelector('.action-icon, .profile-action-icon');
    if (data.data.favorited) {
      btn.classList.add('favorited');
      if (icon) icon.innerHTML = renderBookmarkIcon(true);
      btn.classList.add('favorite-animate');
      setTimeout(function() {
        btn.classList.remove('favorite-animate');
      }, 500);
    } else {
      btn.classList.remove('favorited');
      if (icon) icon.innerHTML = renderBookmarkIcon(false);
    }
  } else {
    showToast(data.message || '操作失败', 'error');
  }
}

async function loadHomePlaylist() {
  var section = document.getElementById('homePlaylistSection');
  var container = document.getElementById('homePlaylist');
  if (!container) return;

  function renderInlineEmpty() {
    if (section) section.classList.add('is-empty');
    container.innerHTML = '<div class="playlist-empty-inline">' +
      '<div class="empty-inline-left">' +
        '<span class="empty-inline-icon">' + renderHomeIcon('music') + '</span>' +
        '<span class="empty-inline-text">今日歌单 · 暂无播放曲目，去点一首吧~</span>' +
      '</div>' +
      '<a href="/radio" class="empty-inline-action">去点歌 ›</a>' +
    '</div>';
  }

  try {
    renderInlineEmpty();

    var response = await fetch('/api/songs/list', {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      renderInlineEmpty();
      return;
    }

    var rawText = await response.text();
    var data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      renderInlineEmpty();
      return;
    }

    if (!data || data.code !== 200) {
      renderInlineEmpty();
      return;
    }

    var songs = Array.isArray(data.data) ? data.data.filter(function(song) {
      return song && !song.deleted_at;
    }) : [];

    var validSongs = songs.filter(function(s) { return s.status !== 'played'; });

    if (!validSongs || validSongs.length === 0) {
      renderInlineEmpty();
      return;
    }

    if (section) section.classList.remove('is-empty');

    var html = '';
    validSongs.forEach(function(song, index) {
      var statusText = '审核通过';
      var statusClass = 'waiting';

      var artistInfo = song.artist ? ' - ' + escapeHtml(song.artist) : '';
      var authorStr = song.is_anonymous ? '匿名用户' : (song.author_name || '用户');

      html += '<div class="playlist-item ' + statusClass + '">' +
        '<span class="song-index">' + (index + 1) + '</span>' +
        '<div class="song-info">' +
          '<span class="song-name">' + escapeHtml(song.song_name || '') + artistInfo + '</span>' +
          '<span class="song-meta">🎤 ' + escapeHtml(authorStr) + '</span>' +
        '</div>' +
        '<span class="song-status">' + statusText + '</span>' +
      '</div>';
    });

    container.innerHTML = html;
  } catch (err) {
    renderInlineEmpty();
  }
}

window.showUserProfileModal = async function(userId) {
  if (!userId) return;
  
  var modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.3s;';
  
  modal.innerHTML = '<div class="modal" style="background:#fff;border-radius:16px;padding:32px;max-width:400px;width:90%;max-height:80vh;overflow-y:auto;position:relative;">' +
    '<button class="modal-close" style="position:absolute;top:16px;right:16px;background:none;border:none;font-size:24px;cursor:pointer;color:#999;" onclick="this.closest(\'.modal-overlay\').remove()">✕</button>' +
    '<div id="user-profile-content" style="text-align:center;padding:20px 0;">' +
      '<div style="font-size:2rem;margin-bottom:10px;">⏳</div>' +
      '<div style="color:#999;">加载中...</div>' +
    '</div>' +
  '</div>';
  
  document.body.appendChild(modal);
  
  setTimeout(function() {
    modal.style.opacity = '1';
  }, 10);
  
  modal.onclick = function(e) {
    if (e.target === modal) {
      modal.style.opacity = '0';
      setTimeout(function() { modal.remove(); }, 300);
    }
  };
  
  try {
    var res = await fetch('/api/posts/users/' + userId);
    var data = await res.json();
    
    if (data.code === 200) {
      var user = data.data;
      var content = document.getElementById('user-profile-content');
      
      var roleText = '';
      if (user.role === 'super_admin') roleText = '👑 超级管理员';
      else if (user.role === 'admin') roleText = '🛡️ 管理员';
      else if (user.role === 'reviewer') roleText = '✅ 审核员';
      else if (user.role === 'radio_admin') roleText = '📻 广播管理员';
      
      content.innerHTML = '<img src="' + escapeHtml(user.avatar || '/uploads/avatars/default.png') + '" style="width:80px;height:80px;border-radius:50%;object-fit:cover;margin-bottom:16px;border:3px solid var(--primary);">' +
        '<h3 style="margin:0 0 8px 0;font-size:1.5rem;color:var(--text-primary);">' + escapeHtml(user.nickname || user.username || '同学') + '</h3>' +
        (roleText ? '<div style="margin-bottom:16px;"><span class="role-badge role-' + user.role + '">' + roleText + '</span></div>' : '') +
        '<div style="display:flex;justify-content:center;gap:24px;margin-bottom:20px;">' +
          '<div style="text-align:center;">' +
            '<div style="font-size:1.25rem;font-weight:700;color:var(--text-primary);">' + (user.post_count || 0) + '</div>' +
            '<div style="font-size:0.85rem;color:var(--text-secondary);">帖子</div>' +
          '</div>' +
          '<div style="text-align:center;">' +
            '<div style="font-size:1.25rem;font-weight:700;color:var(--text-primary);">' + (user.comment_count || 0) + '</div>' +
            '<div style="font-size:0.85rem;color:var(--text-secondary);">评论</div>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:0.85rem;color:var(--text-secondary);">注册时间：' + new Date(user.created_at).toLocaleDateString('zh-CN') + '</div>';
    } else {
      showToast('用户不存在', 'error');
      modal.remove();
    }
  } catch (err) {
    console.error('加载用户资料失败:', err);
    showToast('加载失败', 'error');
    modal.remove();
  }
};

function initHomeWheelScroll() {
  if (window.__homeWheelScrollInitialized) return;
  window.__homeWheelScrollInitialized = true;
}


var HOME_STATE_KEY = 'campus_wall_home_state';

function saveHomeState() {
  try {
    var searchInputEl = document.getElementById('searchInput');
    var kw = searchInputEl ? searchInputEl.value.trim() : (currentKeyword || '');
    var state = {
      keyword: kw,
      category: currentCategory || '全部',
      sort: currentSort || 'latest',
      scrollY: window.scrollY || window.pageYOffset || 0,
      timestamp: Date.now()
    };
    sessionStorage.setItem(HOME_STATE_KEY, JSON.stringify(state));
  } catch (e) {}
}

function getSavedHomeState() {
  try {
    var raw = sessionStorage.getItem(HOME_STATE_KEY);
    if (!raw) return null;
    var state = JSON.parse(raw);
    if (state && (Date.now() - state.timestamp < 3600000)) {
      return state;
    }
  } catch (e) {}
  return null;
}

window.addEventListener('pagehide', saveHomeState);
window.addEventListener('beforeunload', saveHomeState);

document.addEventListener('DOMContentLoaded', function() {
  emptyStateEl = document.getElementById('emptyState');

  updateNavbar();
  initHomeWheelScroll();

  var savedState = getSavedHomeState();
  var shouldRestoreScroll = false;
  var targetScrollY = 0;

  var searchInput = document.getElementById('searchInput');
  var searchClear = document.getElementById('searchClear');

  if (savedState) {
    if (savedState.keyword) {
      currentKeyword = savedState.keyword;
      if (searchInput) searchInput.value = savedState.keyword;
      if (searchClear) searchClear.classList.add('show');
    }
    if (savedState.category && savedState.category !== '全部') {
      currentCategory = savedState.category;
      var catTag = document.querySelector('.filter-tag[data-category="' + savedState.category + '"]');
      if (catTag) {
        var allTags = document.querySelectorAll('.filter-tag');
        for (var i = 0; i < allTags.length; i++) {
          allTags[i].classList.remove('active');
          allTags[i].setAttribute('aria-pressed', 'false');
        }
        catTag.classList.add('active');
        catTag.setAttribute('aria-pressed', 'true');
      }
    }
    if (savedState.sort && savedState.sort !== 'latest') {
      currentSort = savedState.sort;
      var sortBtn = document.querySelector('.sort-btn[data-sort="' + savedState.sort + '"]');
      if (sortBtn) {
        var allBtns = document.querySelectorAll('.sort-btn');
        for (var j = 0; j < allBtns.length; j++) {
          allBtns[j].classList.remove('active');
        }
        sortBtn.classList.add('active');
      }
    }
    if (savedState.scrollY && savedState.scrollY > 0) {
      shouldRestoreScroll = true;
      targetScrollY = savedState.scrollY;
    }
  }

  if (!shouldRestoreScroll) {
    window.scrollTo(0, 0);
  }
  pageInitialized = true;
  totalLoaded = 0;
  hasMore = true;
  loadPosts(false).then(function() {
    if (shouldRestoreScroll && targetScrollY > 0) {
      window.setTimeout(function() {
        window.scrollTo({ top: targetScrollY, behavior: 'instant' });
      }, 80);
    }
  });

  initPullToRefresh();

  setTimeout(loadHomePlaylist, 500);

  var filterContainer = document.querySelector('.filter-categories');
  if (filterContainer) {
    filterContainer.addEventListener('click', function(e) {
      var tag = e.target.closest('.filter-tag');
      if (!tag) return;

      var allTags = filterContainer.querySelectorAll('.filter-tag');
      for (var i = 0; i < allTags.length; i++) {
        allTags[i].classList.remove('active');
        allTags[i].setAttribute('aria-pressed', 'false');
      }
      tag.classList.add('active');
      tag.setAttribute('aria-pressed', 'true');

      currentCategory = tag.getAttribute('data-category') || tag.textContent.trim();
      totalLoaded = 0;
      hasMore = true;
      loadPosts(false);
    });
  }

  var sortContainer = document.querySelector('.filter-sort');
  if (sortContainer) {
    sortContainer.addEventListener('click', function(e) {
      var btn = e.target.closest('.sort-btn');
      if (!btn) return;

      var allBtns = sortContainer.querySelectorAll('.sort-btn');
      for (var i = 0; i < allBtns.length; i++) {
        allBtns[i].classList.remove('active');
      }
      btn.classList.add('active');

      currentSort = btn.getAttribute('data-sort') || 'latest';
      totalLoaded = 0;
      hasMore = true;
      loadPosts(false);
    });
  }

  var loadMoreWrapper = document.querySelector('.load-more-wrapper');
  var loadMoreBtn = document.getElementById('loadMoreBtn');
  var prevPageBtn = document.getElementById('prevPageBtn');
  var nextPageBtn = document.getElementById('nextPageBtn');
  var pageJumpBtn = document.getElementById('pageJumpBtn');
  var pageJumpInput = document.getElementById('pageJumpInput');
  var paginationContainer = document.getElementById('paginationContainer');
  var currentPageNumEl = document.getElementById('currentPageNum');
  var totalPageNumEl = document.getElementById('totalPageNum');
  window._totalPages = 1;

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', function() {
      if (isLoading) return;
      if (!hasMore) return;
      loadPosts(true);
    });
  }

  loadMoreWrapperEl = loadMoreWrapper;
  if (loadMoreWrapperEl && 'IntersectionObserver' in window) {
    loadMoreObserver = new IntersectionObserver(function(entries) {
      if (!entries.some(function(entry) { return entry.isIntersecting; })) return;
      if (!isLoading && hasMore) loadPosts(true);
    }, { rootMargin: '0px 0px 320px 0px' });
    loadMoreObserver.observe(loadMoreWrapperEl);
  }

  var scrollTimer = null;
  
  window.addEventListener('scroll', function() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function() {
      scrollTimer = null;
      checkHomeLoadMore();
    }, 120);
  }, { passive: true });
  window.addEventListener('resize', checkHomeLoadMore, { passive: true });

  var searchInput = document.getElementById('searchInput');
  var searchClear = document.getElementById('searchClear');

  function debounce(fn, wait) {
    var t = null;
    function debounced() {
      var args = arguments;
      var ctx = this;
      clearTimeout(t);
      t = setTimeout(function() { fn.apply(ctx, args); }, wait);
    }
    debounced.cancel = function() {
      clearTimeout(t);
      t = null;
    };
    return debounced;
  }

  var debouncedSearch = debounce(function(val) {
    currentKeyword = val;
    totalLoaded = 0;
    hasMore = true;
    loadPosts(false);
    window.scrollTo({ top: 0, behavior: getMotionSafeScrollBehavior() });
  }, 350);

  if (searchInput) {
    searchInput.addEventListener('input', function() {
      var val = this.value.trim();
      if (searchClear) {
        if (val) {
          searchClear.classList.add('show');
        } else {
          searchClear.classList.remove('show');
        }
      }
      debouncedSearch(val);
    });

    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        debouncedSearch.cancel();
        currentKeyword = this.value.trim();
        totalLoaded = 0;
        hasMore = true;
        loadPosts(false);
        window.scrollTo({ top: 0, behavior: getMotionSafeScrollBehavior() });
      }
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', function() {
      debouncedSearch.cancel();
      if (searchInput) searchInput.value = '';
      searchClear.classList.remove('show');
      currentKeyword = '';
      saveHomeState();
      totalLoaded = 0;
      hasMore = true;
      loadPosts(false);
      window.scrollTo({ top: 0, behavior: getMotionSafeScrollBehavior() });
      searchInput.focus();
    });
  }

});

function initPullToRefresh() {
  if (window.__pullToRefreshInitialized) return;
  window.__pullToRefreshInitialized = true;
  
  var indicator = document.getElementById('pullRefreshIndicator');
  var refreshText = indicator ? indicator.querySelector('.refresh-text') : null;
  var refreshIcon = indicator ? indicator.querySelector('.refresh-icon') : null;
  
  var startY = 0;
  var currentY = 0;
  var isPulling = false;
  var isRefreshing = false;
  var threshold = 80;
  
  document.addEventListener('touchstart', function(e) {
    if (window.innerWidth > 768 || isRefreshing) return;
    var target = e.target;
    if (target && target.closest && target.closest('a, button, input, textarea, select, [data-no-pull-refresh]')) return;
    if (window.scrollY <= 0 && e.touches && e.touches[0]) {
      startY = e.touches[0].pageY;
      currentY = startY;
      isPulling = true;
    }
  }, { passive: true });
  
  document.addEventListener('touchmove', function(e) {
    if (window.innerWidth > 768 || !isPulling || isRefreshing || !e.touches || !e.touches[0]) return;
    
    currentY = e.touches[0].pageY;
    var diff = currentY - startY;
    
    if (diff > 0 && diff < 200) {
      if (indicator) {
        indicator.classList.add('show');
        var progress = Math.min(diff / threshold, 1);
        
        if (progress < 1) {
          refreshText.textContent = '下拉刷新';
          refreshIcon.style.transform = 'rotate(' + (progress * 360) + 'deg)';
          indicator.classList.remove('pull-ready');
        } else {
          refreshText.textContent = '释放刷新';
          refreshIcon.style.transform = 'rotate(360deg)';
          indicator.classList.add('pull-ready');
        }
      }
    } else if (diff <= 0 && indicator) {
      indicator.classList.remove('show', 'pull-ready');
    }
  }, { passive: true });
  
  document.addEventListener('touchend', function(e) {
    if (window.innerWidth > 768 || !isPulling || isRefreshing) {
      isPulling = false;
      return;
    }
    
    var diff = currentY - startY;
    isPulling = false;
    
    if (diff > threshold) {
      performRefresh();
    } else {
      if (indicator) {
        indicator.classList.remove('show');
      }
    }
  }, { passive: true });
  
  function performRefresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    
    if (indicator) {
      indicator.classList.add('refreshing');
      refreshText.textContent = '刷新中...';
    }

    function startRequest() {
      if (isLoading) {
        window.setTimeout(startRequest, 50);
        return;
      }

      totalLoaded = 0;
      hasMore = true;
      loadPosts(false).then(function(success) {
        window.setTimeout(function() {
          isRefreshing = false;
          if (indicator) {
            indicator.classList.remove('show', 'refreshing', 'pull-ready');
          }
          showToast(success ? '刷新成功' : '刷新失败', success ? 'success' : 'error');
        }, success ? 500 : 0);
      });
    }

    startRequest();
  }
}

(function() {
  if (!isLoggedIn()) return;

  function renderCheckinCard(target) {
    var checkinCard = document.createElement('div');
    checkinCard.className = 'side-card glass-effect' + (window.innerWidth <= 768 ? ' mobile-checkin-card' : '');
    checkinCard.id = 'sideCheckin';
    checkinCard.setAttribute('aria-busy', 'true');
    checkinCard.innerHTML = '<div class="checkin-card-heading"><div class="side-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="3"></rect><path d="M7.5 3v4M16.5 3v4M3.5 10.5h17M8 15.5l2.5 2.5 5-5"></path></svg></div><div class="checkin-card-copy"><div class="side-card-title">每日签到</div><div class="checkin-card-subtitle">每天一点，慢慢积累</div></div></div><div class="side-card-body" id="checkinBody"><div class="checkin-loading" role="status">正在读取签到状态…</div></div>';
    if (target === desktopSideGroup) {
      target.insertBefore(checkinCard, target.firstElementChild);
    } else {
      target.appendChild(checkinCard);
    }
  }

  function renderCheckinError(message) {
    var body = document.getElementById('checkinBody');
    if (!body) return;
    var card = document.getElementById('sideCheckin');
    if (card) card.setAttribute('aria-busy', 'false');
    body.innerHTML = '<div class="checkin-error" role="status"><span>' + escapeHtml(message || '签到状态暂时不可用') + '</span><button type="button" class="checkin-retry" onclick="window.retryCheckinStatus()">重试</button></div>';
  }

  function loadCheckinStatus() {
    authFetch('/api/checkin/status').then(function(d) {
      if (d.code !== 200) {
        renderCheckinError(d.message);
        return;
      }
      var data = d.data;
      var body = document.getElementById('checkinBody');
      if (!body) return;
      var card = document.getElementById('sideCheckin');
      if (card) card.setAttribute('aria-busy', 'false');
      var streakHtml = data.checked_in
        ? '<div class="checkin-status-row"><span class="checkin-streak">连续 <strong>' + data.streak + '</strong> 天</span><span class="checkin-done">已签到</span></div>'
        : '<div class="checkin-action-row"><span class="checkin-streak">连续 <strong>' + data.streak + '</strong> 天</span><button class="btn-checkin" onclick="doCheckin()">签到</button></div>';
      var goalHtml = data.streak_goal
        ? '<div class="checkin-encouragement">' + escapeHtml(data.streak_goal.message) + '</div>'
        : '';
      var titleHtml = data.next_checkin_title
        ? '<div class="checkin-title-goal">' + escapeHtml(data.next_checkin_title.message) + '</div>'
        : '';
      var targetDays = data.streak_goal && Number(data.streak_goal.target_days);
      var progressHtml = targetDays > 0
        ? '<progress class="checkin-progress" max="' + targetDays + '" value="' + Math.min(targetDays, Math.max(0, Number(data.streak) || 0)) + '" aria-label="连续签到目标：' + targetDays + '天"></progress>'
        : '';
      body.innerHTML = streakHtml + '<div class="checkin-goals">' + progressHtml + goalHtml + titleHtml + '</div>';
    }).catch(function() {
      renderCheckinError('网络不稳定，请稍后重试');
    });
  }

  window.retryCheckinStatus = loadCheckinStatus;

  var desktopSideGroup = document.querySelector('.side-cards-left');
  var desktopSlot = document.getElementById('desktopCheckinSlot');
  var mobileSlot = document.getElementById('mobileCheckinSlot');

  function getDesktopCheckinTarget() {
    return window.matchMedia('(min-width: 1600px)').matches && desktopSideGroup
      ? desktopSideGroup
      : desktopSlot;
  }

  function placeCheckinCard(target, card, isMobile) {
    if (card.parentElement === target) return;
    if (isMobile || target === desktopSlot) {
      target.appendChild(card);
    } else {
      target.insertBefore(card, target.firstElementChild);
    }
  }

  function syncCheckinPlacement() {
    var card = document.getElementById('sideCheckin');
    var isMobile = window.matchMedia('(max-width: 768px)').matches;
    var target = isMobile ? mobileSlot : getDesktopCheckinTarget();
    if (!target) {
      if (card) card.remove();
      return;
    }

    if (!card) {
      renderCheckinCard(target);
      card = document.getElementById('sideCheckin');
    } else {
      placeCheckinCard(target, card, isMobile);
    }

    if (card) card.classList.toggle('mobile-checkin-card', isMobile);
  }

  syncCheckinPlacement();
  window.addEventListener('resize', syncCheckinPlacement, { passive: true });

  loadCheckinStatus();
  window.doCheckin = function() {
    var btn = document.querySelector('.btn-checkin');
    if (btn) { btn.disabled = true; btn.textContent = '签到中...'; }
    authFetch('/api/checkin', { method: 'POST' }).then(function(d) {
      if (d.code === 200) {
        showToast('签到成功 +' + d.data.points_earned + '分' + (d.data.bonus > 0 ? ' (连续加成+' + d.data.bonus + ')' : ''));
        loadCheckinStatus();
      } else {
        showToast(d.message || '签到失败', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '签到'; }
      }
    }).catch(function() { showToast('网络错误', 'error'); if (btn) { btn.disabled = false; btn.textContent = '签到'; } });
  };
})();
