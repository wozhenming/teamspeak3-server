'use strict';

/**
 * TS 频道聊天点歌监听（每频道一个点歌助手）—— TeamSpeak 3 ServerQuery 版。
 *
 * 每个配置的频道各有一条独立的原始 TCP ServerQuery 连接（端口 10011），
 * 昵称为「点歌助手」（多频道时加「·频道名」后缀），启动后驻留自己的频道，
 * 绝不跨频道移动：
 *
 *   默认频道/点歌专区  ← 点歌助手（收本频道的 !点歌 等指令）
 *   默认频道/游戏专区  ← 点歌助手·游戏专区（收本频道的 !点歌 等指令）
 *
 * 各频道发指令 → 提取歌曲 ID → 加入本频道队列 → 回执到指令所在频道。
 * 队列/播放/机器人按频道隔离。
 *
 * 启用条件：配置了 TS_QUERY_ADMIN_PASSWORD 且未显式禁用（TS_CHAT_ENABLED=0）。
 */

const { config } = require('./config');
const enhanced = require('./enhanced');
const queue = require('./queue');
const player = require('./player');
const tsbridge = require('./tsbridge');
const { connectQuery, esc } = require('./tsquery');

// ---------- 会话表：频道 → 点歌助手连接 ----------
const sessions = new Map(); // channelPath -> session

function createSession(channel) {
  return {
    channel,            // 绑定的频道路径（固定，不移动）
    nick: '',           // 本会话昵称（用于过滤自己发的消息）
    conn: null,         // tsquery 连接
    state: 'stopped',   // stopped | connecting | listening | error
    retryTimer: null,
    started: false,
  };
}

function envKillSwitch() {
  return process.env.TS_CHAT_ENABLED === '0';
}

// 是否应处于运行状态：面板/持久化配置优先，env 仅作总闸
function enabled() {
  if (envKillSwitch()) return false;
  if (config.tsChatEnabled === false) return false;
  return !!config.tsQueryAdminPassword;
}

// ---------- 点歌助手命名 ----------
function assistantBase() {
  return (process.env.TS_CHAT_NICKNAME || '点歌助手').trim() || '点歌助手';
}

// 某频道对应的点歌助手名：单频道用原名；多频道加「·频道名」后缀（与机器人同规则）
function assistantNameFor(channel) {
  const channels = tsbridge.configChannels();
  const names = tsbridge.assignNames(channels, assistantBase());
  if (names[channel]) return names[channel];
  // 频道刚加、还没同步进配置时的兜底
  return channels.length === 1 ? assistantBase() : assistantBase() + '·' + String(channel).split('/').pop();
}

// 从文本提取网易云歌曲 ID：支持 ?id=、/song/<id>、纯数字
function extractSongId(text) {
  if (!text) return null;
  const t = text.trim();
  let m = t.match(/[?&]id=(\d{4,12})/i);
  if (m) return m[1];
  m = t.match(/song\/(\d{4,12})/i);
  if (m) return m[1];
  m = t.match(/^(\d{4,12})$/);
  if (m) return m[1];
  return null;
}

// ---------- 与队列/播放器对接（全部按会话所在频道隔离） ----------

// 确保某频道正在播放：只要该频道当前没在放，就开播（队列空则从头/继续）
function ensurePlaying(channel) {
  const st = player.forChannel(channel).get();
  if (st.playing) return;
  if (!st.current) player.forChannel(channel).play();
  else player.forChannel(channel).resume();
}

