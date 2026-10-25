(function () {
  var protocol = window.location.protocol.split(':')[0];
  var script = document.createElement('script');
  script.src = protocol === 'https'
    ? 'https://zz.bdstatic.com/linksubmit/push.js'
    : 'http://push.zhanzhang.baidu.com/push.js';
  script.async = true;
  var firstScript = document.getElementsByTagName('script')[0];
  if (firstScript && firstScript.parentNode) {
    firstScript.parentNode.insertBefore(script, firstScript);
  } else {
    document.head.appendChild(script);
  }
})();
