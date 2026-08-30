'use strict';

/**
 * TeamSpeak 3 ServerQuery 连接层（原始 TCP，端口 10011）。
 *
 * 协议要点（TS3 3.13 实测）：
 *  - 传输：telnet 风格行协议；连接后服务端发送 "TS3" 横幅与欢迎文本，随后才能发命令
 *  - 认证：`login serveradmin <密码>`（TS3 无 API Key 概念）
 *  - 选服：`use <sid>`；之后命令都在该虚拟服务器上执行
 *  - 响应：若干数据行 + `error id=<n> msg=<m>` 结尾；id=0 为成功
 *  - 转义：空格→\s，反斜杠→\\，竖线→\p，斜杠→\/
 *
 * 实现：面板共享一条长连接（内部命令 FIFO 串行），sid 变化时自动 `use`；
 * 断线后下一条命令自动重连。命令面命令面与路由层约定保持一致。
 */

const net = require('net');
const { config } = require('./config');

const TIMEOUT_MS = 10000;

class QueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
  }
}

// ---------- 行协议工具 ----------
function esc(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '\\s')
    .replace(/\|/g, '\\p')
    .replace(/\//g, '\\/')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n');
}
function unesc(v) {
  return String(v)
    .replace(/\\s/g, ' ')
    .replace(/\\p/g, '|')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');
}
function isRowSeparator(line, idx) {
  let bs = 0, i = idx - 1;
  while (i >= 0 && line[i] === '\\') { bs++; i--; }
  return bs % 2 === 0;
}
function splitRows(line) {
  const rows = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && isRowSeparator(line, i)) {
      rows.push(line.slice(start, i));
      start = i + 1;
    }
  }
  rows.push(line.slice(start));
  return rows.filter((r) => r.length > 0);
}
function parseParams(line) {
  const out = {};
  const re = /(\w+)=("([^"]*)"|[^\s]+)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = unesc(m[3] != null ? m[3] : m[2]);
  return out;
}
function rowsOrObjects(line) {
  const parts = splitRows(line);
  if (parts.length <= 1) return [parseParams(line)];
  return parts.map(parseParams);
}

// ---------- 长连接管理 ----------
let sock = null;
let buf = '';
let bannerSeen = false;
let loggedIn = false;
let currentSid = 0;
let pending = [];       // { rows, resolve, reject, timer, cmdStr }
let connecting = null;  // 进行中的连接 Promise
let chain = Promise.resolve(); // 命令串行链
let lastError = '';
let loginFailUntil = 0;   // 密码错误后的冷却期：防止高频重试触发 TS3 自动封禁

function isReady() { return !!(sock && sock.writable && loggedIn); }

function failWaiters(err) {
  while (pending.length) {
    const p = pending.shift();
    clearTimeout(p.timer);
    try { p.reject(err); } catch (e) { /* 忽略 */ }
  }
}

function teardown(err) {
  loggedIn = false;
  bannerSeen = false;
  currentSid = 0;
  if (sock) {
    try { sock.destroy(); } catch (e) { /* 忽略 */ }
    sock = null;
  }
  if (err) failWaiters(err);
}

