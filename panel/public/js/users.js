'use strict';

/**
 * 用户管理：在线用户列表 + 私聊 / Poke / 移动 / 踢出 / 封禁。
 */

window.TSPages = window.TSPages || {};

TSPages.users = async function () {
  const content = document.getElementById('page-content');
  const sid = TSUtils.sid() || 1;

  content.innerHTML = `
    <div class="card">
      <h3>用户管理 <span class="muted" id="user-count"></span></h3>
      <div class="muted" style="font-size:12.5px;margin-bottom:10px">
        在线用户可执行操作（踢出/封禁/移动/私聊/Poke），离线用户仅查看历史连接记录。
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>昵称</th><th>UID</th><th>频道</th><th>国家</th>
            <th>连接时长</th><th>空闲<span class="muted" title="距用户上次活动（说话/操作）的时间，活动后重新计时"> ⓘ</span></th>
            <th>状态</th><th class="actions">操作</th>
          </tr></thead>
          <tbody id="user-tbody"><tr><td colspan="8"><div class="empty">加载中…</div></td></tr></tbody>
        </table>
      </div>
    </div>`;

  function ago(tsMs) {
    if (!tsMs) return '-';
    const s = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  async function load() {
    const data = await API.clients(sid);
    const tbody = document.getElementById('user-tbody');
    const online = data.clients || [];
    const offline = data.offline_users || [];
    const total = online.length + offline.length;
    document.getElementById('user-count').textContent = `（${online.length} 在线 / ${total} 总）`;

    if (!total) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty">暂无用户记录</div></td></tr>';
      return;
    }

    // 在线用户（可操作）
    const onlineRows = online.map(c => `<tr class="user-online">
      <td>${TSUtils.escapeHtml(c.nickname)}${c.is_query ? ' <span class="badge blue">Query</span>' : ''}</td>
      <td class="mono muted" title="${TSUtils.escapeHtml(c.uid || '')}">${TSUtils.escapeHtml((c.uid || '-').slice(0, 12))}…</td>
      <td>${TSUtils.escapeHtml(c.channel_name || '')}</td>
      <td>${TSUtils.escapeHtml(c.country || '-')}</td>
      <td>${TSUtils.fmtDuration(c.connected_seconds)}</td>
      <td title="距上次活动的时间，用户说话/操作后会重新计时">${c.is_query ? '-' : TSUtils.fmtDuration(c.idle_seconds)}</td>
      <td><span class="badge green">在线</span></td>
      <td class="actions">
        <button class="btn btn-sm" data-act="poke" data-clid="${c.clid}" data-name="${TSUtils.escapeHtml(c.nickname)}">Poke</button>
        <button class="btn btn-sm" data-act="msg" data-clid="${c.clid}" data-name="${TSUtils.escapeHtml(c.nickname)}">私聊</button>
        <button class="btn btn-sm" data-act="move" data-clid="${c.clid}" data-name="${TSUtils.escapeHtml(c.nickname)}">移动</button>
        <button class="btn btn-sm" data-act="kick" data-clid="${c.clid}" data-name="${TSUtils.escapeHtml(c.nickname)}">踢出</button>
        <button class="btn btn-sm btn-danger" data-act="ban" data-clid="${c.clid}" data-name="${TSUtils.escapeHtml(c.nickname)}">封禁</button>
      </td>
    </tr>`);

    // 离线用户（不可操作）
    const offlineRows = offline.map(u => `<tr class="user-offline">
      <td>${TSUtils.escapeHtml(u.nickname)}</td>
      <td class="mono muted" title="${TSUtils.escapeHtml(u.uid || '')}">${TSUtils.escapeHtml((u.uid || '-').slice(0, 12))}…</td>
      <td class="muted">-</td>
      <td>${TSUtils.escapeHtml(u.country || '-')}</td>
      <td class="muted">-</td>
      <td class="muted">-</td>
      <td><span class="badge">离线</span> <span class="muted" style="font-size:12px">${ago(u.last_seen)}</span></td>
      <td class="actions"><span class="muted">离线不可操作</span></td>
    </tr>`);

    tbody.innerHTML = onlineRows.join('') + offlineRows.join('');
  }

  // ---------- 操作处理 ----------
  function modalForm(title, fields, onOk) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    const body = document.getElementById('modal-body');
    body.innerHTML = fields.map(f => {
      const val = f.value != null ? ` value="${TSUtils.escapeHtml(String(f.value))}"` : '';
      const checked = f.checked ? ' checked' : '';
      if (f.type === 'select') {
        return `<label>${f.label}<select class="select" style="width:100%;margin-top:5px" id="f-${f.key}">${f.options.map(o =>
          `<option value="${TSUtils.escapeHtml(String(o.value))}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${TSUtils.escapeHtml(o.label)}</option>`).join('')}</select></label>`;
      }
      if (f.type === 'textarea') {
        return `<label>${f.label}<textarea class="input" style="width:100%;margin-top:5px;resize:vertical" id="f-${f.key}" rows="3">${TSUtils.escapeHtml(String(f.value || ''))}</textarea></label>`;
      }
      return `<label>${f.label}<input class="input" style="width:100%;margin-top:5px" type="${f.type || 'text'}" id="f-${f.key}"${val}${checked}></label>`;
    }).join('') + `<div class="modal-footer"><button class="btn" id="f-cancel">取消</button><button class="btn btn-primary" id="f-ok">确定</button></div>`;
    overlay.hidden = false;
    const close = () => { overlay.hidden = true; };
    body.querySelector('#f-cancel').onclick = close;
    document.getElementById('modal-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    body.querySelector('#f-ok').onclick = async () => {
      const vals = {};
      for (const f of fields) vals[f.key] = body.querySelector(`#f-${f.key}`).value;
      const btn = body.querySelector('#f-ok');
      btn.disabled = true;
      try { await onOk(vals); close(); } catch (e) { TSUtils.toast(e.message, 'error'); btn.disabled = false; }
    };
    const first = body.querySelector('.input, select');
    if (first) first.focus();
  }

  const channels = await API.channels(sid);

  content.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, clid, name } = btn.dataset;
    // 操作成功后自动刷新列表
    const c = async (title, fields, onOk) => modalForm(title, fields, async (v) => { await onOk(v); load(); });

    switch (act) {
      case 'poke':
        c(`Poke ${name}`, [{ key: 'msg', label: 'Poke 消息', type: 'textarea' }], async (v) => {
          if (!v.msg) throw new Error('请输入 Poke 消息');
          await API.pokeClient(sid, clid, v.msg);
          TSUtils.toast(`已 Poke ${name}`, 'success');
        });
        break;
      case 'msg':
        c(`私聊 ${name}`, [{ key: 'msg', label: '私聊消息', type: 'textarea' }], async (v) => {
          if (!v.msg) throw new Error('请输入消息内容');
          await API.sendMessage(sid, clid, v.msg);
          TSUtils.toast(`消息已发送给 ${name}`, 'success');
        });
        break;
      case 'move':
        c(`移动 ${name}`, [{
          key: 'cid', label: '目标频道', type: 'select', value: '',
          options: [{ value: '', label: '— 请选择 —' }].concat(channels.channels.map(ch => ({ value: ch.cid, label: ch.name }))),
        }], async (v) => {
          if (!v.cid) throw new Error('请选择目标频道');
          await API.moveClient(sid, clid, v.cid);
          TSUtils.toast(`已将 ${name} 移动到频道`, 'success');
        });
        break;
      case 'kick':
        c(`踢出 ${name}`, [
          { key: 'reason', label: '原因（可选）', type: 'text' },
          { key: 'from', label: '范围', type: 'select', value: 'server',
            options: [{ value: 'server', label: '从服务器踢出' }, { value: 'channel', label: '仅移出频道' }] },
        ], async (v) => {
          await API.kickClient(sid, clid, { reason: v.reason, from: v.from });
          TSUtils.toast(`已${v.from === 'channel' ? '移出频道' : '踢出服务器'}: ${name}`, 'success');
        });
        break;
      case 'ban':
        c(`封禁 ${name}`, [
          { key: 'reason', label: '封禁原因（可选）', type: 'text' },
          { key: 'time', label: '封禁时长（分钟，0 = 永久）', type: 'number', value: '0' },
          { key: 'ipban', label: '同时封禁 IP', type: 'checkbox', checked: true },
        ], async (v) => {
          const mins = parseInt(v.time, 10);
          await API.banClient(sid, clid, { reason: v.reason, time: isNaN(mins) ? 0 : mins, ipban: !!v.ipban });
          TSUtils.toast(`已封禁 ${name}`, 'success');
        });
        break;
    }
  });

  await load();
};
