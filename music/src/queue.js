'use strict';

/**
 * 点歌队列 — 每个部署频道一套独立队列（内存 + 持久化到数据卷）。
 * 网易云账号全局共享，队列按频道路径隔离：queue_<key>.json。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

// 频道路径 → 安全文件名 key（保留中英文数字，其余转 _，追加哈希防碰撞）
function channelKey(chPath) {
  const clean = String(chPath || '').trim() || 'default';
  const s = clean.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '_').slice(0, 40);
  return s + '_' + crypto.createHash('md5').update(clean).digest('hex').slice(0, 6);
}

class ChannelQueue {
  constructor(key) {
    this.key = key;
    this.file = path.join(config.dataDir, 'queue_' + key + '.json');
    this.seq = 1;
    this.items = []; // { id, title, artists, album, cover, duration, requestedBy, requestedAt }
    this.listeners = [];
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(arr)) {
        this.items = arr.filter((i) => i && i.id);
        this.seq = this.items.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0) + 1;
      }
    } catch (e) { /* 忽略 */ }
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.items), 'utf8');
    } catch (e) { /* 忽略 */ }
  }

  all() {
    return this.items;
  }

  enqueue(song, requestedBy) {
    const item = {
      id: this.seq++,
      songId: song.songId || song.id || null, // 网易云真实歌曲 ID（取直链必需，勿丢！）
      title: song.name,
      artists: song.artists || '',
      album: song.album || '',
      cover: song.cover || '',
      duration: song.duration || 0,
      fee: song.fee != null ? song.fee : null, // 版权：0免费 1VIP 4购专辑 8非会员可听低音质
      requestedBy: requestedBy || 'panel',
      requestedAt: Date.now(),
    };
    this.items.push(item);
    this.save();
    return item;
  }

  // 批量入队（歌单全量加入），返回新增条目数组
  enqueueMany(songs, requestedBy) {
    const added = (Array.isArray(songs) ? songs : [])
      .filter((s) => s && s.id && s.name)
      .map((song) => ({
        id: this.seq++,
        songId: song.songId || song.id || null, // 网易云真实歌曲 ID
        title: song.name,
        artists: song.artists || '',
        album: song.album || '',
        cover: song.cover || '',
        duration: song.duration || 0,
        fee: song.fee != null ? song.fee : null,
        requestedBy: requestedBy || 'panel',
        requestedAt: Date.now(),
      }));
    if (added.length) {
      this.items.push(...added);
      this.save();
    }
    return added;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => Number(i.id) !== Number(id));
    const removed = this.items.length !== before;
    if (removed) {
      this.save();
      this.emitChange(id);
    }
    return removed;
  }

  clear() {
    const had = this.items.length > 0;
    this.items = [];
    this.save();
    if (had) this.emitChange(null);
  }

  // 队列变化监听（播放器据此校正"当前播放"指针）
  onChange(cb) {
    if (typeof cb === 'function') this.listeners.push(cb);
  }
  emitChange(removedId) {
    for (const cb of this.listeners) {
      try { cb(removedId); } catch (e) { /* 忽略 */ }
    }
  }
}

const queues = new Map(); // key -> ChannelQueue

function forChannel(chPath) {
  const key = channelKey(chPath);
  if (!queues.has(key)) {
    const q = new ChannelQueue(key);
    q.load();
    queues.set(key, q);
  }
  return queues.get(key);
}

// 旧版单队列迁移：把 queue.json 挪到第一个部署频道的队列（仅当目标队列尚无数据时执行一次）
function migrateLegacy(firstChannel) {
  try {
    const legacyFile = path.join(config.dataDir, 'queue.json');
    if (!fs.existsSync(legacyFile)) return;
    const target = forChannel(firstChannel);
    if (target.items.length) return; // 已有数据，不动
    const arr = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    if (!Array.isArray(arr) || !arr.length) return;
    target.items = arr.filter((i) => i && i.id);
    target.seq = target.items.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0) + 1;
    target.save();
    fs.renameSync(legacyFile, legacyFile + '.migrated');
    console.log('[queue] 已把旧版队列 ' + arr.length + ' 首迁移到频道「' + firstChannel + '」');
  } catch (e) { /* 迁移失败不影响启动 */ }
}

module.exports = { forChannel, channelKey, migrateLegacy, ChannelQueue };
