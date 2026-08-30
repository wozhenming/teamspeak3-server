'use strict';

/**
 * /api/servers/:sid/clients — 用户管理
 *   GET    /                      在线用户列表（含频道名）
 *   POST   /:clid/kick            踢出 { reason, from: server|channel }
 *   POST   /:clid/ban             封禁 { reason, time 分钟, ipban }
 *   POST   /:clid/move            移动到频道 { cid }
 *   POST   /:clid/poke            Poke { msg }
 *   POST   /:clid/message         私聊 { msg }
 */

const express = require('express');
const { ts } = require('../ts3query');
const { smoothIdle, smoothConnected } = require('../utils/smooth');
const usersDb = require('../users-db');

const router = express.Router({ mergeParams: true });

function sidOf(req) {
  return parseInt(req.params.sid, 10) || 1;
}

function mapClient(c, info) {
  const clid = Number(c.clid);
  // TS3 查询接口的时间字段（实测 3.13.8）：client_idle_time 与
  // connection_connected_time 都是毫秒——后者是【已连接时长】而非时间戳
  const toSec = (v) => (v == null || v === '' ? null : Math.max(0, Math.floor(Number(v) / 1000)));
  const connectedSec = (v) => {
    const n = Number(v);
    if (!v || !Number.isFinite(n) || n <= 0) return null;
    return Math.max(0, Math.floor(n / 1000));
  };
  const rawIdle = (info && info.client_idle_time != null)
    ? info.client_idle_time
    : (c.client_idle_time != null ? c.client_idle_time : null);
  const rawConnected = (info && info.connection_connected_time != null)
    ? info.connection_connected_time
    : (c.connection_connected_time != null ? c.connection_connected_time : null);
  return {
    clid,
    cid: Number(c.cid),
    nickname: c.client_nickname || '?',
    uid: c.client_unique_identifier || '',
    country: c.client_country || '',
    // TS3 查询接口不提供单用户 Ping（官方文档无此字段），故不返回
    connected_seconds: smoothConnected(clid, connectedSec(rawConnected)),
    idle_seconds: smoothIdle(clid, toSec(rawIdle)),
    away: c.client_away === 1 || c.client_away === '1',
    is_query: String(c.client_type) === '1',
  };
}

// 用户管理：返回所有用户（在线 + 离线历史），在线用户可操作，离线用户仅查看
router.get('/', async (req, res, next) => {
  try {
    const sid = sidOf(req);
    const [clients, channels] = await Promise.all([ts.clientlist(sid), ts.channellist(sid)]);
    const channelById = new Map(channels.map(c => [Number(c.cid), c]));

    // 连接时长等扩展字段来自 clientinfo（clientlist -times 只提供 idle/created/lastconnected）
    const voiceClients = clients.filter(c => String(c.client_type) !== '1');
    const infos = await Promise.all(voiceClients.map(c =>
      ts.clientinfo(sid, Number(c.clid)).catch(() => null)
    ));
    const infoByClid = new Map();
    voiceClients.forEach((c, i) => {
      if (infos[i]) infoByClid.set(Number(c.clid), infos[i]);
    });

    // 在线用户
    const onlineList = clients.map(c => {
      const m = mapClient(c, infoByClid.get(Number(c.clid)));
      m.channel_name = (channelById.get(m.cid) || {}).channel_name || '';
      m.online = true;
      return m;
    });

    // 离线用户（从历史数据库）
    const onlineUids = new Set(clients.map(c => c.client_unique_identifier).filter(Boolean));
    const offlineUsers = usersDb.getAllUsers()
      .filter((u) => !onlineUids.has(u.uid))
      .map((u) => ({
        clid: null,
        cid: null,
        nickname: u.nickname,
        uid: u.uid,
        country: u.country || '',
        channel_name: '',
        connected_seconds: null,
        idle_seconds: null,
        away: false,
        is_query: false,
        online: false,
        last_seen: u.last_seen,
        total_connections: u.total_connections,
      }));

    res.json({ ok: true, data: { clients: onlineList, offline_users: offlineUsers } });
  } catch (err) {
    next(err);
  }
});

router.post('/:clid/kick', async (req, res, next) => {
  try {
    const { reason = '', from = 'server' } = req.body || {};
    await ts.kick(sidOf(req), parseInt(req.params.clid, 10), { reason, from });
    res.json({ ok: true, data: { kicked: true } });
  } catch (err) { next(err); }
});

router.post('/:clid/ban', async (req, res, next) => {
  try {
    const { reason = '', time = 0, ipban = false } = req.body || {};
    // 面板 UI 以“分钟”为单位，banclient 的 time 单位为秒
    const minutes = parseInt(time, 10);
    const seconds = isNaN(minutes) || minutes <= 0 ? 0 : minutes * 60;
    await ts.ban(sidOf(req), parseInt(req.params.clid, 10), { reason, time: seconds, ipban });
    res.json({ ok: true, data: { banned: true } });
  } catch (err) { next(err); }
});

router.post('/:clid/move', async (req, res, next) => {
  try {
    const { cid } = req.body || {};
    if (!cid) throw Object.assign(new Error('缺少目标频道 cid'), { status: 400 });
    await ts.move(sidOf(req), parseInt(req.params.clid, 10), parseInt(cid, 10));
    res.json({ ok: true, data: { moved: true } });
  } catch (err) { next(err); }
});

router.post('/:clid/poke', async (req, res, next) => {
  try {
    const { msg = '' } = req.body || {};
    if (!msg) throw Object.assign(new Error('缺少 Poke 消息'), { status: 400 });
    await ts.poke(sidOf(req), parseInt(req.params.clid, 10), msg);
    res.json({ ok: true, data: { poked: true } });
  } catch (err) { next(err); }
});

router.post('/:clid/message', async (req, res, next) => {
  try {
    const { msg = '' } = req.body || {};
    if (!msg) throw Object.assign(new Error('缺少消息内容'), { status: 400 });
    await ts.sendTextMessage(sidOf(req), parseInt(req.params.clid, 10), msg);
    res.json({ ok: true, data: { sent: true } });
  } catch (err) { next(err); }
});

module.exports = router;
