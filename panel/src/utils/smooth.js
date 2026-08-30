'use strict';

/**
 * 单调计数器快照平滑 v2（查询接口公共工具）。
 *
 * 实测查询接口的 client_idle_time / connection_connected_time 均为周期性快照：
 *  - 两次快照之间数值原地不动（旧算法 min(raw, est) 会因此“冻结”显示）；
 *  - 偶发正向抽风跳变（实测 idle 3 秒内 +3000 秒）；
 *  - 重连/用户活动会向下重置。
 *
 * v2 规则（本地单调时钟为主，快照仅用于校准）：
 *  - 无历史 → 直接采用 raw；
 *  - raw 明显小于当前值（重连/活动重置）→ 直接采用 raw；
 *  - raw 远超「当前值 + 真实流逝」的可信上限（计数器抽风）→ 忽略该样本，继续自走；
 *  - 其余样本 → 展示 max(自走值, raw)：快照滞后不回退（消除冻结），快照超前则校准。
 */

const counterCache = new Map(); // key -> { value, at }

function smoothCounter(key, raw) {
  const now = Date.now();
  if (raw == null || raw === '') {
    counterCache.delete(key);
    return null;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    counterCache.delete(key);
    return null;
  }
  const prev = counterCache.get(key);
  if (!prev) {
    counterCache.set(key, { value: seconds, at: now });
    return seconds;
  }
  const elapsed = Math.max(0, Math.floor((now - prev.at) / 1000));
  const ticked = prev.value + elapsed; // 本地时钟自走值

  // 重置（重连/活动）：明显回落 → 直接采用
  const resetEps = Math.max(5, Math.floor(prev.value * 0.02));
  if (seconds < prev.value - resetEps) {
    counterCache.set(key, { value: seconds, at: now });
    return seconds;
  }

  // 可疑正向跳变：超出可信上限 → 忽略样本，按本地时钟继续
  const maxPlausible = ticked + Math.max(60, Math.floor(ticked * 0.1));
  if (seconds > maxPlausible) {
    counterCache.set(key, { value: ticked, at: now });
    return ticked;
  }

  // 正常样本：不回退、不冻结；快照略超前时顺势校准
  const shown = Math.max(ticked, seconds);
  counterCache.set(key, { value: shown, at: now });
  return shown;
}

// idle 与连接时长分别计数（同一 clid 两个计数器，用前缀区分）
const smoothIdle     = (clid, raw) => smoothCounter('i:' + clid, raw);
const smoothConnected = (clid, raw) => smoothCounter('c:' + clid, raw);

module.exports = { smoothCounter, smoothIdle, smoothConnected };
