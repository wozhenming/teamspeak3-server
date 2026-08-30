'use strict';

/**
 * 模拟 TeamSpeak 3 ServerQuery 服务器（开发/测试用，无需真实 TS3）。
 *
 * 用法：
 *   node test/mock-ts3-query.js            # 监听 10011
 *   node test/mock-ts3-query.js 10012      # 指定端口
 *
 * 行为（对齐真实 TS3 3.13 协议）：
 *   - 连接后发送 "TS3" 横幅 + 欢迎文本
 *   - login serveradmin <密码>（默认 test-password），错误密码返回 error id=512
 *   - use <sid> 切换虚拟服务器
 *   - 命令行协议：key=value（空格→\s，竖线→\p），多行结果用 '|' 拼接
 *   - 每条命令以 error id=<n> msg=<m> 应答
 *   - 记录收到的命令到 stdout（[mock] 前缀）
 */

const net = require('net');

const PORT = parseInt(process.argv[2], 10) || 10011;
const PASSWORD = process.env.MOCK_QUERY_PASSWORD || 'test-password';

// ---------- 模拟数据 ----------
const channels = [
  { cid: 1, pid: 0, channel_name: 'Lobby', channel_topic: 'Welcome!', channel_order: 0,
    channel_maxclients: -1, channel_flag_password: 0, channel_flag_permanent: 1, total_clients: 2, total_max_clients: -1 },
  { cid: 2, pid: 1, channel_name: 'Secret Room', channel_topic: '', channel_order: 1,
    channel_maxclients: 5, channel_flag_password: 1, channel_flag_permanent: 1, total_clients: 0, total_max_clients: 5 },
  { cid: 3, pid: 0, channel_name: 'Gaming', channel_topic: '', channel_order: 2,
    channel_maxclients: -1, channel_flag_password: 0, channel_flag_permanent: 1, total_clients: 1, total_max_clients: -1 },
];

// Alice/Bob 的连接时刻按请求动态计算（connectedAgoSec），保证测试断言不受 mock 运行时长影响
const clients = [
  { clid: 1, cid: 1, client_nickname: 'Alice', client_unique_identifier: 'uid-alice-001',
    client_type: '0', client_country: 'CN', client_idle_time: 120000, connectedAgoSec: 3600,
    client_away: 0, client_database_id: 5 },
  { clid: 2, cid: 3, client_nickname: 'Bob', client_unique_identifier: 'uid-bob-002',
    client_type: '0', client_country: 'DE', client_idle_time: 5000, connectedAgoSec: 180,
    client_away: 0, client_database_id: 6 },
  // 对齐真实 TS3：ServerQuery 客户端可见于 clientlist
  { clid: 3, cid: 1, client_nickname: 'serveradmin', client_unique_identifier: 'serveradmin',
    client_type: '1', client_country: '', client_idle_time: 0, client_database_id: 1 },
];

let channelSeq = 100;
let loggedIn = false;
let currentSid = 0;

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
function parseLine(line) {
  const parts = unesc(line).trim().split(/\s+/).filter(Boolean);
  const cmd = parts.shift() || '';
  const flags = [];
  const params = {};
  for (const p of parts) {
    if (p.startsWith('-') && !p.includes('=')) { flags.push(p); continue; }
    const i = p.indexOf('=');
    if (i > 0) params[p.slice(0, i)] = p.slice(i + 1);
    else flags.push(p);
  }
  return { cmd, flags, params };
}

const BANNER = 'TS3\n\rWelcome to the TeamSpeak 3 ServerQuery interface, type "help" for a list of commands and "help <command>" for information on a specific command.\n\r';

