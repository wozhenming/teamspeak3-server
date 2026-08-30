'use strict';

/**
 * 播放器状态机 — 每个部署频道一套独立实例。
 *
 * - 队列本身只是歌曲列表；本模块在其上维护 currentId 指针
 * - 进度按时间推算（basePosition + 流逝时间），读取时惰性计算
 * - 歌曲自然播完时按循环模式自动切歌（one 重播 / all 绕回 / off 停止）
 * - 状态持久化到数据卷（player_<key>.json）；服务重启后恢复当前曲目但保持暂停
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const queue = require('./queue');

const LOOP_MODES = ['all', 'one', 'shuffle', 'off'];

class ChannelPlayer {
  constructor(key, chQueue) {
    this.key = key;
    this.queue = chQueue;
    this.file = path.join(config.dataDir, 'player_' + key + '.json');
    this.state = {
      currentId: null,
      basePosition: 0,
      updatedAt: 0,
      playing: false,
      loopMode: 'all',
    };
    // 状态版本号：任何会影响实际出声的操作(播放/暂停/切歌/seek/循环)都自增，
    // 电台流据此感知变化并重启转码进程（如带 -ss 跳转）
    this.rev = 0;
    // 队列变化后校正指针：当前曲目被删则接管它原来位置的下一首，队列空则停止
    this.queue.onChange((removedId) => this.onQueueChanged(removedId));
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state.currentId = raw.currentId != null ? Number(raw.currentId) : null;
        this.state.basePosition = Number(raw.position) || 0;
        this.state.loopMode = LOOP_MODES.includes(raw.loopMode) ? raw.loopMode : 'all';
      }
    } catch (e) { /* 忽略 */ }
    // 重启后不自动续播，停在保存的进度上
    this.state.playing = false;
    this.state.updatedAt = Date.now();
    // 当前曲目已不在队列则丢弃指针
    if (this.state.currentId != null && !this.currentItem()) this.state.currentId = null;
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({
        currentId: this.state.currentId,
        position: Math.round(this.positionSec()),
        playing: this.state.playing,
        loopMode: this.state.loopMode,
      }), 'utf8');
    } catch (e) { /* 忽略 */ }
  }

  currentItem() {
    return this.queue.all().find((i) => Number(i.id) === Number(this.state.currentId)) || null;
  }

  durationOf(item) {
    return item && item.duration > 0 ? item.duration : 0;
  }

  // 有效进度（秒），已按时长截断
  positionSec() {
    if (!this.state.currentId) return 0;
    let pos = this.state.playing
      ? this.state.basePosition + (Date.now() - this.state.updatedAt) / 1000
      : this.state.basePosition;
    const dur = this.durationOf(this.currentItem());
    if (dur > 0 && pos > dur) pos = dur;
    if (pos < 0) pos = 0;
    return pos;
  }

  playItem(id) {
    const item = this.queue.all().find((i) => Number(i.id) === Number(id));
    this.state.currentId = item ? Number(item.id) : null;
    this.state.basePosition = 0;
    this.state.updatedAt = Date.now();
    this.state.playing = !!item;
    this.rev++;
    this.save();
    return this.currentItem();
  }

  stopInternal() {
    this.state.currentId = null;
    this.state.basePosition = 0;
    this.state.updatedAt = Date.now();
    this.state.playing = false;
    this.rev++;
    this.save();
  }

  // 随机取一首（排除当前曲，仅一首时退化为自身）
  pickRandomId(excludeId) {
    const items = this.queue.all();
    if (!items.length) return null;
    const pool = items.filter((i) => Number(i.id) !== Number(excludeId));
    const cand = pool.length ? pool : items;
    return Number(cand[Math.floor(Math.random() * cand.length)].id);
  }

  // dir=1 下一曲 dir=-1 上一曲；到边界时按 wrap 决定绕回或停止
  // 随机模式忽略方向与边界，直接跳到随机曲目（排除当前曲）
  step(dir, wrap) {
    if (this.state.loopMode === 'shuffle') {
      const rid = this.pickRandomId(this.state.currentId);
      if (rid == null) return this.stopInternal();
      return this.playItem(rid);
    }
    const items = this.queue.all();
    if (!items.length) return this.stopInternal();
    const idx = items.findIndex((i) => Number(i.id) === Number(this.state.currentId));
    let nextIdx;
    if (idx === -1) nextIdx = dir > 0 ? 0 : items.length - 1;
    else nextIdx = idx + dir;
    if (nextIdx >= items.length) nextIdx = (wrap || this.state.loopMode === 'all') ? 0 : -1;
    else if (nextIdx < 0) nextIdx = (wrap || this.state.loopMode === 'all') ? items.length - 1 : (idx === -1 ? 0 : idx);
    if (nextIdx < 0 || nextIdx >= items.length) return this.stopInternal();
    return this.playItem(items[nextIdx].id);
  }

  // 自然播完后的自动切换：one 重播当前，shuffle 随机，all 绕回下一首，off 到队尾停止
  autoAdvance() {
    if (!this.state.currentId || !this.state.playing) return;
    const cur = this.currentItem();
    if (!cur) return this.stopInternal();
    const dur = this.durationOf(cur);
    if (dur <= 0) return; // 无时长信息不自动切
    const elapsed = this.state.basePosition + (Date.now() - this.state.updatedAt) / 1000;
    if (elapsed < dur) return;
    if (this.state.loopMode === 'one') this.playItem(cur.id);
    else if (this.state.loopMode === 'shuffle') {
      const rid = this.pickRandomId(cur.id);
      if (rid != null) this.playItem(rid);
    } else this.step(1, this.state.loopMode === 'all');
  }

  // ---------- 对外接口 ----------

  get() {
    this.autoAdvance();
    return {
      current: this.currentItem(),
      position: Math.round(this.positionSec()),
      playing: !!this.state.playing && !!this.currentItem(),
      loopMode: this.state.loopMode,
      queueLength: this.queue.all().length,
      rev: this.rev,
    };
  }

  // 播放指定曲目；不带 id 则继续播放当前/队首
  play(id) {
    if (id != null) return { ...this.get(), current: this.playItem(id), playing: true };
    if (!this.state.currentId) {
      const first = this.queue.all()[0];
      if (!first) return this.get();
      return { ...this.get(), current: this.playItem(first.id), playing: true };
    }
    if (!this.state.playing) {
      this.state.updatedAt = Date.now();
      this.state.playing = true;
      this.rev++;
      this.save();
    }
    return this.get();
  }

  pause() {
    if (!this.state.playing) return this.get();
    this.state.basePosition = this.positionSec();
    this.state.playing = false;
    this.state.updatedAt = Date.now();
    this.rev++;
    this.save();
    return this.get();
  }

  resume() {
    if (this.state.playing) return this.get();
    if (!this.state.currentId) return this.play();
    this.state.basePosition = this.positionSec();
    this.state.updatedAt = Date.now();
    this.state.playing = true;
    this.rev++;
    this.save();
    return this.get();
  }

  toggle() {
    return this.state.playing ? this.pause() : this.resume();
  }

  // 跳转到指定秒数
  seek(sec) {
    if (!this.state.currentId) return this.get();
    const dur = this.durationOf(this.currentItem());
    let pos = Number(sec);
    if (!Number.isFinite(pos)) pos = 0;
    if (dur > 0) pos = Math.min(pos, dur);
    if (pos < 0) pos = 0;
    this.state.basePosition = pos;
    this.state.updatedAt = Date.now();
    this.rev++;
    this.save();
    return this.get();
  }

  // 手动切歌：one/all 模式到边界绕回，off 模式到边界停止
  next() { this.step(1, this.state.loopMode !== 'off'); return this.get(); }
  prev() { this.step(-1, this.state.loopMode !== 'off'); return this.get(); }

  setLoop(mode) {
    if (!LOOP_MODES.includes(mode)) return this.get();
    // 注意：循环模式只影响“播完后的切歌方式”，不改变当前出声，
    // 因此这里绝不能 bump rev（否则电台流会被无谓重启，产生电音毛刺）
    if (this.state.loopMode !== mode) { this.state.loopMode = mode; this.save(); }
    return this.get();
  }

  // 队列变化后校正指针：当前曲目被删则接管它原来位置的下一首，队列空则停止
  onQueueChanged(removedId) {
    if (removedId == null) { this.stopInternal(); return; }
    if (Number(removedId) !== Number(this.state.currentId)) return;
    const items = this.queue.all();
    if (!items.length) return this.stopInternal();
    const fallback = items.find((i) => Number(i.id) !== Number(removedId));
    if (!fallback) return this.stopInternal();
    if (this.state.playing) this.playItem(fallback.id);
    else {
      this.state.currentId = Number(fallback.id);
      this.state.basePosition = 0;
      this.rev++;
      this.save();
    }
  }
}

const players = new Map(); // key -> ChannelPlayer

function forChannel(chPath) {
  const key = queue.channelKey(chPath);
  if (!players.has(key)) {
    const p = new ChannelPlayer(key, queue.forChannel(chPath));
    p.load();
    players.set(key, p);
  }
  return players.get(key);
}

module.exports = { forChannel };
