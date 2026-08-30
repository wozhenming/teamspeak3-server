'use strict';

/**
 * 点歌助手跟随修复回归测试（ServerQuery 多行 '|' 拼接解析）。|' 拼接解析）。
 *
 * TS6 的 ServerQuery 会把 channellist / clientlist / serverlist 的多条结果行
 * 用 '|ServerQuery 会把 channellist / clientlist / serverlist 的多条结果行
用 '|' 拼接在同一条物理行返回（TS3/TS6 皆如此）。旧实现按“一行一对象”解析，
 * 会把多行合并成一个错乱对象（字段跨行混搭、只留最后一行值），导致点歌助手
 * 无法正确定位点歌机器人所在频道。本测试保证 splitRows 能正确拆分。
 *
 * 运行（music 目录，需先安装依赖）：
 *   npm install
 *   node test/tschat-parser.test.js
 */

const { splitRows, isRowSeparator, parseParams } = require('../src/tsquery.js');
void isRowSeparator;

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log('PASS  ' + name);
  } else {
    failed += 1;
    console.log('FAIL  ' + name + (extra !== undefined ? '  (got: ' + JSON.stringify(extra) + ')' : ''));
  }
}

// 1) 真实的 |-joined channellist（多频道）
const chanList = 'cid=1 pid=0 channel_order=0 channel_name=Default\\sChannel total_clients=0|cid=2 pid=0 channel_order=1 channel_name=闲聊 total_clients=0|cid=3 pid=0 channel_order=2 channel_name=游戏房 total_clients=0|cid=4 pid=0 channel_order=3 channel_name=点歌专区 total_clients=0';
const chanRows = splitRows(chanList).map(parseParams);
check('channellist 拆成 4 行', chanRows.length === 4, chanRows);
check('第 1 行是 Default Channel', chanRows[0] && chanRows[0].channel_name === 'Default Channel', chanRows[0]);
check('第 2 行是 闲聊 且 cid=2', chanRows[1] && chanRows[1].channel_name === '闲聊' && chanRows[1].cid === '2', chanRows[1]);
check('第 4 行是 点歌专区 且 cid=4', chanRows[3] && chanRows[3].channel_name === '点歌专区' && chanRows[3].cid === '4', chanRows[3]);
check('无跨行串扰（第 1 行 cid=1 而非最后一行值）', chanRows[0] && chanRows[0].cid === '1', chanRows[0]);

// 2) 转义管道符 \p 不应被当作行分隔符
const escPipe = 'channel_name=A\\pB|cid=2 channel_name=正常';
const escRows = splitRows(escPipe);
check('\\p 转义管道符不作分隔', escRows.length === 2, escRows);
check('\\p 解析为字面管道符', parseParams(escRows[0]).channel_name === 'A|B', escRows);

// 3) 单行（whoami 等）不被误拆
const single = 'client_id=1 client_channel_id=3 client_nickname=serveradmin';
check('单行不拆分', splitRows(single).length === 1, splitRows(single));
check('单行字段完整', parseParams(single).client_channel_id === '3', single);

// 4) 空/单行临界：空串无数据行（不产生对象，也不抛错）
check('空串无数据行', splitRows('').length === 0, splitRows(''));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);