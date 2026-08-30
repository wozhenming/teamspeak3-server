'use strict';

/**
 * TeamSpeak 3 ServerQuery 客户端（原始 TCP，端口 10011）。
 *
 * 协议要点（TS3 3.13 实测）：
 *  - 连接后服务端先发送横幅：首行 "TS3"，随后是欢迎文本与一个空行；
 *    必须等横幅结束后才允许发送命令（过早写入会被丢弃）。
 *  - 登录：`login <user> <password>`；选服：`use <sid>`；之后即可发命令。
 *  - 每条命令以换行结尾；应答为若干数据行 + `error id=<n> msg=<m>` 结尾。
 *  - 多条结果行用 '|' 拼接在同一行（channellist/clientlist/serverlist）。
 *  - 转义：空格→\s，反斜杠→\\，竖线→\p，斜杠→\/（值里出现都会转义）。
 *  - 通知（notifytextmessage 等）由 servernotifyregister 订阅后异步到达。
 *
 * 连接为「命令串行 FIFO + 通知回调」模型：cmd() 按发送顺序配对应答，
 * 通知行独立分发给 onNotify。断线由使用方决定重连策略（见 tschat）。
 */

const net = require('net');

// ---------- 行协议工具（与面板/测试共用同一套语义） ----------
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
// 判断某位置的 '|' 是否为“行分隔符”而不是被反斜杠转义的 \p（原义管道符）。
// 只有前面反斜杠数量为偶数时才是真正的分隔符。
function isRowSeparator(line, idx) {
  let bs = 0, i = idx - 1;
  while (i >= 0 && line[i] === '\\') { bs++; i--; }
  return bs % 2 === 0;
}
// 把一行按未转义的 '|' 拆成多行（TS3 会把多条结果行用 '|' 拼接返回）
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
// 解析一行 key=value key="v v" ... 参数（值已做反转义）
function parseParams(line) {
  const out = {};
  const re = /(\w+)=("([^"]*)"|[^\s]+)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = unesc(m[3] != null ? m[3] : m[2]);
  return out;
}
// 把一行 ServerQuery 数据行解析成对象；'|' 拼接的多行返回对象数组
function rowsOrObjects(line) {
  const parts = splitRows(line);
  if (parts.length <= 1) return [parseParams(line)];
  return parts.map(parseParams);
}

class Ts3QueryError extends Error {
  constructor(id, msg, extra) {
    super(`TS3 Query 错误 [${id}]：${msg}${extra ? '（' + extra + '）' : ''}`);
    this.name = 'Ts3QueryError';
    this.id = id;
    this.msg = msg;
  }
}

/**
 * 建立一条 ServerQuery 连接。
 * @param {object} opts { host, port, user, password, sid, onNotify, on_close }
 *   - sid: 登录后自动 `use` 的虚拟服务器（0/undefined = 不切换）
 *   - onNotify(line, parsed): 通知行回调（notifytextmessage 等）
 * @returns {Promise<conn>} conn = { cmd(), raw(), close(), connected }
 */
