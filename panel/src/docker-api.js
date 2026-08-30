'use strict';

/**
 * Docker Engine API 客户端（Unix socket 直连）。
 *
 * 用途：容器化模式下，面板容器内不再安装 docker CLI（避免 apk 依赖与
 * 网络慢导致的构建卡顿），通过挂载的 /var/run/docker.sock 直接调用
 * Docker Engine API 完成：引擎检测、容器状态、启停、日志读取。
 *
 * 参考: https://docs.docker.com/engine/api/latest/
 */

const http = require('http');
const SOCKET_PATH = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: SOCKET_PATH,
      method,
      path,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch (e) { parsed = null; }
        resolve({ status: res.statusCode, raw, body: parsed });
      });
    });
    req.on('error', (err) => reject(err));
    if (body) req.write(body);
    req.end();
  });
}

/** docker logs 响应为流格式：每段 8 字节头（1 类型 + 3 保留 + 4 大端长度）+ 数据 */
function parseLogStream(buf) {
  const parts = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    if (i + 8 + size > buf.length) break; // 尾部不完整，丢弃
    parts.push(buf.slice(i + 8, i + 8 + size).toString('utf8'));
    i += 8 + size;
  }
  return parts.join('');
}

function encodeFilters(filters) {
  return encodeURIComponent(JSON.stringify(filters));
}

async function ping() {
  try {
    const r = await api('GET', '/_ping');
    return r.status === 200;
  } catch (e) { return false; }
}

async function version() {
  try {
    const r = await api('GET', '/version');
    return r.status === 200 ? r.body : null;
  } catch (e) { return null; }
}

/** 容器化模式的“环境检测”（替代 docker CLI 检测） */
async function detect() {
  const v = await version();
  const engineOk = await ping();
  return {
    installed: !!v,
    dockerVersion: v ? `Docker ${v.Version} (${v.Os}/${v.Arch})` : null,
    compose: null, // 容器化模式：compose 由主机管理
    engineOk,
    engineError: engineOk ? null : (v ? 'Docker 引擎无响应' : '无法连接 Docker socket（/var/run/docker.sock 未挂载？）'),
  };
}

async function containerStatus(name) {
  try {
    const r = await api('GET', `/containers/json?all=1&filters=${encodeFilters({ name: [name] })}`);
    const list = Array.isArray(r.body) ? r.body : [];
    if (!list.length) return { exists: false };
    const c = list[0];
    const ports = (c.Ports || [])
      .map((p) => `${p.IP ? p.IP + ':' : ''}${p.PublicPort || ''}->${p.PrivatePort}/${p.Type}`)
      .filter(Boolean).join(', ');
    return {
      exists: true,
      name: ((c.Names || [''])[0] || '').replace(/^\//, ''),
      status: c.Status || '',
      ports,
      running: c.State === 'running',
    };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

async function containerLogs(name, tail = 300) {
  try {
    const r = await api('GET', `/containers/${name}/logs?stdout=1&stderr=1&tail=${tail}`);
    if (r.status !== 200) {
      const msg = r.body && r.body.message ? r.body.message : `HTTP ${r.status}`;
      return `（无法读取日志：${msg}）`;
    }
    return parseLogStream(r.raw);
  } catch (e) {
    return `（无法读取日志：${e.message}）`;
  }
}

/** 读取容器环境变量（用于自动获取 TS_QUERY_ADMIN_PASSWORD 等） */
async function containerEnv(name) {
  try {
    const r = await api('GET', `/containers/${name}/json`);
    if (r.status !== 200 || !r.body || !r.body.Config || !Array.isArray(r.body.Config.Env)) return {};
    const env = {};
    for (const entry of r.body.Config.Env) {
      const idx = entry.indexOf('=');
      if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return env;
  } catch (e) {
    return {};
  }
}

/** 容器动作：start / stop / restart */
async function containerAction(name, action) {
  try {
    const r = await api('POST', `/containers/${name}/${action}`);
    // 204=成功；304=状态无变化（如 start 已运行的容器），同样视为成功
    if (r.status === 204 || r.status === 304) return { ok: true };
    const msg = r.body && r.body.message ? r.body.message : `HTTP ${r.status}`;
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  ping,
  version,
  detect,
  containerStatus,
  containerLogs,
  containerEnv,
  containerAction,
};