async function addSong(body, invokerName, reply, channel) {
  const songId = extractSongId(body);
  if (!songId) {
    reply('用法：!点歌 <歌曲ID 或 网易云链接>');
    return;
  }
  try {
    let detail = null;
    try {
      const d = await enhanced.songDetail(songId);
      detail = d && d.songs && d.songs[0];
    } catch (e) { /* 详情失败仍可尝试入队最小信息 */ }
    if (!detail) detail = { id: songId, name: '歌曲 ' + songId };
    const q = queue.forChannel(channel);
    q.enqueue({
      name: detail.name,
      songId: songId,
      artists: (detail.ar || []).map((a) => a.name).join(' '),
      album: (detail.al || {}).name || '',
      cover: (detail.al || {}).picUrl || '',
      duration: detail.dt ? Math.round(detail.dt / 1000) : 0,
      fee: detail.fee != null ? detail.fee : null,
    }, (invokerName || 'TS用户') + '(TS)');
    ensurePlaying(channel); // 队列为空或未在播放时自动开播
    const pos = q.all().length;
    reply('✔ 已加入本频道队列：' + detail.name + '（第 ' + pos + ' 位）');
  } catch (e) {
    reply('✖ 点歌失败：' + e.message);
  }
}

function runControl(cmdName, invokerName, arg, reply, channel) {
  try {
    const st = player.forChannel(channel).get();
    if (cmdName === 'play') {
      const at = parsePosition(arg);
      if (at) { runPlayAt(at, invokerName, reply, channel); return; }
      if (!st.current) player.forChannel(channel).play();
      else player.forChannel(channel).resume();
      require('./tsbridge').resumeRadio(channel).catch(() => {});
      reply(st.current && st.current.title ? '▶ 已继续播放：' + st.current.title : '▶ 已开始播放');
    } else if (cmdName === 'pause') {
      player.forChannel(channel).pause();
      reply('⏸ 已暂停');
    } else if (cmdName === 'next') {
      const r = player.forChannel(channel).next();
      const cur = r && r.current;
      reply(cur ? '⏭ 已切歌：' + cur.title : '队列末尾/为空，无法继续切');
      // 切歌后主动重新向点歌机器人下达播放：即便它此前因流空档停了，也能立即恢复拉流
      require('./tsbridge').resumeRadio(channel).catch(() => {});
    } else if (cmdName === 'clear') {
      runClear(invokerName, reply, channel);
    } else if (cmdName === 'search') {
      runSearch(arg || '', invokerName, reply);
    } else if (cmdName === 'queue') {
      runQueue(arg || '', invokerName, reply, channel);
    }
  } catch (e) {
    reply('✖ 操作失败：' + e.message);
  }
}

// 清空本频道点歌队列（并停止当前播放，emitChange(null) 会触发 player 停止）
function runClear(invokerName, reply, channel) {
  try {
    const n = queue.forChannel(channel).all().length;
    queue.forChannel(channel).clear();
    reply(n ? ('🧹 已清空本频道点歌队列（' + n + ' 首）') : '队列本来就是空的');
  } catch (e) {
    reply('✖ 清空失败：' + e.message);
  }
}

