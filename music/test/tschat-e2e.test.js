'use strict';

/**
 * 点歌助手端到端回归：起一个假的 TS3 ServerQuery 服务器（原始 TCP），
 * 让真实 tschat 会话流程完整跑一遍：TCP 登录 → 横幅 → 昵称 → channellist
 * 解析频道 → clientmove 驻留 → 订阅 → 收到 !点歌 → 入本频道队列 → 频道回执。
 *
 * 同时回归多会话命名：单频道「点歌助手」原名；第二个频道「点歌助手·开黑房」。
 *
 * 运行（music 目录，需先 npm install）：node test/tschat-e2e.test.js
 */

process.env.MUSIC_DATA_DIR = '/tmp/data-tschat-e2e';
delete process.env.TS_CHAT_BOT_NICKNAME;
delete process.env.TS_CHAT_ENABLED;
process.env.TS3AB_URL = 'http://127.0.0.1:1'; // 不可达地址：本测试不依赖引擎
process.env.TS_HOST = '127.0.0.1';
process.env.AUTO_PAUSE_EMPTY = 'true';

const http = require('http');
const net = require('net');
const path = require('path');

let pass = 0, fail = 0;
const check = (n, c, g) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (g !== undefined ? '  (got: ' + JSON.stringify(g) + ')' : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假网易云 API（song/detail） ----------
const apiSrv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    code: 200,
    songs: [{ id: 742360, name: '测试歌', ar: [{ name: '测试歌手' }], al: { name: '测试专辑', picUrl: '' }, dt: 180000, fee: 1 }],
  }));
});

// ---------- 假 TS3 ServerQuery（原始 TCP） ----------
const CH1 = '默认频道/点歌专区';
const CH2 = '默认频道/开黑房';
let sqPort = 0;
const moves = [];    // clientmove 命令
const subs = [];     // servernotifyregister 命令
const replies = [];  // sendtextmessage 的 msg（已反转义）
const seenCmds = []; // 全部命令名（诊断用）
let clientSocks = []; // 所有会话的 socket（用于注入 notify）

function handleCommand(line, sock) {
  const name = line.split(/\s+/)[0];
  seenCmds.push(name + (line.includes('cid=') ? '(' + (line.match(/cid=(\d+)/) || [])[1] + ')' : ''));
  const ok = () => sock.write('error id=0 msg=ok\n\r');
  if (name === 'login') ok();
  else if (name === 'serverlist') { sock.write('virtualserver_id=1 name=default\\sserver clients=0\n\r'); ok(); }
  else if (name === 'use') ok();
  else if (name === 'channellist') {
    sock.write('cid=1 pid=0 channel_name=Default\\sChannel|cid=2 pid=0 channel_name=默认频道|cid=3 pid=2 channel_name=点歌专区|cid=4 pid=2 channel_name=开黑房\n\r');
    ok();
  } else if (name === 'clientlist') {
    sock.write('clid=9 client_nickname=serveradmin client_type=1|clid=50 client_nickname=serveradmin\\sfrom\\s127.0.0.1 client_type=1\n\r');
    ok();
  } else if (name === 'whoami') { sock.write('clid=9 cid=1 client_nickname=serveradmin\n\r'); ok(); }
  else if (name === 'clientupdate') ok();
  else if (name === 'clientmove') { moves.push(line); ok(); }
  else if (name === 'servernotifyregister') { subs.push(line); ok(); }
  else if (name === 'sendtextmessage') { replies.push((line.match(/msg=([^\s]+)/) || [])[1]); ok(); }
  else ok();
}

function startFakeTS() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.setEncoding('utf8');
      clientSocks.push(sock);
      // TS3 横幅：首行 TS3 + 一行欢迎文本（行尾与真实服务端一致用 \n\r）
      sock.write('TS3\n\rWelcome to the fake TeamSpeak 3 ServerQuery interface.\n\r');
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (line) handleCommand(line, sock);
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

// 发送一条频道聊天通知（转义空格）
function injectChat(sock, msg, invoker) {
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/ /g, '\\s').replace(/\|/g, '\\p');
  sock.write('notifytextmessage targetmode=2 msg=' + esc(msg) + ' invokername=' + esc(invoker) + '\n\r');
}

