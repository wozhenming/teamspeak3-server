'use strict';

/**
 * 端到端测试：面板 API × 模拟 TS3 ServerQuery。
 *
 * 前置：
 *   1. node test/mock-ts3-query.js          （终端 1，端口 10011）
 *   2. TSSERVER_QUERY_HOST=127.0.0.1 TSSERVER_QUERY_PORT=10011 TSSERVER_QUERY_PASSWORD=test-password node src/server.js （终端 2）
 *   3. node test/api.test.js                （终端 3）
 *
 * 面板默认账号 admin/admin123（.env）。
 */

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';

let passed = 0;
let failed = 0;

async function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

// ---------- 空闲/连接时长快照平滑单元验证 ----------
async function testSmoothing() {
  const { smoothIdle, smoothConnected } = require('../src/utils/smooth');
  const CLID = 999001;
  const s1 = smoothIdle(CLID, 100);              // 首次：直接展示 100
  await check('空闲首次展示', s1 === 100, s1);
  await new Promise((r) => setTimeout(r, 1100)); // 真实流逝 ~1.1s
  const s2 = smoothIdle(CLID, 100 + 3600);       // 快照跳变 +3600 → 应平滑为 ~101
  await check('空闲快照跳变平滑', Math.abs(s2 - 101) <= 1, s2);
  const s3 = smoothIdle(CLID, 50);               // 用户活动重置 → 直接展示 50
  await check('空闲活动重置直接展示', s3 === 50, s3);

  // 连接时长同样快照化：独立计数器，跳变时平滑
  const c1 = smoothConnected(CLID, 5000);        // 首次：直接展示 5000
  await check('连接时长首次展示', c1 === 5000, c1);
  await new Promise((r) => setTimeout(r, 1100));
  const c2 = smoothConnected(CLID, 5000 + 7200); // 快照跳变 +7200 → 应平滑为 ~5001
  await check('连接时长快照跳变平滑', Math.abs(c2 - 5001) <= 1, c2);
  const c3 = smoothConnected(CLID, 30);          // 重连重置 → 直接展示 30
  await check('连接时长重连直接展示', c3 === 30, c3);
  // idle 与 connected 缓存相互独立：idle 基于自己的缓存平滑（50 + 真实流逝 ~2-3s）
  const s4 = smoothIdle(CLID, 60);
  await check('计数器相互独立', s4 >= 51 && s4 <= 70, s4); // 容差放宽：慢机器上真实流逝可能达 ~10s
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  if (r.status !== 200) throw new Error('登录失败');
  return r.headers.get('set-cookie').split(';')[0];
}

