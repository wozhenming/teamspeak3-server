'use strict';

/**
 * 测试用假 TS3 ServerQuery 服务器（原始 TCP）。
 * 供 autopause / per-channel / tschat-e2e 等测试复用：
 * 自动处理横幅、login、use、whoami；channellist/clientlist 由测试通过
 * state 对象动态修改；其余命令一律 error id=0。
 *
 * 用法：
 *   const fake = await require('./fake-ts3-query.js')();
 *   fake.state.clientlist = [{ clid: 1, client_nickname: 'bot', cid: 2, client_type: 0 }];
 *   fake.port ... fake.close()
 */

const net = require('net');

module.exports = function startFakeTs3() {
  const state = {
    clientlist: [],   // 行对象数组；置为 null 时模拟命令失败
    channellist: [],
  };
  const seen = [];        // 收到的命令名（诊断/计数）
  const socks = new Set();
  let srv = null;

  const ok = (sock) => sock.write('error id=0 msg=ok\n\r');
  const err = (sock, id, msg) => sock.write(`error id=${id} msg=${msg}\n\r`);
  const rows = (sock, list) => {
    if (Array.isArray(list) && list.length) {
      sock.write(list.map((r) => Object.entries(r).map(([k, v]) => `${k}=${escVal(v)}`).join(' ')).join('|') + '\n\r');
    }
    ok(sock);
  };
  const escVal = (v) => String(v).replace(/\\/g, '\\\\').replace(/ /g, '\\s').replace(/\|/g, '\\p').replace(/\//g, '\\/');

  function handle(line, sock) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    const name = parts.shift() || '';
    const flags = [];
    const params = {};
    for (const p of parts) {
      if (p.startsWith('-') && !p.includes('=')) { flags.push(p); continue; }
      const i = p.indexOf('=');
      if (i > 0) params[p.slice(0, i)] = p.slice(i + 1);
      else flags.push(p);
    }
    seen.push(name);
    if (name === 'login') return ok(sock);
    if (name === 'use') return ok(sock);
    if (name === 'whoami') { sock.write('clid=9 cid=1 client_nickname=serveradmin\n\r'); return ok(sock); }
    if (name === 'channellist') return rows(sock, state.channellist);
    if (name === 'clientlist') {
      if (state.clientlist == null) return err(sock, 256, 'unavailable');
      return rows(sock, state.clientlist);
    }
    return ok(sock);
  }

  const ready = new Promise((resolve) => {
    srv = net.createServer((sock) => {
      socks.add(sock);
      sock.setEncoding('utf8');
      sock.write('TS3\n\rWelcome to the fake TeamSpeak 3 ServerQuery interface.\n\r');
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (line) handle(line, sock);
        }
      });
      sock.on('error', () => {});
      sock.on('close', () => socks.delete(sock));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });

  return {
    ready,
    get port() { return srv && srv.address().port; },
    state,
    seen,
    // 向当前所有连接注入一行通知（如 notifytextmessage）
    inject(line) { for (const s of socks) { try { s.write(line + '\n\r'); } catch (e) { /* 忽略 */ } } },
    close() { for (const s of socks) { try { s.destroy(); } catch (e) { /* 忽略 */ } } if (srv) srv.close(); },
  };
};