function connectQuery(opts) {
  const {
    host = '127.0.0.1',
    port = 10011,
    user = 'serveradmin',
    password = '',
    sid = 0,
    onNotify = null,
    onClosed = null,
  } = opts || {};

  return new Promise((resolve, reject) => {
    const conn = {
      connected: false,
      pending: [],     // 命令 FIFO：{ rows, resolve, reject, timer }
      notify: null,    // 通知回调
      sock: null,
      buf: '',
      bannerSeen: false,
      closedByUs: false,
    };
    conn.notify = onNotify;

    const failWaiters = (err) => {
      while (conn.pending.length) {
        const p = conn.pending.shift();
        clearTimeout(p.timer);
        try { p.reject(err); } catch (e) { /* 忽略 */ }
      }
    };

    const fail = (err) => {
      const wasConnected = conn.connected;
      conn.connected = false;
      failWaiters(err);
      if (!conn.closedByUs && typeof onClosed === 'function') {
        try { onClosed(err); } catch (e) { /* 忽略 */ }
      }
      if (!wasConnected) reject(err);
    };

    const sock = net.createConnection({ host, port });
    sock.setEncoding('utf8');
    sock.setKeepAlive(true, 30000);
    conn.sock = sock;

    sock.on('connect', () => { /* 等横幅 */ });
    sock.on('data', (chunk) => {
      conn.buf += chunk;
      let idx;
      while ((idx = conn.buf.indexOf('\n')) >= 0) {
        const line = conn.buf.slice(0, idx).replace(/\r$/, '').trim();
        conn.buf = conn.buf.slice(idx + 1);
        if (!line) continue;
        // 横幅：首行 "TS3"，随后是一行欢迎文本（TS3 3.13 实测，行尾为 \n\r）。
        // 见到 TS3 后再收到下一行才允许发命令（过早写入会被丢弃）。
        if (conn.bannerSeen !== true) {
          if (/^TS3\b/.test(line)) { conn.bannerSeen = 'ts3'; }
          else if (conn.bannerSeen === 'ts3') {
            conn.bannerSeen = true;
            handshake();
          }
          continue;
        }
        dispatchLine(line);
      }
    });
    sock.on('error', (e) => fail(new Error('TS3 Query 连接错误: ' + e.message)));
    sock.on('close', () => {
      conn.connected = false;
      failWaiters(new Error('TS3 Query 连接已关闭'));
      if (!conn.closedByUs && typeof onClosed === 'function') {
        try { onClosed(new Error('连接关闭')); } catch (e) { /* 忽略 */ }
      }
    });

    const handshake = async () => {
      try {
        await conn.cmd(`login ${esc(user)} ${esc(password)}`, 8000);
        if (sid && parseInt(sid, 10) > 0) await conn.cmd('use ' + parseInt(sid, 10), 8000);
        conn.connected = true;
        resolve(conn);
      } catch (e) {
        try { sock.destroy(); } catch (e2) { /* 忽略 */ }
        fail(e);
      }
    };

    const dispatchLine = (line) => {
      // 通知行：notifytextmessage / notifycliententerview / ... 直接分发
      if (/^notify/i.test(line)) {
        if (typeof conn.notify === 'function') {
          const parsed = rowsOrObjects(line);
          try { conn.notify(line, parsed.length === 1 ? parsed[0] : parsed); } catch (e) { /* 忽略 */ }
        }
        return;
      }
      const head = conn.pending[0];
      if (!head) return; // 迟到的欢迎文本等，忽略
      if (/^error id=/i.test(line)) {
        conn.pending.shift();
        clearTimeout(head.timer);
        if (/^error id=0(\s|$)/i.test(line)) {
          const rows = head.rows;
          const val = rows.length === 0 ? {} : (rows.length === 1 ? rows[0] : rows);
          // TS3 部分命令（如 clientlist）成功时数据行在 error 行之前
          head.resolve(val);
        } else {
          head.reject(new Ts3QueryError(
            (line.match(/id=(-?\d+)/) || [])[1],
            (line.match(/msg=([^\s]+)/) || [])[1] ? unesc((line.match(/msg=([^\s]+)/) || [])[1]) : line,
            head.cmdStr
          ));
        }
        return;
      }
      for (const o of rowsOrObjects(line)) head.rows.push(o);
    };

    // 发送命令并等待应答（串行 FIFO）。cmdStr 不带换行。
    conn.cmd = (cmdStr, timeoutMs = 8000) => new Promise((resolve2, reject2) => {
      if (!sock.writable) return reject2(new Error('TS3 Query 连接未就绪'));
      const entry = { rows: [], cmdStr, resolve: resolve2, reject: reject2, timer: null };
      entry.timer = setTimeout(() => {
        const i = conn.pending.indexOf(entry);
        if (i >= 0) conn.pending.splice(i, 1);
        reject2(new Error('cmd 超时: ' + cmdStr));
      }, timeoutMs);
      conn.pending.push(entry);
      sock.write(cmdStr + '\n');
    });

    conn.close = () => {
      conn.closedByUs = true;
      try { sock.write('quit\n'); } catch (e) { /* 忽略 */ }
      setTimeout(() => { try { sock.destroy(); } catch (e) { /* 忽略 */ } }, 200);
    };
  });
}

// ---------- 一次性连接助手：跑一段命令后自动关闭 ----------
// 适合低频管理操作（clientlist 轮询、频道解析），无需维护长连接。
async function withQuery(opts, fn) {
  const conn = await connectQuery(opts);
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

module.exports = {
  connectQuery,
  withQuery,
  esc,
  unesc,
  splitRows,
  parseParams,
  rowsOrObjects,
  isRowSeparator,
  Ts3QueryError,
};