const server = net.createServer((sock) => {
  sock.setEncoding('utf8');
  sock.write(BANNER);
  let buf = '';

  const reply = (line) => { sock.write(line + '\n\r'); };
  const ok = (rows) => {
    if (Array.isArray(rows) && rows.length) reply(rows.map((r) => Object.entries(r).map(([k, v]) => `${k}=${esc(v)}`).join(' ')).join('|'));
    else if (rows && !Array.isArray(rows)) reply(Object.entries(rows).map(([k, v]) => `${k}=${esc(v)}`).join(' '));
    reply('error id=0 msg=ok');
  };
  const err = (id, msg) => reply(`error id=${id} msg=${esc(msg)}`);

  sock.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      handle(line);
    }
  });
  sock.on('error', () => { /* 忽略 */ });

  function handle(line) {
    const { cmd, flags, params } = parseLine(line);
    console.log(`[mock] ${cmd}`, JSON.stringify({ flags, params }));

    if (cmd === 'login') {
      // TS3 支持两种写法：login <user> <password>（位置参数）或 login client_login_name=.. client_login_password=..
      const user = params.client_login_name || params.username || flags[0] || '';
      const pwd = params.client_login_password || params.password || (params[Object.keys(params)[0]] != null && flags.length === 1 ? '' : flags[1]) || flags[1] || '';
      if (/^serveradmin$/.test(user) && pwd === PASSWORD) { loggedIn = true; return ok({}); }
      return err(512, 'invalid login');
    }
    if (cmd === 'quit') { sock.end(); return; }
    if (!loggedIn) return err(256, 'not logged in');

    if (cmd === 'use') {
      const sid = parseInt(params.sid || flags[0], 10) || 0;
      if (sid < 1) return err(1024, 'invalid server id');
      currentSid = sid;
      return ok({});
    }
    if (cmd === 'version') return ok({ build: '1779874471', platform: 'Linux', version: '3.13.8' });
    if (cmd === 'whoami') return ok({ virtualserver_id: String(currentSid || 1), clid: '3', cid: '1', client_login_name: 'serveradmin' });
    if (cmd === 'serverlist') {
      return ok([{ virtualserver_id: '1', virtualserver_port: '9987', virtualserver_status: 'online',
        virtualserver_clientsonline: '3', virtualserver_queryclientsonline: '1', virtualserver_maxclients: '32',
        virtualserver_uptime: '86400', virtualserver_name: 'Test Server', virtualserver_autostart: '1' }]);
    }
    if (cmd === 'serverinfo') {
      return ok({ virtualserver_name: 'Test Server', virtualserver_status: 'online', virtualserver_platform: 'Linux',
        virtualserver_version: '3.13.8', virtualserver_clientsonline: '3', virtualserver_queryclientsonline: '1',
        virtualserver_maxclients: '32', virtualserver_uptime: '86400', virtualserver_created: '1700000000',
        virtualserver_total_packetloss_total: '0.12', virtualserver_total_ping: '25',
        connection_bytes_sent_total: '100000000', connection_bytes_received_total: '50000000',
        connection_packets_sent_total: '1234', connection_packets_received_total: '5678',
        connection_bandwidth_sent_last_second_total: '2048', connection_bandwidth_received_last_second_total: '1024' });
    }
    if (cmd === 'clientlist') {
      // 模拟真实 TS3：带 flag 参数才返回扩展字段（uid/国家/时长/空闲等）
      const base = (c) => ({ clid: String(c.clid), cid: String(c.cid),
        client_database_id: String(c.client_database_id || c.clid),
        client_nickname: c.client_nickname, client_type: c.client_type });
      return ok(flags.length ? clients : clients.map(base));
    }
    if (cmd === 'clientinfo') {
      const c = clients.find((x) => Number(x.clid) === Number(params.clid));
      if (!c) return err(512, 'invalid clientID');
      const { connectedAgoSec, ...rest } = c;
      // 对齐真实 TS3 语义：connection_connected_time = 已连接时长（毫秒）
      const conn = connectedAgoSec != null ? { connection_connected_time: connectedAgoSec * 1000 } : {};
      return ok({ ...rest, ...conn, connection_client_ip: '203.0.113.7', client_created: '1700000000', client_lastconnected: '1700000000' });
    }
    if (cmd === 'channellist') {
      const base = (ch) => ({ cid: String(ch.cid), pid: String(ch.pid),
        channel_name: ch.channel_name, channel_order: String(ch.channel_order),
        total_clients: String(ch.total_clients), total_max_clients: String(ch.total_max_clients) });
      return ok(flags.length ? channels : channels.map(base));
    }
    if (cmd === 'channelinfo') {
      const ch = channels.find((x) => Number(x.cid) === Number(params.cid));
      if (!ch) return err(768, 'invalid channelID');
      return ok({ ...ch });
    }
    if (cmd === 'channelcreate') {
      channelSeq += 1;
      return ok({ cid: String(channelSeq) });
    }
    if (cmd === 'serveredit' || cmd === 'channeledit' || cmd === 'channeldelete'
      || cmd === 'clientkick' || cmd === 'banclient' || cmd === 'banadd'
      || cmd === 'clientmove' || cmd === 'clientpoke' || cmd === 'sendtextmessage') {
      return ok({});
    }
    if (cmd === 'clientpoke') {
      if (params.clid === '999') return err(512, 'invalid clientID');
      return ok({});
    }
    return err(1792, `unknown command: ${cmd}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] TS3 ServerQuery mock listening on 127.0.0.1:${PORT} (password: ${PASSWORD})`);
});
