'use strict';

/**
 * 部署管理：前端引导式一键部署 TeamSpeak 3。
 *
 * 流程：① 环境检测 → ② 部署配置（生成 compose）→ ③ 启动服务（实时日志）
 *       → ④ 初始管理员凭证 → ⑤ serveradmin 查询密码配置
 */

window.TSPages = window.TSPages || {};

TSPages.deploy = async function () {
  const content = document.getElementById('page-content');
  const token = TSUtils.navToken();
  let status = null;
  let taskTimer = null;

  content.innerHTML = `
    <div id="deploy-alert"></div>
    <div id="mode-banner"></div>

    <div class="grid grid-2">
      <!-- ① 环境检测 -->
      <div class="card">
        <h3><span class="step-badge">1</span> 环境检测</h3>
        <div id="env-check">
          <div class="empty">检测中…</div>
        </div>
        <div style="margin-top:12px" class="muted" id="env-guide"></div>
      </div>

      <!-- ② 部署配置（独立模式为表单；容器化模式为说明） -->
      <div class="card" id="card-config">
        <h3><span class="step-badge">2</span> 部署配置</h3>
        <div class="deploy-form" id="config-form">
          <div class="form-row">
            <label>容器名<input type="text" id="cfg-name" value="teamspeak-server"></label>
            <label>语音端口 (UDP)<input type="number" id="cfg-voice" value="9987"></label>
          </div>
          <div class="form-row">
            <label>文件传输端口<input type="number" id="cfg-file" value="30033"></label>
            <label>ServerQuery 端口<input type="number" id="cfg-query" value="10011"></label>
          </div>
          <pre class="yaml-preview" id="compose-preview">（配置后自动预览）</pre>
          <div class="modal-footer">
            <button class="btn btn-sm" id="btn-preview">刷新预览</button>
            <button class="btn btn-sm btn-primary" id="btn-compose">生成 docker-compose.yml</button>
          </div>
          <div class="muted" id="compose-file-info" style="font-size:12px"></div>
        </div>
        <div id="config-note" hidden></div>
      </div>
    </div>

    <!-- ③ 启动服务 -->
    <div class="card" style="margin-top:16px">
      <h3><span class="step-badge">3</span> 启动服务
        <span id="container-state" class="badge">未知</span>
      </h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <button class="btn btn-primary" id="btn-up">${TSUtils.icons.rocket} 启动服务</button>
        <button class="btn" id="btn-restart">重启</button>
        <button class="btn btn-danger" id="btn-down">停止</button>
        <button class="btn" id="btn-refresh-status">刷新状态</button>
      </div>
      <div class="term" id="task-console"><div class="term-empty">任务输出将显示在这里…</div></div>
    </div>

    <!-- ④ 初始管理员凭证 -->
    <div class="card" style="margin-top:16px">
      <h3><span class="step-badge">4</span> 初始管理员凭证
        <button class="btn btn-sm" id="btn-credentials">查看 / 重新提取</button>
      </h3>
      <div id="credentials-box"><div class="empty">凭证仅在首次启动生成，已自动保存到面板数据卷（容器重建不丢失）</div></div>
    </div>

    <!-- ⑤ 查询密码配置 -->
    <div class="card" style="margin-top:16px">
      <h3><span class="step-badge">5</span> serveradmin 查询密码配置</h3>
      <div class="alert" style="margin-bottom:12px">
        面板、点歌机器人都通过 <b>ServerQuery</b>（端口 10011）管理 TeamSpeak 3，
        使用上方 ④ 提取到的 <b>serveradmin 密码</b>。粘贴保存即可（立即生效，无需重启面板）：
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap">
        <input type="text" id="query-password-input" class="input" style="flex:1;min-width:260px" placeholder="粘贴 serveradmin 密码后保存（来自步骤 ④ 的日志或凭证副本）">
        <button class="btn btn-primary" id="btn-save-password">保存</button>
        <button class="btn" id="btn-check">检测连接</button>
      </div>
      <div id="query-password-result" style="margin-top:10px"></div>
    </div>

    <!-- ⑥ 服务器日志 -->
    <div class="card" style="margin-top:16px">
      <h3><span class="step-badge">6</span> 服务器日志
        <button class="btn btn-sm" id="btn-logs">刷新日志</button>
      </h3>
      <div class="term term-tall" id="logs-console"><div class="term-empty">暂无日志</div></div>
    </div>`;

  // ============ 工具 ============
  function $(id) { return document.getElementById(id); }

  function escape(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function copyText(text) {
    TSUtils.copyText(text);
  }

  function setTerm(el, lines, emptyText) {
    if (!lines || !lines.length) {
      el.innerHTML = `<div class="term-empty">${emptyText || '暂无输出'}</div>`;
      return;
    }
    el.innerHTML = lines.map(l => `<div>${escape(l)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }

  function taskDoneMessage(statusCode) {
    return statusCode === 0 ? '任务完成 ✓' : `任务失败（退出码 ${statusCode}）`;
  }

  // ============ ① 环境检测 ============
  async function loadStatus() {
    try {
      status = await API.deployStatus();
      renderEnv();
      renderMode();
      renderContainer();
      renderComposeInfo();
      renderQueryState();
    } catch (e) {
      $('env-check').innerHTML = `<div class="empty">状态获取失败：${escape(e.message)}</div>`;
    }
  }

  // 容器化模式 / 独立模式界面切换
  function renderMode() {
    const isContainer = status && status.mode === 'container';
    const banner = $('mode-banner');
    const configForm = $('config-form');
    const configNote = $('config-note');

    if (isContainer) {
      banner.innerHTML = `<div class="alert">${TSUtils.icons.box} 容器化模式：TS3 服务器与本面板由项目根目录 <b>docker-compose.yml</b> 统一管理
        （docker compose up -d 启动）。本页提供初始凭证提取、查询密码配置、日志查看与 TS3 容器快捷启停。</div>`;
      // ② 不消失：显示为说明卡片（端口/密码等由根目录 compose 管理）
      if (configForm) configForm.hidden = true;
      if (configNote) {
        configNote.hidden = false;
        configNote.innerHTML = `
          <div class="alert" style="margin-bottom:10px">当前由项目根目录 <b>docker-compose.yml</b> 统一管理，无需在此配置。
            常用调整在服务器上完成：</div>
          <div class="cmd-box"><code>nano docker-compose.yml        # 端口映射、环境变量</code></div>
          <div class="cmd-box"><code>cp .env.example .env && nano .env   # 面板密码/端口</code></div>
          <div class="cmd-box"><code>docker compose up -d          # 应用修改</code></div>
          <div class="muted" style="font-size:12px;margin-top:6px">修改后到 ① 环境检测 点「刷新状态」即可看到新配置生效。</div>`;
      }
      $('btn-up').innerHTML = `${TSUtils.icons.play} 启动 TS3 容器`;
      $('btn-up').title = 'docker start teamspeak-server';
      $('btn-restart').innerHTML = '重启容器';
      $('btn-down').innerHTML = '停止容器';
    } else {
      banner.innerHTML = '';
      if (configForm) configForm.hidden = false;
      if (configNote) configNote.hidden = true;
      $('btn-up').innerHTML = `${TSUtils.icons.rocket} 启动服务（docker compose up -d）`;
      $('btn-up').title = '';
      $('btn-restart').innerHTML = '重启';
      $('btn-down').innerHTML = '停止';
    }
  }

  function renderEnv() {
    const d = status.docker;
    const isContainer = status.mode === 'container';
    const box = $('env-check');
    const composeCell = isContainer
      ? '<span class="badge green">由主机 compose 管理</span>'
      : (d.compose
        ? `<span class="badge green">可用</span> ${escape(d.compose.command)} ${escape(d.compose.version || '')}`
        : '<span class="badge red">不可用</span>');
    const rows = [
      ['Docker', d.installed ? `<span class="badge green">已安装</span> ${escape(d.dockerVersion || '')}` : '<span class="badge red">未安装</span>'],
      ['Compose', composeCell],
      ['Docker 引擎', d.engineOk ? '<span class="badge green">连接正常</span>' : `<span class="badge red">不可用</span>${d.engineError ? '<div class="muted" style="font-size:12px">' + escape(d.engineError) + '</div>' : ''}`],
    ];
    box.innerHTML = '<table>' + rows.map(r => `<tr><td class="muted">${r[0]}</td><td>${r[1]}</td></tr>`).join('') + '</table>';

    const guide = $('env-guide');
    if (!isContainer && (!d.installed || !d.compose)) {
      const cmds = status.dockerInstallGuide || [];
      guide.innerHTML = '<div class="alert">Docker/Compose 未就绪，请按以下命令安装后点击「刷新状态」：</div>' +
        cmds.map(c => `<div class="cmd-box"><code>${escape(c)}</code><button class="btn btn-sm" data-copy="${escape(c)}">复制</button></div>`).join('');
    } else if (!d.engineOk) {
      guide.innerHTML = '<div class="alert">Docker 引擎不可用，请确认 Docker 服务已启动（如 systemctl start docker）。</div>';
    } else {
      guide.innerHTML = '';
    }
  }

  function renderContainer() {
    const c = status.container;
    const el = $('container-state');
    if (!c.exists) {
      el.className = 'badge';
      el.textContent = '容器未创建';
    } else {
      el.className = 'badge ' + (c.running ? 'green' : 'red');
      el.textContent = c.running ? '运行中' : '已停止';
      el.title = c.status + '\n' + (c.ports || '');
    }
  }

  function renderComposeInfo() {
    const f = status.composeFile;
    $('compose-file-info').textContent = f.exists ? `✓ 已生成：${f.path}` : '尚未生成 docker-compose.yml';
  }

  function renderQueryState() {
    const w = status.query || {};
    $('query-password-result').innerHTML = `
      <div class="conn-status ${w.reachable ? 'online' : (w.passwordConfigured ? 'offline' : '')}">
        <span class="dot"></span>
        <span>${w.reachable ? `ServerQuery 已连通（版本 ${escape(w.version || '')}）` : (w.passwordConfigured ? `ServerQuery 不可达：${escape(w.error || '')}` : '查询密码未配置')}</span>
      </div>`;
  }

  // ============ ② 部署配置（仅独立模式） ============
  function previewParams() {
    return {
      name: $('cfg-name').value.trim() || 'teamspeak-server',
      voice: $('cfg-voice').value || 9987,
      file: $('cfg-file').value || 30033,
      query: $('cfg-query').value || 10011,
    };
  }

  async function refreshPreview() {
    if (!status || status.mode === 'container') return;
    try {
      const d = await API.deployPreview(previewParams());
      $('compose-preview').textContent = d.content;
    } catch (e) {
      $('compose-preview').textContent = '预览失败：' + e.message;
    }
  }

  async function saveCompose(force) {
    const btn = $('btn-compose');
    btn.disabled = true;
    try {
      const d = await API.deployCompose({ ...previewParams(), force });
      TSUtils.toast('docker-compose.yml 已生成', 'success');
      $('compose-file-info').textContent = `✓ 已生成：${d.path}`;
      await loadStatus();
    } catch (e) {
      if (e.message.includes('已存在') && confirm('docker-compose.yml 已存在，确定覆盖吗？')) {
        return saveCompose(true);
      }
      TSUtils.toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ============ ③ 启动服务 ============
  async function runTask(apiCall, label, done) {
    const consoleEl = $('task-console');
    setTerm(consoleEl, [`[${label}] 执行中…`]);
    let d = null;
    try {
      d = await apiCall();
    } catch (e) {
      setTerm(consoleEl, [`[${label}] 提交失败：${e.message}`]);
      return;
    }
    // 容器化模式：操作即时完成（无 taskId）
    if (!d || !d.taskId) {
      setTerm(consoleEl, [`[${label}] 完成 ✓`]);
      if (done) done({ code: 0 });
      await loadStatus();
      return;
    }
    const taskId = d.taskId;
    if (taskTimer) clearInterval(taskTimer);
    taskTimer = TSUtils.setInterval(async () => {
      if (token !== TSUtils.navToken()) { clearInterval(taskTimer); taskTimer = null; return; }
      try {
        const t = await API.deployTask(taskId);
        setTerm(consoleEl, t.lines, '运行中');
        if (t.status !== 'running') {
          clearInterval(taskTimer);
          taskTimer = null;
          setTerm(consoleEl, [...t.lines, `[${label}] ${taskDoneMessage(t.code)}`]);
          if (done) done(t);
          await loadStatus();
        }
      } catch (e) {
        clearInterval(taskTimer);
        taskTimer = null;
        setTerm(consoleEl, ['[任务查询失败] ' + e.message]);
      }
    }, 600);
  }

  // ============ ④ 凭证 ============
  async function extractCredentials() {
    if (token !== TSUtils.navToken()) return;
    const box = $('credentials-box');
    box.innerHTML = '<div class="empty">提取中…</div>';
    try {
      const d = await API.deployCredentials();
      if (d.found) {
        const sourceTag = d.source === 'saved' ? '<span class="badge green">已保存副本</span>'
          : '<span class="badge yellow">已自动保存</span>';
        box.innerHTML = `
          <div class="cred-box">
            ${d.lines.map(l => `<div class="cred-line">${escape(l)}</div>`).join('')}
          </div>
          <div style="margin-top:8px">${sourceTag}
            <span class="muted" style="font-size:12px">${escape(d.note || '')}</span>
          </div>`;
      } else {
        box.innerHTML = `<div class="alert" style="margin:0">${escape(d.note || '未发现凭证')}</div>`;
      }
    } catch (e) {
      box.innerHTML = `<div class="empty">提取失败：${escape(e.message)}</div>`;
    }
  }

  // ============ ⑤ 查询密码 ============
  async function savePassword() {
    const password = $('query-password-input').value.trim();
    if (!password) { TSUtils.toast('请输入 serveradmin 密码', 'error'); return; }
    const btn = $('btn-save-password');
    btn.disabled = true;
    try {
      await API.deploySetPassword(password);
      TSUtils.toast('查询密码已保存并生效', 'success');
      $('query-password-result').innerHTML = '<div class="empty">检测连接中…</div>';
      await checkConnection();
    } catch (e) {
      TSUtils.toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function checkConnection() {
    const box = $('query-password-result');
    box.innerHTML = '<div class="empty">检测中…</div>';
    try {
      const d = await API.deployCheck();
      box.innerHTML = `<div class="conn-status online"><span class="dot"></span><span>连接成功：TeamSpeak ${escape(d.version || '')} @ ${escape(d.host || '')}:${escape(d.port || '')}</span></div>`;
      TSUtils.toast('ServerQuery 连接成功', 'success');
    } catch (e) {
      box.innerHTML = `<div class="alert error">${escape(e.message)}</div>`;
    }
  }

  // ============ ⑥ 日志 ============
  async function refreshLogs() {
    if (token !== TSUtils.navToken()) return;
    try {
      const d = await API.deployLogs(300);
      setTerm($('logs-console'), d.log.split('\n'), '容器暂无日志输出');
    } catch (e) {
      setTerm($('logs-console'), ['读取日志失败：' + e.message]);
    }
  }

  // ============ 事件绑定 ============
  $('btn-preview').onclick = refreshPreview;
  $('btn-compose').onclick = () => saveCompose(false);
  $('btn-up').onclick = () => runTask(API.deployUp, '启动服务', (t) => {
    if (t.code === 0) {
      TSUtils.toast('服务启动完成，正在提取初始凭证…', 'success');
      TSUtils.setTimeout(extractCredentials, 1500);
      TSUtils.setTimeout(refreshLogs, 2000);
    } else {
      TSUtils.toast('启动失败，请查看任务输出', 'error');
    }
  });
  $('btn-restart').onclick = () => runTask(API.deployRestart, '重启服务');
  $('btn-down').onclick = () => {
    if (!confirm('确定停止 TeamSpeak 服务器吗？')) return;
    runTask(API.deployDown, '停止服务');
  };
  $('btn-refresh-status').onclick = loadStatus;
  $('btn-credentials').onclick = extractCredentials;
  $('btn-save-password').onclick = savePassword;
  $('btn-check').onclick = checkConnection;
  $('btn-logs').onclick = refreshLogs;

  // 复制按钮（事件委托）
  content.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-copy]');
    if (btn) copyText(btn.dataset.copy);
  });
  ['cfg-name', 'cfg-voice', 'cfg-file', 'cfg-query'].forEach(id => {
    $(id).addEventListener('input', debounce(refreshPreview, 400));
  });

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ============ 初始化 ============
  await loadStatus();
  await refreshPreview();
  await refreshLogs();
};
