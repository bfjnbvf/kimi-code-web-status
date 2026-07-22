/**
 * Kimi Web Status Widget
 *
 * 职责边界：
 * - 内容脚本：读取当前 Kimi Web 会话、订阅本地 WebSocket、更新 UI。
 * - 扩展后台：请求跨域的 Kimi 额度 API。
 */
(function () {
  'use strict';

  const QUOTA_INTERVAL_MS = 60_000;
  const ROUTE_POLL_INTERVAL_MS = 1_000;
  const WS_RECONNECT_DELAY_MS = 3_000;
  const CREDENTIAL_STORAGE_KEY = 'kimi-web.server-credential';
  const SUBSCRIPTION_URL = 'https://www.kimi.com/membership/subscription?tab=quota';
  const MINI_STORAGE_KEY = 'kimi-statusbar.mini';
  const ONBOARDED_STORAGE_KEY = 'kimi-statusbar.onboarded';
  const {
    appendSpeedSample,
    boosterBalanceYuan,
    cacheReadPercentage,
    decodeSpeed,
    medianSpeed,
    normalizeUsage,
    totalInputTokens
  } = globalThis.KimiMetrics;

  const STATUS_TEXT = {
    idle: '空闲',
    thinking: '思考中',
    running: '运行中',
    offline: '未连接',
    unauthorized: '未授权'
  };

  let token = '';
  let sessionId = '';
  let ws = null;
  let reconnectTimer = null;
  let quotaTimer = null;
  let routeTimer = null;
  let quotaAuthRequired = false;
  let oauthStarting = false;
  let pageActivated = false;
  let disposed = false;
  let lastSeq = 0;
  let sessionRequestId = 0;
  let reconnectAttempts = 0;

  // 创建 widget 时缓存一次，后续渲染不再重复查询 DOM
  let els = null;

  const metrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    speedSamples: [],
    lastSpeed: 0,
    lastDuration: 0,
    agentStatus: 'idle'
  };

  /* ---------- 格式化 ---------- */

  function fmtNum(value) {
    const number = Number(value) || 0;
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(number);
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '--';
    if (ms < 1_000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}min`;
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function progressClass(percentage) {
    if (percentage >= 80) return 'ksb-high';
    if (percentage >= 50) return 'ksb-mid';
    return 'ksb-low';
  }

  /* ---------- 凭据与路由 ---------- */

  function readCredential() {
    try {
      const raw = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return typeof parsed?.credential === 'string' ? parsed.credential : '';
    } catch (error) {
      console.warn('[Kimi Status] 无法读取本地凭据', error);
      return '';
    }
  }

  function getSessionId() {
    return location.pathname.match(/^\/sessions\/([^/?#]+)/)?.[1] || '';
  }

  /* ---------- Widget DOM ---------- */

  function createWidget() {
    const widget = document.createElement('div');
    widget.id = 'ksb-widget';
    widget.setAttribute('role', 'status');
    widget.addEventListener('click', beginOAuth);
    widget.addEventListener('keydown', (event) => {
      if (quotaAuthRequired && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        beginOAuth();
      }
    });
    widget.innerHTML = `
      <div class="ksb-header">
        <span class="ksb-status-dot ksb-idle" id="ksb-status-dot"></span>
        <span class="ksb-title" title="点击重置并重新拉取数据"><span class="ksb-title-long">Kimi Code</span><span class="ksb-title-brief">Kimi</span></span>
        <span class="ksb-agent-status" id="ksb-agent-status">空闲</span>
        <span class="ksb-balance" id="ksb-balance" title="查看 / 充值额度">余额 --</span>
      </div>
      <div class="ksb-auth-banner" id="ksb-auth-banner" hidden>点击完成 Kimi 授权</div>
      <div class="ksb-stats">
        <div class="ksb-stat">
          <span class="ksb-stat-label">输入</span>
          <span class="ksb-stat-value" id="ksb-input-tokens">0</span>
        </div>
        <div class="ksb-stat">
          <span class="ksb-stat-label">输出</span>
          <span class="ksb-stat-value" id="ksb-output-tokens">0</span>
        </div>
        <div class="ksb-stat">
          <span class="ksb-stat-label">缓存命中</span>
          <span class="ksb-stat-value" id="ksb-cache-pct">--</span>
        </div>
        <div class="ksb-stat">
          <span class="ksb-stat-label">速度<span class="ksb-stat-sub" id="ksb-duration-val"></span></span>
          <span class="ksb-stat-value" id="ksb-speed-val">--</span>
        </div>
      </div>
      <div class="ksb-quota" title="点击切换 Mini 模式">
        <div class="ksb-quota-group">
          <div class="ksb-quota-head">
            <span class="ksb-quota-label">5h</span>
            <span class="ksb-reset" id="ksb-5h-reset"><span class="ksb-reset-full"></span><span class="ksb-reset-short"></span></span>
            <span class="ksb-quota-pct" id="ksb-5h-pct">--</span>
          </div>
          <div class="ksb-progress"><div class="ksb-progress-fill ksb-low" id="ksb-5h-fill" style="width:0%"></div></div>
        </div>
        <div class="ksb-quota-group">
          <div class="ksb-quota-head">
            <span class="ksb-quota-label">本周</span>
            <span class="ksb-reset" id="ksb-week-reset"><span class="ksb-reset-full"></span><span class="ksb-reset-short"></span></span>
            <span class="ksb-quota-pct" id="ksb-week-pct">--</span>
          </div>
          <div class="ksb-progress"><div class="ksb-progress-fill ksb-low" id="ksb-week-fill" style="width:0%"></div></div>
        </div>
        <span class="ksb-chevron">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1.5 5L4 2.5L6.5 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </div>
    `;

    // 余额 → 充值页；标题 → 手动刷新；额度行 → Mini 模式
    widget.querySelector('.ksb-balance').addEventListener('click', (event) => {
      event.stopPropagation();
      window.open(SUBSCRIPTION_URL, '_blank');
    });
    widget.querySelector('.ksb-title').addEventListener('click', (event) => {
      event.stopPropagation();
      manualRefresh();
    });
    widget.querySelector('.ksb-quota').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleMini();
    });

    try {
      if (localStorage.getItem(MINI_STORAGE_KEY) === '1') widget.classList.add('ksb-mini');
    } catch (error) {
      // localStorage 不可用时忽略，Mini 状态仅不持久化
    }

    return widget;
  }

  function cacheElements() {
    const byId = (id) => document.getElementById(id);
    els = {
      widget: byId('ksb-widget'),
      statusDot: byId('ksb-status-dot'),
      balance: byId('ksb-balance'),
      authBanner: byId('ksb-auth-banner'),
      inputTokens: byId('ksb-input-tokens'),
      outputTokens: byId('ksb-output-tokens'),
      cachePct: byId('ksb-cache-pct'),
      speedVal: byId('ksb-speed-val'),
      durationVal: byId('ksb-duration-val'),
      agentStatus: byId('ksb-agent-status'),
      quota: {
        '5h': { fill: byId('ksb-5h-fill'), pct: byId('ksb-5h-pct'), reset: byId('ksb-5h-reset') },
        week: { fill: byId('ksb-week-fill'), pct: byId('ksb-week-pct'), reset: byId('ksb-week-reset') }
      }
    };
  }

  function ensureWidget() {
    if (document.getElementById('ksb-widget')) {
      // SPA 可能重建 sidebar，导致缓存的引用失效
      if (!els || !els.widget.isConnected) cacheElements();
      return true;
    }
    const column = document.querySelector('aside.side > .col');
    if (!column) return false;
    const footer = column.querySelector('.side-footer');
    const widget = createWidget();
    footer ? column.insertBefore(widget, footer) : column.appendChild(widget);
    cacheElements();
    renderAll();
    return true;
  }

  function setConnectionHint(text) {
    if (els?.widget) els.widget.title = text || '';
  }

  /* ---------- 交互：手动刷新 / Mini 模式 ---------- */

  function manualRefresh() {
    setConnectionHint('正在刷新…');
    fetchQuota();
    // 重置全部累计指标（含上轮耗时/速度），重新拉快照并重建 WebSocket
    if (sessionId && token) startSession(sessionId);
  }

  function toggleMini() {
    const widget = document.getElementById('ksb-widget');
    if (!widget) return;
    const mini = widget.classList.toggle('ksb-mini');
    try {
      localStorage.setItem(MINI_STORAGE_KEY, mini ? '1' : '0');
    } catch (error) {
      // localStorage 不可用时忽略，Mini 状态仅不持久化
    }
    setConnectionHint(mini ? 'Mini 模式：点击额度行展开' : 'Kimi Status 已连接');
  }

  /* ---------- 新手引导 ---------- */

  function maybeShowGuide() {
    if (document.getElementById('ksb-guide')) return;
    try {
      if (localStorage.getItem(ONBOARDED_STORAGE_KEY)) return;
    } catch (error) {
      return;
    }

    const guide = document.createElement('div');
    guide.id = 'ksb-guide';
    guide.innerHTML = `
      <div class="ksb-guide-title">Kimi Code Monitor 快速上手</div>
      <div class="ksb-guide-item">
        <span class="ksb-guide-key">授权</span>
        <span>首次使用点击状态栏，按提示完成一次设备授权；之后如需重新授权或切换账户，点浏览器工具栏的扩展图标操作</span>
      </div>
      <div class="ksb-guide-item">
        <span class="ksb-guide-key">状态灯</span>
        <span><i class="ksb-guide-dot g-gray"></i>空闲&ensp;<i class="ksb-guide-dot g-blue"></i>工作中&ensp;<i class="ksb-guide-dot g-red"></i>未授权/未连接</span>
      </div>
      <div class="ksb-guide-item">
        <span class="ksb-guide-key">输入/输出</span>
        <span>当前会话累计的 token 用量</span>
      </div>
      <div class="ksb-guide-item">
        <span class="ksb-guide-key">缓存命中</span>
        <span>输入中命中 KV 缓存的比例，越高越省额度</span>
      </div>
      <div class="ksb-guide-item">
        <span class="ksb-guide-key">速度</span>
        <span>最近一步的生成速度（tok/s），右侧小字是上一轮回复总耗时</span>
      </div>
      <div class="ksb-guide-item">
        <span class="ksb-guide-key">余额</span>
        <span>打开 Kimi 月额度详情与充值页面</span>
      </div>
      <div class="ksb-guide-item">
        <span class="ksb-guide-key">标题</span>
        <span>点击重置指标并重新拉取数据</span>
      </div>
      <div class="ksb-guide-item">
        <span class="ksb-guide-key">额度行</span>
        <span>5 小时与本周的额度占用，标签旁小字是距重置的剩余时间；点击这一行切换 Mini 模式</span>
      </div>
      <button type="button" class="ksb-guide-btn">我知道了</button>
    `;
    guide.querySelector('.ksb-guide-btn').addEventListener('click', () => {
      try {
        localStorage.setItem(ONBOARDED_STORAGE_KEY, '1');
      } catch (error) {
        // 写入失败也只影响下次是否再显示
      }
      guide.remove();
    });
    document.body.appendChild(guide);
  }

  /* ---------- 渲染 ---------- */

  function updateProgress(prefix, percentage) {
    const safePercentage = Math.max(0, Math.min(100, Math.round(percentage)));
    const target = els?.quota[prefix];
    if (!target) return;
    if (target.fill) {
      target.fill.style.width = `${safePercentage}%`;
      target.fill.className = `ksb-progress-fill ${progressClass(safePercentage)}`;
    }
    if (target.pct) {
      target.pct.textContent = `${safePercentage}%`;
      target.pct.className = `ksb-quota-pct ${progressClass(safePercentage)}`;
    }
  }

  function updateBalance(wallet) {
    if (!els?.balance) return;
    const balanceYuan = boosterBalanceYuan(wallet);
    els.balance.textContent = balanceYuan != null
      ? `¥${balanceYuan.toFixed(2)}`
      : '余额 --';
  }

  function updateTokenDisplay() {
    if (!els) return;
    if (els.inputTokens) els.inputTokens.textContent = fmtNum(totalInputTokens(metrics));
    if (els.outputTokens) els.outputTokens.textContent = fmtNum(metrics.outputTokens);
  }

  function updateCacheDisplay() {
    if (!els?.cachePct) return;
    const percentage = cacheReadPercentage(metrics);
    els.cachePct.textContent = percentage != null
      ? `${percentage}%`
      : '--';
  }

  function updatePerfDisplay() {
    if (!els) return;
    if (els.speedVal) {
      els.speedVal.textContent = metrics.lastSpeed > 0 ? `${metrics.lastSpeed} tok/s` : '--';
    }
    if (els.durationVal) {
      els.durationVal.textContent = metrics.lastDuration > 0
        ? ` · 上轮 ${fmtDuration(metrics.lastDuration)}`
        : '';
    }
  }

  function setAgentStatus(status) {
    metrics.agentStatus = status;
    if (!els) return;
    // 未授权时状态灯恒红（除非 WS 已断开，优先显示未连接）
    const display = quotaAuthRequired && status !== 'offline' ? 'unauthorized' : status;
    if (els.statusDot) els.statusDot.className = `ksb-status-dot ksb-${display}`;
    if (els.agentStatus) els.agentStatus.textContent = STATUS_TEXT[display] || display;
  }

  function renderAll() {
    updateTokenDisplay();
    updateCacheDisplay();
    updatePerfDisplay();
    setAgentStatus(metrics.agentStatus);
  }

  /* ---------- 额度与授权 ---------- */

  // 额度窗口的重置时间戳（来自 API 的 resetTime，ISO8601）
  const quotaResetAt = { '5h': null, week: null };
  let resetRefetchTimer = null;

  function parseResetTime(value) {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : null;
  }

  // 紧凑格式（额度行内）：45m / 2h30m / 3d5h，与 macOS 菜单栏应用同精度
  function fmtCountdown(diffMs) {
    const totalMin = Math.floor(diffMs / 60_000);
    if (totalMin < 1) return '即将重置';
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    if (hours < 1) return `${totalMin}m`;
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    if (days >= 1) return `${days}d${restHours ? `${restHours}h` : ''}`;
    return `${hours}h${minutes ? `${minutes}m` : ''}`;
  }

  // 窄宽度下的单单位格式：45m / 2h / 3d
  function fmtCountdownShort(diffMs) {
    const totalMin = Math.floor(diffMs / 60_000);
    if (totalMin < 1) return '即将重置';
    const hours = Math.floor(totalMin / 60);
    if (hours < 1) return `${totalMin}m`;
    const days = Math.floor(hours / 24);
    if (days >= 1) return `${days}d`;
    return `${hours}h`;
  }

  // 完整格式（tooltip）：2小时30分钟后重置（07-23 15:00）
  function fmtCountdownLong(diffMs, resetMs) {
    const totalMin = Math.floor(diffMs / 60_000);
    const date = new Date(resetMs);
    const abs = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (totalMin < 1) return '即将重置';
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;
    const days = Math.floor(hours / 24);
    const text = days >= 1
      ? `${days}天${hours % 24}小时后重置`
      : hours >= 1
        ? `${hours}小时${minutes}分钟后重置`
        : `${totalMin}分钟后重置`;
    return `${text}（${abs}）`;
  }

  function updateResetText(prefix, resetMs) {
    quotaResetAt[prefix] = resetMs;
    const element = els?.quota[prefix]?.reset;
    if (!element) return;
    const full = element.querySelector('.ksb-reset-full');
    const short = element.querySelector('.ksb-reset-short');
    if (!Number.isFinite(resetMs)) {
      if (full) full.textContent = '';
      if (short) short.textContent = '';
      setResetTooltip(prefix, '');
      return;
    }
    const diff = resetMs - Date.now();
    const text = diff > 0 ? fmtCountdown(diff) : '即将重置';
    if (full) full.textContent = text;
    if (short) short.textContent = diff > 0 ? fmtCountdownShort(diff) : '即将重置';
    setResetTooltip(prefix, fmtCountdownLong(Math.max(diff, 0), resetMs));
    // 到点重置后额度必然变化，提前补一次拉取
    if (diff <= 0 && !resetRefetchTimer) {
      resetRefetchTimer = setTimeout(() => {
        resetRefetchTimer = null;
        fetchQuota();
      }, 15_000);
    }
  }

  function setResetTooltip(prefix, text) {
    const group = els?.quota[prefix]?.pct?.closest('.ksb-quota-group');
    if (group) group.title = text;
  }

  function quotaPercentage(detail) {
    const limit = toNumber(detail?.limit);
    if (limit <= 0) return null;
    const explicitUsed = toNumber(detail?.used);
    const used = detail?.used != null
      ? explicitUsed
      : Math.max(0, limit - toNumber(detail?.remaining));
    return (used / limit) * 100;
  }

  async function fetchQuota() {
    if (!els?.widget || !chrome?.runtime?.sendMessage) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'quota.fetch' });
      if (!response?.ok) {
        if (response?.code === 'AUTH_REQUIRED') {
          setQuotaAuthRequired(true);
          return;
        }
        throw new Error(response?.error || '额度请求失败');
      }

      setQuotaAuthRequired(false);
      updateBalance(response.data?.boosterWallet);

      const weeklyPercentage = quotaPercentage(response.data?.usage);
      if (weeklyPercentage != null) updateProgress('week', weeklyPercentage);
      updateResetText('week', parseResetTime(response.data?.usage?.resetTime));

      const fiveHour = response.data?.limits?.find(
        (item) => toNumber(item?.window?.duration) === 300
      );
      const fiveHourPercentage = quotaPercentage(fiveHour?.detail);
      if (fiveHourPercentage != null) updateProgress('5h', fiveHourPercentage);
      updateResetText('5h', parseResetTime(fiveHour?.detail?.resetTime));
    } catch (error) {
      if (String(error?.message || error).includes('Extension context invalidated')) {
        // 扩展已重载，这个残留脚本立即停止所有活动，不再刷错误
        dispose();
        return;
      }
      console.warn('[Kimi Status] 额度更新失败', error);
      setConnectionHint(`额度更新失败：${error.message || error}`);
    }
  }

  function setQuotaAuthRequired(required) {
    quotaAuthRequired = required;
    if (!els?.widget) return;

    els.widget.classList.toggle('ksb-auth-required', required);
    els.widget.tabIndex = required ? 0 : -1;
    els.widget.setAttribute('role', required ? 'button' : 'status');
    if (els.authBanner) {
      els.authBanner.hidden = !required;
      if (required) els.authBanner.textContent = '点击完成 Kimi 授权';
    }
    // 授权状态变化会改变状态灯的显示（未授权恒红 / 恢复后回到真实状态）
    setAgentStatus(metrics.agentStatus);
    setConnectionHint(required ? '点击授权 Kimi 额度查询' : 'Kimi Status 已连接');
  }

  async function beginOAuth() {
    if (!quotaAuthRequired || oauthStarting) return;
    oauthStarting = true;
    try {
      setConnectionHint('正在打开 Kimi 授权页…');
      const response = await chrome.runtime.sendMessage({ type: 'oauth.start' });
      if (!response?.ok) throw new Error(response?.error || '无法开始授权');
      // 轮询由后台 service worker 驱动，授权页完成后自动关闭，面板自动恢复
      if (els.authBanner) {
        els.authBanner.textContent = '授权中，完成后自动恢复';
      }
      setConnectionHint('请在新打开的页面完成授权');
    } catch (error) {
      console.warn('[Kimi Status] 授权启动失败', error);
      setConnectionHint(`授权启动失败：${error.message || error}`);
    } finally {
      oauthStarting = false;
    }
  }

  /* ---------- 会话与 WebSocket ---------- */

  function resetMetrics() {
    metrics.inputTokens = 0;
    metrics.outputTokens = 0;
    metrics.cacheReadTokens = 0;
    metrics.cacheCreationTokens = 0;
    metrics.speedSamples = [];
    metrics.lastSpeed = 0;
    metrics.lastDuration = 0;
    metrics.agentStatus = 'idle';
    lastSeq = 0;
    renderAll();
  }

  async function loadSessionSnapshot(targetSessionId, targetToken, requestId) {
    if (!targetSessionId || !targetToken) return;
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(targetSessionId)}`, {
        headers: { Authorization: `Bearer ${targetToken}` },
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (
        requestId !== sessionRequestId ||
        targetSessionId !== sessionId ||
        targetToken !== token
      ) return;
      const usage = normalizeUsage(data.usage);
      metrics.inputTokens = usage.inputTokens;
      metrics.outputTokens = usage.outputTokens;
      metrics.cacheReadTokens = usage.cacheReadTokens;
      metrics.cacheCreationTokens = usage.cacheCreationTokens;
      metrics.agentStatus = data.busy || data.main_turn_active ? 'running' : 'idle';
      lastSeq = toNumber(data.last_seq);
      renderAll();
    } catch (error) {
      console.warn('[Kimi Status] 会话用量初始化失败，将从实时事件开始统计', error);
    }
  }

  function connectWebSocket() {
    if (disposed || !token || !sessionId || ws) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/api/v1/ws?client_id=kimi-statusbar`;

    try {
      ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
    } catch (error) {
      console.warn('[Kimi Status] WebSocket 创建失败', error);
      reconnectAttempts += 1;
      scheduleReconnect();
      return;
    }

    ws.onmessage = (event) => {
      try {
        handleWsMessage(JSON.parse(event.data));
      } catch (error) {
        console.warn('[Kimi Status] 忽略无法解析的 WebSocket 消息', error);
      }
    };

    ws.onclose = (event) => {
      ws = null;
      setAgentStatus('offline');
      setConnectionHint(`WebSocket 已断开（${event.code}${event.reason ? `: ${event.reason}` : ''}）`);
      reconnectAttempts += 1;
      scheduleReconnect();
    };

    ws.onerror = () => setConnectionHint('WebSocket 连接失败');
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    const exponentialDelay = Math.min(
      30_000,
      WS_RECONNECT_DELAY_MS * (2 ** Math.min(reconnectAttempts, 4))
    );
    const delay = Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function sendFrame(frame) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  function sendClientHello() {
    sendFrame({
      type: 'client_hello',
      id: `ksb-${Date.now()}`,
      payload: {
        client_id: 'kimi-statusbar',
        subscriptions: [sessionId],
        cursors: { [sessionId]: { seq: lastSeq } }
      }
    });
  }

  function handleWsMessage(message) {
    if (message.type === 'server_hello') {
      reconnectAttempts = 0;
      setConnectionHint('Kimi Status 已连接');
      // 重连成功后先回到空闲，后续事件（含游标补发的）会把状态修正过来
      if (metrics.agentStatus === 'offline') setAgentStatus('idle');
      sendClientHello();
      return;
    }

    if (message.type === 'ping') {
      sendFrame({ type: 'pong', payload: { nonce: message.payload?.nonce } });
      return;
    }

    if (message.session_id && message.session_id !== sessionId) return;
    if (message.seq != null) {
      const sequence = Number(message.seq);
      if (Number.isFinite(sequence)) {
        if (sequence <= lastSeq) return;
        lastSeq = sequence;
      }
    }
    const payload = message.payload || {};

    switch (message.type) {
      case 'turn.started':
        setAgentStatus('running');
        break;
      case 'turn.step.started':
        setAgentStatus('thinking');
        break;
      case 'turn.step.completed':
        handleStepCompleted(payload);
        // step 之间的间隙通常在执行工具，用绿色「运行中」和思考（蓝）区分
        setAgentStatus('running');
        break;
      case 'turn.ended':
      case 'turn.completed':
        metrics.lastDuration = toNumber(payload.durationMs ?? payload.duration_ms ?? payload.duration);
        setAgentStatus('idle');
        updatePerfDisplay();
        break;
      case 'event.session.work_changed':
        setAgentStatus(payload.busy || payload.main_turn_active ? 'running' : 'idle');
        break;
      case 'agent.status.updated':
        handleAgentStatus(payload);
        break;
      case 'error':
        console.warn('[Kimi Status] 服务器事件错误', payload);
        break;
    }
  }

  function handleAgentStatus(payload) {
    const status = payload.status || payload.agent_status;
    if (status === 'thinking' || status === 'processing') setAgentStatus('thinking');
    else if (status === 'running' || status === 'working') setAgentStatus('running');
    else if (status === 'idle' || status === 'waiting') setAgentStatus('idle');
  }

  function handleStepCompleted(payload) {
    const usage = normalizeUsage(payload.usage || payload.token_usage);

    metrics.inputTokens += usage.inputTokens;
    metrics.outputTokens += usage.outputTokens;
    metrics.cacheReadTokens += usage.cacheReadTokens;
    metrics.cacheCreationTokens += usage.cacheCreationTokens;

    const streamDuration = payload.llmStreamDurationMs ?? payload.llmServerDecodeMs;
    const speed = decodeSpeed(usage.outputTokens, streamDuration);
    if (speed != null) {
      metrics.speedSamples = appendSpeedSample(metrics.speedSamples, speed);
      metrics.lastSpeed = medianSpeed(metrics.speedSamples);
    } else {
      metrics.lastSpeed = 0;
    }
    renderAll();
  }

  function disconnectWebSocket() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (ws) {
      const current = ws;
      ws = null;
      current.onclose = null;
      current.close(1000, 'session changed');
    }
  }

  async function startSession(nextSessionId) {
    const requestId = ++sessionRequestId;
    disconnectWebSocket();
    sessionId = nextSessionId;
    resetMetrics();
    if (!sessionId || !token) return;
    const targetToken = token;
    await loadSessionSnapshot(nextSessionId, targetToken, requestId);
    if (
      !disposed &&
      requestId === sessionRequestId &&
      sessionId === nextSessionId &&
      token === targetToken
    ) connectWebSocket();
  }

  /* ---------- 生命周期 ---------- */

  function activatePage() {
    if (pageActivated || disposed) return;
    pageActivated = true;
    token = readCredential();
    const initialSessionId = getSessionId();
    maybeShowGuide();
    fetchQuota();
    startSession(initialSessionId);
    quotaTimer = setInterval(fetchQuota, QUOTA_INTERVAL_MS);
  }

  function checkPageState() {
    // 扩展重载后 chrome.runtime.id 消失，残留脚本自我了断
    if (!chrome?.runtime?.id) {
      dispose();
      return;
    }
    if (!ensureWidget()) return;
    if (!pageActivated) activatePage();

    const nextToken = readCredential();
    const nextSessionId = getSessionId();
    if (nextToken !== token) {
      token = nextToken;
      fetchQuota();
      startSession(nextSessionId);
      return;
    }
    if (nextSessionId !== sessionId) startSession(nextSessionId);
    else if (sessionId && token && !ws && !reconnectTimer) connectWebSocket();
  }

  function handleStorageChanged(changes, area) {
    if (area !== 'local' || !changes.kimiOnboardingResetAt) return;
    try {
      localStorage.removeItem(ONBOARDED_STORAGE_KEY);
    } catch (error) {
      // 忽略，下次刷新页面仍会显示
    }
    if (pageActivated) {
      maybeShowGuide();
      setQuotaAuthRequired(true);
      updateBalance(null);
    }
  }

  function handleRuntimeMessage(message) {
    if (message?.type === 'auth.completed') fetchQuota();
    if (message?.type === 'auth.cleared') {
      setQuotaAuthRequired(true);
      updateBalance(null);
    }
  }

  function handlePageHide(event) {
    if (event.persisted) {
      disconnectWebSocket();
      return;
    }
    dispose();
  }

  function handlePageShow(event) {
    if (event.persisted && !disposed) checkPageState();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    sessionRequestId += 1;
    disconnectWebSocket();
    if (quotaTimer) clearInterval(quotaTimer);
    if (routeTimer) clearInterval(routeTimer);
    if (resetRefetchTimer) clearTimeout(resetRefetchTimer);
    // 扩展重载后 Chrome 不会自动重新注入 content script，
    // 残留脚本退出时一并移除 widget，避免留下一个永远灰色的「僵尸面板」
    if (els?.widget) els.widget.remove();
    document.getElementById('ksb-guide')?.remove();
    try {
      chrome.storage.onChanged.removeListener(handleStorageChanged);
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    } catch (error) {
      // 扩展上下文失效时监听器会随上下文一起销毁
    }
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('pageshow', handlePageShow);
    els = null;
  }

  function init() {
    checkPageState();
    routeTimer = setInterval(checkPageState, ROUTE_POLL_INTERVAL_MS);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    chrome.storage.onChanged.addListener(handleStorageChanged);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
