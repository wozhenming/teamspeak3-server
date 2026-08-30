'use strict';

/**
 * /api/stats — 数据统计
 *   GET /overview      汇总统计（总用户/总连接/平均时长/峰值在线）
 *   GET /connections   连接记录列表（最新在前）
 */

const express = require('express');
const usersDb = require('../users-db');
const metrics = require('../metrics');

const router = express.Router();

router.get('/overview', (req, res, next) => {
  try {
    const stats = usersDb.getStats();
    const historyPoints = metrics.history(60); // 最近 1 小时图表数据
    res.json({ ok: true, data: { ...stats, recent_points: historyPoints } });
  } catch (err) { next(err); }
});

router.get('/connections', (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
    const allUsers = usersDb.getAllUsers();
    const onlineUids = usersDb.getOnlineUids();
    const connections = usersDb.getConnections(limit);

    res.json({
      ok: true,
      data: {
        users: allUsers.map((u) => ({
          ...u,
          is_online: onlineUids.has(u.uid),
        })),
        connections,
        stats: usersDb.getStats(),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
