(function () {
  'use strict';
  var section = document.getElementById('homeNotices');
  if (!section) return;
  var list = document.getElementById('homeNoticeList');
  var status = document.getElementById('homeNoticeStatus');
  var retry = document.getElementById('homeNoticeRetry');
  var count = document.getElementById('homeNoticeCount');
  var loading = false;

  function textElement(tag, className, text) {
    var el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
  }

  async function loadNotices() {
    if (loading) return;
    loading = true;
    section.setAttribute('aria-busy', 'true');
    retry.hidden = true;
    status.textContent = '正在读取公告…';
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 10000);
    try {
      var response = await fetch('/api/notices?limit=10', { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('notice request failed');
      var result = await response.json();
      if (result.code !== 200 || !Array.isArray(result.data)) throw new Error('invalid notice response');
      var notices = result.data.filter(function (item) {
        return item && typeof item.title === 'string' && item.title.trim() && typeof item.content === 'string';
      });
      var fragment = document.createDocumentFragment();
      notices.forEach(function (notice) {
        var item = document.createElement('details');
        item.className = 'home-notice';
        var summary = document.createElement('summary');
        var headline = textElement('span', 'home-notice-headline', '');
        if (Number(notice.is_top) === 1) headline.appendChild(textElement('span', 'home-notice-pin', '置顶'));
        headline.appendChild(textElement('span', 'home-notice-title', notice.title));
        summary.appendChild(headline);
        var action = textElement('span', 'home-notice-action', '');
        action.setAttribute('aria-hidden', 'true');
        action.appendChild(textElement('span', 'home-notice-expand', '查看全文'));
        action.appendChild(textElement('span', 'home-notice-collapse', '收起'));
        summary.appendChild(action);
        var preview = notice.content.trim().split(/\r?\n\s*\r?\n/)[0].replace(/\s+/g, ' ');
        summary.appendChild(textElement('span', 'home-notice-preview', preview.length > 140 ? preview.slice(0, 140) + '…' : preview));
        item.appendChild(summary);
        var body = textElement('div', 'home-notice-body', notice.content);
        item.appendChild(body);
        fragment.appendChild(item);
      });
      list.replaceChildren(fragment);
      status.textContent = '';
      if (count) count.textContent = notices.length ? notices.length + ' 条' : '';
      section.hidden = notices.length === 0;
    } catch (error) {
      section.hidden = false;
      status.textContent = '公告暂时加载失败';
      retry.hidden = false;
    } finally {
      clearTimeout(timer);
      loading = false;
      section.setAttribute('aria-busy', 'false');
    }
  }

  retry.addEventListener('click', loadNotices);
  loadNotices();
})();
