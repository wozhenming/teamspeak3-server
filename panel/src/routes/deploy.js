'use strict';

/**
 * /api/deploy — 部署管理（前端引导式一键部署）
 *
 *   GET    /status        环境/文件/容器/ServerQuery 综合状态
 *   GET    /preview       预览 docker-compose.yml 内容
 *   POST   /compose       生成 docker-compose.yml { ...opts, force }
 *   POST   /up            启动服务（后台任务，返回 taskId）
 *   POST   /down          停止服务（后台任务）
 *   POST   /restart       重启服务（后台任务）
 *   GET    /task/:id      查询后台任务进度 { status, lines, code }
 *   GET    /logs?tail=N   容器日志
 *   GET    /credentials   从日志提取初始管理员凭证（serveradmin 密码 / privilege key）
 *   POST   /password      保存 serveradmin 查询密码到 .env 并立即生效 { password }
 *   GET    /check         检测 ServerQuery 连通性（login + version）
 */

const express = require('express');
const fs = require('fs');
const { config, setQueryPassword } = require('../config');
const { ts, clearLoginCooldown } = require('../ts3query');
const docker = require('../docker');
const dockerApi = require('../docker-api');

const router = express.Router();

const isContainerMode = () => config.runMode === 'container';

function num(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ---------- 综合状态 ----------
router.get('/status', async (req, res, next) => {
  try {
    const containerName = req.query.name || config.tsContainerName;
    const [env, container, composeFile, sq] = await Promise.all([
      isContainerMode() ? dockerApi.detect() : docker.detectDocker(),
      isContainerMode() ? dockerApi.containerStatus(containerName) : docker.containerStatus(containerName),
      docker.composeFilePath(),
      ts.version()
        .then((v) => ({ reachable: true, version: v && v.version ? v.version : '' }))
        .catch((e) => ({ reachable: false, error: e.message })),
    ]);

    let composeContent = null;
    try { composeContent = fs.existsSync(composeFile) ? fs.readFileSync(composeFile, 'utf8') : null; } catch (e) { composeContent = null; }

    res.json({
      ok: true,
      data: {
        mode: config.runMode,
        containerName,
        distro: docker.detectDistro(),
        docker: env,
        dockerInstallGuide: env.installed ? [] : docker.dockerInstallGuide(docker.detectDistro()),
        composeFile: { path: composeFile, exists: !!composeContent, content: composeContent },
        container,
        query: {
          host: config.tsQueryHost,
          port: config.tsQueryPort,
          passwordConfigured: !!config.tsQueryPassword,
          reachable: sq.reachable,
          version: sq.reachable ? sq.version : null,
          error: sq.reachable ? null : sq.error,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- 预览 compose（容器化模式下由根目录 compose 管理，不适用） ----------
router.get('/preview', (req, res) => {
  if (config.runMode === 'container') {
    return res.status(400).json({ ok: false, error: { code: 'CONTAINER_MODE', message: '容器化模式下 docker-compose.yml 由项目根目录管理，无需在此生成' } });
  }
  const content = docker.renderCompose({
    containerName: req.query.name || undefined,
    voicePort: num(req.query.voice, 9987),
    filePort: num(req.query.file, 30033),
    queryPort: num(req.query.query, 10011),
    queryPassword: req.query.password || undefined,
  });
  res.json({ ok: true, data: { content } });
});

// ---------- 生成 compose（容器化模式下不适用） ----------
router.post('/compose', async (req, res, next) => {
  try {
    if (config.runMode === 'container') {
      throw Object.assign(new Error('容器化模式下 docker-compose.yml 由项目根目录管理，无需在此生成'), { status: 400 });
    }
    const b = req.body || {};
    const result = await docker.saveComposeFile({
      containerName: b.name || undefined,
      voicePort: num(b.voice, 9987),
      filePort: num(b.file, 30033),
      queryPort: num(b.query, 10011),
      queryPassword: b.password || undefined,
    }, !!b.force);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------- 启动 / 停止 / 重启 ----------
// 容器化模式：经 docker.sock 直接操作 TS3 容器（由根目录 compose 创建），即时返回；
// 独立模式：compose 后台任务（返回 taskId 供轮询）
const CONTAINER_ACTIONS = { up: 'start', down: 'stop', restart: 'restart' };

async function containerActionOrComposeTask(action) {
  if (isContainerMode()) {
    const result = await dockerApi.containerAction(config.tsContainerName, CONTAINER_ACTIONS[action]);
    if (!result.ok) {
      throw Object.assign(new Error(`容器操作失败：${result.error}`), { status: 502 });
    }
    return { taskId: null, action, success: true };
  }
  const taskMap = { up: ['up', '-d'], down: ['down'], restart: ['restart'] };
  if (action === 'up' && !fs.existsSync(docker.composeFilePath())) {
    throw Object.assign(new Error('尚未生成 docker-compose.yml，请先在「部署配置」中生成'), { status: 400 });
  }
  const taskId = await docker.composeTask(`compose-${action}`, taskMap[action]);
  return { taskId, action };
}

router.post('/up', async (req, res, next) => {
  try {
    const result = await containerActionOrComposeTask('up');
    res.json({ ok: true, data: { ...result, mode: config.runMode } });
  } catch (err) { next(err); }
});

router.post('/down', async (req, res, next) => {
  try {
    const result = await containerActionOrComposeTask('down');
    res.json({ ok: true, data: { ...result, mode: config.runMode } });
  } catch (err) { next(err); }
});

router.post('/restart', async (req, res, next) => {
  try {
    const result = await containerActionOrComposeTask('restart');
    res.json({ ok: true, data: { ...result, mode: config.runMode } });
  } catch (err) { next(err); }
});

// ---------- 任务查询 ----------
router.get('/task/:id', (req, res) => {
  const task = docker.getTask(req.params.id);
  if (!task) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在或已过期' } });
  res.json({ ok: true, data: { id: task.id, name: task.name, status: task.status, code: task.code, lines: task.lines } });
});

// ---------- 容器日志 ----------
router.get('/logs', async (req, res, next) => {
  try {
    const name = req.query.name || config.tsContainerName;
    const log = isContainerMode()
      ? await dockerApi.containerLogs(name, num(req.query.tail, 300))
      : await docker.containerLogs(name, num(req.query.tail, 300));
    res.json({ ok: true, data: { name, log } });
  } catch (err) { next(err); }
});

// ---------- 初始管理员凭证 ----------
// 凭证仅在容器首次启动打印；为避免容器重建（应用新配置）后丢失，
// 首次提取到时自动持久化到面板数据卷，之后直接读取保存的副本。
// 来源优先级：① 持久化文件 → ② 容器日志（提取后自动保存）
router.get('/credentials', async (req, res, next) => {
  try {
    const name = req.query.name || config.tsContainerName;
    const fs = require('fs');

    // ① 持久化副本
    if (fs.existsSync(config.credentialFile)) {
      const saved = fs.readFileSync(config.credentialFile, 'utf8').trim();
      const lines = saved.split('\n').filter(Boolean);
      if (lines.length) {
        return res.json({ ok: true, data: { found: true, lines, source: 'saved', note: '来自面板数据卷中保存的凭证副本（首次提取时自动保存，容器重建不丢失）' } });
      }
    }

    // ② 容器日志（提取后自动保存）
    const log = isContainerMode()
      ? await dockerApi.containerLogs(name, 10000)
      : await docker.containerLogs(name, 10000);
    let lines = docker.extractCredentials(log);
    if (lines.length) {
      try {
        await fs.promises.writeFile(config.credentialFile, lines.join('\n') + '\n', 'utf8');
      } catch (e) { /* 保存失败不影响返回 */ }
      return res.json({ ok: true, data: { found: true, lines, source: 'log', note: '已自动保存到面板数据卷，容器重建后仍可查看' } });
    }

    res.json({
      ok: true,
      data: {
        found: false,
        lines: [],
        note: '未找到凭证：容器首次启动的日志已随重建丢失。请在服务器上执行 docker compose down && docker compose up -d 重建 teamspeak 容器（注意会清空虚拟服务器配置），首次启动日志会再次打印 serveradmin 密码。',
      },
    });
  } catch (err) { next(err); }
});

// ---------- serveradmin 查询密码 ----------
router.post('/password', (req, res) => {
  const { password } = req.body || {};
  if (password === undefined) {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: '缺少 password 参数' } });
  }
  const saved = setQueryPassword(password);
  clearLoginCooldown(); // 新密码立即生效，不等冷却
  res.json({ ok: true, data: { configured: !!saved } });
});

// ---------- ServerQuery 连通性检测 ----------
router.get('/check', async (req, res, next) => {
  try {
    const v = await ts.version();
    res.json({ ok: true, data: { reachable: true, version: (v && v.version) || v, host: config.tsQueryHost, port: config.tsQueryPort, passwordConfigured: !!config.tsQueryPassword } });
  } catch (err) {
    res.status(502).json({ ok: false, error: { code: err.code || 'QUERY_UNREACHABLE', message: err.message } });
  }
});

module.exports = router;
