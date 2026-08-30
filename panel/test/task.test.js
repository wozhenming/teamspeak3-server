'use strict';

/**
 * 任务流生命周期测试（不依赖 Docker 引擎，可在受限环境运行）。
 *
 * 说明：部分沙箱禁止子进程管道（spawn EPERM），因此这里用 stdio:'ignore'
 * 验证 runTask 的完整生命周期：提交 → running → done/error → 状态与退出码。
 */

const docker = require('../src/docker');

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

function waitTask(id, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const task = docker.getTask(id);
      if (!task) { clearInterval(timer); return resolve(null); }
      if (task.status !== 'running' || Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        resolve(task);
      }
    }, 100);
  });
}

(async () => {
  console.log('\n[成功任务]');
  const okId = docker.runTask('probe-ok', process.execPath, ['-e', 'console.log("hi")'], { stdio: 'ignore' });
  const okTask = await waitTask(okId);
  await check('提交返回 id', typeof okId === 'string' && okId.length > 0);
  await check('状态收敛为 done', okTask && okTask.status === 'done', okTask);
  await check('退出码 0', okTask && okTask.code === 0, okTask);

  console.log('\n[失败任务]');
  const failId = docker.runTask('probe-fail', process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
  const failTask = await waitTask(failId);
  await check('状态收敛为 error', failTask && failTask.status === 'error', failTask);
  await check('退出码 3', failTask && failTask.code === 3, failTask);

  console.log('\n[不存在的命令]');
  const badId = docker.runTask('probe-bad', 'definitely-not-a-real-cmd-xyz', [], { stdio: 'ignore' });
  const badTask = await waitTask(badId, 5000);
  await check('错误路径收敛', badTask && badTask.status === 'error', badTask);
  await check('退出码为 -1', badTask && badTask.code === -1, badTask);
  await check('有错误提示', badTask && badTask.lines.some((l) => /错误|失败|error/i.test(l)), badTask && badTask.lines);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
