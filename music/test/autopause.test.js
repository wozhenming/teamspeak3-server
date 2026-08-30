'use strict';

/**
 * 验证「频道无人时自动暂停、有人进入自动恢复」逻辑（真实 maybeAutoPauseEmpty + 真实每频道播放器）。
 *
 * 起一个假的 TS3 ServerQuery 服务器（clientlist 由测试动态控制），
 * 驱动真实函数体并校验对应频道播放器的暂停/恢复。
 *
 * 关键回归：
 * 1. 点歌助手/serveradmin Query 常驻频道不算“人”（client_type=1 排除）；
 * 2. 查询端不可用时无法判断，保持现状。
 *
 * 运行（music 目录，需先安装依赖）：node test/autopause.test.js
 */

process.env.MUSIC_DATA_DIR = '/tmp/data-autopause';
process.env.AUTO_PAUSE_EMPTY = 'true';
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
  process.env.TS3AB_CHANNELS = '点歌专区';

  const queueMod = require(path.resolve(__dirname, '..', 'src/queue.js'));
  const playerMod = require(path.resolve(__dirname, '..', 'src/player.js'));
  const { config } = require(path.resolve(__dirname, '..', 'src/config.js'));
  config.saveTsBridge({ ts3abChannels: ['点歌专区'], tsQueryAdminPassword: 'testpass' });
  const tsbridge = require(path.resolve(__dirname, '..', 'src/tsbridge.js'));

  const CH = '点歌专区';
  const queue = queueMod.forChannel(CH);
  const player = playerMod.forChannel(CH);

  // ---- 可调节的“频道内客户端”，模拟 TS3 ServerQuery clientlist ----
  // 固定成员：clid=10 点歌机器人(语音) / clid=11 serveradmin(Query) / clid=12 点歌助手(Query)
  // fakeUsers = 频道内真实语音用户数量（clid 从 100 起）
  let fakeUsers = 0;
  function channelClients() {
    const list = [
      { clid: 10, client_nickname: '点歌机器人', cid: 2, client_type: 0 },
      { clid: 11, client_nickname: 'serveradmin', cid: 2, client_type: 1 },
      { clid: 12, client_nickname: '点歌助手', cid: 2, client_type: 1 },
    ];
    for (let i = 0; i < fakeUsers; i++) list.push({ clid: 100 + i, client_nickname: '用户' + i, cid: 2, client_type: 0 });
    return list;
  }
  fake.state.channellist = [{ cid: 1, pid: 0, channel_name: '默认' }, { cid: 2, pid: 1, channel_name: '点歌专区' }];

  let pass = 0, fail = 0;
  const check = (n, c, g) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (g !== undefined ? '  (got: ' + JSON.stringify(g) + ')' : '')); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  queue.load();
  player.load();
  queue.clear();
  const queued = queue.enqueue({ id: 0, name: '测试乐曲', artists: 'T', album: '', cover: '', duration: 200, fee: null }, 'tester');
  player.play(queued.id);
  check('初始处于播放中', player.get().playing === true, player.get());

  const maybeAutoPauseEmpty = tsbridge._internal.maybeAutoPauseEmpty;

  // 场景1：频道内只有机器人 + serveradmin/点歌助手 Query（真实用户 0）→ 自动暂停
  fake.state.clientlist = channelClients(); fakeUsers = 0;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('仅机器人+Query 在频道 → 自动暂停', player.get().playing === false, player.get());

  // 场景2：保持无人，再次调用 → 维持暂停
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('仍无人且已暂停 → 保持暂停', player.get().playing === false, player.get());

  // 场景3：真实用户进入（Query 仍在场）→ 自动恢复
  fakeUsers = 1;
  fake.state.clientlist = channelClients();
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('真实用户进入 → 自动恢复', player.get().playing === true, player.get());

  // 场景4：有人在且正在播放 → 维持
  fakeUsers = 3;
  fake.state.clientlist = channelClients();
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('有人在且播放中 → 保持播放', player.get().playing === true, player.get());

  // 场景5：查询端不可用 → 无法判断，保持现状（不误暂停也不误恢复）
  fake.state.clientlist = null;
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('clients 查询不可用 → 保持现状', player.get().playing === true, player.get());
  fakeUsers = 3;
  fake.state.clientlist = channelClients();

  // 场景6：autoPauseEmpty 关闭时，即便无人也不暂停
  config.autoPauseEmpty = false;
  fakeUsers = 0;
  fake.state.clientlist = channelClients();
  await maybeAutoPauseEmpty();
  await sleep(50);
  check('autoPauseEmpty=false → 不自动暂停恢复', player.get().playing === true, player.get());
  config.autoPauseEmpty = true;

  const countCalls = fake.seen.filter((c) => c === 'clientlist').length;
  check('确实发生了频道计数读取（>0）', countCalls > 0, countCalls);

  fake.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL', e.stack || e.message); process.exit(1); });