function connect() {
  if (connecting) return connecting;
  if (Date.now() < loginFailUntil) {
    const waitSec = Math.ceil((loginFailUntil - Date.now()) / 1000);
    return Promise.reject(new QueryError(-1,
      `上次登录失败后冷却中（还需 ${waitSec}s）：请确认 serveradmin 密码后重试`));
  }
  const { tsQueryHost, tsQueryPort, tsQueryUser, tsQueryPassword } = config;
  connecting = new Promise((resolve, reject) => {
    const s = net.createConnection({ host: tsQueryHost, port: tsQueryPort });
    s.setEncoding('utf8');
    s.setKeepAlive(true, 30000);
    sock = s;
    let handshakeDone = false;

    const onErr = (e) => {
      const err = new QueryError(-1, `无法连接 TeamSpeak ServerQuery（${tsQueryHost}:${tsQueryPort}）：${e.message || e}`);
      lastError = err.message;
      connecting = null;
      handshakeDone = true;
      teardown(err);
      reject(err);
    };
    s.once('error', onErr);
    s.once('close', () => {
      if (connecting && !handshakeDone) { onErr(new Error('连接在握手前关闭')); }
    });

    s.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (bannerSeen !== true) {
          // 横幅：首行 "TS3"，随后一行欢迎文本；见到欢迎文本即可发命令
          if (/^TS3\b/.test(line)) bannerSeen = 'ts3';
          else if (bannerSeen === 'ts3') {
            bannerSeen = true;
            handshake();
          }
          continue;
        }
        dispatchLine(line);
      }
    });

    const handshake = async () => {
      if (handshakeDone) return;
      handshakeDone = true;
      try {
        if (!tsQueryPassword) {
          throw new QueryError(-1, '未配置 serveradmin 查询密码（请进入「部署管理」页保存密码）');
        }
        await rawCmd(`login ${esc(tsQueryUser || 'serveradmin')} ${esc(tsQueryPassword)}`, 8000);
        loggedIn = true;
        connecting = null;
        resolve();
      } catch (e) {
        const err = e instanceof QueryError ? e : new QueryError(-1, 'TS3 Query 登录失败：' + (e.message || e));
        if (/512|invalid login/i.test(err.message)) loginFailUntil = Date.now() + 30000;
        lastError = err.message;
        connecting = null;
        teardown(err);
        reject(err);
      }
    };
  });
  return connecting;
}

function dispatchLine(line) {
  const head = pending[0];
  if (!head) return;
  if (/^error id=/i.test(line)) {
    pending.shift();
    clearTimeout(head.timer);
    if (/^error id=0(\s|$)/i.test(line)) {
      // 统一返回数组：单行列表（如 serverlist 只有 1 台服务器）也保持数组形态；
      // 单对象消费方一律走 one() 取第一行
      head.resolve(head.rows);
    } else {
      const id = (line.match(/id=(-?\d+)/) || [])[1];
      const msg = (line.match(/msg=(.*)$/) || [])[1] || line;
      head.reject(new QueryError(id, `TS3 Query 错误 [${id}]：${unesc(msg)}（${head.cmdStr}）`));
    }
    return;
  }
  for (const o of rowsOrObjects(line)) head.rows.push(o);
}

function rawCmd(cmdStr, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    // 只检查 socket 可写：登录命令本身发出时 loggedIn 还是 false
    if (!sock || !sock.writable) return reject(new QueryError(-1, 'TS3 Query 连接未就绪'));
    const entry = { rows: [], cmdStr, resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
      reject(new QueryError(-1, `TS3 Query 命令超时（${cmdStr}）`));
    }, timeoutMs);
    pending.push(entry);
    sock.write(cmdStr + '\n');
  });
}

// 执行一条命令（自动补 use sid）。sid=0 表示实例级（无需 use）。
async function command(sid, cmdStr, timeoutMs) {
  if (!isReady()) await connect();
  const wantSid = parseInt(sid, 10) || 0;
  if (wantSid > 0 && currentSid !== wantSid) {
    await rawCmd('use ' + wantSid, 8000);
    currentSid = wantSid;
  }
  return rawCmd(cmdStr, timeoutMs);
}

// 串行化并发命令（面板路由会并发调用）
function enqueue(sid, cmdStr, timeoutMs) {
  const run = chain.then(() => command(sid, cmdStr, timeoutMs));
  chain = run.then(() => {}, () => {});
  // 连接刚断时允许下一次入队触发重连
  run.catch(() => {});
  return run;
}

// 重建命令构造：把参数对象拼成 key=value 命令串（自动转义；flag 以 -uid 等形式直接拼接）
function buildLine(cmd, params) {
  let line = cmd;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (k.startsWith('-')) line += ' ' + k; // 旗标参数
      else line += ' ' + k + '=' + esc(v);
    }
  }
  return line;
}

// 单行命令的便捷封装：cmd('clientinfo', { clid: 1 })
function q(sid, cmd, params, timeoutMs) {
  return enqueue(sid, buildLine(cmd, params), timeoutMs);
}

