'use strict';

/**
 * 频道管理：频道树展示 + 创建/删除频道、查看频道详情。
 */

window.TSPages = window.TSPages || {};

TSPages.channels = async function () {
  const content = document.getElementById('page-content');
  const sid = TSUtils.sid() || 1;
  let selectedCid = null;

  content.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <h3>频道树
          <span>
            <button class="btn btn-sm" id="ch-refresh">刷新</button>
            <button class="btn btn-sm btn-primary" id="ch-create">新建频道</button>
          </span>
        </h3>
        <div id="channel-tree"><div class="empty">加载中…</div></div>
      </div>
      <div class="card">
        <h3>频道详情</h3>
        <div id="channel-detail"><div class="empty">点击左侧频道查看详情</div></div>
      </div>
    </div>`;

  // 构建树
  function buildTree(channels) {
    const byParent = new Map();
    for (const ch of channels) {
      if (!byParent.has(ch.pid)) byParent.set(ch.pid, []);
      byParent.get(ch.pid).push(ch);
    }
    const sortFn = (a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name));
    for (const list of byParent.values()) list.sort(sortFn);

    function render(pid) {
      const list = byParent.get(pid) || [];
      if (!list.length) return '';
      return `<div class="channel-children">` + list.map(ch => {
        const kids = byParent.has(ch.cid) ? render(ch.cid) : '';
        const count = ch.clients || 0;
        return `<div class="channel-node" data-cid="${ch.cid}">
          <span class="ch-name" title="${TSUtils.escapeHtml(ch.name)}">${TSUtils.escapeHtml(ch.name)}${ch.has_password ? ' ' + TSUtils.icons.lock : ''}</span>
          <span class="ch-count">${count} 人</span>
        </div>${kids}`;
      }).join('') + `</div>`;
    }

    // 顶层（pid=0）不缩进
    const top = byParent.get(0) || [];
    top.sort(sortFn);
    return top.map(ch => {
      const kids = render(ch.cid);
      return `<div class="channel-node" data-cid="${ch.cid}">
        <span class="ch-name" title="${TSUtils.escapeHtml(ch.name)}">${TSUtils.escapeHtml(ch.name)}${ch.has_password ? ' ' + TSUtils.icons.lock : ''}</span>
        <span class="ch-count">${ch.clients || 0} 人</span>
      </div>${kids}`;
    }).join('');
  }

  async function load() {
    const data = await API.channels(sid);
    const tree = document.getElementById('channel-tree');
    if (!data.channels.length) {
      tree.innerHTML = '<div class="empty">暂无频道，点击右上角"新建频道"创建</div>';
    } else {
      tree.innerHTML = buildTree(data.channels);
    }
    if (selectedCid != null) showDetail(selectedCid, data.channels);
    else tree.querySelector('.channel-node') && selectNode(tree.querySelector('.channel-node'));
  }

  function selectNode(node) {
    document.querySelectorAll('.channel-node.selected').forEach(n => n.classList.remove('selected'));
    node.classList.add('selected');
    showDetail(parseInt(node.dataset.cid, 10));
  }

  async function showDetail(cid) {
    selectedCid = cid;
    const data = await API.channels(sid);
    const ch = data.channels.find(c => c.cid === cid);
    const box = document.getElementById('channel-detail');
    if (!ch) { box.innerHTML = '<div class="empty">频道不存在</div>'; return; }

    const members = data.clients.filter(c => c.cid === cid);
    box.innerHTML = `
      <table>
        <tr><td class="muted">频道名称</td><td>${TSUtils.escapeHtml(ch.name)}</td></tr>
        <tr><td class="muted">ID</td><td class="mono">${ch.cid}</td></tr>
        <tr><td class="muted">主题</td><td>${TSUtils.escapeHtml(ch.topic || '-')}</td></tr>
        <tr><td class="muted">最大用户</td><td>${ch.max_clients == null || ch.max_clients < 0 ? '不限' : ch.max_clients}</td></tr>
        <tr><td class="muted">密码保护</td><td>${ch.has_password ? '<span class="badge yellow">是</span>' : '<span class="badge green">否</span>'}</td></tr>
        <tr><td class="muted">当前用户</td><td>${ch.clients || 0} 人</td></tr>
      </table>
      <h3 style="margin-top:6px">频道内用户（${members.length}）</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>昵称</th><th>空闲</th></tr></thead>
        <tbody>${members.length ? members.map(m =>
          `<tr><td>${TSUtils.escapeHtml(m.nickname)}${m.is_query ? ' <span class="badge blue">Query</span>' : ''}</td><td>${m.is_query ? '-' : TSUtils.fmtDuration(m.idle_seconds)}</td></tr>`).join('')
          : '<tr><td colspan="2"><div class="empty">暂无用户</div></td></tr>'}</tbody>
      </table></div>
      <div class="modal-footer">
        <button class="btn btn-sm" id="ch-edit">编辑频道</button>
        <button class="btn btn-sm" id="ch-add-sub">新建子频道</button>
        <button class="btn btn-sm btn-danger" id="ch-del">删除频道</button>
      </div>`;

    document.getElementById('ch-edit').onclick = () => openEditModal(ch);

    document.getElementById('ch-del').onclick = () => {
      TSUtils.confirmModal(
        '删除频道',
        `确定要删除频道 <b>${TSUtils.escapeHtml(ch.name)}</b> 吗？该操作不可恢复。`,
        async () => {
          await API.deleteChannel(sid, cid);
          selectedCid = null;
          TSUtils.toast('频道已删除', 'success');
          load();
        }
      );
    };
    document.getElementById('ch-add-sub').onclick = () => openCreateModal(ch.cid);
  }

  // ---------- 编辑频道 ----------
  function openEditModal(ch) {
    const fields = [
      { key: 'name', label: '频道名称 *', type: 'text', value: ch.name },
      { key: 'topic', label: '主题', type: 'text', value: ch.topic || '' },
      { key: 'password', label: '密码（留空 = 不修改）', type: 'text', value: '' },
      { key: 'max_clients', label: '最大用户数（-1 = 不限）', type: 'number', value: ch.max_clients },
      { key: 'order', label: '排序（越小越靠前）', type: 'number', value: ch.order },
    ];
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = `编辑频道 #${ch.cid} ${ch.name}`;
    const body = document.getElementById('modal-body');
    body.innerHTML = fields.map(f =>
      `<label>${f.label}<input class="input" style="width:100%;margin-top:5px" type="${f.type}" id="f-${f.key}" value="${TSUtils.escapeHtml(String(f.value != null ? f.value : ''))}"></label>`
    ).join('') + `<div class="modal-footer"><button class="btn" id="f-cancel">取消</button><button class="btn btn-primary" id="f-ok">保存</button></div>`;
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; };
    body.querySelector('#f-cancel').onclick = close;
    document.getElementById('modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    body.querySelector('#f-ok').onclick = async () => {
      const v = {};
      for (const f of fields) v[f.key] = body.querySelector(`#f-${f.key}`).value;
      if (!v.name.trim()) { TSUtils.toast('频道名称不能为空', 'error'); return; }
      const btn = body.querySelector('#f-ok');
      btn.disabled = true;
      try {
        await API.editChannel(sid, ch.cid, {
          name: v.name.trim(),
          topic: v.topic || undefined,
          password: v.password || undefined,
          max_clients: parseInt(v.max_clients, 10),
          order: parseInt(v.order, 10) || 0,
        });
        close();
        TSUtils.toast('频道已更新', 'success');
        load();
      } catch (e) { TSUtils.toast(e.message, 'error'); btn.disabled = false; }
    };
    body.querySelector('#f-name').focus();
  }

  // ---------- 创建频道 ----------
  async function openCreateModal(parentCid) {
    const data = await API.channels(sid);
    const options = [{ value: 0, label: '（根频道）' }].concat(
      data.channels.map(ch => ({ value: ch.cid, label: ch.name })));
    const fields = [
      { key: 'name', label: '频道名称 *', type: 'text' },
      { key: 'parent', label: '父频道', type: 'select', value: parentCid || 0, options },
      { key: 'order', label: '排序（越小越靠前）', type: 'number', value: '0' },
      { key: 'max_clients', label: '最大用户数（-1 = 不限）', type: 'number', value: '-1' },
      { key: 'password', label: '密码（留空 = 无密码）', type: 'text' },
      { key: 'topic', label: '主题（可选）', type: 'text' },
    ];
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = '新建频道';
    const body = document.getElementById('modal-body');
    body.innerHTML = fields.map(f => {
      const sel = f.type === 'select' ? `<select class="select" style="width:100%;margin-top:5px" id="f-${f.key}">` +
        f.options.map(o => `<option value="${o.value}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${TSUtils.escapeHtml(o.label)}</option>`).join('') + '</select>'
        : `<input class="input" style="width:100%;margin-top:5px" type="${f.type}" id="f-${f.key}" value="${TSUtils.escapeHtml(String(f.value != null ? f.value : ''))}">`;
      return `<label>${f.label}${sel}</label>`;
    }).join('') + `<div class="modal-footer"><button class="btn" id="f-cancel">取消</button><button class="btn btn-primary" id="f-ok">创建</button></div>`;
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; };
    body.querySelector('#f-cancel').onclick = close;
    document.getElementById('modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    body.querySelector('#f-ok').onclick = async () => {
      const v = {};
      for (const f of fields) v[f.key] = body.querySelector(`#f-${f.key}`).value;
      if (!v.name.trim()) { TSUtils.toast('请输入频道名称', 'error'); return; }
      const btn = body.querySelector('#f-ok');
      btn.disabled = true;
      try {
        await API.createChannel(sid, {
          name: v.name.trim(),
          parent_cid: parseInt(v.parent, 10) || 0,
          order: parseInt(v.order, 10) || 0,
          max_clients: parseInt(v.max_clients, 10) || -1,
          password: v.password || undefined,
          topic: v.topic || undefined,
        });
        close();
        TSUtils.toast('频道已创建', 'success');
        load();
      } catch (e) { TSUtils.toast(e.message, 'error'); btn.disabled = false; }
    };
    body.querySelector('#f-name').focus();
  }

  // ---------- 事件 ----------
  document.getElementById('ch-refresh').onclick = load;
  document.getElementById('ch-create').onclick = () => openCreateModal(0);
  document.getElementById('channel-tree').addEventListener('click', (e) => {
    const node = e.target.closest('.channel-node');
    if (node) selectNode(node);
  });

  await load();
};
