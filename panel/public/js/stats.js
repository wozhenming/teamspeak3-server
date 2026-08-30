'use strict';

/**
 * 数据统计页：汇总指标图表 + 用户连接记录历史。
 */

window.TSPages = window.TSPages || {};

TSPages.stats = async function () {
  const content = document.getElementById('page-content');
  const ago = (tsMs) => {
    if (!tsMs) return '-';
    const s = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  };

  // 数据统计页：全量数据（最多 7 天）
  const RANGES = [
    { m: 30, label: '30分' },
    { m: 60, label: '1小时' },
    { m: 360, label: '6小时' },
    { m: 1440, label: '24小时' },
    { m: 4320, label: '3天' },
    { m: 10080, label: '7天' },
  ];
  let range = 60;

  content.innerHTML = `
    <div class="grid grid-4" id="stat-cards">
      <div class="card stat-card"><span class="stat-label">累计独立用户</span><span class="stat-value" id="s-total-users">-</span></div>
      <div class="card stat-card"><span class="stat-label">累计连接次数</span><span class="stat-value" id="s-total-conn">-</span></div>
      <div class="card stat-card"><span class="stat-label">当前在线</span><span class="stat-value" id="s-online">-</span></div>
      <div class="card stat-card"><span class="stat-label">平均连接时长</span><span class="stat-value" id="s-avg-dur">-</span></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h3><span>在线人数趋势
        <span class="range-btns" id="stats-range-btns"></span>
      </span></h3><div class="chart-box"><canvas id="chart-s-clients"></canvas></div></div>
      <div class="card"><h3><span>带宽使用<span class="muted">（近 <span id="stats-range-label">1 小时</span>）</span></span></h3><div class="chart-box"><canvas id="chart-s-bandwidth"></canvas></div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3><span>用户连接记录</span>
        <button class="btn btn-sm" id="btn-refresh-stats">刷新</button>
      </h3>
      <div id="connections-table"><div class="empty">加载中…</div></div>
    </div>`;

  // ---------- 时间范围按钮 ----------
  const rangeBtns = document.getElementById('stats-range-btns');
  rangeBtns.innerHTML = RANGES.map(r =>
    `<button class="btn btn-sm range-btn${r.m === range ? ' active' : ''}" data-m="${r.m}">${r.label}</button>`).join('');

  let clientsChart = null;
  let bandwidthChart = null;

  function ensureCharts() {
    if (clientsChart || !window.Chart) return;
    clientsChart = new Chart(document.getElementById('chart-s-clients'), {
      type: 'line',
      data: { labels: [], datasets: [{ label: '在线人数', data: [], borderColor: '#3d7eff', backgroundColor: 'rgba(61,126,255,.12)', fill: true, tension: .3, pointRadius: 0, spanGaps: true }] },
      options: { animation: false, maintainAspectRatio: false, responsive: true, plugins: { legend: { display: false } },
        scales: { x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
    bandwidthChart = new Chart(document.getElementById('chart-s-bandwidth'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: '上行 Kbit/s', data: [], borderColor: '#2ecc71', tension: .3, pointRadius: 0, spanGaps: true },
        { label: '下行 Kbit/s', data: [], borderColor: '#f1c40f', tension: .3, pointRadius: 0, spanGaps: true },
      ]},
      options: { animation: false, maintainAspectRatio: false, responsive: true,
        scales: { x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { beginAtZero: true } } },
    });
  }

  // 与仪表盘相同的动态步长网格轴
  function renderCharts(historyCache) {
    ensureCharts();
    if (!clientsChart || !historyCache) return;
    const now = Date.now();
    const win = range * 60000;
    const STEP = Math.max(60000, Math.ceil(win / 120));
    const start = Math.floor((now - win) / STEP) * STEP;
    const count = Math.max(1, Math.ceil((now - start) / STEP));
    const labels = [];
    const clientsData = new Array(count).fill(null);
    const upData = new Array(count).fill(null);
    const downData = new Array(count).fill(null);
    for (let i = 0; i < count; i++) labels.push(new Date(start + i * STEP).toLocaleTimeString('zh-CN', { hour12: false }));
    for (const p of historyCache) {
      const idx = Math.round((p.t - start) / STEP);
      if (idx >= 0 && idx < count) { clientsData[idx] = p.clients; upData[idx] = p.up; downData[idx] = p.down; }
    }
    const lineOk = clientsData.filter((v) => v !== null).length >= 2;
    clientsChart.data.labels = labels;
    clientsChart.data.datasets[0].data = clientsData;
    clientsChart.data.datasets[0].pointRadius = lineOk ? 0 : 2;
    clientsChart.update('none');
    bandwidthChart.data.labels = labels;
    bandwidthChart.data.datasets[0].data = upData;
    bandwidthChart.data.datasets[1].data = downData;
    bandwidthChart.data.datasets[0].pointRadius = lineOk ? 0 : 1.5;
    bandwidthChart.data.datasets[1].pointRadius = lineOk ? 0 : 1.5;
    bandwidthChart.update('none');
  }

  // ---------- 范围切换 ----------
  rangeBtns.addEventListener('click', async (e) => {
    const btn = e.target.closest('.range-btn');
    if (!btn) return;
    range = parseInt(btn.dataset.m, 10);
    rangeBtns.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('stats-range-label').textContent = RANGES.find(r => r.m === range).label;
    await loadCharts();
  });

  async function loadCharts() {
    try {
      const d = await API.overviewHistory(range);
      renderCharts(d.points || []);
    } catch (e) { /* 静默 */ }
  }

  // ---------- 汇总 + 用户表 ----------
  function fmtDur(sec) {
    if (sec == null || sec <= 0) return '-';
    return TSUtils.fmtDuration(sec);
  }

  async function load() {
    try {
      const data = await API.statsConnections(500);
      const s = data.stats || {};
      document.getElementById('s-total-users').textContent = s.total_users || 0;
      document.getElementById('s-total-conn').textContent = s.total_connections || 0;
      document.getElementById('s-online').textContent = s.online_now || 0;
      document.getElementById('s-avg-dur').textContent = fmtDur(s.avg_connection_seconds);

      const users = data.users || [];
      const box = document.getElementById('connections-table');
      if (!users.length) {
        box.innerHTML = '<div class="empty">暂无用户记录（面板启动后会自动记录连接）</div>';
        return;
      }
      box.innerHTML = `<div class="table-wrap"><table>
        <thead><tr>
          <th>昵称</th><th>UID</th><th>国家</th><th>状态</th>
          <th>首次连接</th><th>最后在线</th><th class="num">总连接次数</th>
        </tr></thead>
        <tbody>${users.map(u => `<tr>
          <td>${TSUtils.escapeHtml(u.nickname)}</td>
          <td class="mono muted" title="${TSUtils.escapeHtml(u.uid)}">${TSUtils.escapeHtml((u.uid || '-').slice(0, 16))}</td>
          <td>${TSUtils.escapeHtml(u.country || '-')}</td>
          <td>${u.is_online
            ? '<span class="badge green">在线</span>'
            : '<span class="badge">离线</span>'}</td>
          <td>${TSUtils.fmtTime(u.first_seen / 1000)}</td>
          <td>${ago(u.last_seen)}</td>
          <td class="num">${u.total_connections || 0}</td>
        </tr>`).join('')}</tbody></table></div>`;
    } catch (e) {
      document.getElementById('connections-table').innerHTML =
        `<div class="alert error">${TSUtils.escapeHtml(e.message)}</div>`;
    }
  }

  document.getElementById('btn-refresh-stats').onclick = () => { loadCharts(); load(); };

  // 初始化：加载图表 + 表格
  await Promise.all([loadCharts(), load()]);
};
