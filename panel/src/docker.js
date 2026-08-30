'use strict';

/**
 * Docker / Docker Compose 操作层（供部署管理前端调用）。
 * 提供：环境检测、compose 模板渲染与写入、后台任务流（启动/停止/重启）、
 * 容器状态与日志、初始管理员凭证提取。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { config } = require('./config');

// ---------- 基础：捕获式命令执行 ----------
function execCapture(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      return resolve({ code: -1, out: String(err.message) });
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch (e) { /* 忽略 */ } }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: String(err.message) }); });
  });
}

// ---------- 环境检测 ----------
async function detectDocker() {
  const d = await execCapture('docker', ['--version']);
  const installed = d.code === 0 && /docker/i.test(d.out);

  let compose = null;
  if (installed) {
    const v2 = await execCapture('docker', ['compose', 'version']);
    if (v2.code === 0) {
      compose = { command: 'docker compose', version: v2.out };
    } else {
      const v1 = await execCapture('docker-compose', ['--version']);
      if (v1.code === 0) compose = { command: 'docker-compose', version: v1.out };
    }
  }

  let engineOk = false;
  let engineError = null;
  if (installed) {
    const info = await execCapture('docker', ['info', '--format', '{{.ServerVersion}}'], 5000);
    engineOk = info.code === 0;
    if (!engineOk) engineError = info.out || '无法连接 Docker 引擎';
  }

  return {
    installed,
    dockerVersion: installed ? d.out : null,
    compose,
    engineOk,
    engineError,
  };
}

