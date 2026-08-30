'use strict';

/**
 * GET /api/overview?sid=1
 * 仪表盘聚合数据：版本 / 服务器信息（含每秒带宽）/ 在线用户 / 频道列表。
 *
 * TS3 ServerQuery 字段名：
 *  - serverinfo: virtualserver_name / _status / _clientsonline / _maxclients /
 *                _uptime / _created / _version / _platform / _total_packetloss_total / _total_ping
 *  - serverinfo（带宽）: connection_bandwidth_sent_last_second_total /
 *                connection_bandwidth_received_last_second_total（字节/秒）
 */

const express = require('express');
const { ts } = require('../ts3query');
const { smoothIdle, smoothConnected } = require('../utils/smooth');

const router = express.Router();

/** TS3 version 返回 {version,build,platform}，兼容数组结构 */
function pickVersion(v) {
  if (!v) return null;
  const item = Array.isArray(v) ? v[0] : v;
  return (item && item.version) || null;
}

// 带宽采样兜底：若 last_second 字段缺失，用计数器差值计算速率
let lastSample = { at: 0, sent: 0, received: 0 };

function computeRates(server) {
  const now = Date.now();
  const sent = Number(server.connection_bandwidth_sent || server.bandwidth_sent || 0);
  const received = Number(server.connection_bandwidth_received || server.bandwidth_received || 0);
  let sentRate = 0;
  let receivedRate = 0;
  if (lastSample.at && sent >= lastSample.sent && received >= lastSample.received) {
    const dt = (now - lastSample.at) / 1000;
    if (dt > 0) {
      sentRate = ((sent - lastSample.sent) * 8) / 1000 / dt; // Kbit/s
      receivedRate = ((received - lastSample.received) * 8) / 1000 / dt;
    }
  }
  lastSample = { at: now, sent, received };
  return { sentRate, receivedRate };
}

function mapClient(c, info) {
  const clid = Number(c.clid);
  // TS3（实测）：两者均为毫秒，connection_connected_time 是已连接时长
  const toSec = (v) => (v == null || v === '' ? null : Math.max(0, Math.floor(Number(v) / 1000)));
  const connectedSec = (v) => {
    const n = Number(v);
    if (!v || !Number.isFinite(n) || n <= 0) return null;
    return Math.max(0, Math.floor(n / 1000));
  };
  const rawIdle = (info && info.client_idle_time != null) ? info.client_idle_time
    : (c.client_idle_time != null ? c.client_idle_time : null);
  const rawConnected = (info && info.connection_connected_time != null) ? info.connection_connected_time
    : (c.connection_connected_time != null ? c.connection_connected_time : null);
  return {
    clid,
    cid: Number(c.cid),
    nickname: c.client_nickname || '?',
    uid: c.client_unique_identifier || '',
    country: c.client_country || '',
    ping: c.connection_ping != null ? c.connection_ping : c.client_ping,
    connected_seconds: smoothConnected(clid, connectedSec(rawConnected)),
    idle_seconds: smoothIdle(clid, toSec(rawIdle)),
    away: c.client_away === 1 || c.client_away === '1',
    is_query: String(c.client_type) === '1',
  };
}

function mapChannel(ch) {
  return {
    cid: Number(ch.cid),
    pid: Number(ch.pid || 0),
    order: Number(ch.channel_order || 0),
    name: ch.channel_name || '',
    topic: ch.channel_topic || '',
    max_clients: Number(ch.channel_maxclients != null ? ch.channel_maxclients : -1),
    has_password: ch.channel_flag_password === 1 || ch.channel_flag_password === '1',
    is_permanent: ch.channel_flag_permanent === 1 || ch.channel_flag_permanent === '1',
    clients: Number(ch.clients != null ? ch.clients : 0),
    total_clients: Number(ch.total_clients || 0),
  };
}

// ---------- 历史指标（采样器数据） ----------
router.get('/history', async (req, res, next) => {
  try {
    const minutes = Math.min(Math.max(parseInt(req.query.minutes, 10) || 60, 5), 7 * 24 * 60);
    const metrics = require('../metrics');
    res.json({ ok: true, data: { points: metrics.history(minutes), minutes } });
  } catch (err) { next(err); }
});

