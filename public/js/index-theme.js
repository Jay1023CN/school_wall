(function() {
  'use strict';

  function init() {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    updateIcon();
    const btn = document.getElementById('themeSwitch');
    if (btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDark) {
          document.documentElement.removeAttribute('data-theme');
          localStorage.setItem('theme', 'light');
        } else {
          document.documentElement.setAttribute('data-theme', 'dark');
          localStorage.setItem('theme', 'dark');
        }
        updateIcon();
        if (typeof updateThemeColor === 'function') updateThemeColor();
      });
    }
  }

  function updateIcon() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const icon = document.getElementById('themeIcon');
    if (icon) icon.textContent = isDark ? '☀️' : '🌙';
  }

  window.indexThemeUpdate = updateIcon;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
