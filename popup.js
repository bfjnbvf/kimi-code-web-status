/**
 * Kimi Web Status Bar — 扩展弹窗
 * 显示授权状态，提供「重新授权 / 切换账户」入口（设备码 OAuth 流程）。
 */
(function () {
  'use strict';

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const authHint = document.getElementById('auth-hint');
  const reauthBtn = document.getElementById('reauth-btn');

  let pollTimer = null;

  document.getElementById('version').textContent = chrome.runtime.getManifest().version;

  function send(type) {
    return chrome.runtime.sendMessage({ type });
  }

  function setStatus(authorized, detail) {
    statusDot.className = `dot ${authorized ? 'ok' : 'bad'}`;
    statusText.textContent = authorized
      ? `已授权${detail ? `（token ${detail}）` : ''}`
      : '未授权，额度与余额无法显示';
  }

  async function refreshStatus() {
    try {
      const response = await send('auth.status');
      if (response?.ok && response.authorized) {
        stopPolling();
        reauthBtn.disabled = false;
        const expiry = response.expiresAt
          ? `至 ${new Date(response.expiresAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })}`
          : '';
        setStatus(true, expiry);
      } else if (response?.pending) {
        reauthBtn.disabled = true;
        statusDot.className = 'dot bad';
        statusText.textContent = '授权流程进行中…';
        showHint('请在授权页完成授权。', response.userCode);
        if (!pollTimer) pollTimer = setInterval(poll, 2_000);
      } else {
        stopPolling();
        reauthBtn.disabled = false;
        setStatus(false);
      }
    } catch (error) {
      statusDot.className = 'dot bad';
      statusText.textContent = `状态查询失败：${error.message || error}`;
    }
  }

  function showHint(message, userCode = '') {
    authHint.replaceChildren();
    authHint.append(document.createTextNode(message));
    if (userCode) {
      authHint.append(document.createElement('br'), document.createTextNode('验证码：'));
      const strong = document.createElement('strong');
      strong.textContent = userCode;
      authHint.append(strong);
    }
    authHint.classList.remove('hidden');
  }

  function hideHint() {
    authHint.classList.add('hidden');
    authHint.textContent = '';
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // 后台在驱动授权轮询，弹窗只需周期性查询授权状态
  async function poll() {
    try {
      const response = await send('auth.status');
      if (response?.authorized) {
        stopPolling();
        showHint('授权成功，状态栏会自动恢复显示。');
        reauthBtn.disabled = false;
        setStatus(true);
        return;
      }
      if (response && !response.pending && !response.authorized) {
        // 后台轮询已结束（超时或失败）
        stopPolling();
        showHint('授权未完成（已超时或被取消），请重试。');
        reauthBtn.disabled = false;
      }
    } catch (error) {
      stopPolling();
      showHint(`状态查询失败：${error.message || error}`);
      reauthBtn.disabled = false;
    }
  }

  reauthBtn.addEventListener('click', async () => {
    if (pollTimer) return;
    reauthBtn.disabled = true;
    showHint('正在打开 Kimi 授权页…');
    try {
      const response = await send('oauth.reset');
      if (!response?.ok) throw new Error(response?.error || '无法开始授权');
      showHint('已在新标签页打开授权页，请完成授权；关闭本弹窗不影响授权。', response.userCode);
      pollTimer = setInterval(poll, 2_000);
      poll();
    } catch (error) {
      showHint(`授权启动失败：${error.message || error}`);
      reauthBtn.disabled = false;
    }
  });

  document.getElementById('clear-btn').addEventListener('click', async () => {
    stopPolling();
    hideHint();
    try {
      await send('auth.clear');
      showHint('授权已清除。Kimi Code Web 页面上的新手引导会重新出现，状态栏将回到待授权状态。');
    } catch (error) {
      showHint(`清除失败：${error.message || error}`);
    }
    refreshStatus();
  });

  refreshStatus();
})();
