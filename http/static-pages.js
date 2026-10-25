'use strict';
const express = require('express');
const path = require('path');

function registerStaticPages(app, { staticRoot = path.resolve(__dirname, '..', 'public') } = {}) {
  const pageAliases = {
    '/radio': 'radio.html',
    '/profile': 'profile.html',
    '/login': 'login.html',
    '/register': 'register.html',
    '/new-post': 'new-post.html',
    '/edit-post': 'edit-post.html',
    '/edit-profile': 'edit-profile.html',
    '/feedback': 'feedback.html',
    '/agreement': 'agreement.html',
    '/privacy': 'privacy.html',
    '/messages': 'messages.html',
    '/admin/mp-draft': 'admin/mp-draft.html'
  };

  function setHtmlRevalidationHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('Surrogate-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  function setAdminHtmlCacheHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    res.setHeader('Surrogate-Control', 'public, max-age=300, stale-while-revalidate=86400');
  }

  function sendHtmlPage(res, relativePath) {
    setHtmlRevalidationHeaders(res);
    return res.sendFile(path.join(staticRoot, relativePath));
  }

  Object.keys(pageAliases).forEach((route) => {
    app.get(route, (req, res) => sendHtmlPage(res, pageAliases[route]));
  });
  app.get('/post/:id', (req, res) => sendHtmlPage(res, 'post-detail.html'));

  app.use(express.static(staticRoot, {
    setHeaders: (res, filePath) => {
      if (/[\\/]admin[\\/]index\.html$/i.test(filePath)) {
        setAdminHtmlCacheHeaders(res);
      } else if (/\.html$/i.test(filePath)) {
        setHtmlRevalidationHeaders(res);
      }

      if (/\.(css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
        res.setHeader('Surrogate-Control', 'public, max-age=300, stale-while-revalidate=86400');
      }

      if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }

      if (/\.(mp4|webm|ogv)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        res.setHeader('Accept-Ranges', 'bytes');
      }
    }
  }));
}

module.exports = { registerStaticPages };