// 从 "!第3首" / "3" / "第 3 首" / "3首" 中解析 1 基序号
function parsePosition(text) {
  if (text == null) return null;
  const m = String(text).match(/第?\s*(\d+)\s*(?:首|位|个|song)?/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// 跳播队列指定位置（1 基）：!播放第3首 / !播3 / !跳3 / !播放 3
function runPlayAt(n, invokerName, reply, channel) {
  const all = queue.forChannel(channel).all();
  if (!all.length) return reply('队列为空，用 !点歌 <ID> 添加歌曲');
  if (!Number.isInteger(n) || n < 1 || n > all.length) {
    return reply('✖ 队列只有 ' + all.length + ' 首，无法播放第 ' + n + ' 首');
  }
  const item = all[n - 1];
  const res = player.forChannel(channel).play(item.id);
  const played = res.current || item;
  require('./tsbridge').resumeRadio(channel).catch(() => {});
  reply('▶ 已跳播第 ' + n + ' 首：' + (played.title || played.name) + (played.artists ? ' - ' + played.artists : ''));
}

// 查看本频道播放队列（分页，每页最多 10 首）：!队列 [页码]
function runQueue(arg, invokerName, reply, channel) {
  const all = queue.forChannel(channel).all();
  const total = all.length;
  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = player.forChannel(channel).get().current;
  const curId = cur ? cur.id : null;
  // 未指定页码时，默认定位到“当前正在播放的歌曲”所在页
  let defaultPage = 1;
  if (curId != null) {
    const curIndex = all.findIndex((s) => Number(s.id) === Number(curId));
    if (curIndex >= 0) defaultPage = Math.floor(curIndex / pageSize) + 1;
  }
  let page = parseInt((arg || '').trim(), 10);
  if (!page || page < 1) page = defaultPage;
  if (page > pages) page = pages;
  const start = (page - 1) * pageSize;
  const slice = all.slice(start, start + pageSize);
  if (!total) {
    reply('队列为空，用 !点歌 <ID> 添加歌曲');
    return;
  }
  const lines = slice.map((s, i) => {
    const idx = start + i + 1;
    const mark = (s.id === curId) ? '▶ ' : '  ';
    const artists = s.artists ? ' - ' + s.artists : '';
    const sid = s.songId || s.id;
    return mark + idx + '. ' + s.title + artists + '  (ID:' + sid + ')';
  });
  let msg = '📜 本频道播放队列（共 ' + total + ' 首，第 ' + page + '/' + pages + ' 页）\n' + lines.join('\n');
  if (pages > 1) {
    msg += '\n!队列 ' + (page < pages ? (page + 1) : 1) + ' 查看' + (page < pages ? '下一页' : '首页');
  }
  reply(msg);
}

// 按关键词搜索歌曲，返回前 5 首：歌名 - 歌手（ID）
function runSearch(keyword, invokerName, reply) {
  keyword = (keyword || '').trim();
  if (!keyword) {
    reply('用法：!搜索 <歌曲名/关键字>，例如 !搜索 周杰伦');
    return;
  }
  // 异步执行，避免阻塞命令分发
  (async () => {
    try {
      const result = await enhanced.search(keyword, 'song', 5, 0);
      const songs = (result && result.songs) || [];
      if (!songs.length) {
        reply('未找到与「' + keyword + '」相关的歌曲');
        return;
      }
      const lines = songs.slice(0, 5).map((s, i) => {
        const artists = Array.isArray(s.artists) ? s.artists.map((a) => a.name).join('/') : (s.artist || '');
        return (i + 1) + '. ' + s.name + (artists ? ' - ' + artists : '') + '  (ID:' + s.id + ')';
      });
      reply('🔍 搜索「' + keyword + '」前 ' + lines.length + ' 首：\n' + lines.join('\n') + '\n用 !点歌 <ID> 点播');
    } catch (e) {
      reply('✖ 搜索失败：' + e.message);
    }
  })();
}

// 命令分发：!点歌/!点 <ID|链接> · !播放/!继续/!pause · !暂停 · !切歌/!下一首/!next · !清队列 · !搜索 <关键词>
const CTRL_MAP = {
  play: 'play', resume: 'play', 继续: 'play', 播放: 'play', 开始: 'play',
  pause: 'pause', 暂停: 'pause',
  next: 'next', skip: 'next', 切歌: 'next', 下一首: 'next',
  clear: 'clear', 清队列: 'clear', 清空队列: 'clear', 清队: 'clear', 清掉队列: 'clear',
  search: 'search', 搜: 'search', 搜索: 'search', 查找: 'search', 找歌: 'search', find: 'search',
  queue: 'queue', 队列: 'queue', 列表: 'queue', q: 'queue', playlist: 'queue', 待播: 'queue',
};
const LOOP_WORDS = { loop: 1, cycle: 1, 循环: 1, 循环模式: 1 };
const LOOP_MODES = {
  all: 'all', 列表: 'all', 顺序: 'all', list: 'all',
  one: 'one', 单曲: 'one', single: 'one',
  shuffle: 'shuffle', 随机: 'shuffle',
  off: 'off', 关: 'off', none: 'off',
};
const LOOP_LABEL = { all: '列表循环', one: '单曲循环', shuffle: '随机播放', off: '顺序播放' };

// 指令是否被面板允许
function cmdEnabled(name) {
  const cmds = (config.chatCommands || {});
  return cmds[name] !== false;
}

function runLoop(arg, invokerName, reply, channel) {
  try {
    const a = (arg || '').trim().toLowerCase();
    let mode = LOOP_MODES[a];
    let cur = player.forChannel(channel).get().loopMode;
    if (!mode) {
      if (a) { reply('循环模式：!循环 <列表|单曲|随机|关>（当前：' + (LOOP_LABEL[cur] || cur) + '）'); return; }
      const order = ['all', 'one', 'shuffle', 'off'];
      mode = order[(order.indexOf(cur) + 1) % order.length]; // 不给参数则循环切换
    }
    player.forChannel(channel).setLoop(mode);
    reply('循环模式 → ' + (LOOP_LABEL[player.forChannel(channel).get().loopMode] || player.forChannel(channel).get().loopMode));
  } catch (e) {
    reply('✖ 切换循环失败：' + e.message);
  }
}

// !状态：本频道正在播放 / 下一首 / 播放与循环状态
const STATUS_WORDS = { 状态: 1, now: 1, 当前: 1, playing: 1, 正在播放: 1 };
function mm(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function runStatus(invokerName, reply, channel) {
  try {
    const st = player.forChannel(channel).get();
    const all = queue.forChannel(channel).all();
    const cur = st.current;
    let nowTxt = '无';
    if (cur) {
      nowTxt = cur.title + (cur.artists ? ' - ' + cur.artists : '') + ' [' + mm(st.position) + '/' + (cur.duration ? mm(cur.duration) : '--') + ']';
    }
    let nextTxt = '无';
    if (all.length) {
      const idx = cur ? all.findIndex((i) => Number(i.id) === Number(cur.id)) : -1;
      const nxt = (idx >= 0 && idx + 1 < all.length) ? all[idx + 1] : (st.loopMode === 'all' && all[0] ? all[0] : null);
      if (nxt) nextTxt = nxt.title + (nxt.artists ? ' - ' + nxt.artists : '');
    }
    reply('正在播放：' + nowTxt + '｜下一首：' + nextTxt + '｜' +
      (st.playing ? '▶播放中' : '⏸已暂停') + '｜' + '循环：' + (LOOP_LABEL[st.loopMode] || st.loopMode) +
      '｜队列：' + all.length + ' 首');
  } catch (e) {
    reply('✖ 状态查询失败：' + e.message);
  }
}

const CMD_NAME = { play: 'play', pause: 'pause', next: 'next', clear: 'clear', search: 'search', queue: 'queue', playat: 'playat' };
function handleRequest(rawText, invokerName, reply, channel) {
  const text = (rawText || '').trim();
  if (!text) return;
  channel = channel || 'default';
  const ctl = text.match(/^!\s*(\S+)\s*(.*)$/);
  if (ctl) {
    const w = ctl[1].toLowerCase();
    const rest = ctl[2].trim();
    if (CTRL_MAP[w]) {
      const name = CMD_NAME[CTRL_MAP[w]];
      if (!cmdEnabled(name)) return reply('该指令已被管理员禁用');
      runControl(CTRL_MAP[w], invokerName, rest, reply, channel);
      return;
    }
    if (LOOP_WORDS[w]) {
      if (!cmdEnabled('loop')) return reply('循环指令已被管理员禁用');
      runLoop(rest, invokerName, reply, channel);
      return;
    }
    if (STATUS_WORDS[w]) {
      if (!cmdEnabled('status')) return reply('状态指令已被管理员禁用');
      runStatus(invokerName, reply, channel);
      return;
    }
    if (['点歌', '点', 'dian', 'song', 'req', '点播'].includes(w)) {
      if (!cmdEnabled('dian')) return reply('点歌指令已被管理员禁用');
      addSong(rest, invokerName, reply, channel);
      return;
    }
    // 跳播队列第 N 首：!播放第3首 / !播3 / !跳3 / !第3首 / !play3
    const playAtMatch = text.match(/^!\s*(?:播|播放|跳|选|放|第|play|jump|goto|select|p)\s*第?\s*(\d+)\s*(?:首|位|个|song)?\s*$/i);
    if (playAtMatch) {
      if (!cmdEnabled('playat')) return reply('该指令已被管理员禁用');
      runPlayAt(parseInt(playAtMatch[1], 10), invokerName, reply, channel);
      return;
    }
    reply('可用指令：!点歌 <歌曲ID或链接> · !播放(第N首) · !暂停 · !切歌 · !清队列 · !搜索 <关键词> · !队列 [页码] · !循环 · !状态');
    return;
  }
  // 无前缀：整条就是歌曲 ID 或链接才视为点歌（避免把闲聊话题误当成点歌）
  if (/^https?:\/\//i.test(text) || /^\d{4,12}$/.test(text)) {
    if (!cmdEnabled('dian')) return;
    addSong(text, invokerName, reply, channel);
  }
}

// ---------- 会话命令收发（基于 tsquery 的串行 FIFO 连接） ----------
function cmd(session, cmdStr, timeoutMs = 6000) {
  if (!session.conn) return Promise.reject(new Error('chat 连接未就绪'));
  return session.conn.cmd(cmdStr, timeoutMs);
}

// TS3 单条消息有长度限制（约 1024 字节），长回执按行拆成多条发送
function reply(session, msg) {
  const full = String(msg == null ? '' : msg);
  const LIMIT = 900;
  const chunks = [];
  if (full.length <= LIMIT) {
    chunks.push(full);
  } else {
    let rest = full;
    while (rest.length > LIMIT) {
      // 优先在换行处断开，其次退到 LIMIT 内最后一个空白/符号处
      let cut = rest.lastIndexOf('\n', LIMIT);
      if (cut < LIMIT * 0.5) cut = LIMIT;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest) chunks.push(rest);
  }
  (async () => {
    for (const c of chunks) {
      try { await cmd(session, 'sendtextmessage targetmode=2 msg=' + esc('[点歌] ' + c)); } catch (e) { return; }
    }
  })();
}

// 解析频道 cid：查询端 channellist 按名字匹配（完整名 → 叶子名 → 叶子后缀），
// 失败退化 channelinfo 逐个探测。全部失败时抛错并带上「查询端实际看到的频道名」。
async function resolveChannelCid(session, channelPath) {
  const want = String(channelPath || '').trim();
  const leaf = want.split('/').pop().trim();
  const low = (v) => String(v || '').trim().toLowerCase();
  let seen = [];
  // 1) channellist 匹配（多行 '|' 拼接已由 tsquery 处理）
  try {
    const cl = await cmd(session, 'channellist');
    const items = (Array.isArray(cl) ? cl : [cl]).filter(Boolean);
    seen = items.map((c) => c.channel_name);
    const hit = items.find((c) => low(c.channel_name) === low(want))
      || items.find((c) => leaf && low(c.channel_name) === low(leaf))
      || items.find((c) => leaf && low(c.channel_name).endsWith(low(leaf)));
    if (hit && hit.cid != null) return String(hit.cid);
  } catch (e) { /* 继续走探测 */ }
  // 2) channelinfo 逐个探测
  for (let cid = 1; cid <= 12; cid++) {
    try {
      const ci = await cmd(session, 'channelinfo cid=' + cid);
      const o = (Array.isArray(ci) ? ci[0] : ci) || {};
      if (low(o.channel_name) === low(leaf) || low(o.channel_name) === low(want)) return String(cid);
    } catch (e) { /* 该 cid 可能不存在，忽略 */ }
  }
  throw new Error('找不到频道「' + want + '」（查询端 channellist 实际看到: ' + JSON.stringify(seen) + '）');
}

// ---------- 单会话 TCP 连接管理 ----------
function connect(session) {
  const host = config.tsHost || 'teamspeak';
  const port = config.tsQueryPort || parseInt(process.env.TS_QUERY_PORT || '10011', 10);
  console.log('[tschat][' + session.channel + '] 连接 TeamSpeak ServerQuery：host=' + host + ' port=' + port);
  session.state = 'connecting';

  connectQuery({
    host,
    port,
    user: 'serveradmin',
    password: config.tsQueryAdminPassword,
    sid: 0, // bootstrap 中按需选择虚拟服务器
    onNotify: (line, parsed) => {
      const p = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!p || !/^notifytextmessage/i.test(line)) return;
      console.log('[tschat][' + session.channel + '] 收到聊天 from=' + (p.invokername || '?') + ' tm=' + (p.targetmode || '?') + ' msg=' + String(p.msg || '').slice(0, 120));
      const invName = (p.invokername || '').trim();
      // 仅忽略“自己发出的回执”（按本会话昵称判断，最可靠）
      if (invName && invName === session.nick) return;
      // 指令只作用于本会话所在频道的队列/播放器
      handleRequest(p.msg || '', invName || '?', (msg) => reply(session, msg), session.channel);
    },
    onClosed: () => {
      if (!session.started) { teardownSession(session); return; }
      fail(session, new Error('query 连接关闭'));
    },
  }).then(async (conn) => {
    session.conn = conn;
    await bootstrap(session);
  }).catch((e) => {
    if (!session.started) { teardownSession(session); return; }
    fail(session, e);
  });
}

// 会话启动：进自己的频道并订阅聊天事件（固定驻留，绝不跨频道移动）
async function bootstrap(session) {
  try {
    await selectVirtualServer(session, session.channel);
    // 昵称冲突自愈（上一次连接未干净退出时 513）
    let nick = assistantNameFor(session.channel);
    try {
      await cmd(session, 'clientupdate client_nickname=' + esc(nick));
    } catch (e) {
      nick = nick + Math.floor(Math.random() * 90 + 10);
      await cmd(session, 'clientupdate client_nickname=' + esc(nick));
    }
    session.nick = nick;
    await joinOwnChannel(session);
    session.state = 'listening';
    session.retryAttempt = 0; // 连续失败计数清零（退避重置）
    console.log('[tschat][' + session.channel + '] 已驻留频道并监听点歌指令 (昵称=' + nick + ')');
  } catch (e) {
    fail(session, e);
  }
}

// 把本会话的查询客户端移动到自己绑定的频道（失败重试；已在则 error id=770 视为成功）
async function joinOwnChannel(session) {
  const cid = await resolveChannelCid(session, session.channel);
  const me = await myInfo(session);
  const myClid = me.clid;
  if (!myClid) throw new Error('无法获取查询端自身 clid');
  const cpw = (config.ts3abChannelPassword || '').trim();
  let moved = false;
  for (let attempt = 0; attempt < 3 && !moved; attempt++) {
    try {
      let cmdStr = 'clientmove cid=' + cid + ' clid=' + myClid;
      if (cpw) cmdStr += ' cpw=' + esc(cpw);
      await cmd(session, cmdStr);
      console.log('[tschat][' + session.channel + '] 已 clientmove 到频道 cid=' + cid + (cpw ? '（带密码）' : ''));
      moved = true;
    } catch (e) {
      // error id=770 already member of channel：已在目标频道，视为成功
      if (/id=770|already[^a-z]*member/i.test(e.message || String(e))) { moved = true; }
      else {
        console.log('[tschat][' + session.channel + '] clientmove 第 ' + (attempt + 1) + ' 次失败：' + (e.message || e));
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  if (!moved) throw new Error('clientmove 失败');
  // 订阅聊天事件。server 全局事件只挂在第一个频道会话上，避免多助手重复应答。
  const events = ['textchannel', 'textprivate'];
  const firstChannel = tsbridge.configChannels()[0];
  if (session.channel === firstChannel) events.push('textserver');
  for (const ev of events) {
    try { await cmd(session, 'servernotifyregister event=' + ev); }
    catch (e) { console.log('[tschat][' + session.channel + '] 订阅 ' + ev + ' 失败：' + (e.message || e)); }
  }
}

// 取查询客户端自身的 clid/cid。优先 whoami，失败时从 clientlist 里找自己兜底。
function findMe(items, nick) {
  if (nick) {
    const m = items.find((x) => x.client_nickname === nick)
      || items.find((x) => x.client_nickname && String(x.client_nickname).startsWith(nick));
    if (m) return m;
  }
  return items.find((x) => String(x.client_type) === '1'); // 退化：取任一 ServerQuery 客户端
}
async function myInfo(session) {
  // TS3 whoami 字段为 client_id / channel_id（兼容 clid / cid 写法）
  const pickClid = (o) => (o.client_id != null ? o.client_id : (o.clid != null ? o.clid : null));
  const pickCid = (o) => (o.channel_id != null ? o.channel_id : (o.cid != null ? o.cid : null));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const w = await cmd(session, 'whoami');
      const o = (Array.isArray(w) ? w[0] : w) || {};
      if (pickClid(o) != null || pickCid(o) != null) {
        return { clid: pickClid(o), cid: pickCid(o), via: 'whoami' };
      }
    } catch (e) { /* 重试 */ }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
  }
  // 兜底：从 clientlist 里找自己（按当前昵称优先）
  try {
    const list = await cmd(session, 'clientlist -uid');
    const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
    const m = findMe(items, session.nick);
    return { clid: m ? m.clid : null, cid: m ? m.cid : null, via: 'list' };
  } catch (e) {
    return { clid: null, cid: null, via: 'none' };
  }
}

// 选择包含目标频道的虚拟服务器（TeamSpeak 可能有多台；默认 use 1，找不到目标频道再遍历）
async function selectVirtualServer(session, wantName) {
  const defaultSid = (process.env.TS_CHAT_SID || '1');
  const leaf = (wantName || '').split('/').pop().toLowerCase();
  const matchCh = (ch) => {
    const n = (ch.channel_name || '').toLowerCase();
    return n === (wantName || '').toLowerCase() || (leaf && n.endsWith(leaf));
  };
  if (wantName) {
    try {
      const sl = await cmd(session, 'serverlist');
      const servers = (Array.isArray(sl) ? sl : [sl]).filter(Boolean);
      for (const s of servers) {
        const sid = s.virtualserver_id || s.sid || s.id;
        if (!sid) continue;
        try {
          await cmd(session, 'use ' + sid);
          const cl = await cmd(session, 'channellist');
          const chs = (Array.isArray(cl) ? cl : [cl]).filter(Boolean);
          if (chs.some(matchCh)) { console.log('[tschat][' + session.channel + '] 已切到含目标频道的虚拟服务器 sid=' + sid); return; }
        } catch (e) { /* 试下一台 */ }
      }
      console.log('[tschat][' + session.channel + '] 未找到含目标频道的虚拟服务器，回退默认 sid=' + defaultSid);
    } catch (e) {
      console.log('[tschat][' + session.channel + '] 遍历虚拟服务器失败，回退默认：' + (e.message || e));
    }
  }
  await cmd(session, 'use ' + defaultSid);
}

function scheduleRetry(session) {
  if (session.retryTimer) return;
  session.retryAttempt = (session.retryAttempt || 0) + 1;
  const wait = Math.min(60000, 8000 * session.retryAttempt); // 指数退避：8s/16s/24s…封顶 60s，防重连风暴堆积查询会话
  console.log('[tschat][' + session.channel + '] ' + Math.round(wait / 1000) + 's 后重试（第 ' + session.retryAttempt + ' 次）');
  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    if (!session.started) return;
    connect(session);
  }, wait);
}

function fail(session, err) {
  if (!session.started) { teardownSession(session); return; }
  session.state = 'error';
  console.log('[tschat][' + session.channel + '] 断开：' + (err && err.message ? err.message : err));
  teardownConn(session);
  scheduleRetry(session);
}

function teardownConn(session) {
  try { session.conn && session.conn.close(); } catch (e) { /* 忽略 */ }
  session.conn = null;
}

function teardownSession(session) {
  session.started = false;
  session.state = 'stopped';
  if (session.retryTimer) { clearTimeout(session.retryTimer); session.retryTimer = null; }
  teardownConn(session);
}

// ---------- 多会话编排 ----------
// 面板保存配置后调用：按最新频道列表增删会话（密码变化时全部重建）
let appliedPassword = null;

function syncSessions() {
  const channels = tsbridge.configChannels();
  // 停掉不再配置的频道会话
  for (const [ch, s] of [...sessions]) {
    if (!channels.includes(ch)) {
      teardownSession(s);
      sessions.delete(ch);
      console.log('[tschat] 频道「' + ch + '」已从部署列表移除，点歌助手停止');
    }
  }
  // 为新频道创建会话（错峰连接，避免同时大量查询登录触发 TS3 洪水限制）
  let delay = 0;
  for (const ch of channels) {
    if (sessions.has(ch)) continue;
    const s = createSession(ch);
    sessions.set(ch, s);
    setTimeout(() => {
      if (sessions.get(ch) === s && s.started && enabled()) connect(s);
    }, delay);
    delay += 2500;
    s.started = true;
    s.state = 'connecting';
    console.log('[tschat] 将为频道「' + ch + '」启动点歌助手（' + assistantNameFor(ch) + '）');
  }
}

function start() {
  if (!enabled()) {
    console.log('[tschat] 未启用（需设置查询密码；可在点歌页「机器人管理 → 点歌助手」中配置）');
    return;
  }
  appliedPassword = config.tsQueryAdminPassword || '';
  syncSessions();
}

function stop() {
  appliedPassword = null;
  for (const s of sessions.values()) teardownSession(s);
  sessions.clear();
  console.log('[tschat] 已按配置停止');
}

// 面板保存配置后调用：按最新配置启/停/增删会话
function applyConfig() {
  if (!enabled()) {
    if (sessions.size) stop();
    console.log('[tschat] 已按配置停止');
    return;
  }
  const pwd = config.tsQueryAdminPassword || '';
  if (appliedPassword !== null && appliedPassword !== pwd) {
    console.log('[tschat] 查询密码变更，重建全部点歌助手连接');
    stop();
  }
  start();
}

// 运行状态（面板展示）：state 为聚合状态，sessions 为各频道明细
function getState() {
  const list = [...sessions.values()].map((s) => ({ channel: s.channel, state: s.state, nick: s.nick }));
  let state = 'stopped';
  if (!enabled()) state = 'stopped';
  else if (!list.length) state = 'stopped';
  else if (list.some((s) => s.state === 'error')) state = 'error';
  else if (list.some((s) => s.state === 'connecting')) state = 'connecting';
  else if (list.every((s) => s.state === 'listening')) state = 'listening';
  else state = 'connecting';
  return {
    state,
    enabled: enabled(),
    hasPassword: !!config.tsQueryAdminPassword,
    sessions: list,
  };
}

module.exports = {
  start,
  stop,
  applyConfig,
  enabled,
  getState,
  // 测试钩子（非公开接口）
  _internal: { extractSongId, handleRequest, assistantNameFor },
};
