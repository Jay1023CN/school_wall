
function createUserCard() {
  if (document.getElementById('userCardOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'userCardOverlay';
  overlay.className = 'user-card-overlay';
  overlay.innerHTML = `
    <div class="user-card">
      <div class="user-card-header">
        <span class="deco-dot"></span>
        <span class="deco-dot"></span>
        <span class="deco-dot"></span>
        <button class="user-card-close" onclick="closeUserCard()">✕</button>
        <img class="user-card-avatar" id="userCardAvatar" src="/uploads/avatars/default.png" alt="头像">
        <div class="user-card-nickname" id="userCardNickname">加载中...</div>
        <div class="user-card-username" id="userCardUsername">@user</div>
        <div class="user-card-role" id="userCardRole" style="display:none;"></div>
      </div>
      <div class="user-card-body">
        <div class="user-card-loading" id="userCardLoading">
          <div class="loading-spinner"></div>
          <div>正在加载...</div>
        </div>
        <div class="user-card-stats" id="userCardStats" style="display:none;">
          <div class="user-card-stat">
            <div class="user-card-stat-label">
              <span class="stat-icon">📝</span>
              发帖
              <span class="user-card-stat-number" id="userCardPostCount">0</span>
            </div>
          </div>
          <div class="user-card-stat">
            <div class="user-card-stat-label">
              <span class="stat-icon">💬</span>
              评论
              <span class="user-card-stat-number" id="userCardCommentCount">0</span>
            </div>
          </div>
          <div class="user-card-stat">
            <div class="user-card-stat-label">
              <span class="stat-icon">❤️</span>
              获赞
              <span class="user-card-stat-number" id="userCardLikeCount">0</span>
            </div>
          </div>
          <div class="user-card-stat">
            <div class="user-card-stat-label">
              <span class="stat-icon">👥</span>
              粉丝
              <span class="user-card-stat-number" id="userCardFollowerCount">0</span>
            </div>
          </div>
          <div class="user-card-stat">
            <div class="user-card-stat-label">
              <span class="stat-icon">👣</span>
              关注
              <span class="user-card-stat-number" id="userCardFollowingCount">0</span>
            </div>
          </div>
        </div>
        <div class="user-card-titles" id="userCardTitles" style="display:none;"></div>
        <div class="user-card-actions" id="userCardActions" style="display:none;">
          <button class="user-card-btn user-card-btn-secondary" onclick="closeUserCard()">🥰 关闭</button>
          <button class="user-card-btn user-card-btn-follow" id="userCardFollowBtn" style="display:none;"></button>
          <button class="user-card-btn user-card-btn-primary" id="userCardViewBtn">✨ 查看资料</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) {
      closeUserCard();
    }
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeUserCard();
    }
  });
}

async function showUserCard(userId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  var overlay = document.getElementById('userCardOverlay');
  if (overlay && overlay.classList.contains('show') && overlay._currentUserId === userId) {
    return;
  }

  createUserCard();
  overlay = document.getElementById('userCardOverlay');
  overlay._currentUserId = userId;

  var loading = document.getElementById('userCardLoading');
  var stats = document.getElementById('userCardStats');
  var titles = document.getElementById('userCardTitles');
  var actions = document.getElementById('userCardActions');
  var followBtn = document.getElementById('userCardFollowBtn');

  loading.style.display = 'block';
  stats.style.display = 'none';
  titles.style.display = 'none';
  actions.style.display = 'none';

  overlay.classList.add('show');

  try {
    var res = await fetch('/api/posts/users/' + userId);
    var data = await res.json();
    
    if (data.code === 200 && data.data) {
      var user = data.data;
      
      var avatarEl = document.getElementById('userCardAvatar');
      if (avatarEl) avatarEl.src = user.avatar || '/uploads/avatars/default.png';
      
      var nickEl = document.getElementById('userCardNickname');
      if (nickEl) nickEl.textContent = user.nickname || user.username || '未知用户';
      
      var userEl = document.getElementById('userCardUsername');
      if (userEl) userEl.textContent = '@' + (user.username || 'unknown');
      
      var roleEl = document.getElementById('userCardRole');
      if (roleEl) {
        if (user.role && user.role !== 'user') {
          var roleMap = {
            'super_admin': '🏆 超级管理员',
            'admin': '👑 管理员',
            'reviewer': '🎖️ 审核员',
            'radio_admin': '🎵 电台管理员'
          };
          roleEl.textContent = roleMap[user.role] || '';
          roleEl.style.display = 'inline-block';
        } else {
          roleEl.style.display = 'none';
        }
      }
      
      var postEl = document.getElementById('userCardPostCount');
      if (postEl) postEl.textContent = user.post_count != null ? user.post_count : 0;
      var commentEl = document.getElementById('userCardCommentCount');
      if (commentEl) commentEl.textContent = user.comment_count != null ? user.comment_count : 0;
      var likeEl = document.getElementById('userCardLikeCount');
      if (likeEl) likeEl.textContent = user.likes_count != null ? user.likes_count : 0;

      var followerEl = document.getElementById('userCardFollowerCount');
      var followingEl = document.getElementById('userCardFollowingCount');
      if (followerEl) followerEl.textContent = user.followers_count != null ? user.followers_count : 0;
      if (followingEl) followingEl.textContent = user.following_count != null ? user.following_count : 0;

      var followBtn = document.getElementById('userCardFollowBtn');
      if (followBtn) {
        var currentUser = JSON.parse(localStorage.getItem('user') || sessionStorage.getItem('user') || 'null');
        if (currentUser && currentUser.id && parseInt(currentUser.id) !== parseInt(userId)) {
          followBtn.style.display = 'block';
          followBtn.textContent = '⭐ 关注';
          followBtn.className = 'user-card-btn user-card-btn-follow';
          followBtn.onclick = null;

          checkFollowStatus(userId, followBtn);
        } else {
          followBtn.style.display = 'none';
        }
      }
      
      if (user.titles && user.titles.length > 0) {
        var titlesHtml = '';
        user.titles.forEach(function(title) {
          titlesHtml += '<span class="user-card-title" style="background:' + (title.title_bg || '#F3F4F6') + ';color:' + (title.title_color || '#1F2937') + '">' + (title.icon || '') + ' ' + title.title_name + '</span>';
        });
        titles.innerHTML = titlesHtml;
        titles.style.display = 'flex';
      } else {
        titles.style.display = 'none';
      }
      
      var viewBtn = document.getElementById('userCardViewBtn');
      if (viewBtn) {
        viewBtn.onclick = function() {
          closeUserCard();
          setTimeout(function() {
            window.location.href = '/profile?user_id=' + userId;
          }, 150);
        };
      }
      
      loading.style.display = 'none';
      stats.style.display = 'flex';
      actions.style.display = 'flex';
    } else {
      if (loading) {
        loading.innerHTML = '<div style="font-size:2rem;margin-bottom:10px;">❌</div><div>' + (data.message || '加载失败') + '</div>';
      }
    }
  } catch (err) {
    console.error('加载用户资料失败:', err);
    if (loading) {
      loading.innerHTML = '<div style="font-size:2rem;margin-bottom:10px;">❌</div><div>网络错误</div>';
    }
  }
}

function closeUserCard() {
  var overlay = document.getElementById('userCardOverlay');
  if (overlay) {
    overlay.classList.remove('show');
    setTimeout(function() {
      if (overlay._currentUserId) delete overlay._currentUserId;
    }, 300);
  }
}

async function checkFollowStatus(targetUserId, followBtn) {
  try {
    var token = localStorage.getItem('token') || sessionStorage.getItem('token') || '';
    if (!token) return;
    var res = await fetch('/api/follows/status/' + targetUserId, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await res.json();
    if (data.code === 200 && data.data && data.data.followed) {
      followBtn.textContent = '✔️ 已关注';
      followBtn.className = 'user-card-btn user-card-btn-follow following';
    }
    followBtn.onclick = function() { toggleFollow(targetUserId, followBtn); };
  } catch (err) {
    console.error('[UserCard] 检查关注状态失败:', err);
    followBtn.onclick = function() { toggleFollow(targetUserId, followBtn); };
  }
}

async function toggleFollow(targetUserId, followBtn) {
  try {
    var token = localStorage.getItem('token') || sessionStorage.getItem('token') || '';
    if (!token) {
      window.location.href = '/login';
      return;
    }
    followBtn.disabled = true;
    var res = await fetch('/api/follows/' + targetUserId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      }
    });
    var data = await res.json();
    if (data.code === 200) {
      if (data.data && data.data.followed) {
        followBtn.textContent = '✔️ 已关注';
        followBtn.className = 'user-card-btn user-card-btn-follow following';
      } else {
        followBtn.textContent = '⭐ 关注';
        followBtn.className = 'user-card-btn user-card-btn-follow';
      }
      var followerEl = document.getElementById('userCardFollowerCount');
      if (followerEl) {
        var current = parseInt(followerEl.textContent) || 0;
        followerEl.textContent = data.data.followed ? (current + 1) : Math.max(0, current - 1);
      }
    } else {
      alert(data.message || '操作失败');
    }
    followBtn.disabled = false;
  } catch (err) {
    console.error('[UserCard] 关注操作失败:', err);
    alert('操作失败，请稍后重试');
    followBtn.disabled = false;
  }
}

window.showUserCard = showUserCard;
window.closeUserCard = closeUserCard;

function initUserCardEvents() {
  document.addEventListener('click', function(e) {
    var trigger = e.target.closest('.user-card-trigger');
    if (trigger) {
      var userId = trigger.getAttribute('data-user-id');
      if (userId) {
        showUserCard(userId, e);
      }
    }
  }, true);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUserCardEvents);
} else {
  initUserCardEvents();
}