// ---------- 发行版识别（用于缺失 Docker 时的安装指引） ----------
function detectDistro() {
  try {
    if (process.platform === 'linux' && fs.existsSync('/etc/os-release')) {
      const txt = fs.readFileSync('/etc/os-release', 'utf8');
      const id = (txt.match(/^ID=(.+)$/m) || [])[1];
      const vid = (txt.match(/^VERSION_ID=(.+)$/m) || [])[1];
      return { id: id ? id.replace(/["']/g, '') : 'unknown', version: vid ? vid.replace(/["']/g, '') : '' };
    }
  } catch (e) { /* 忽略 */ }
  return { id: process.platform, version: os.release() };
}

function dockerInstallGuide(distro) {
  if (distro.id !== 'linux') {
    return ['请参考官方文档安装 Docker：https://docs.docker.com/engine/install/'];
  }
  switch (distro.id) {
    case 'ubuntu':
    case 'debian':
      return [
        'sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2',
        '或使用官方脚本：curl -fsSL https://get.docker.com | sudo sh',
      ];
    case 'centos':
    case 'rhel':
    case 'fedora':
    case 'rocky':
    case 'almalinux':
      return [
        'sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin',
        'sudo systemctl enable --now docker',
      ];
    case 'arch':
    case 'manjaro':
      return ['sudo pacman -S --needed docker docker-compose'];
    default:
      return ['请参考官方文档安装 Docker：https://docs.docker.com/engine/install/'];
  }
}

// ---------- docker-compose.yml 模板（与 deploy/install.sh 保持一致） ----------
function renderCompose(opts = {}) {
  const containerName = opts.containerName || 'teamspeak-server';
  const voicePort = opts.voicePort || 9987;
  const filePort = opts.filePort || 30033;
  const queryPort = opts.queryPort || 10011;
  const queryPassword = opts.queryPassword || '';

  return [
    "version: '3'",
    '',
    'services:',
    '  teamspeak:',
    '    image: teamspeak:3.13',
    `    container_name: ${containerName}`,
    '    restart: unless-stopped',
    '    environment:',
    '      - TS3SERVER_LICENSE=accept  # 接受许可证（免费，最多 32 槽位）',
    '    ports:',
    `      - "${voicePort}:9987/udp"      # 语音端口（必须）`,
    `      - "${filePort}:30033/tcp"      # 文件传输端口`,
    `      - "${queryPort}:10011/tcp"     # ServerQuery（管理面板/点歌机器人经内网使用）`,
    '    volumes:',
    '      - teamspeak-data:/teamspeak3-server/  # 数据持久化',
    '      - ./query_ip_allowlist.txt:/teamspeak3-server/query_ip_allowlist.txt:ro',
    '',
    'volumes:',
    '  teamspeak-data:',
    '',
  ].join('\n');
}

function composeFilePath() {
  return path.join(config.deployDir, 'docker-compose.yml');
}

async function saveComposeFile(opts, force = false) {
  const file = composeFilePath();
  if (fs.existsSync(file) && !force) {
    const err = new Error(`docker-compose.yml 已存在（${file}），如需覆盖请确认`);
    err.status = 409;
    throw err;
  }
  // 确保 Query 接口 IP 白名单文件存在（compose 模板会挂载它）
  const allowlistPath = path.join(config.deployDir, 'query_ip_allowlist.txt');
  if (!fs.existsSync(allowlistPath)) {
    await fs.promises.mkdir(config.deployDir, { recursive: true });
    await fs.promises.writeFile(allowlistPath, [
      '# TeamSpeak 3 Query 接口 IP 白名单（每行一个 IP 或 CIDR）',
      '# 远程管理时把来源公网 IP 加入本文件（curl ifconfig.me 查看），',
      '# 然后重启容器：docker compose restart teamspeak',
      '127.0.0.1',
      '::1',
      '172.16.0.0/12',
      '10.0.0.0/8',
      '192.168.0.0/16',
      '',
    ].join('\n'), 'utf8');
  }
  const content = renderCompose(opts);
  await fs.promises.mkdir(config.deployDir, { recursive: true });
  await fs.promises.writeFile(file, content, 'utf8');
  return { path: file, content };
}

// ---------- 后台任务流 ----------
const tasks = new Map();

function runTask(name, cmd, args, opts = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const task = { id, name, status: 'running', lines: [], code: null, startedAt: Date.now() };
  tasks.set(id, task);

  const push = (d) => {
    const text = String(d).replace(/\r/g, '');
    for (const line of text.split('\n')) {
      if (line.trim()) task.lines.push(line);
    }
    if (task.lines.length > 2000) task.lines.splice(0, task.lines.length - 2000);
  };

  let proc;
  try {
    // stdio 默认 'pipe'（捕获输出）；测试环境可传 'ignore'/'inherit'
    proc = spawn(cmd, args, { cwd: opts.cwd, stdio: opts.stdio || 'pipe', windowsHide: true });
  } catch (err) {
    task.status = 'error';
    task.code = -1;
    push(`[启动进程失败] ${err.message}`);
    return id;
  }
  if (proc.stdout) proc.stdout.on('data', push);
  if (proc.stderr) proc.stderr.on('data', push);
  proc.on('error', (err) => {
    push(`[进程错误] ${err.message}`);
    task.status = 'error';
    task.code = -1;
    task.spawnFailed = true;
  });
  proc.on('close', (code) => {
    if (task.spawnFailed) return; // error 事件已处理（如 ENOENT）
    task.status = code === 0 ? 'done' : 'error';
    task.code = code;
  });
  return id;
}

function getTask(id) {
  return tasks.get(id) || null;
}

/** 解析 compose 命令：优先 docker compose（v2），回退 docker-compose（v1） */
async function composeCommand() {
  const v2 = await execCapture('docker', ['compose', 'version']);
  if (v2.code === 0) return { base: 'docker', args: ['compose'] };
  const v1 = await execCapture('docker-compose', ['--version']);
  if (v1.code === 0) return { base: 'docker-compose', args: [] };
  return null;
}

function composeTask(name, actions) {
  return composeCommand().then((compose) => {
    if (!compose) {
      throw Object.assign(new Error('未检测到 Docker Compose（请先安装 docker-compose 插件）'), { status: 400 });
    }
    return runTask(name, compose.base, [...compose.args, ...actions], { cwd: config.deployDir });
  });
}

// ---------- 容器状态与日志 ----------
async function containerStatus(name) {
  const r = await execCapture('docker', [
    'ps', '-a', '--filter', `name=${name}`,
    '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}',
  ], 6000);
  if (r.code !== 0 || !r.out) {
    return { exists: false, error: r.code === 0 ? null : r.out };
  }
  const [containerName, status, ports] = r.out.split('\n')[0].split('\t');
  return {
    exists: true,
    name: containerName,
    status: status || '',
    ports: ports || '',
    running: /^Up/i.test(status || ''),
  };
}

async function containerLogs(name, tail = 300) {
  const r = await execCapture('docker', ['logs', '--tail', String(tail), name], 15000);
  return r.code === 0 ? r.out : `（无法读取日志：${r.out || 'docker logs 失败'}）`;
}

// ---------- 初始管理员凭证提取 ----------
// TS3 首次启动日志格式（实测 3.13）：
//   loginname= "serveradmin", password= "xxxx"
//   token=xxxx   （ServerAdmin privilege key，注意前面有时间戳前缀）
const CRED_RE = /loginname=|password=|token=/i;
const SKIP_RE = /license|starting|stopping|connecting|listening/i;

function extractCredentials(logText) {
  const lines = String(logText || '').split('\n');
  return lines
    .map((l) => l.trimEnd())
    .filter((l) => CRED_RE.test(l) && !SKIP_RE.test(l) && !/^\s*$/.test(l))
    .slice(-8);
}

module.exports = {
  execCapture,
  detectDocker,
  detectDistro,
  dockerInstallGuide,
  renderCompose,
  composeFilePath,
  saveComposeFile,
  runTask,
  getTask,
  composeTask,
  containerStatus,
  containerLogs,
  extractCredentials,
};
