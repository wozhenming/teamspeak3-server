'use strict';

/**
 * /api/servers/:sid/channels — 频道管理
 *   GET     /             频道列表（含在线用户数与成员）
 *   POST    /             创建频道 { name, parent_cid, order, max_clients, password, topic }
 *   PUT     /:cid         编辑频道（名称/主题/密码/最大用户/排序）
 *   DELETE  /:cid         删除频道（force=1）
 */

const express = require('express');
const { ts } = require('../ts3query');
const { smoothIdle } = require('../utils/smooth');

const router = express.Router({ mergeParams: true });

function sidOf(req) {
  return parseInt(req.params.sid, 10) || 1;
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

router.get('/', async (req, res, next) => {
  try {
    const sid = sidOf(req);
    const [rawChannels, clients] = await Promise.all([ts.channellist(sid), ts.clientlist(sid)]);
    // 频道在线人数：TS3 channellist 的 total_clients 含 Query 客户端，
    // 直接按 clientlist 统计每个频道的客户端数最稳妥。
    const countByCid = new Map();
    for (const c of clients) {
      const cid = Number(c.cid);
      countByCid.set(cid, (countByCid.get(cid) || 0) + 1);
    }
    const channels = rawChannels.map(ch => {
      const m = mapChannel(ch);
      m.clients = countByCid.get(Number(ch.cid)) || 0;
      m.total_clients = m.clients;
      return m;
    });
    // TS3 的 client_idle_time 单位为毫秒，需转秒；并记录是否为 Query 客户端
    const mappedClients = clients.map(c => ({
      clid: Number(c.clid),
      cid: Number(c.cid),
      nickname: c.client_nickname || '?',
      is_query: String(c.client_type) === '1',
      idle_seconds: smoothIdle(Number(c.clid), c.client_idle_time != null ? Math.floor(Number(c.client_idle_time) / 1000) : null),
    }));
    res.json({ ok: true, data: { channels, clients: mappedClients } });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, parent_cid = 0, order = 0, max_clients = -1, password, topic } = req.body || {};
    if (!name || !String(name).trim()) {
      throw Object.assign(new Error('频道名称不能为空'), { status: 400 });
    }
    const body = await ts.createChannel(sidOf(req), {
      name: String(name).trim(),
      parent_cid,
      order,
      max_clients,
      password: password || undefined,
      topic: topic || undefined,
    });
    // channelcreate 返回 { cid } 或 [{ cid }]
    const arr = Array.isArray(body) ? body : [body];
    const cid = arr[0] && (arr[0].cid != null ? Number(arr[0].cid) : null);
    res.json({ ok: true, data: { cid } });
  } catch (err) { next(err); }
});

router.put('/:cid', async (req, res, next) => {
  try {
    const { name, topic, password, max_clients, order } = req.body || {};
    const opts = {};
    if (name !== undefined) opts.name = String(name).trim();
    if (topic !== undefined) opts.topic = topic;
    if (password !== undefined) opts.password = password || undefined;
    if (max_clients !== undefined) opts.max_clients = parseInt(max_clients, 10);
    if (order !== undefined) opts.order = parseInt(order, 10);
    await ts.editChannel(sidOf(req), parseInt(req.params.cid, 10), opts);
    res.json({ ok: true, data: { edited: true } });
  } catch (err) { next(err); }
});

router.delete('/:cid', async (req, res, next) => {
  try {
    await ts.deleteChannel(sidOf(req), parseInt(req.params.cid, 10));
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

module.exports = router;
