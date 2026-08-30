'use strict';

/**
 * 点歌页：网易云扫码登录 + 歌曲/歌单搜索 + 点歌队列 + 播放器控制。
 */

window.TSPages = window.TSPages || {};

TSPages.music = async function () {
  const content = document.getElementById('page-content');
  let searchType = 'song';
  let loginTimer = null;

  // 搜索分页状态
  let searchQ = '';
  let searchPage = 1;
  const searchPageSize = 20;
  let searchResults = []; // 当前页搜索结果（点歌按钮按索引引用，避免把 JSON 塞进 HTML 属性导致引号/单引号断裂）

  // 队列分页/筛选状态
  let queueQ = '';
  let queuePage = 1;
  const queuePageSize = 10;

  // 播放器本地插值状态
  let playerState = { current: null, position: 0, playing: false, loopMode: 'all', queueLength: 0 };
  let playerTick = null;
  let pollTimer = null;
  let statusTimer = null;
  let lastPollAt = 0;
  let seeking = false;

  // 页面卸载令牌：切换走后异步回调靠它放弃写 DOM
  const token = TSUtils.navToken();

  content.innerHTML = `
    <style>
      .fee-badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:8px;font-size:10.5px;line-height:16px;vertical-align:1px;white-space:nowrap}
      .fee-free{background:#e6f7ec;color:#18a058}
      .fee-vip{background:#fff1d6;color:#c47b00}
      .fee-alb{background:#e6f0ff;color:#2b6cb0}
      .fee-none{background:#ececec;color:#8a8a8a;text-decoration:line-through}
      .fee-playing{background:#e6f7ec;color:#18a058;margin:0 6px 0 0}
      tr.queue-now td{background:rgba(61,126,255,.10)}
      html[data-theme="light"] tr.queue-now td{background:rgba(37,99,235,.08)}
      .ch-tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
    </style>
    <div id="music-alert"></div>

    <div class="card" id="ch-tabs-card" style="padding:10px 14px">
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
        <span class="muted" style="font-size:12px;flex:none">当前管理频道：</span>
        <span id="ch-tabs" style="display:flex;flex-wrap:wrap;gap:6px"></span>
      </div>
    </div>

    <div class="card music-player" id="player-card">
      <h3><span>正在播放 <span class="muted" id="player-ch-name"></span></span>
        <span class="muted" id="player-mode"></span>
      </h3>
      <div class="player-main">
        <img class="player-cover" id="player-cover" alt="" src="">
        <div class="player-info">
          <div class="player-title" id="player-title">未在播放</div>
          <div class="muted" id="player-artists"></div>
        </div>
        <div class="player-controls">
          <button class="btn btn-sm" id="btn-prev" title="上一首">${TSUtils.icons.prev}</button>
          <button class="btn btn-sm btn-primary" id="btn-toggle" title="播放/暂停">${TSUtils.icons.play}</button>
          <button class="btn btn-sm" id="btn-next" title="下一首">${TSUtils.icons.next}</button>
          <button class="btn btn-sm" id="btn-loop" title="循环模式">循环:列表</button>
        </div>
      </div>
      <div class="player-progress">
        <span id="player-pos">0:00</span>
        <input type="range" id="player-range" min="0" max="100" value="0" step="1">
        <span id="player-dur">0:00</span>
      </div>
    </div>

    <div class="card">
      <h3><span>TeamSpeak 推流</span></h3>
      <div id="ts-status" class="muted" style="font-size:12.5px">未连接</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <div style="display:flex;flex-direction:column;gap:3px">
          <span class="muted" style="font-size:12px">TeamSpeak 3 查询密码（serveradmin，连接 TS 服务器用；部署管理页可提取）</span>
          <input class="input" id="ts-key" type="password" placeholder="填入 serveradmin 查询密码" style="flex:1">
        </div>
        <div style="display:flex;flex-direction:column;gap:3px">
          <span class="muted" style="font-size:12px">部署频道（每个频道固定一个点歌机器人和一个点歌助手，不会移动到别的频道）</span>
          <div id="ts-channel-list" style="display:flex;flex-direction:column;gap:4px"></div>
          <div style="display:flex;gap:8px">
            <select id="ts-channel" class="select" style="flex:1">
              <option value="">（加载频道中…）</option>
            </select>
            <button class="btn btn-sm btn-primary" id="btn-ts-channel-add">添加频道</button>
            <button class="btn btn-sm" id="btn-ts-refresh" title="保存 Key 并刷新频道列表">↻</button>
          </div>
          <span class="muted" style="font-size:11px">每个频道的机器人播放自己频道的独立电台流（点歌队列互不相通，网易云账号全局共享）；移除频道后需在「机器人管理」删除对应机器人。</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--border);padding-top:8px">
          <div class="muted" style="font-size:12px;font-weight:600">音质与行为</div>
          <label class="ts-toggle" style="font-size:12.5px">
            <input type="checkbox" id="ts-autopause-on">
            <span>频道无人时自动暂停，有人进入自动恢复</span>
          </label>
          <div style="display:flex;flex-wrap:wrap;gap:10px 16px;font-size:12px;align-items:center">
            <label style="display:flex;gap:6px;align-items:center">编码
              <select id="ts-audio-codec" class="select" style="width:108px">
                <option value="libmp3lame">MP3</option>
                <option value="libopus">Opus</option>
              </select>
            </label>
            <label style="display:flex;gap:6px;align-items:center">码率
              <select id="ts-audio-bitrate" class="select" style="width:84px">
                <option value="128k">128k</option>
                <option value="192k">192k</option>
                <option value="256k">256k</option>
                <option value="320k">320k</option>
              </select>
            </label>
            <label style="display:flex;gap:6px;align-items:center">采样率
              <select id="ts-audio-rate" class="select" style="width:84px">
                <option value="44100">44100</option>
                <option value="48000">48000</option>
              </select>
            </label>
            <label style="display:flex;gap:6px;align-items:center">声道
              <select id="ts-audio-channels" class="select" style="width:84px">
                <option value="1">单声道</option>
                <option value="2">立体声</option>
              </select>
            </label>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-sm" id="btn-ts-audio-save">保存音质设置</button>
            <span class="muted" id="ts-audio-state" style="font-size:11.5px">修改后下一首生效</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--border);padding-top:8px">
          <label class="ts-toggle" style="font-size:12.5px">
            <input type="checkbox" id="ts-token-on">
            <span>开启音频流令牌（防公网随意收听）</span>
          </label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-sm" id="btn-ts-token-save">生成并保存</button>
            <code id="ts-token-val" style="font-size:11px;word-break:break-all;flex:1;min-width:120px"></code>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3><span>机器人管理</span></h3>
      <div class="muted" style="font-size:11.5px;margin-bottom:10px">点歌机器人：加入频道推流的音乐机器人（每个部署频道一个，固定驻留）；点歌助手：驻留频道接收 <code>!点歌</code> 等聊天指令的查询端（与机器人同频道）。此处管理二者的身份与生命周期，推流参数在「TeamSpeak 推流」卡片配置。</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;flex-direction:column;gap:3px">
          <span class="muted" style="font-size:12px">点歌机器人昵称（多频道时自动加「·频道名」后缀区分，点歌助手同规则）</span>
          <input class="input" id="ts-bot-nickname" type="text" placeholder="点歌机器人" style="flex:1">
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <button class="btn btn-sm btn-primary" id="btn-ts-link">生成机器人 / 重建连接</button>
          <button class="btn btn-sm" id="btn-ts-unlink">断开</button>
          <button class="btn btn-sm" id="btn-bot-refresh">刷新状态</button>
          <button class="btn btn-sm btn-danger" id="btn-bot-delete">删除机器人</button>
        </div>
        <div class="muted" style="font-size:11px">填好上方 Key、添加部署频道后点「生成机器人 / 重建连接」，会为每个频道各部署一个机器人并自动推流；「删除机器人」移除所有部署的机器人（不会删除本地歌单/队列数据）。</div>
        <div style="display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--border);padding-top:8px">
          <div class="muted" style="font-size:12px;font-weight:600">点歌助手（频道聊天点歌）</div>
          <label class="ts-toggle" style="font-size:12.5px">
            <input type="checkbox" id="ts-chat-on">
            <span>在频道内启用聊天点歌</span>
          </label>
          <div style="display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px" id="ts-cmd-box">
            <label class="ts-toggle"><input type="checkbox" data-cmd="dian"> 点歌</label>
            <label class="ts-toggle"><input type="checkbox" data-cmd="play"> 播放</label>
            <label class="ts-toggle"><input type="checkbox" data-cmd="playat"> 播放第N首</label>
            <label class="ts-toggle"><input type="checkbox" data-cmd="pause"> 暂停</label>
            <label class="ts-toggle"><input type="checkbox" data-cmd="next"> 切歌</label>
            <label class="ts-toggle"><input type="checkbox" data-cmd="clear"> 清队列</label>
            <label class="ts-toggle"><input type="checkbox" data-cmd="search"> 搜索</label>
            <label class="ts-toggle"><input type="checkbox" data-cmd="queue"> 队列</label>
            <label class="ts-toggle"><input type="checkbox" data-cmd="loop"> 循环</label>
            <label class="ts-toggle"><input type="checkbox" data-cmd="status"> 状态</label>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
            <button class="btn btn-sm" id="btn-ts-chat-save">保存聊天设置</button>
            <button class="btn btn-sm" id="btn-ts-chat-help">指令一览</button>
            <span class="muted" id="ts-chat-state" style="font-size:11.5px"></span>
          </div>
          <div class="muted" style="font-size:11px">频道聊天/私聊点歌助手：<code>!点歌 &lt;歌曲ID或链接&gt;</code> · <code>!播放(第N首)</code> · <code>!暂停</code> · <code>!切歌</code> · <code>!清队列</code> · <code>!搜索 &lt;关键词&gt;</code> · <code>!队列 [页码]</code></div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3><span>网易云点歌 <span class="muted" id="search-target"></span></span>
        <span>
          <button class="btn btn-sm" id="btn-login-refresh" title="刷新登录状态">↻</button>
          <button class="btn btn-sm" id="btn-login">扫码登录</button>
        </span>
      </h3>
      <div id="login-state" class="muted" style="font-size:12.5px;min-height:20px">未登录（登录后可播放受版权歌曲）</div>
      <div id="login-user" hidden style="display:flex;align-items:center;gap:8px;margin-top:8px">
        <img id="login-avatar" alt="" style="width:34px;height:34px;border-radius:50%;flex:none">
        <div style="display:flex;flex-direction:column;gap:1px">
          <span style="font-size:13px;font-weight:600" id="login-name"></span>
          <span style="font-size:11px" class="muted" id="login-meta"></span>
        </div>
        <button class="btn btn-sm btn-danger" id="btn-logout" style="margin-left:auto">退出登录</button>
      </div>

      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <input type="text" id="search-q" class="input" style="flex:1;min-width:200px" placeholder="搜索歌曲 / 歌单">
        <select id="search-type" class="select">
          <option value="song">歌曲</option>
          <option value="playlist">歌单</option>
        </select>
        <button class="btn btn-primary" id="btn-search">搜索</button>
      </div>
      <div id="search-results" style="margin-top:10px"><div class="empty">输入关键词搜索</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3><span>点歌队列 <span class="muted" id="queue-ch-name"></span><span class="muted" id="queue-summary"></span></span>
        <button class="btn btn-sm btn-danger" id="btn-clear-queue">清空</button>
      </h3>
      <div class="list-toolbar">
        <input type="text" id="queue-q" class="input" style="flex:1;min-width:160px" placeholder="筛选队列（歌曲/歌手/点歌人）">
      </div>
      <div id="queue-list" style="margin-top:10px"><div class="empty">队列为空</div></div>
    </div>`;

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function thumb(cover) {
    if (!cover) return '';
    const prox = API.musicImg(cover, '80y80');
    return `<img class="song-thumb" src="${prox}" data-fallback="${cover}" alt="" loading="lazy" onerror="if(this.dataset.fallback&&this.src!==this.dataset.fallback){this.src=this.dataset.fallback;}else{this.style.visibility='hidden';}">`;
  }
  function fmtDur(sec) {
    if (!sec) return '0:00';
    sec = Math.floor(sec);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function fmtNum(n) {
    if (!n) return '0';
    if (n > 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n > 10000) return (n / 10000).toFixed(1) + '万';
    return String(n);
  }
  // 版权标识：fee 0免费/无版权 1VIP 4购专辑 8非会员可听低音质
  function feeBadge(fee, noCopyright) {
    if (noCopyright) return '<span class="fee-badge fee-none">无版权</span>';
    if (fee === 1) return '<span class="fee-badge fee-vip">VIP</span>';
    if (fee === 4) return '<span class="fee-badge fee-alb">专辑</span>';
    if (fee === 8) return '<span class="fee-badge fee-free">免费听</span>';
    if (fee === 0) return '<span class="fee-badge fee-free">免费</span>';
    return '';
  }

  // ---------- 通用分页条 ----------
  function pager(page, pages, onGo) {
    if (pages <= 1) return '';
    const mk = (label, p, dis) =>
      `<button class="btn btn-sm pager-btn" data-p="${p}" ${dis ? 'disabled' : ''}>${label}</button>`;
    return `<div class="pager">
      ${mk('«', 1, page === 1)}
      ${mk('‹', page - 1, page === 1)}
      <span class="pager-info">${page} / ${pages}</span>
      ${mk('›', page + 1, page >= pages)}
      ${mk('»', pages, page >= pages)}
    </div>`;
  }

  // ---------- 播放器 ----------
  function loopLabel(m) {
    return m === 'one' ? '循环:单曲' : m === 'shuffle' ? '循环:随机' : m === 'off' ? '循环:关' : '循环:列表';
  }

  function renderPlayer() {
    if (token !== TSUtils.navToken()) return;
    const st = playerState;
    const pc = $('player-cover');
    if (st.current && st.current.cover) {
      pc.dataset.fallback = st.current.cover;
      pc.onerror = () => { if (pc.dataset.fallback && pc.src !== pc.dataset.fallback) pc.src = pc.dataset.fallback; };
      pc.src = API.musicImg(st.current.cover, '112y112');
    } else {
      pc.onerror = null;
      pc.src = '';
    }
    $('player-title').innerHTML = st.current ? (esc(st.current.title) + feeBadge(st.current.fee)) : '未在播放';
    $('player-artists').textContent = st.current ? (st.current.artists || '') : '';
    $('player-mode').textContent = st.queueLength ? `（队列 ${st.queueLength} 首）` : '';
    $('btn-toggle').innerHTML = st.playing ? TSUtils.icons.pause : TSUtils.icons.play;
    $('btn-loop').textContent = loopLabel(st.loopMode);
    const dur = st.current && st.current.duration ? st.current.duration : 0;
    $('player-range').max = dur || 0;
    if (!seeking) $('player-range').value = st.position || 0;
    $('player-pos').textContent = fmtDur(st.position || 0);
    $('player-dur').textContent = fmtDur(dur);
  }

  async function pollPlayer(force) {
    if (token !== TSUtils.navToken()) return;
    if (!currentCh) return;
    const now = Date.now();
    if (!force && now - lastPollAt < 800) return;
    lastPollAt = now;
    try {
      const d = await API.musicPlayer(currentCh);
      playerState = d;
      renderPlayer();
    } catch (e) { /* 服务不可用 */ }
  }

  // 本地插值：每秒推进进度条
  function startTick() {
    if (playerTick) return;
    playerTick = TSUtils.setInterval(() => {
      if (token !== TSUtils.navToken()) { clearInterval(playerTick); playerTick = null; return; }
      const st = playerState;
      if (st.playing && st.current && !seeking) {
        const dur = st.current.duration || 0;
        let pos = st.position + 1;
        if (dur > 0 && pos >= dur) { pollPlayer(true); return; }
        st.position = pos;
        $('player-range').value = pos;
        $('player-pos').textContent = fmtDur(pos);
      }
    }, 1000);
  }

  async function refreshLogin() {
    if (token !== TSUtils.navToken()) return;
    try {
      const d = await API.musicStatus();
      const el = $('login-state');
      $('login-user').hidden = true;
      if (!d.loggedIn) {
        el.textContent = '未登录（登录后可播放受版权歌曲）';
        el.style.color = 'var(--text-muted)';
        return;
      }
      el.textContent = '';
      el.style.color = 'var(--text-muted)';
      const p = d.profile || {};
      $('login-name').textContent = p.nickname || '已登录网易云';
      if (p.avatarUrl) {
        $('login-avatar').src = p.avatarUrl;
        $('login-avatar').style.display = '';
      } else {
        $('login-avatar').removeAttribute('src');
        $('login-avatar').style.display = 'none';
      }
      let meta = '';
      if (d.vip) {
        meta = d.vip.isVip
          ? `<span class="fee-badge fee-vip">${esc(d.vip.label || 'VIP')}</span>`
          : '<span class="fee-badge fee-none">非VIP</span>';
      }
      $('login-meta').innerHTML = meta || '';
      $('login-user').hidden = false;
    } catch (e) { /* 服务不可用 */ }
  }

  // ---------- 退出登录 ----------
  async function doLogout() {
    if (!confirm('确定退出网易云登录吗？')) return;
    try {
      await API.musicLogout();
      TSUtils.toast('已退出登录', 'success');
      await refreshLogin();
    } catch (e) {
      TSUtils.toast('退出失败：' + e.message, 'error');
    }
  }

  // ---------- 扫码登录 ----------
  function openQrModal() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = '网易云扫码登录';
    const body = document.getElementById('modal-body');
    body.innerHTML = '<div class="empty">正在生成二维码…</div>';
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; clearInterval(loginTimer); loginTimer = null; refreshLogin(); };
    document.getElementById('modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    API.musicQrCreate().then((qr) => {
      body.innerHTML = `
        <div style="text-align:center">
          <img id="qr-img" src="${qr.qrDataUrl || ''}" alt="扫码" style="width:220px;height:220px;background:var(--bg);border:1px solid var(--border);border-radius:10px">
          <div class="muted" style="font-size:13px;margin-top:10px">请用网易云音乐 App 扫码，并在手机上确认登录</div>
          <div id="qr-status" class="muted" style="font-size:13px;margin-top:6px">等待扫码…</div>
        </div>
        <div class="modal-footer"><button class="btn" id="qr-close">完成</button></div>`;
      body.querySelector('#qr-close').onclick = close;
      if (qr.qrDataUrl) {
        loginTimer = TSUtils.setInterval(async () => {
          try {
            const r = await API.musicQrCheck(qr.key);
            const st = body.querySelector('#qr-status');
            if (!st) return;
            if (r.code === 803) {
              close();
              TSUtils.toast('登录成功', 'success');
            } else if (r.code === 802) {
              st.textContent = '已扫码，请在手机上确认登录…';
            } else if (r.code === 800) {
              st.textContent = '二维码已过期，请关闭重试';
              if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
            } else {
              st.textContent = '等待扫码…';
            }
          } catch (e) { /* 忽略轮询错误 */ }
        }, 2500);
      } else {
        body.querySelector('#qr-status').textContent = '二维码生成失败：' + (qr.url ? '需要手动打开 ' + qr.url : '未知错误');
      }
    }).catch((e) => {
      body.innerHTML = `<div class="alert error">${esc(e.message)}</div><div class="modal-footer"><button class="btn" id="qr-close">关闭</button></div>`;
      body.querySelector('#qr-close').onclick = close;
    });
  }

  // ---------- 搜索 ----------
  async function doSearch(page) {
    if (page != null) searchPage = page;
    const q = $('search-q').value.trim();
    if (!q) return;
    searchQ = q;
    const box = $('search-results');
    box.innerHTML = '<div class="empty">搜索中…</div>';
    try {
      const d = await API.musicSearch(q, searchType, searchPageSize, (searchPage - 1) * searchPageSize);
      if (!d.items || !d.items.length) {
        box.innerHTML = '<div class="empty">未找到结果</div>';
        return;
      }
      const pages = Math.max(1, Math.ceil(d.total / searchPageSize));
      if (searchType === 'playlist') {
        box.innerHTML = `<div style="font-size:12px" class="muted">共 ${fmtNum(d.total)} 个歌单</div><div class="table-wrap"><table>
          <thead><tr><th>名称</th><th>曲目/播放</th><th>创建者</th><th class="actions">操作</th></tr></thead>
          <tbody>${d.items.map(p => `<tr>
            <td>${esc(p.name)}</td><td>${p.tracks} 首 · ${fmtNum(p.playCount)} 播放</td><td>${esc(p.creator)}</td>
            <td class="actions">
              <button class="btn btn-sm" data-view="${p.id}" data-name="${esc(p.name)}">查看</button>
              <button class="btn btn-sm btn-primary" data-pl="${p.id}" data-name="${esc(p.name)}">加入队列</button>
            </td>
          </tr>`).join('')}</tbody></table></div>${pager(searchPage, pages, (p) => doSearch(p))}`;
      } else {
        searchResults = d.items || [];
        box.innerHTML = `<div style="font-size:12px" class="muted">共 ${fmtNum(d.total)} 首</div><div class="table-wrap"><table>
          <thead><tr><th>歌曲</th><th>专辑</th><th class="num">时长</th><th class="actions">操作</th></tr></thead>
       <tbody>${searchResults.map((s, i) => `<tr>
             <td class="song-cell">${thumb(s.cover)}<span>${esc(s.name)}${feeBadge(s.fee, s.noCopyright)} <span class="muted">- ${esc(s.artists)}</span></span></td>
             <td>${esc(s.album)}</td><td class="num">${fmtDur(s.duration)}</td>
            <td class="actions"><button class="btn btn-sm btn-primary" data-i="${i}">点歌</button></td>
           </tr>`).join('')}</tbody></table></div>${pager(searchPage, pages, (p) => doSearch(p))}`;
      }
    } catch (e) {
      box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }

  // ---------- 歌单浏览/全量入队 ----------
  async function openPlaylistModal(plId, plName) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = '歌单：' + plName;
    const body = document.getElementById('modal-body');
    body.innerHTML = `
      <div class="list-toolbar">
        <input type="text" class="input" id="pl-filter" placeholder="筛选本歌单曲目" style="flex:1;min-width:160px">
        <span class="muted" id="pl-count" style="font-size:12.5px"></span>
      </div>
      <div id="pl-list"><div class="empty">加载中…</div></div>`;
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; };
    document.getElementById('modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    let all = [];
    let page = 1;
    let plRendered = [];
    const pageSize = 20;
    try {
      const d = await API.musicPlaylistTracksAll(plId);
      all = d.tracks || [];
    } catch (e) {
      body.innerHTML = `<div class="alert error">${esc(e.message)}</div><div class="modal-footer"><button class="btn" onclick="document.getElementById('modal-close').click()">关闭</button></div>`;
      return;
    }

    function render() {
      const kw = (body.querySelector('#pl-filter').value || '').trim().toLowerCase();
      const list = kw
        ? all.filter((t) => [t.name, t.artists, t.album].join(' ').toLowerCase().includes(kw))
        : all;
      const pages = Math.max(1, Math.ceil(list.length / pageSize));
      if (page > pages) page = pages;
      const start = (page - 1) * pageSize;
      plRendered = list.slice(start, start + pageSize);
      body.querySelector('#pl-count').textContent = `共 ${all.length} 首` + (kw ? `，匹配 ${list.length} 首` : '');
      const box = body.querySelector('#pl-list');
      if (!list.length) { box.innerHTML = '<div class="empty">无匹配曲目</div>'; return; }
      box.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>歌曲</th><th>专辑</th><th class="num">时长</th><th class="actions">操作</th></tr></thead>
        <tbody>${plRendered.map((t, i) => `<tr>
           <td class="song-cell">${thumb(t.cover)}<span>${esc(t.name)}${feeBadge(t.fee)} <span class="muted">- ${esc(t.artists)}</span></span></td>
             <td>${esc(t.album)}</td><td class="num">${fmtDur(t.duration)}</td>
           <td class="actions"><button class="btn btn-sm btn-primary" data-ri="${i}">点歌</button></td>
        </tr>`).join('')}</tbody></table></div>${pager(page, pages, (p) => { page = p; render(); })}
        <div class="modal-footer">
          <button class="btn btn-primary" id="pl-add-all">全部加入队列（${all.length}）</button>
          <button class="btn" onclick="document.getElementById('modal-close').click()">关闭</button>
        </div>`;
      box.querySelector('#pl-add-all').onclick = async () => {
        try {
          if (!currentCh) { TSUtils.toast('请先选择部署频道', 'error'); return; }
          const r = await API.musicEnqueueMany(currentCh, all.map((t) => ({ id: t.id, name: t.name, artists: t.artists, album: t.album, duration: t.duration, cover: t.cover, fee: t.fee, noCopyright: t.noCopyright })));
          TSUtils.toast(`已加入 ${r.count} 首到「' + currentCh.split('/').pop() + '」`, 'success');
          refreshQueue();
        } catch (err) { TSUtils.toast(err.message, 'error'); }
      };
      box.onclick = async (e) => {
        const btn = e.target.closest('button[data-ri]');
        if (!btn) return;
        if (!currentCh) { TSUtils.toast('请先选择部署频道', 'error'); return; }
        const t = plRendered[Number(btn.dataset.ri)];
        if (!t) return;
        btn.disabled = true;
        try {
          await API.musicEnqueue(currentCh, { id: t.id, name: t.name, artists: t.artists, album: t.album, duration: t.duration, cover: t.cover, fee: t.fee, noCopyright: t.noCopyright });
          TSUtils.toast('已加入「' + currentCh.split('/').pop() + '」的点歌队列', 'success');
          refreshQueue();
        } catch (err) { TSUtils.toast(err.message, 'error'); }
      };
    }

    body.querySelector('#pl-filter').addEventListener('input', () => { page = 1; render(); });
    render();
  }

  // ---------- 队列（当前管理频道） ----------
  async function refreshQueue() {
    if (token !== TSUtils.navToken()) return;
    const box = $('queue-list');
    if (!currentCh) {
      $('queue-summary').textContent = '';
      box.innerHTML = '<div class="empty">请先在「TeamSpeak 推流 → 部署频道」添加频道并部署机器人</div>';
      return;
    }
    try {
      const d = await API.musicQueue(currentCh, queuePage, queuePageSize, queueQ);
      const items = d.items || [];
      $('queue-summary').textContent = queueQ ? `（筛选匹配 ${d.total} 首）` : `（共 ${d.total} 首）`;
      const box = $('queue-list');
      if (!items.length) {
        if (d.page > 1) { queuePage = d.page - 1; return refreshQueue(); }
        box.innerHTML = `<div class="empty">${queueQ ? '没有匹配的歌曲' : '队列为空'}</div>`;
        return;
      }
      const curId = playerState.current ? playerState.current.id : null;
      box.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>歌曲</th><th>点歌人</th><th class="actions">操作</th></tr></thead>
        <tbody>${items.map((it, i) => {
          const isCur = curId != null && Number(it.id) === Number(curId);
          const idx = (d.page - 1) * d.pageSize + i + 1;
          return `<tr${isCur ? ' class="queue-now"' : ''}>
          <td>${idx}</td>
           <td class="song-cell">${isCur ? '<span class="fee-badge fee-playing">▶ 播放中</span>' : ''}${thumb(it.cover)}<span>${esc(it.title)}${feeBadge(it.fee)} <span class="muted">- ${esc(it.artists)}</span></span></td>
          <td>${esc(it.requestedBy)}</td>
          <td class="actions">
            <button class="btn btn-sm" data-play="${it.id}">播放</button>
            <button class="btn btn-sm btn-danger" data-del="${it.id}">移除</button>
          </td>
        </tr>`;
        }).join('')}</tbody></table></div>${pager(d.page, d.pages, (p) => { queuePage = p; refreshQueue(); })}`;
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 事件 ----------
  $('btn-login').onclick = openQrModal;
  $('btn-login-refresh').onclick = () => { refreshLogin(); };
  $('btn-logout').onclick = doLogout;
  $('btn-search').onclick = () => { searchPage = 1; doSearch(); };
  $('search-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { searchPage = 1; doSearch(); } });
  $('search-type').onchange = (e) => { searchType = e.target.value; searchPage = 1; };
  $('btn-clear-queue').onclick = async () => {
    if (!currentCh) { TSUtils.toast('请先选择部署频道', 'error'); return; }
    if (!confirm('确定清空「' + currentCh.split('/').pop() + '」的点歌队列吗？')) return;
    await API.musicClearQueue(currentCh);
    queuePage = 1;
    refreshQueue();
  };
  // 筛选队列：必须把输入值写入 queueQ 再请求（此前漏了赋值，筛选永远无效）
  let queueQTimer = null;
  $('queue-q').addEventListener('input', (e) => {
    queueQ = e.target.value.trim();
    queuePage = 1;
    if (queueQTimer) clearTimeout(queueQTimer);
    queueQTimer = setTimeout(refreshQueue, 250); // 轻防抖，避免每个按键都打一次后端
  });

  // ---------- 部署频道列表（每频道固定一个机器人+一个点歌助手） ----------
  let tsChannelsAvail = []; // TS 上可用的频道（来自 TS3 ServerQuery）
  let deployChannels = [];  // 已配置的部署频道

  function renderChannelList() {
    const box = $('ts-channel-list');
    if (!deployChannels.length) {
      box.innerHTML = '<div class="muted" style="font-size:12px">尚未配置部署频道，请从下方选择并「添加频道」</div>';
    } else {
      box.innerHTML = deployChannels.map((ch) => `<div style="display:flex;align-items:center;gap:8px;font-size:12.5px;border:1px solid var(--border);border-radius:8px;padding:4px 10px">
        <span style="flex:1;word-break:break-all">${esc(ch)}</span>
        <button class="btn btn-sm btn-danger" data-rmch="${esc(ch)}">移除</button>
      </div>`).join('');
    }
    // 下拉只显示未添加的频道
    const sel = $('ts-channel');
    const avail = tsChannelsAvail.filter((c) => !deployChannels.includes(c.path || c.name));
    sel.innerHTML = avail.length
      ? avail.map((c) => `<option value="${esc(c.path || c.name)}">${esc(c.path || c.name)}</option>`).join('')
      : '<option value="">（没有可添加的频道）</option>';
  }

  async function saveChannels() {
    try {
      await API.musicTsSaveConfig({ ts3abChannels: deployChannels.slice() });
      TSUtils.toast('频道配置已保存。新增频道需点「生成机器人 / 重建连接」部署；移除频道的机器人可用「删除机器人」清理', 'success');
    } catch (e) {
      TSUtils.toast('保存失败：' + e.message, 'error');
    }
    renderChannelList();
  }

  $('btn-ts-channel-add').onclick = async () => {
    const ch = $('ts-channel').value.trim();
    if (!ch) { TSUtils.toast('请先从下拉选择要添加的频道（可点 ↻ 刷新列表）', 'error'); return; }
    if (deployChannels.includes(ch)) { TSUtils.toast('该频道已在部署列表中', 'error'); return; }
    deployChannels.push(ch);
    await saveChannels();
  };

  $('ts-channel-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-rmch]');
    if (!btn) return;
    deployChannels = deployChannels.filter((c) => c !== btn.dataset.rmch);
    await saveChannels();
  });

  // ---------- 频道页签：切换当前管理的频道（播放器/队列/点歌都只作用于该频道） ----------
  let currentCh = null;

  function renderChannelTabs() {
    const box = $('ch-tabs');
    if (!deployChannels.length) {
      box.innerHTML = '<span class="muted" style="font-size:12px">未配置（先在下方「TeamSpeak 推流 → 部署频道」添加）</span>';
    } else {
      box.innerHTML = deployChannels.map((c) =>
        `<button class="btn btn-sm ch-tab${c === currentCh ? ' active' : ''}" data-ch="${esc(c)}">${esc(c.split('/').pop())}</button>`).join('');
    }
    const leaf = currentCh ? currentCh.split('/').pop() : '';
    $('player-ch-name').textContent = leaf ? '（频道：' + leaf + '）' : '';
    $('queue-ch-name').textContent = leaf ? '（' + leaf + '）' : '';
    $('search-target').textContent = leaf ? '（点歌加入：' + leaf + '）' : '';
  }

  function syncCurrentCh() {
    if (!deployChannels.includes(currentCh)) currentCh = deployChannels[0] || null;
    renderChannelTabs();
  }

  $('ch-tabs').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-ch]');
    if (!b || b.dataset.ch === currentCh) return;
    currentCh = b.dataset.ch;
    renderChannelTabs();
    await pollPlayer(true); // 先取该频道播放器状态，队列的“播放中”标注才准确
    refreshQueue();
  });

  async function refreshTsStatus() {
    if (token !== TSUtils.navToken()) return;
    try {
      const st = await API.musicTsStatus();
      const box = $('ts-status');
      if (st.error && !(st.channels || []).length) { box.textContent = '连接异常：' + st.error; return; }
      const lines = [];
      const chs = st.channels || [];
      if (!chs.length) lines.push('未配置部署频道（请在上方添加频道后点「生成机器人 / 重建连接」）');
      for (const ch of chs) {
        const stateTxt = ch.connected ? (ch.status === 'playing' ? '推流中' : ch.status) : (ch.status || '未部署');
        let t = (ch.connected ? '🟢' : '🔴') + ' ' + ch.channel + ' — ' + (ch.nickname || '') + '（' + stateTxt + '）';
        if (ch.error) t += ' ' + ch.error;
        lines.push(t);
      }
      const np = st.nowPlaying;
      if (np && np.title) lines.push('♪ 正在播放：' + (np.title || '') + (np.artist ? ' - ' + np.artist : ''));
      box.innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join('');
    } catch (e) { /* 忽略 */ }
  }
  $('btn-ts-link').onclick = async () => {
    try {
      const key = $('ts-key').value.trim();
      if (!deployChannels.length) { TSUtils.toast('请先在上方添加部署频道', 'error'); return; }
      if (!key) { TSUtils.toast('请先填写 TS 查询密码', 'error'); return; }
      TSUtils.toast('正在为 ' + deployChannels.length + ' 个频道部署/重建机器人…', 'success');
      // 保存频道列表、昵称与查询密码，再自动建连（后端异步执行，多频道耗时更长，避免代理超时）
      await API.musicTsSaveConfig({ ts3abChannels: deployChannels.slice(), ts3abBotNickname: $('ts-bot-nickname').value.trim() || '点歌机器人', tsQueryAdminPassword: key });
      await API.musicTsLink();
      TSUtils.toast('已发起部署，请稍后用「刷新状态」查看各频道结果', 'success');
      setTimeout(refreshTsStatus, 8000);
    } catch (e) { TSUtils.toast('生成失败：' + e.message, 'error'); }
  };
  $('btn-ts-unlink').onclick = async () => {
    try { await API.musicTsUnlink(); TSUtils.toast('已停止所有频道推流', 'success'); refreshTsStatus(); }
    catch (e) { TSUtils.toast('断开失败：' + e.message, 'error'); }
  };
  $('btn-bot-refresh').onclick = async () => {
    try { await refreshTsStatus(); TSUtils.toast('已刷新机器人状态', 'success'); }
    catch (e) { TSUtils.toast('刷新失败：' + e.message, 'error'); }
  };
  $('btn-bot-delete').onclick = async () => {
    if (!confirm('确定要删除所有部署的点歌机器人吗？\n（每个部署频道的机器人都会被移除，本地歌单/队列不受影响；之后可点「生成机器人 / 重建连接」按当前频道配置恢复）')) return;
    try {
      const r = await API.musicTsDeleteBot();
      TSUtils.toast(r.deleted ? '已删除 ' + (r.count || '') + ' 个机器人' : '未找到可删除的机器人', 'success');
      refreshTsStatus();
    } catch (e) { TSUtils.toast('删除失败：' + e.message, 'error'); }
  };
  async function loadTsChannels() {
    const sel = $('ts-channel');
    try {
      const cfg = await API.musicTsConfig();
      $('ts-key').value = cfg.hasQueryPassword ? '••••••••' : '';
      $('ts-bot-nickname').value = cfg.ts3abBotNickname || '点歌机器人';
      deployChannels = Array.isArray(cfg.ts3abChannels) ? cfg.ts3abChannels.slice() : [];
      $('ts-chat-on').checked = cfg.tsChatEnabled !== false;
      refreshChatState();
      const cmds = cfg.chatCommands || {};
      document.querySelectorAll('#ts-cmd-box input[data-cmd]').forEach((cb) => {
        cb.checked = cmds[cb.dataset.cmd] !== false;
      });
      $('ts-token-on').checked = cfg.streamTokenEnabled !== false;
      $('ts-token-val').textContent = cfg.streamTokenEnabled !== false && cfg.streamToken ? cfg.streamToken : '未开启';
      // 音质与行为
      $('ts-autopause-on').checked = cfg.autoPauseEmpty !== false;
      $('ts-audio-codec').value = cfg.audioCodec || 'libmp3lame';
      $('ts-audio-bitrate').value = cfg.audioBitrate || '320k';
      $('ts-audio-rate').value = String(cfg.audioRate || 48000);
      $('ts-audio-channels').value = String(cfg.audioChannels || 2);
      if (!cfg.hasQueryPassword) {
        sel.innerHTML = '<option value="">（请先填写 TS 查询密码后点 ↻ 刷新）</option>';
        renderChannelList();
        syncCurrentCh();
        return;
      }
      tsChannelsAvail = await API.musicTsChannels();
      renderChannelList();
      syncCurrentCh();
    } catch (e) {
      sel.innerHTML = '<option value="">（加载失败：' + e.message + '）</option>';
      renderChannelList();
      syncCurrentCh();
    }
  }
  // ↻ 先保存当前填写的查询密码，再刷新频道列表
  $('btn-ts-refresh').onclick = async () => {
    const key = $('ts-key').value.trim();
    if (key) {
      try { await API.musicTsSaveConfig({ tsQueryAdminPassword: key, ts3abChannels: deployChannels.slice() }); } catch (e) { /* 忽略 */ }
    }
    loadTsChannels();
  };

  // ---------- 音频流令牌 ----------
  $('btn-ts-token-save').onclick = async () => {
    try {
      const on = $('ts-token-on').checked;
      const payload = { streamTokenEnabled: on };
      if (on) payload.streamToken = ''; // 由后端自动生成新令牌
      const r = await API.musicTsSaveConfig(payload);
      TSUtils.toast(on ? '已开启，令牌已生成' : '已关闭音频流令牌', 'success');
      $('ts-token-val').textContent = r.streamToken || '未开启';
    } catch (e) {
      TSUtils.toast('保存失败：' + e.message, 'error');
    }
  };

  // ---------- 频道聊天点歌设置 ----------
  async function refreshChatState() {
    if (token !== TSUtils.navToken()) return;
    try {
      const s = await API.musicTsChatStatus();
      const el = $('ts-chat-state');
      const label = { listening: '监听中', connecting: '连接中', error: '异常（自动重试中）', stopped: '停止' };
      if (s.sessions && s.sessions.length) {
        el.textContent = s.sessions
          .map((x) => (x.channel.split('/').pop()) + '：' + (label[x.state] || x.state) + (x.nick ? '（' + x.nick + '）' : ''))
          .join('　');
      } else {
        el.textContent = label[s.state] || (s.enabled ? '待机（未配置部署频道）' : '未启用');
      }
    } catch (e) { /* 服务不可用 */ }
  }
  $('btn-ts-chat-save').onclick = async () => {
    try {
      const on = $('ts-chat-on').checked;
      const cfg = await API.musicTsConfig();
      const payload = { tsChatEnabled: on };
      // 收集可用指令开关
      const cmds = {};
      document.querySelectorAll('#ts-cmd-box input[data-cmd]').forEach((cb) => { cmds[cb.dataset.cmd] = cb.checked; });
      payload.chatCommands = cmds;
      if (on && !cfg.hasQueryPassword) {
        // 音乐服务还没拿到查询密码：从部署管理凭证里自动提取（.env 或容器）
        try {
          const cred = await API.deployCredentials();
          const line = (cred.data && cred.data.lines) ? cred.data.lines.join('\n') : '';
          const m = line.match(/password\s*=\s*"?([^"\s]+)"?/i) || line.match(/password:\s*"?([^"\s]+)"?/i);
          if (!m || !m[1]) throw new Error('未找到 serveradmin 密码');
          payload.tsQueryAdminPassword = m[1];
        } catch (e) {
          TSUtils.toast('找不到 serveradmin 密码：请在服务器 .env 设置 TS_QUERY_ADMIN_PASSWORD 后重建', 'error');
          return;
        }
      }
      await API.musicTsSaveConfig(payload);
      TSUtils.toast('聊天点歌设置已保存', 'success');
      await loadTsChannels();
    } catch (e) {
      TSUtils.toast('保存失败：' + e.message, 'error');
    }
  };

  // ---------- 音质与行为设置 ----------
  $('btn-ts-audio-save').onclick = async () => {
    try {
      const payload = {
        audioCodec: $('ts-audio-codec').value,
        audioBitrate: $('ts-audio-bitrate').value,
        audioRate: parseInt($('ts-audio-rate').value, 10) || 48000,
        audioChannels: parseInt($('ts-audio-channels').value, 10) || 2,
        autoPauseEmpty: $('ts-autopause-on').checked,
      };
      await API.musicTsSaveConfig(payload);
      TSUtils.toast('音质与行为设置已保存（下一首生效）', 'success');
    } catch (e) {
      TSUtils.toast('保存失败：' + e.message, 'error');
    }
  };

  // ---------- 聊天点歌指令一览（弹窗） ----------
  const CHAT_CMD_HELP = [
    { cmd: '!点歌', alias: '!点 · !dian · !song · !req · !点播', ex: '!点歌 2652820720', desc: '点播歌曲（歌曲ID或网易云分享链接）' },
    { cmd: '!播放', alias: '!继续 · !resume · !play · !开始', ex: '!播放', desc: '开始 / 继续播放' },
    { cmd: '!播放第N首', alias: '!播第N首 · !播N · !跳N · !第N首 · !play N', ex: '!播放第3首', desc: '跳播队列第 N 首（1 基）' },
    { cmd: '!暂停', alias: '!pause', ex: '!暂停', desc: '暂停播放' },
    { cmd: '!切歌', alias: '!下一首 · !next · !skip', ex: '!切歌', desc: '切到下一首' },
    { cmd: '!清队列', alias: '!清空队列 · !清队 · !清掉队列 · !clear', ex: '!清队列', desc: '清空点歌队列并停止播放' },
    { cmd: '!搜索', alias: '!搜 · !查找 · !找歌 · !find · !search', ex: '!搜索 周杰伦', desc: '搜索歌曲，返回前5首（歌名-歌手-ID）' },
    { cmd: '!队列', alias: '!列表 · !q · !playlist · !待播', ex: '!队列 2', desc: '查看播放队列（每页10首，可翻页）' },
    { cmd: '!循环', alias: '!循环模式 · !loop · !cycle', ex: '!循环 列表', desc: '设置循环：列表 / 单曲 / 随机 / 关' },
    { cmd: '!状态', alias: '!now · !当前 · !playing · !正在播放', ex: '!状态', desc: '查看当前播放与队列' },
  ];
  function showChatCmdHelp() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = '聊天点歌指令一览';
    const body = document.getElementById('modal-body');
    body.innerHTML = `
      <div class="muted" style="font-size:12px;margin-bottom:8px">指令以 <code>!</code> 开头；需在面板「机器人管理 → 点歌助手」中开启对应权限。直接发送歌曲ID或网易云链接也可点歌。</div>
      <div class="table-wrap chat-help-table">
        <table>
          <thead><tr><th>指令</th><th>别名</th><th>示例</th><th>说明</th></tr></thead>
          <tbody>
            ${CHAT_CMD_HELP.map((r) => `<tr><td><code>${r.cmd}</code></td><td>${r.alias}</td><td><code>${r.ex}</code></td><td>${r.desc}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-footer"><button class="btn" id="chat-help-close">关闭</button></div>`;
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; };
    document.getElementById('modal-close').onclick = close;
    const closeBtn = document.getElementById('chat-help-close');
    if (closeBtn) closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
  }
  $('btn-ts-chat-help').onclick = showChatCmdHelp;

  loadTsChannels();
  refreshTsStatus();


  $('search-results').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.i != null) {
        if (!currentCh) { TSUtils.toast('请先在上方选择部署频道', 'error'); return; }
        const s = searchResults[Number(btn.dataset.i)];
        if (!s) { TSUtils.toast('结果已过期，请重新搜索', 'error'); return; }
        await API.musicEnqueue(currentCh, s);
        TSUtils.toast('已加入「' + currentCh.split('/').pop() + '」的点歌队列', 'success');
        refreshQueue();
      } else if (btn.dataset.pl) {
        if (!currentCh) { TSUtils.toast('请先在上方选择部署频道', 'error'); return; }
        const tracks = await API.musicPlaylistTracksAll(btn.dataset.pl);
        if (!tracks.tracks || !tracks.tracks.length) { TSUtils.toast('歌单为空', 'error'); return; }
        await API.musicEnqueueMany(currentCh, tracks.tracks.map((t) => ({ id: t.id, name: t.name, artists: t.artists, album: t.album, duration: t.duration, cover: t.cover, fee: t.fee, noCopyright: t.noCopyright })));
        TSUtils.toast(`已将歌单全部 ${tracks.tracks.length} 首加入「' + currentCh.split('/').pop() + '」的队列`, 'success');
        refreshQueue();
      } else if (btn.dataset.view) {
        openPlaylistModal(btn.dataset.view, btn.dataset.name);
      } else if (btn.classList.contains('pager-btn')) {
        const p = parseInt(btn.dataset.p, 10);
        doSearch(p);
      }
    } catch (err) {
      TSUtils.toast(err.message, 'error');
    }
  });

  $('queue-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.play != null) {
        await API.musicPlay(currentCh, parseInt(btn.dataset.play, 10));
        pollPlayer(true);
        TSUtils.toast('开始播放', 'success');
      } else if (btn.dataset.del != null) {
        await API.musicDequeue(currentCh, btn.dataset.del);
      } else if (btn.classList.contains('pager-btn')) {
        queuePage = parseInt(btn.dataset.p, 10);
      }
      refreshQueue();
    } catch (err) {
      TSUtils.toast(err.message, 'error');
      refreshQueue();
    }
  });

  // 播放器控制（作用于当前管理频道）
  $('btn-prev').onclick = async () => { if (!currentCh) return; await API.musicPrev(currentCh); pollPlayer(true); };
  $('btn-next').onclick = async () => { if (!currentCh) return; await API.musicNext(currentCh); pollPlayer(true); };
  $('btn-toggle').onclick = async () => { if (!currentCh) return; await API.musicToggle(currentCh); pollPlayer(true); };
  $('btn-loop').onclick = async () => {
    if (!currentCh) return;
    const order = ['all', 'one', 'shuffle', 'off'];
    const next = order[(order.indexOf(playerState.loopMode) + 1) % order.length];
    await API.musicLoop(currentCh, next);
    pollPlayer(true);
  };
  $('player-range').addEventListener('input', () => { seeking = true; });
  $('player-range').addEventListener('change', async () => {
    if (!currentCh) { seeking = false; return; }
    const pos = parseInt($('player-range').value, 10) || 0;
    seeking = false;
    try { await API.musicSeek(currentCh, pos); } catch (e) { /* 忽略 */ }
    pollPlayer(true);
  });

  await refreshLogin();
  await loadTsChannels(); // 先拿到部署频道列表并确定当前管理频道
  refreshTsStatus();
  await pollPlayer(true); // 先取播放器状态，队列首次渲染即可标注“正在播放”
  await refreshQueue();
  startTick();
  pollTimer = TSUtils.setInterval(() => { refreshQueue(); pollPlayer(); }, 5000);
  statusTimer = TSUtils.setInterval(() => { refreshTsStatus(); refreshChatState(); }, 15000); // TS/助手状态刷新频率低于队列（走 TS3AudioBot 引擎）

  // 页面卸载时清理所有定时器和未关闭的弹窗，避免快速切页写入已销毁 DOM / 卡死
  TSUtils.registerCleanup(() => {
    if (playerTick) { clearInterval(playerTick); playerTick = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
    const ov = document.getElementById('modal-overlay');
    if (ov) ov.hidden = true;
  });
};