// ---------- 最近加入用户（退出后仍保留） ----------
router.get('/recent-clients', async (req, res, next) => {
  try {
    const metrics = require('../metrics');
    res.json({ ok: true, data: { clients: metrics.recent() } });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const sid = parseInt(req.query.sid, 10) || 1;
    const safe = (p, label) => p.catch((e) => { console.warn(`[overview] ${label} 失败:`, e.message); return null; });
    const [version, server, connInfo, clients, channels] = await Promise.all([
      safe(ts.version(), 'version'),
      safe(ts.serverinfo(sid), 'serverinfo'),
      safe(ts.connectionInfo(sid), 'connectionInfo'),
      safe(ts.clientlist(sid).then((v) => v || []), 'clientlist'),
      safe(ts.channellist(sid).then((v) => v || []), 'channellist'),
    ]);

    if (!server) {
      return res.json({
        ok: true,
        data: {
          connected: false,
          version: pickVersion(version),
          server: null,
          clients: [],
          channels: [],
          error: '无法获取服务器信息（服务器可能离线或查询密码未配置/错误）',
        },
      });
    }

    const channelById = new Map(channels.map(c => [Number(c.cid), c]));

    // TS3 的 clientlist 不带连接时长，需对每个语音用户补一次 clientinfo
    const voiceClients = clients.filter(c => String(c.client_type) !== '1');
    const infos = await Promise.all(voiceClients.map(c =>
      ts.clientinfo(sid, Number(c.clid)).catch(() => null)
    ));
    const infoByClid = new Map();
    voiceClients.forEach((c, i) => {
      if (infos[i]) infoByClid.set(Number(c.clid), infos[i]);
    });

    // 每秒带宽（字节/秒 -> Kbit/s）
    let sentRate = 0;
    let receivedRate = 0;
    if (connInfo) {
      sentRate = (Number(connInfo.connection_bandwidth_sent_last_second_total) || 0) * 8 / 1000;
      receivedRate = (Number(connInfo.connection_bandwidth_received_last_second_total) || 0) * 8 / 1000;
    }
    if (!sentRate && !receivedRate) {
      const rates = computeRates(server);
      sentRate = rates.sentRate;
      receivedRate = rates.receivedRate;
    }

    // TS3 channellist 的 total_clients 含 Query 客户端，按 clientlist 统计真实人数
    const countByCid = new Map();
    for (const c of clients) {
      const cid = Number(c.cid);
      countByCid.set(cid, (countByCid.get(cid) || 0) + 1);
    }
    const mappedClients = clients.map(c => {
      const m = mapClient(c, infoByClid.get(Number(c.clid)));
      m.channel_name = (channelById.get(m.cid) || {}).channel_name || '';
      return m;
    });
    for (const ch of channels) {
      ch.clients = countByCid.get(Number(ch.cid)) || 0;
    }

    res.json({
      ok: true,
      data: {
        connected: true,
        version: pickVersion(version),
        server: {
          id: sid,
          name: server.virtualserver_name,
          status: server.virtualserver_status,
          platform: server.virtualserver_platform,
          clients_online: Number(server.virtualserver_clientsonline || 0),
          max_clients: Number(server.virtualserver_maxclients || 0),
          uptime_seconds: Number(server.virtualserver_uptime || 0),
          packetloss: Number(server.virtualserver_total_packetloss_total || 0),
          ping: Number(server.virtualserver_total_ping || 0),
          created_at: Number(server.virtualserver_created || 0),
          // 累计字节/包：TS3 serverinfo 提供 connection_bytes_*_total（会话级）与
          // virtualserver_total_bytes_*（服务器级累计），兼容两种
          bandwidth_sent: Number(server.connection_bytes_sent_total != null ? server.connection_bytes_sent_total : server.virtualserver_total_bytes_uploaded || 0),
          bandwidth_received: Number(server.connection_bytes_received_total != null ? server.connection_bytes_received_total : server.virtualserver_total_bytes_downloaded || 0),
          packets_sent: Number(server.connection_packets_sent_total || 0),
          packets_received: Number(server.connection_packets_received_total || 0),
        },
        bandwidth_sent_rate: sentRate,
        bandwidth_received_rate: receivedRate,
        clients: mappedClients,
        channels: channels.map(mapChannel),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
