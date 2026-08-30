'use strict';

/**
 * /api/servers — 虚拟服务器
 *   GET /         服务器列表（顶部下拉框）
 *   PUT /:sid     编辑服务器（白名单字段，当前仅支持名称）
 *
 * 实例级命令 serverlist 字段：virtualserver_id / _name / _status / _clientsonline / _maxclients / _uptime
 */

const express = require('express');
const { ts } = require('../ts3query');

const router = express.Router({ mergeParams: true });

router.get('/', async (req, res, next) => {
  try {
    const list = await ts.serverlist();
    const servers = (Array.isArray(list) ? list : []).map(s => ({
      id: Number(s.virtualserver_id),
      name: s.virtualserver_name || '',
      status: s.virtualserver_status || '',
      clients_online: Number(s.virtualserver_clientsonline || 0),
      max_clients: Number(s.virtualserver_maxclients || 0),
      uptime_seconds: Number(s.virtualserver_uptime || 0),
    }));
    res.json({ ok: true, data: servers });
  } catch (err) {
    next(err);
  }
});

// 可编辑字段白名单（最小权限：仅开放名称）
const EDITABLE_FIELDS = new Set(['virtualserver_name']);

router.put('/:sid', async (req, res, next) => {
  try {
    const sid = parseInt(req.params.sid, 10) || 1;
    const opts = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      if (EDITABLE_FIELDS.has(key)) opts[key] = String(value).trim();
    }
    if (!opts.virtualserver_name) {
      throw Object.assign(new Error('服务器名称不能为空'), { status: 400 });
    }
    await ts.editServer(sid, opts);
    res.json({ ok: true, data: { edited: true, name: opts.virtualserver_name } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
