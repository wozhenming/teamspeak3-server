'use strict';

/**
 * 面板 SPA 骨架：哈希路由、页面切换、服务器选择、连接状态。
 * 各页面实现挂载到 window.TSPages。
 */

(function () {
  const PAGES = {
    deploy: { title: '部署管理', render: () => TSPages.deploy() },
    dashboard: { title: '仪表盘', render: () => TSPages.dashboard() },
    users: { title: '用户管理', render: () => TSPages.users() },
    channels: { title: '频道管理', render: () => TSPages.channels() },
    stats: { title: '数据统计', render: () => TSPages.stats() },
    music: { title: '点歌', render: () => TSPages.music() },
  };

  let currentSid = null;

  // ---------- 页面生命周期：定时器登记与卸载 ----------
  // 页面切换时统一清理上一页遗留的定时器与资源，避免快速切页时
  // 旧页面的 setInterval 写入已销毁的 DOM（Cannot set ... of null）并造成页面卡死。
  let pageCleanup = null;
  let navToken = 0;
  const pageTimers = new Set();

  function trackTimer(id) { pageTimers.add(id); return id; }

  // 侧边栏切换后调用：Chart.js 图表随容器重绘
  window.resizeAllCharts = function resizeAllCharts() {
    if (typeof Chart === 'undefined') return;
    document.querySelectorAll('canvas').forEach(function (c) {
      try {
        var chart = Chart.getChart(c);
        if (chart) chart.resize();
      } catch (e) { /* 忽略 */ }
    });
  }

  // ResizeObserver：监听所有 .chart-box 容器尺寸变化，自动 resize 图表
  // （解决侧边栏折叠改变容器宽度时 Chart.js 不自动重绘的问题）
  if ('ResizeObserver' in window) {
    var chartRo = new ResizeObserver(function (entries) {
      entries.forEach(function (entry) {
        var canvas = entry.target.querySelector('canvas');
        if (canvas && typeof Chart !== 'undefined') {
          try {
            var chart = Chart.getChart(canvas);
            if (chart) chart.resize();
          } catch (e) { /* 忽略 */ }
        }
      });
    });
    // 页面切换时会重新注入 .chart-box，用 MutationObserver 监听动态添加
    var bodyObs = new MutationObserver(function () {
      document.querySelectorAll('.chart-box').forEach(function (el) {
        if (!el.dataset.observed) {
          el.dataset.observed = '1';
          try { chartRo.observe(el); } catch (e) { /* 忽略 */ }
        }
      });
    });
    bodyObs.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('.chart-box').forEach(function (el) {
      el.dataset.observed = '1';
      try { chartRo.observe(el); } catch (e) { /* 忽略 */ }
    });
  }

  // ---------- 全局工具 ----------
  // SVG 图标集（Feather 风格，统一替代 emoji）
  const ICON = (paths, extra) =>
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra || ''}>${paths}</svg>`;

  window.TSUtils = {
    icons: {
      edit: ICON('<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
      rocket: ICON('<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2 0-2.8-.8-.7-2.2-.7-3 .8z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>'),
      play: ICON('<path d="M5 3l14 9-14 9V3z"/>', 'fill="currentColor" stroke="none"'),
      zap: ICON('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'),
      help: ICON('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
      lock: ICON('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
      pause: ICON('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'),
      prev: ICON('<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/>'),
      next: ICON('<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>'),
      shuffle: ICON('<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 16 16 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>'),
      box: ICON('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/>'),
      sun: ICON('<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>'),
      moon: ICON('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
    },
    navToken: () => navToken,
    registerCleanup: (fn) => { if (typeof fn === 'function') pageCleanup = fn; },
    setInterval: (fn, ms) => trackTimer(setInterval(fn, ms)),
    setTimeout: (fn, ms) => {
      const id = setTimeout(() => { pageTimers.delete(id); fn(); }, ms);
      pageTimers.add(id);
      return id;
    },
    sid() {
      return currentSid;
    },
    setSid(sid) {
      currentSid = sid;
    },
    escapeHtml(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    fmtDuration(seconds) {
      if (seconds == null || isNaN(seconds)) return '-';
      const s = Math.max(0, Math.floor(seconds));
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (d > 0) return `${d}天 ${h}小时 ${m}分`;
      if (h > 0) return `${h}小时 ${m}分 ${sec}秒`;
      if (m > 0) return `${m}分 ${sec}秒`;
      return `${sec}秒`;
    },
    fmtBytes(b) {
      if (b == null || isNaN(b)) return '-';
      b = Number(b);
      if (b < 1024) return b + ' B';
      if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
      return (b / 1073741824).toFixed(2) + ' GB';
    },
    fmtKbps(v) {
      if (v == null || isNaN(v)) return '-';
      return Number(v).toFixed(1) + ' Kbit/s';
    },
    fmtTime(ts) {
      if (!ts) return '-';
      return new Date(ts * 1000).toLocaleString();
    },
    toast(msg, type) {
      const box = document.getElementById('toast-container');
      const el = document.createElement('div');
      el.className = 'toast ' + (type || '');
      el.textContent = msg;
      box.appendChild(el);
      setTimeout(() => el.remove(), 3500);
    },
    confirmModal(title, bodyHtml, onOk) {
      const overlay = document.getElementById('modal-overlay');
      const titleEl = document.getElementById('modal-title');
      const bodyEl = document.getElementById('modal-body');
      titleEl.textContent = title;
      bodyEl.innerHTML = bodyHtml;
      const footer = document.createElement('div');
      footer.className = 'modal-footer';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = '取消';
      const okBtn = document.createElement('button');
      okBtn.className = 'btn btn-danger';
      okBtn.textContent = '确认';
      footer.appendChild(cancel);
      footer.appendChild(okBtn);
      bodyEl.appendChild(footer);
      overlay.hidden = false;
      const close = () => { overlay.hidden = true; };
      cancel.onclick = close;
      document.getElementById('modal-close').onclick = close;
      overlay.onclick = (e) => { if (e.target === overlay) close(); };
      okBtn.onclick = async () => {
        okBtn.disabled = true;
        try { await onOk(); close(); } catch (e) { TSUtils.toast(e.message, 'error'); okBtn.disabled = false; }
      };
    },

    /**
     * 复制文本到剪贴板。
     * navigator.clipboard 仅在 HTTPS/localhost 可用（HTTP 部署下为 undefined），
     * 自动降级到 execCommand 方案。
     */
    copyText(text) {
      const value = String(text == null ? '' : text);
      const done = () => TSUtils.toast('已复制', 'success');
      const fail = () => TSUtils.toast('复制失败，请手动选择复制', 'error');

      const legacyCopy = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = value;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-9999px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, value.length);
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          ok ? done() : fail();
        } catch (e) {
          fail();
        }
      };

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(value).then(done, legacyCopy);
      } else {
        legacyCopy();
      }
    },
  };

  // ---------- 导航 ----------
  async function navigate() {
    const hash = location.hash || '#/dashboard';
    const name = (hash.replace(/^#\//, '').split('?')[0]) || 'dashboard';
    const page = PAGES[name];
    if (!page) { location.hash = '#/dashboard'; return; }
    document.querySelectorAll('.sidebar-nav a').forEach(a =>
      a.classList.toggle('active', a.dataset.page === name));
    document.getElementById('page-title').textContent = page.title;
    if (pageCleanup) { try { pageCleanup(); } catch (e) { /* 忽略卸载异常 */ } pageCleanup = null; }
    pageTimers.forEach((id) => { try { clearInterval(id); clearTimeout(id); } catch (e) { /* 忽略 */ } });
    pageTimers.clear();
    navToken++;
    try {
      await page.render();
    } catch (e) {
      TSUtils.toast(e.message, 'error');
      document.getElementById('page-content').innerHTML =
        `<div class="empty">加载失败：${TSUtils.escapeHtml(e.message)}</div>`;
    }
  }

  // ---------- 服务器下拉 ----------
  async function loadServers() {
    const sel = document.getElementById('server-select');
    try {
      const servers = await API.servers();
      if (!servers || !servers.length) {
        sel.hidden = true;
        return;
      }
      sel.innerHTML = '';
      for (const s of servers) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `服务器 #${s.id}${s.name ? ' - ' + s.name : ''}`;
        sel.appendChild(opt);
      }
      if (!currentSid || !servers.some(s => String(s.id) === String(currentSid))) {
        currentSid = servers[0].id;
      }
      sel.value = currentSid;
      sel.hidden = false;
    } catch (e) {
      sel.hidden = true;
      console.warn('加载服务器列表失败:', e.message);
    }
  }

  // ---------- 连接状态 ----------
  async function refreshConnStatus() {
    const box = document.getElementById('conn-status');
    const text = document.getElementById('conn-status-text');
    try {
      const data = await API.overview(currentSid || 1);
      const online = data && data.server && data.server.status !== 'offline' && !data.error;
      box.classList.remove('online', 'offline');
      if (online) {
        box.classList.add('online');
        text.textContent = `已连接 · ${(data.server.name || 'TeamSpeak 3 服务器')}`;
      } else {
        box.classList.add('offline');
        text.textContent = '服务器离线';
      }
    } catch (e) {
      box.classList.remove('online');
      box.classList.add('offline');
      text.textContent = '无法连接';
    }
  }

  // ---------- 主题切换（暗色/亮色，localStorage 记忆） ----------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ts3-theme', theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.innerHTML = theme === 'dark' ? TSUtils.icons.sun : TSUtils.icons.moon;
      btn.title = theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题';
    }
  }

  function initTheme() {
    const saved = localStorage.getItem('ts3-theme') || 'dark';
    applyTheme(saved);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.onclick = () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
      };
    }
  }

  // ---------- 侧边栏导航点击后自动收起（移动端） ----------
  (function () {
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebar-overlay');
    var main = document.getElementById('main');
    if (sidebar) {
      sidebar.querySelectorAll('.sidebar-nav a').forEach(function (a) {
        a.addEventListener('click', function () {
          if (window.innerWidth <= 1024) {
            sidebar.classList.remove('open');
            sidebar.style.transform = '';
            if (overlay) overlay.classList.remove('active');
            setTimeout(function () { resizeAllCharts(); }, 300);
          }
        });
      });
    }
  })();

  // ---------- 启动 ----------
  // 竞态防护：boot 必须等所有同步脚本（deploy/dashboard/users/channels.js）
  // 执行完毕（DOMContentLoaded 触发时同步脚本必然已执行），否则快速刷新时
  // /api/me 先返回、页面脚本后下载，会报 "TSPages.xxx is not a function"
  function start() {
    window.addEventListener('hashchange', navigate);
    document.getElementById('logout-btn').onclick = async () => {
      try { await API.logout(); } catch (e) { /* 忽略 */ }
      location.href = '/login.html';
    };
    document.getElementById('server-select').onchange = (e) => {
      currentSid = e.target.value;
      navigate();
      refreshConnStatus();
    };

    (async function boot() {
      initTheme();
      try {
        const me = await API.me();
        document.getElementById('current-user').textContent = me.username;
      } catch (e) {
        location.href = '/login.html';
        return;
      }
      await loadServers();
      await navigate();
      await refreshConnStatus();
      setInterval(refreshConnStatus, 15000);
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
