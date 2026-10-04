/* 登录页专属交互。独立文件便于缓存，避免把页面逻辑堆在 HTML 内联脚本中。 */
(function () {
  try {
    window.currentUser = JSON.parse(localStorage.getItem('user') || sessionStorage.getItem('user') || 'null');
  } catch (e) {
    window.currentUser = null;
  }
  window.loginCaptchaKey = '';

  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target) return;
    var action = target.getAttribute('data-action');
    if (action === 'reload-captcha') {
      window.loadLoginCaptcha();
    } else if (action === 'toggle-theme') {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (dark) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('theme', 'light');
        target.textContent = '🌙';
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
        target.textContent = '☀️';
      }
      if (typeof window.updateThemeColor === 'function') window.updateThemeColor();
    } else {
      return;
    }
    if (target.tagName === 'BUTTON' || target.tagName === 'IMG') event.preventDefault();
  });

  window.loadLoginCaptcha = async function () {
    try {
      var res = await fetch('/api/auth/captcha');
      var data = await res.json();
      if (data.code === 200) {
        window.loginCaptchaKey = data.data.key;
        var image = document.getElementById('captchaImg');
        if (image) image.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(data.data.captcha)));
      }
    } catch (err) {
      console.error('加载验证码失败:', err);
    }
  };

  fetch('/api/auth/login-status')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.code === 200 && d.data && d.data.needCaptcha) {
        var group = document.getElementById('loginCaptchaGroup');
        if (group) group.classList.add('show');
        window.loadLoginCaptcha();
      }
    })
    .catch(function () {});

  document.addEventListener('loginCaptchaRequired', function () {
    var group = document.getElementById('loginCaptchaGroup');
    if (group) group.classList.add('show');
    window.loadLoginCaptcha();
  });

  document.addEventListener('loginError', function (e) {
    var errDiv = document.getElementById('loginError');
    if (!errDiv) return;
    var msg = e.detail;
    if (typeof e.detail === 'object' && e.detail.ban_reason) {
      msg = e.detail.message + '（原因：' + e.detail.ban_reason + '）\n请联系管理员 2108474355@qq.com 申诉';
    }
    errDiv.textContent = msg;
    errDiv.classList.add('show');
  });

  document.addEventListener('loginLoading', function (e) {
    var button = document.getElementById('loginBtn');
    if (button) button.classList.toggle('loading', e.detail);
  });

  var defaultSiteName = '嘉二の墙墙';
  var cachedSettings = localStorage.getItem('siteSettings');
  if (cachedSettings) {
    try { applySiteSettings(JSON.parse(cachedSettings)); } catch (e) {}
  }

  var siteInfoRequest = window.CampusWallSiteInfoPromise;
  if (!siteInfoRequest) {
    siteInfoRequest = fetch('/api/site-info', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
    window.CampusWallSiteInfoPromise = siteInfoRequest;
  }
  siteInfoRequest.then(function (data) {
    if (data && data.code === 200 && data.data) {
      localStorage.setItem('siteSettings', JSON.stringify(data.data));
      applySiteSettings(data.data);
    }
  }).catch(function () {});

  function applySiteSettings(settings) {
    var siteName = settings.site_name || defaultSiteName;
    document.title = siteName + ' - 登录';
    var navLogo = document.querySelector('.nav-logo');
    if (navLogo) navLogo.textContent = '🏠 ' + siteName;
  }
}());
