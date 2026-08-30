'use strict';

/**
 * 回归：容器重启（重新 require 模块）后看门狗必须保持工作。
 *
 * desiredLinked（保持连接的意图）只在 link() 成功时置 true，此前模块加载虽然
 * 会因持久化的频道绑定启动看门狗，但 tick 里 `if (!desiredLinked) return;` 直接退出，
 * 导致每次重启/部署后「频道无人自动暂停」与「断线自动重连」全部失效
 * （机器人活在 TS3AudioBot 进程里不受影响，现象是"一切正常就是不暂停"）。
 *
 * 本测试在数据目录预置持久化的 tsbridge.json（含 ts3abChannelBots 绑定），
 * 模拟“此前已成功部署”的容器重启场景。
 *
 * 运行（music 目录）：node test/watchdog-restart.test.js
 */

process.env.MUSIC_DATA_DIR = '/tmp/data-watchdog';
const fs = require('fs');
const path = require('path');
const dataDir = process.env.MUSIC_DATA_DIR;
fs.mkdirSync(dataDir, { recursive: true });
// 预置“此前已成功部署”的持久化状态：频道 → 机器人模板绑定
fs.writeFileSync(path.join(dataDir, 'tsbridge.json'), JSON.stringify({
  ts3abChannels: ['点歌专区'],
  ts3abChannelBots: { '点歌专区': 'ts3bot_dianqu_2f31a55b' },
}), 'utf8');

const tsbridge = require(path.resolve(__dirname, '..', 'src/tsbridge.js'));

let pass = 0, fail = 0;
const check = (n, c, g) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (g !== undefined ? '  (got: ' + JSON.stringify(g) + ')' : '')); } };

check('持久化频道绑定下模块加载即视为"应保持连接"', tsbridge._internal.isLinkedDesired() === true, tsbridge._internal.isLinkedDesired());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