// 单结果便捷封装（serverinfo/clientinfo 等返回单对象）
async function one(sid, cmd, params, timeoutMs) {
  const r = await q(sid, cmd, params, timeoutMs);
  return Array.isArray(r) ? (r[0] || {}) : (r || {});
}

// ---------- 对路由层暴露的命令面 ----------
const ts = {
  // 连接信息（部署页展示用）
  describe: () => `ServerQuery ${config.tsQueryHost}:${config.tsQueryPort}`,
  lastError: () => lastError,

  version: () => one(0, 'version'), // { version, build, platform }
  whoami: (sid) => one(sid, 'whoami'),
  serverlist: () => q(0, 'serverlist'),

  // ---------- 服务器信息 ----------
  serverinfo: (sid) => one(sid, 'serverinfo'),
  // TS3 无 serverrequestconnectioninfo：每秒带宽字段就在 serverinfo 里，直接复用
  connectionInfo: (sid) => one(sid, 'serverinfo'),
  editServer: (sid, opts) => q(sid, 'serveredit', opts),

  // ---------- 用户 ----------
  clientlist: (sid) => q(sid, 'clientlist', {
    '-uid': '', '-away': '', '-voice': '', '-times': '', '-groups': '', '-info': '', '-country': '', '-ip': '',
  }),
  clientinfo: (sid, clid) => one(sid, 'clientinfo', { clid }),
  kick: (sid, clid, { reason = '', from = 'server' } = {}) =>
    q(sid, 'clientkick', {
      clid,
      reasonid: from === 'channel' ? 4 : 5, // TS3：4=踢出频道，5=踢出服务器
      reasonmsg: reason || undefined,
    }),
  ban: async (sid, clid, { reason = '', time = 0, ipban = false } = {}) => {
    await q(sid, 'banclient', { clid, time, banreason: reason || undefined });
    // 可选：额外封禁客户端 IP
    if (ipban) {
      try {
        const info = await ts.clientinfo(sid, clid);
        const ip = info.connection_client_ip || info.client_ip;
        if (ip && !['0.0.0.0', '::'].includes(ip)) {
          await q(sid, 'banadd', { ip, time, banreason: reason ? `IP: ${reason}` : undefined });
        }
      } catch (err) {
        console.warn('[ts3query] IP 封禁失败（忽略）:', err.message);
      }
    }
  },
  move: (sid, clid, cid) => q(sid, 'clientmove', { clid, cid }),
  poke: (sid, clid, msg) => q(sid, 'clientpoke', { clid, msg }),
  sendTextMessage: (sid, clid, msg) => q(sid, 'sendtextmessage', { targetmode: 1, target: clid, msg }),

  // ---------- 频道 ----------
  channellist: (sid) => q(sid, 'channellist', {
    '-topic': '', '-flags': '', '-voice': '', '-limits': '', '-icon': '', '-secondsempty': '',
  }),
  channelinfo: (sid, cid) => one(sid, 'channelinfo', { cid }),
  createChannel: (sid, opts) => q(sid, 'channelcreate', {
    channel_name: opts.name,
    channel_topic: opts.topic || undefined,
    channel_password: opts.password || undefined,
    channel_maxclients: opts.max_clients,
    channel_order: opts.order,
    cpid: opts.parent_cid,
    channel_flag_permanent: 1,
  }),
  editChannel: (sid, cid, opts) => q(sid, 'channeledit', {
    cid,
    channel_name: opts.name,
    channel_topic: opts.topic,
    channel_password: opts.password,
    channel_maxclients: opts.max_clients,
    channel_order: opts.order,
  }),
  deleteChannel: (sid, cid) => q(sid, 'channeldelete', { cid, force: 1 }),
};

// 密码更新后立即解除登录冷却（部署页保存密码时调用）
function clearLoginCooldown() { loginFailUntil = 0; }

module.exports = { ts, QueryError, esc, unesc, parseParams, splitRows, rowsOrObjects, clearLoginCooldown, _internals: { teardown, isReady } };