(async () => {
  // 空闲平滑单元验证（不依赖面板服务）
  console.log('\n[空闲平滑]');
  await testSmoothing();

  const cookie = await login();
  const H = { cookie };

  // ---------- 仪表盘 ----------
  console.log('\n[仪表盘]');
  let r = await fetch(`${BASE}/api/overview?sid=1`, { headers: H });
  let j = await r.json();
  await check('overview 200', r.status === 200 && j.ok, j);
  await check('connected=true', j.data && j.data.connected === true);
  await check('服务端版本显示', j.data && j.data.version === '3.13.8', j.data && j.data.version);
  await check('server 名称', j.data && j.data.server && j.data.server.name === 'Test Server');
  await check('在线用户数=3（含查询端）', j.data && j.data.server && j.data.server.clients_online === 3);
  await check('运行时长=86400', j.data && j.data.server && j.data.server.uptime_seconds === 86400);
  await check('累计发送字节', j.data && j.data.server && j.data.server.bandwidth_sent === 100000000, j.data && j.data.server);
  await check('累计接收字节', j.data && j.data.server && j.data.server.bandwidth_received === 50000000, j.data && j.data.server);
  await check('累计数据包', j.data && j.data.server && j.data.server.packets_sent === 1234 && j.data.server.packets_received === 5678, j.data && j.data.server);
  await check('上行速率=16.384 Kbit/s', Math.abs(j.data.bandwidth_sent_rate - 2048 * 8 / 1000) < 0.01, j.data.bandwidth_sent_rate);
  await check('下行速率=8.192 Kbit/s', Math.abs(j.data.bandwidth_received_rate - 1024 * 8 / 1000) < 0.01, j.data.bandwidth_received_rate);
  await check('客户端含频道名', j.data.clients.length === 3 && j.data.clients[0].channel_name === 'Lobby', j.data.clients);
  await check('query 客户端识别', j.data.clients.find(c => c.nickname === 'serveradmin').is_query === true);
  await check('频道数=3', j.data.channels.length === 3);
  await check('频道密码标记', j.data.channels.find(c => c.cid === 2).has_password === true);

  // ---------- 服务器列表 ----------
  console.log('\n[服务器列表]');
  r = await fetch(`${BASE}/api/servers`, { headers: H });
  j = await r.json();
  await check('serverlist 200', r.status === 200 && j.ok);
  await check('包含 Test Server', j.data && j.data.length === 1 && j.data[0].name === 'Test Server', j.data);

  // ---------- 修改服务器名称 ----------
  r = await fetch(`${BASE}/api/servers/1`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ virtualserver_name: 'My TeamSpeak' }) });
  j = await r.json();
  await check('serveredit 200', r.status === 200 && j.ok && j.data.edited && j.data.name === 'My TeamSpeak', j);

  r = await fetch(`${BASE}/api/servers/1`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ virtualserver_name: '   ' }) });
  await check('serveredit 空名 400', r.status === 400);

  // ---------- 用户管理 ----------
  console.log('\n[用户管理]');
  r = await fetch(`${BASE}/api/servers/1/clients`, { headers: H });
  j = await r.json();
  await check('clientlist 200', r.status === 200 && j.ok);
  await check('用户数=3', j.data && j.data.clients.length === 3);
  // 关键回归：clientlist 必须带 -uid/-times/-info/-country 等 flag，字段才完整
  const alice = j.data && j.data.clients.find((c) => c.nickname === 'Alice');
  await check('UID 字段', alice && alice.uid === 'uid-alice-001', alice);
  await check('国家字段', alice && alice.country === 'CN', alice);
  await check('连接时长字段(clientinfo 换算)', alice && Math.abs(alice.connected_seconds - 3600) <= 2, alice);
  await check('空闲字段', alice && alice.idle_seconds === 120, alice);
  await check('频道名字段', alice && alice.channel_name === 'Lobby', alice);
  const bob = j.data && j.data.clients.find((c) => c.nickname === 'Bob');
  await check('Bob 连接时长独立(clientinfo)', bob && bob.connected_seconds === 180, bob);
  await check('Query 客户端无连接时长', j.data.clients.find((c) => c.nickname === 'serveradmin').connected_seconds == null);

  r = await fetch(`${BASE}/api/servers/1/clients/1/kick`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'test', from: 'server' }) });
  j = await r.json();
  await check('kick 200', r.status === 200 && j.ok && j.data.kicked);

  r = await fetch(`${BASE}/api/servers/1/clients/2/ban`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'spam', time: 60, ipban: true }) });
  j = await r.json();
  await check('ban(60分钟+IP) 200', r.status === 200 && j.ok && j.data.banned);

  r = await fetch(`${BASE}/api/servers/1/clients/1/move`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ cid: 3 }) });
  j = await r.json();
  await check('move 200', r.status === 200 && j.ok && j.data.moved);

  r = await fetch(`${BASE}/api/servers/1/clients/1/poke`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: 'hey' }) });
  j = await r.json();
  await check('poke 200', r.status === 200 && j.ok && j.data.poked);

  r = await fetch(`${BASE}/api/servers/1/clients/1/message`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: 'hello' }) });
  j = await r.json();
  await check('message 200', r.status === 200 && j.ok && j.data.sent);

  // 参数校验
  r = await fetch(`${BASE}/api/servers/1/clients/1/move`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  await check('move 缺参 400', r.status === 400);

  // ---------- 频道管理 ----------
  console.log('\n[频道管理]');
  r = await fetch(`${BASE}/api/servers/1/channels`, { headers: H });
  j = await r.json();
  await check('channellist 200', r.status === 200 && j.ok);
  await check('频道数=3', j.data && j.data.channels.length === 3);
  await check('频道成员映射', j.data && j.data.clients.length === 3);

  r = await fetch(`${BASE}/api/servers/1/channels`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Room', parent_cid: 1, max_clients: 10, password: 'pw', topic: 't' }) });
  j = await r.json();
  const newCid = j.data && j.data.cid;
  await check('channelcreate 200 且返回 cid', r.status === 200 && j.ok && Number(newCid) > 0, j.data);

  r = await fetch(`${BASE}/api/servers/1/channels/${newCid}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed', max_clients: 20, order: 5 }) });
  j = await r.json();
  await check('channeledit 200', r.status === 200 && j.ok && j.data.edited);

  r = await fetch(`${BASE}/api/servers/1/channels/${newCid}`, { method: 'DELETE', headers: H });
  j = await r.json();
  await check('channeldelete 200', r.status === 200 && j.ok && j.data.deleted);

  r = await fetch(`${BASE}/api/servers/1/channels`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '  ' }) });
  await check('channelcreate 空名 400', r.status === 400);

  // ---------- 未授权 ----------
  console.log('\n[鉴权]');
  r = await fetch(`${BASE}/api/servers/1/clients`);
  await check('无 Cookie 401', r.status === 401);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