async function main() {
  const apiPort = await new Promise((r) => apiSrv.listen(0, '127.0.0.1', () => r(apiSrv.address().port)));
  process.env.NCMAPI_BASE = 'http://127.0.0.1:' + apiPort;
  sqPort = await startFakeTS();
  process.env.TS_QUERY_PORT = String(sqPort);

  const { config } = require(path.resolve(__dirname, '..', 'src/config.js'));
  config.saveTsBridge({
    ts3abChannels: [CH1],
    tsChatEnabled: true,
    tsQueryAdminPassword: 'testpass',
  });
  const queueMod = require(path.resolve(__dirname, '..', 'src/queue.js'));
  const tschat = require(path.resolve(__dirname, '..', 'src/tschat.js'));

  tschat.start();
  await sleep(2500); // 等 TCP 登录 + 横幅 + bootstrap 完成

  // ---- 1. 会话建立与驻留 ----
  const st = tschat.getState();
  check('会话已建立（1 个频道）', st.sessions.length === 1, st.sessions);
  check('助手状态 listening', st.sessions[0] && st.sessions[0].state === 'listening', st.sessions[0]);
  check('单频道助手用原名「点歌助手」', st.sessions[0] && st.sessions[0].nick === '点歌助手', st.sessions[0] && st.sessions[0].nick);
  check('解析到点歌专区频道并 clientmove(cid=3)', moves.some((m) => /clientmove\s+cid=3\b/.test(m)), moves);
  check('订阅了聊天事件（3 类）', subs.length === 3, subs);
  check('未发送 channelidbyname（release 稳定版不含该命令）', !seenCmds.some((c) => c.startsWith('channelidbyname')), seenCmds.filter((c) => c.startsWith('channel')));

  // ---- 2. 频道聊天点歌 → 入本频道队列 → 频道回执 ----
  injectChat(clientSocks[0], '!点歌 742360', '测试用户');
  await sleep(1200); // 等 songDetail + 入队 + 回执

  const q = queueMod.forChannel(CH1);
  check('歌曲已入本频道队列', q.all().length === 1 && String(q.all()[0].songId) === '742360', q.all());
  check('入队歌名来自网易云详情', q.all()[0] && q.all()[0].title === '测试歌', q.all()[0] && q.all()[0].title);
  check('请求者记录 TS 昵称', q.all()[0] && q.all()[0].requestedBy === '测试用户(TS)', q.all()[0] && q.all()[0].requestedBy);
  check('向频道回执了点歌结果', replies.some((r) => r.includes('已加入本频道队列') && r.includes('测试歌')), replies);
  check('队列非空时自动开播', (function () {
    const playerMod = require(path.resolve(__dirname, '..', 'src/player.js'));
    return playerMod.forChannel(CH1).get().playing === true;
  })());

  // ---- 3. 不认识的指令有用法回执 ----
  replies.length = 0;
  injectChat(clientSocks[0], '大家好啊', '路人');
  await sleep(400);
  check('普通聊天不触发点歌', q.all().length === 1 && replies.length === 0, { queue: q.all().length, replies });

  // ---- 4. 第二个频道：会话与命名后缀 ----
  config.saveTsBridge({ ts3abChannels: [CH1, CH2] });
  tschat.applyConfig();
  await sleep(4500); // 第二个会话错峰 2.5s 后连接
  const st2 = tschat.getState();
  check('新增频道后共有 2 个助手会话', st2.sessions.length === 2, st2.sessions);
  const s2 = st2.sessions.find((s) => s.channel === CH2);
  check('第二频道助手带「·开黑房」后缀', s2 && s2.nick === '点歌助手·开黑房', s2 && s2.nick);
  check('第二频道助手也驻留 listening', s2 && s2.state === 'listening', s2);
  check('第二频道也 clientmove 到自己频道', moves.some((m) => /clientmove\s+cid=4\b/.test(m)), moves);

  // 第二频道点歌 → 入第二频道队列（互不可见）
  const sock2 = clientSocks[1];
  injectChat(sock2, '!点歌 888888', '开黑房用户');
  await sleep(1200);
  const q2 = queueMod.forChannel(CH2);
  check('开黑房的点歌只进开黑房队列', q2.all().length === 1 && String(q2.all()[0].songId) === '888888', q2.all());
  check('点歌专区的队列不受影响', q.all().length === 1, q.all());

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('FATAL', e.stack || e.message); process.exit(1); });
