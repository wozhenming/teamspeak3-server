'use strict';

/**
 * 用户历史数据库：持久化所有连接过的用户及连接记录。
 *
 * - 每次 metrics 采样时调用 updateOnline()，检测新连接/离线事件
 * - 持久化到面板数据卷（ts3-users.json），面板重启不丢
 * - 提供汇总统计与连接记录查询
 */

const fs = require('fs');
const path = require('path');
const { config, envFile } = require('./config');

const SAVE_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟保存
const MAX_CONNECTIONS = 5000;             // 最大连接记录条数

const usersFile = path.join(path.dirname(envFile || path.join(__dirname, '..', '.env')), 'ts3-users.json');

// uid -> { nickname, uid, country, first_seen, last_seen, total_connections }
const users = new Map();
// 连接记录（最新在前）: { uid, nickname, channel_name, joined_at, left_at, duration }
const connections = [];
// 当前在线 uid 集合
const onlineUids = new Set();
// uid -> 最后一次在线时的 joined_at（用于计算离线时 duration）
const activeJoins = new Map();

let saveTimer = null;

// ---------- 持久化 ----------
function save() {
  try {
    const data = {
      users: Object.fromEntries(users),
      connections,
    };
    fs.writeFileSync(usersFile, JSON.stringify(data), 'utf8');
  } catch (e) { /* 忽略 */ }
}

function load() {
  try {
    if (!fs.existsSync(usersFile)) return;
    const raw = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.users && typeof raw.users === 'object') {
        for (const [uid, info] of Object.entries(raw.users)) {
          users.set(uid, info);
        }
      }
      if (Array.isArray(raw.connections)) {
        connections.length = 0;
        connections.push(...raw.connections.filter((c) => c && c.uid));
        if (connections.length > MAX_CONNECTIONS) connections.length = MAX_CONNECTIONS;
      }
    }
  } catch (e) { /* 忽略 */ }
}

// ---------- 在线状态追踪（metrics 调用） ----------
function updateOnline(rawClients, channelById) {
  const now = Date.now();
  const currentUids = new Set();

  for (const c of rawClients) {
    if (String(c.client_type) === '1') continue; // 过滤 query 客户端
    const uid = c.client_unique_identifier || '';
    if (!uid) continue;
    const nickname = c.client_nickname || '?';
    const country = c.client_country || '';
    const cid = Number(c.cid);
    const channel_name = (channelById && channelById.get(cid)) || '';

    currentUids.add(uid);

    // 更新用户主记录
    let user = users.get(uid);
    if (!user) {
      user = { nickname, uid, country, first_seen: now, last_seen: now, total_connections: 0 };
      users.set(uid, user);
    }
    user.nickname = nickname; // 昵称可能变化
    if (country) user.country = country;
    user.last_seen = now;

    // 新连接检测（之前不在线）
    if (!onlineUids.has(uid)) {
      user.total_connections++;
      connections.unshift({ uid, nickname, channel_name, joined_at: now, left_at: null, duration: null });
      if (connections.length > MAX_CONNECTIONS) connections.length = MAX_CONNECTIONS;
      activeJoins.set(uid, now);
    }
  }

  // 离线检测（之前在线，现在不在）
  for (const uid of onlineUids) {
    if (!currentUids.has(uid)) {
      const joinedAt = activeJoins.get(uid) || now;
      const conn = connections.find((c) => c.uid === uid && c.left_at === null);
      if (conn) {
        conn.left_at = now;
        conn.duration = Math.floor((now - joinedAt) / 1000);
      }
      activeJoins.delete(uid);
    }
  }

  onlineUids.clear();
  for (const uid of currentUids) onlineUids.add(uid);
}

// ---------- 查询接口 ----------
function getAllUsers() {
  return Array.from(users.values()).sort((a, b) => b.last_seen - a.last_seen);
}

function getOnlineUids() {
  return new Set(onlineUids);
}

function isOnline(uid) {
  return onlineUids.has(uid);
}

function getConnections(limit = 100) {
  return connections.slice(0, limit);
}

function getStats() {
  const totalUsers = users.size;
  const totalConnections = connections.length;
  const onlineCount = onlineUids.size;

  // 计算平均连接时长（只统计有 duration 的）
  let totalDuration = 0;
  let durationCount = 0;
  let maxOnline = 0;
  for (const c of connections) {
    if (c.duration != null && c.duration > 0) {
      totalDuration += c.duration;
      durationCount++;
    }
  }

  // 峰值在线：从 metrics 的历史数据取（metrics.history 返回 {t,clients,...}）
  // 这里简化：用最近连接记录估算
  let recentMax = 0;
  for (const c of connections.slice(0, 200)) {
    if (c.joined_at && !c.left_at) recentMax++; // 当前在线
  }
  maxOnline = Math.max(onlineCount, recentMax);

  return {
    total_users: totalUsers,
    total_connections: totalConnections,
    online_now: onlineCount,
    avg_connection_seconds: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
    max_online: maxOnline,
  };
}

// ---------- 启动 ----------
function start() {
  load();
  saveTimer = setInterval(save, SAVE_INTERVAL_MS);
}

module.exports = {
  start,
  updateOnline,
  getAllUsers,
  getOnlineUids,
  isOnline,
  getConnections,
  getStats,
  save, // 手动保存
};
