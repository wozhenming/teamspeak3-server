'use strict';

/**
 * 指标采样器测试（需要 test/mock-ts3-query.js 运行在 10012 端口）。
 *
 * 前置：node test/mock-ts3-query.js 10012
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 隔离配置：避免写入真实 panel/.env
const testEnvFile = path.join(os.tmpdir(), 'ts3-test-panel.env');
process.env.PANEL_ENV_FILE = testEnvFile;
process.env.TSSERVER_QUERY_HOST = '127.0.0.1';
process.env.TSSERVER_QUERY_PORT = '10012';
process.env.TSSERVER_QUERY_PASSWORD = 'test-password';

const metrics = require('../src/metrics');

let passed = 0;
let failed = 0;

async function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : '');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. 采样
  console.log('\n[采样]');
  metrics.start();
  await sleep(6500); // 至少一个采样周期
  const h1 = metrics.history(30);
  await check('30 分钟窗口有点', h1.length >= 1, h1.length);
  const last = h1[h1.length - 1];
  await check('在线人数=3（mock，含查询端）', last && last.clients === 3, last);
  await check('带宽速率>0（mock）', last && last.up > 0 && last.down > 0, last);

  // 2. 时间窗口过滤
  console.log('\n[窗口]');
  const h5 = metrics.history(5);
  await check('5 分钟窗口 ≤ 30 分钟窗口', h5.length <= h1.length && h5.length >= 1, { h5: h5.length, h1: h1.length });
  const h1440 = metrics.history(1440);
  await check('24 小时窗口包含全部', h1440.length >= h1.length, h1440.length);

  // 3. 持久化
  console.log('\n[持久化]');
  metrics.save();
  await check('持久化文件存在', fs.existsSync(metrics.metricsFile));
  metrics.load(); // 模拟重启后加载
  const h2 = metrics.history(30);
  await check('重新加载后数据完整', h2.length === h1.length, { before: h1.length, after: h2.length });
  await check('加载后数据正确', h2[h2.length - 1] && h2[h2.length - 1].clients === 3, h2[h2.length - 1]);

  // 清理
  fs.rmSync(metrics.metricsFile, { force: true });
  fs.rmSync(testEnvFile, { force: true });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
