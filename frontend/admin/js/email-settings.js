    var API_BASE = '/api/admin';

    function getToken() {
      return localStorage.getItem('token') || sessionStorage.getItem('token') || '';
    }

    async function checkAuth() {
      var token = getToken();
      if (!token) { window.location.href = '/admin/'; return false; }
      try {
        var res = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
        if (res.status === 401 || res.status === 403) { window.location.href = '/admin/'; return false; }
        var json = await res.json();
        if (json.code !== 200) { window.location.href = '/admin/'; return false; }
        return true;
      } catch (e) { window.location.href = '/admin/'; return false; }
    }

    var token = getToken();

    // 加载当前配置
    async function loadSettings() {
      try {
        document.getElementById('saveBtn').disabled = true;
        var res = await fetch(API_BASE + '/settings', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        var data = await res.json();
        if (data.code === 200 && data.data) {
          var s = data.data;
          document.getElementById('emailEnabled').checked = s.email_enabled === 'true' || s.email_enabled === true;
          document.getElementById('smtpHost').value = s.smtp_host || '';
          document.getElementById('smtpPort').value = s.smtp_port || '587';
          document.getElementById('smtpUser').value = s.smtp_user || '';
          var smtpPassInput = document.getElementById('smtpPass');
          smtpPassInput.value = '';
          smtpPassInput.placeholder = s.smtp_pass_configured ? '已配置（留空保持不变）' : '输入密码或授权码';
          document.getElementById('smtpFrom').value = s.smtp_from || '';
          updateToggleLabel();
        }
      } catch (err) {
        showStatus('加载配置失败: ' + err.message, 'error');
      } finally {
        document.getElementById('saveBtn').disabled = false;
      }
    }

    // 保存配置
    async function saveSettings() {
      var btn = document.getElementById('saveBtn');
      btn.disabled = true;
      btn.textContent = '⏳ 保存中...';
      try {
        // 先加载现有全部设置，避免覆盖其他配置
        var res = await fetch(API_BASE + '/settings', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        var data = await res.json();
        var currentSettings = (data.code === 200 && data.data) ? data.data : {};

        var body = { ...currentSettings };
        body.email_enabled = document.getElementById('emailEnabled').checked;
        body.smtp_host = document.getElementById('smtpHost').value.trim();
        body.smtp_port = document.getElementById('smtpPort').value.trim() || '587';
        body.smtp_user = document.getElementById('smtpUser').value.trim();
        // 密码不会由接口回传；留空时不提交，避免误覆盖服务器上的现有密码。
        delete body.smtp_pass;
        var smtpPass = document.getElementById('smtpPass').value.trim();
        if (smtpPass) body.smtp_pass = smtpPass;
        body.smtp_from = document.getElementById('smtpFrom').value.trim();

        var saveRes = await fetch(API_BASE + '/settings', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify(body)
        });
        var saveData = await saveRes.json();
        if (saveData.code === 200) {
          showStatus('✅ 配置保存成功！', 'success');
        } else {
          showStatus('❌ 保存失败: ' + (saveData.message || '未知错误'), 'error');
        }
      } catch (err) {
        showStatus('❌ 保存失败: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '💾 保存配置';
      }
    }

    // 测试发送
    async function testSend() {
      var testEmail = document.getElementById('testEmail').value.trim();
      if (!testEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
        showStatus('请输入有效的测试邮箱地址', 'error');
        return;
      }
      var btn = document.getElementById('testBtn');
      btn.disabled = true;
      btn.textContent = '⏳ 发送中...';
      try {
        var res = await fetch('/api/admin/test-email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({ email: testEmail })
        });
        var data = await res.json();
        if (data.code === 200) {
          showStatus('✅ 测试邮件已发送，请检查 ' + testEmail + ' 的收件箱！', 'success');
        } else {
          showStatus('❌ 发送失败: ' + (data.message || '请检查SMTP配置'), 'error');
        }
      } catch (err) {
        showStatus('❌ 发送失败: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '✈️ 发送测试邮件';
      }
    }

    function updateToggleLabel() {
      var label = document.getElementById('toggleLabel');
      label.textContent = document.getElementById('emailEnabled').checked ? '已开启 ✨' : '关闭';
      label.style.color = document.getElementById('emailEnabled').checked ? '#10B981' : '#9CA3AF';
    }

    document.getElementById('emailEnabled').addEventListener('change', updateToggleLabel);
    document.getElementById('saveBtn').addEventListener('click', saveSettings);
    document.getElementById('testBtn').addEventListener('click', testSend);

    function showStatus(msg, type) {
      var el = document.getElementById('statusMsg');
      el.textContent = msg;
      el.className = 'status-msg ' + type;
      el.style.display = 'block';
      setTimeout(function() {
        el.style.display = 'none';
      }, 8000);
    }

    // 页面加载后先验证权限再读取配置
    checkAuth().then(function(ok) { if (ok) loadSettings(); });
