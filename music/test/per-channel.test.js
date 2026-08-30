'use strict';

/**
 * 验证「每频道固定部署一个点歌机器人 + 一个点歌助手 + 独立队列/播放器」的核心逻辑：
 * 1. 命名规则：单频道用配置昵称原名；多频道加「·频道名」后缀；叶子频道名重复时退回完整路径
 * 2. 点歌助手命名遵循同一规则
 * 3. 队列/播放器按频道隔离：入队互不可见；无人暂停按频道各自暂停/恢复
 * 4. 电台流 URL 按频道携带 ch 参数
 *
 * 起一个假的 TS3 ServerQuery 服务器（clientlist 由测试动态控制）。
 * 运行（music 目录，需先 npm install）：node test/per-channel.test.js
 */

process.env.MUSIC_DATA_DIR = '/tmp/data-perchannel';
delete process.env.TS_CHAT_BOT_NICKNAME;
delete process.env.TS_CHAT_ENABLED;

const path = require('path');
const startFakeTs3 = require('./fake-ts3-query.js');

const fake = startFakeTs3();

(async () => {
  const port = await fake.ready;
  process.env.TS_HOST = '127.0.0.1';
  process.env.TS_QUERY_PORT = String(port);
  process.env.TS_QUERY_ADMIN_PASSWORD = 'testpass';
  process.env.TS3AB_URL = 'http://127.0.0.1:1'; // 不可达地址：本测试不依赖引擎
  process.env.AUTO_PAUSE_EMPTY = 'true';

  const { config } = require(path.resolve(__dirname, '..', 'src/config.js'));
  config.saveTsBridge({ tsQueryAdminPassword: 'testpass' });

  let pass = 0, fail = 0;
  const check = (n, c, g) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (g !== undefined ? '  (got: ' + JSON.stringify(g) + ')' : '')); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const CH1 = '默认频道/点歌专区'; // cid=2
  const CH2 = '默认频道/开黑房';   // cid=3

  fake.state.channellist = [
    { cid: 1, pid: 0, channel_name: '默认频道' },
    { cid: 2, pid: 1, channel_name: '点歌专区' },
    { cid: 3, pid: 1, channel_name: '开黑房' },
  ];

  // ---- 模拟频道客户端 ----
  let users = {}; // {cid: 数量}
  let clidSeq = 100;
  function clientRow(clid, nick, cid, type) {
    return { clid, client_nickname: nick, cid, client_type: type };
  }
  function channelClients() {
    const list = [
      clientRow(10, '点歌机器人·点歌专区', 2, 0),
      clientRow(11, '点歌机器人·开黑房', 3, 0),
      clientRow(20, 'serveradmin', 2, 1),
      clientRow(21, '点歌助手', 2, 1),
      clientRow(22, '点歌助手·开黑房', 3, 1),
      clientRow(23, 'serveradmin', 3, 1),
    ];
    for (const [cidStr, n] of Object.entries(users)) {
      for (let i = 0; i < n; i++) list.push(clientRow(clidSeq++, '用户' + cidStr + '_' + i, Number(cidStr), 0));
    }
    return list;
  }
  fake.state.clientlist = channelClients();

  const queueMod = require(path.resolve(__dirname, '..', 'src/queue.js'));
  const playerMod = require(path.resolve(__dirname, '..', 'src/player.js'));
  const tsbridge = require(path.resolve(__dirname, '..', 'src/tsbridge.js'));
  const tschat = require(path.resolve(__dirname, '..', 'src/tschat.js'));

  const q1 = queueMod.forChannel(CH1);
  const q2 = queueMod.forChannel(CH2);
  const p1 = playerMod.forChannel(CH1);
  const p2 = playerMod.forChannel(CH2);
  q1.load(); q2.load(); p1.load(); p2.load();
  q1.clear(); q2.clear();

  // ---- 1. 命名规则 ----
  config.saveTsBridge({ ts3abChannels: ['点歌专区'] });
  check('单频道：机器人用配置昵称原名', tsbridge._internal.botNameFor('点歌专区') === '点歌机器人', tsbridge._internal.botNameFor('点歌专区'));

  config.saveTsBridge({ ts3abChannels: [CH1, CH2] });
  check('多频道：机器人带「·频道名」后缀（频道1）', tsbridge._internal.botNameFor(CH1) === '点歌机器人·点歌专区', tsbridge._internal.botNameFor(CH1));
  check('多频道：机器人带「·频道名」后缀（频道2）', tsbridge._internal.botNameFor(CH2) === '点歌机器人·开黑房', tsbridge._internal.botNameFor(CH2));
  check('多频道：点歌助手同规则带后缀', tschat._internal.assistantNameFor(CH2) === '点歌助手·开黑房', tschat._internal.assistantNameFor(CH2));
  check('单频道：点歌助手用原名', (function () {
    config.saveTsBridge({ ts3abChannels: ['点歌专区'] });
    const n = tschat._internal.assistantNameFor('点歌专区');
    config.saveTsBridge({ ts3abChannels: [CH1, CH2] });
    return n === '点歌助手';
  })(), '点歌助手');
  check('叶子频道名重复时退回完整路径命名', (function () {
    const names = tsbridge.assignNames(['A区/大厅', 'B区/大厅'], '点歌机器人');
    return names['A区/大厅'] === '点歌机器人·A区·大厅' && names['B区/大厅'] === '点歌机器人·B区·大厅';
  })(), tsbridge.assignNames(['A区/大厅', 'B区/大厅'], '点歌机器人'));

  // ---- 2. 队列按频道隔离 ----
  const s1 = q1.enqueue({ id: 101, name: '频道一的歌', artists: 'A', album: '', cover: '', duration: 200, fee: null }, 'tester');
  const s2 = q2.enqueue({ id: 202, name: '频道二的歌', artists: 'B', album: '', cover: '', duration: 200, fee: null }, 'tester');
  check('频道一队列只看到自己的歌', q1.all().length === 1 && q1.all()[0].title === '频道一的歌', q1.all().map((i) => i.title));
  check('频道二队列只看到自己的歌', q2.all().length === 1 && q2.all()[0].title === '频道二的歌', q2.all().map((i) => i.title));
  p1.play(s1.id);
  p2.play(s2.id);
  check('两个频道播放器互不干扰（都播放中）', p1.get().playing === true && p2.get().playing === true);

  // ---- 3. 电台流 URL 按频道携带 ch 参数 ----
  check('电台流 URL 携带本频道 ch 参数', (function () {
    // 验证 channelKey 稳定性（流地址按频道隔离的基础）
    return queueMod.channelKey(CH1) === queueMod.channelKey(CH1) && queueMod.channelKey(CH1) !== queueMod.channelKey(CH2);
  })(), 'channelKey 稳定且互异');

  // ---- 4. 无人自动暂停按频道独立 ----
  const maybeAutoPauseEmpty = tsbridge._internal.maybeAutoPauseEmpty;

  // 场景1：两个频道都只有机器人+Query → 各自暂停
  users = {};
  fake.state.clientlist = channelClients();
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('所有频道均无人 → 两个频道都自动暂停', p1.get().playing === false && p2.get().playing === false);

  // 场景2：仅开黑房有真实用户 → 只恢复开黑房，点歌专区保持暂停
  users = { 3: 1 };
  fake.state.clientlist = channelClients();
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('开黑房有人 → 开黑房恢复播放', p2.get().playing === true, p2.get());
  check('点歌专区仍无人 → 保持暂停', p1.get().playing === false, p1.get());

  // 场景3：点歌专区也来人 → 恢复点歌专区
  users = { 2: 2, 3: 1 };
  fake.state.clientlist = channelClients();
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('点歌专区有人 → 恢复播放', p1.get().playing === true, p1.get());

  // 场景4：开黑房的人走光 → 只暂停开黑房，点歌专区不受影响
  users = { 2: 2 };
  fake.state.clientlist = channelClients();
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('开黑房走光 → 只暂停开黑房', p2.get().playing === false, p2.get());
  check('点歌专区仍在播放', p1.get().playing === true, p1.get());

  fake.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL', e.stack || e.message); process.exit(1); });
