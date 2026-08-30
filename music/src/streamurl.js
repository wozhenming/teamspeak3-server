'use strict';

// 电台音频流“对外收听”地址的解析（面板展示用，可选）：
// TS3AudioBot 引擎拉流不受公网限制（内网地址即可，见 config.streamBotUrl）。
// 此地址仅供面板“收听”展示：优先读显式配置；否则启动时自动探测本机公网 IP。

const dns = require('dns').promises;
const { config } = require('./config');

const DETECT_SERVICES = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
  'https://myip.dnsomatic.com',
  'https://checkip.amazonaws.com',
  'https://api.ip.sb/ip',
  'https://ipinfo.io/ip',
];

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    // IPv6
    if (ip === '::1') return true;
    if (ip.startsWith('fe80')) return true; // 链路本地
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // 唯一本地地址
    return false;
  }
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 0) return true;
  return false;
}

async function resolveStreamPublicUrl() {
  const streamPort = process.env.MUSIC_STREAM_PORT || '3200';
  if (process.env.STREAM_PUBLIC_URL) {
    config.streamPublicUrl = process.env.STREAM_PUBLIC_URL;
    console.log('[music-bot] 电台流对外收听地址(显式 STREAM_PUBLIC_URL):', config.streamPublicUrl);
    return;
  }
  if (process.env.STREAM_PUBLIC_HOST) {
    config.streamPublicUrl = `http://${process.env.STREAM_PUBLIC_HOST}:${streamPort}/api/stream`;
    console.log('[music-bot] 电台流对外收听地址(显式 STREAM_PUBLIC_HOST):', config.streamPublicUrl);
    return;
  }
  // 自动探测公网 IP（多个服务兜底，单个超时/失败不影响其他）
  for (const s of DETECT_SERVICES) {
    try {
      const r = await fetch(s, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const ip = (await r.text()).trim().replace(/\s+/g, '');
      if (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        config.streamPublicUrl = `http://${ip}:${streamPort}/api/stream`;
        console.log('[music-bot] 电台流对外收听地址(自动探测公网 IP ' + s + '):', config.streamPublicUrl);
        return;
      }
    } catch (e) { /* 尝试下一个 */ }
  }
  // 兜底：仍用内网主机名（仅影响对外收听展示，不影响机器人拉流）
  config.streamPublicUrl = `http://music:${streamPort}/api/stream`;
  console.log('[music-bot] 警告：未能自动获取公网 IP，回退到内网地址', config.streamPublicUrl, '（对外收听可能不可用，建议设置 STREAM_PUBLIC_HOST）');
}

// 当前 config.streamPublicUrl 是否“可用”（非内网、可达）
async function isStreamUrlOk() {
  // 显式配置过则信任用户意图
  if (process.env.STREAM_PUBLIC_URL || process.env.STREAM_PUBLIC_HOST) return true;
  const urlStr = config.streamPublicUrl || '';
  let host;
  try { host = new URL(urlStr).hostname; } catch (e) { return false; }
  if (!host) return false;
  // 已知的 docker 内网服务名，必然被 SSRF 拦截
  if (host === 'music' || host === 'teamspeak' || host === 'localhost' || host.endsWith('.local')) return false;
  try {
    const { address } = await dns.lookup(host);
    return !isPrivateIp(address);
  } catch (e) {
    // 解析失败（容器无 DNS）：无法确认，按“不可用”处理以触发重新探测
    return false;
  }
}

// 建机器人/播放电台前调用：若地址仍可疑，立即重新探测；仍失败则抛出清晰错误。
async function ensureStreamPublicUrl() {
  if (await isStreamUrlOk()) return;
  console.log('[music-bot] 电台流地址可疑(内网/未解析)，尝试重新探测公网地址…');
  await resolveStreamPublicUrl();
  if (await isStreamUrlOk()) {
    console.log('[music-bot] 重新探测成功：', config.streamPublicUrl);
    return;
  }
  throw new Error(
    '电台流地址仍指向内网(' + config.streamPublicUrl + ')，对外收听将不可用。' +
    '请在 .env 设置 STREAM_PUBLIC_HOST=你的公网IP 或 STREAM_PUBLIC_URL=完整地址 后重建 music 服务'
  );
}

module.exports = { resolveStreamPublicUrl, isStreamUrlOk, ensureStreamPublicUrl, isPrivateIp };
