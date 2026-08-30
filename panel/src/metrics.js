'use strict';

/**
 * 指标采样器：周期采集服务器状态，供仪表盘历史图表与"最近加入用户"使用。
 *
 * - 每 5 秒采样一次（在线人数 / 上下行带宽 Kbit/s），内存环形缓冲保留 24 小时；
 * - 同时追踪客户端列表，记录"新加入"的用户（退出后仍保留在最近列表）。
 *
 * 注意：ServerQuery 不可用（未配置密码 / 服务器离线）时静默跳过，恢复后自动续采。
 */

const { config } = require('./config');
const { ts } = require('./ts3query');
const usersDb = require('./users-db');

const SAMPLE_MS = 5000;
const MAX_POINTS = 7 * 24 * 60 * 60 / 5;   // 7 天 @5s
const MAX_RECENT = 30;                  // 最近加入用户保留条数

const points = []; // { t, clients, up, down }
let recentClients = []; // { clid, nickname, uid, channel_name, joined_at }
let knownClients = new Set();
let timer = null;
let saveTimer = null;

async function sample() {
  const sid = config.tsDefaultSid;
  try {
    const [server, conn, clients, channels] = await Promise.all([
      ts.serverinfo(sid).catch(() => null),
      ts.connectionInfo(sid).catch(() => null),
      ts.clientlist(sid).catch(() => []),
      ts.channellist(sid).catch(() => []),
    ]);

    if (server) {
      const up = conn ? (Number(conn.connection_bandwidth_sent_last_second_total) || 0) * 8 / 1000 : 0;
      const down = conn ? (Number(conn.connection_bandwidth_received_last_second_total) || 0) * 8 / 1000 : 0;
      points.push({
        t: Date.now(),
        clients: Number(server.virtualserver_clientsonline || 0),
        up: Math.round(up * 100) / 100,
        down: Math.round(down * 100) / 100,
      });
      if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
    }

    // 追踪新加入用户（过滤 ServerQuery 客户端）
    const channelById = new Map(channels.map((c) => [Number(c.cid), c.channel_name || '']));
    const current = new Set();
    const now = Date.now();
    for (const c of clients) {
      if (String(c.client_type) === '1') continue; // 过滤 query 客户端
      const clid = Number(c.clid);
      current.add(clid);
      if (!knownClients.has(clid)) {
        recentClients.unshift({
          clid,
          nickname: c.client_nickname || '?',
          uid: c.client_unique_identifier || '',
          channel_name: channelById.get(Number(c.cid)) || '',
          joined_at: now,
        });
      }
    }
    knownClients = current;
    if (recentClients.length > MAX_RECENT) recentClients.length = MAX_RECENT;

    // 用户历史数据库同步（在线/离线检测 + 连接记录）
    usersDb.updateOnline(clients, channelById);
  } catch (e) {
    // 静默：ServerQuery 不可用时跳过本轮
  }
}

function start() {
  if (timer) return;
  usersDb.start(); // 启动用户历史数据库
  load();
  sample();
  timer = setInterval(sample, SAMPLE_MS);
  saveTimer = setInterval(save, 5 * 60000); // 每 5 分钟持久化一次
}

// ---------- 持久化（面板重启不丢历史） ----------
const metricsFile = config.metricsFile;

function save() {
  try {
    if (!points.length) return;
    const fs = require('fs');
    fs.writeFileSync(metricsFile, JSON.stringify(points), 'utf8');
  } catch (e) { /* 持久化失败忽略 */ }
}

function load() {
  try {
    const fs = require('fs');
    if (!fs.existsSync(metricsFile)) return;
    const arr = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
    if (Array.isArray(arr)) {
      points.length = 0;
      points.push(...arr.filter((p) => p && typeof p.t === 'number'));
      if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
    }
  } catch (e) { /* 读取失败忽略 */ }
}

/** 最近 minutes 分钟的历史点（按时间升序） */
function history(minutes) {
  const cutoff = Date.now() - minutes * 60000;
  const out = points.filter((p) => p.t >= cutoff);
  // 若窗口内无点（如面板刚启动），补当前时刻点保证图表可用
  if (!out.length && points.length) out.push(points[points.length - 1]);
  return out;
}

function recent() {
  return recentClients;
}

module.exports = { start, history, recent, save, load, metricsFile, SAMPLE_MS };
