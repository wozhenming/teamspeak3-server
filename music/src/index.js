'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { config } = require('./config');
const enhanced = require('./enhanced');
const queueMod = require('./queue');
const playerMod = require('./player');
const tsbridge = require('./tsbridge');
const tschat = require('./tschat');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

function ok(res, data) {
  res.json({ ok: true, data });
}
function fail(res, status, code, message) {
  res.status(status).json({ ok: false, error: { code, message } });
}

// 解析请求目标频道：query/body 的 ch 必须在已配置部署频道里，缺省取第一个。
// 未配置任何频道返回 null（调用方返回 400）。
function chOf(req) {
  const channels = tsbridge.configChannels();
  const want = String((req.query && req.query.ch) || (req.body && req.body.ch) || '').trim();
  if (want && channels.includes(want)) return want;
  return channels[0] || null;
}

// ---------- 图片代理（绕过网易云外链防盗链 / 混合内容限制） ----------
const IMG_HOSTS = ['.music.126.net', '.music.163.com'];
app.get('/api/img', async (req, res) => {
  const u = req.query.u;
  if (!u || typeof u !== 'string') return res.status(400).send('missing u');
  let target;
  try { target = new URL(u); } catch (e) { return res.status(400).send('bad url'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return res.status(400).send('bad protocol');
  if (!IMG_HOSTS.some((h) => target.hostname.endsWith(h))) return res.status(400).send('blocked host');

  // 抓取图片（带超时 + 跟随重定向 + 伪装 Referer 绕过防盗链）。失败返回 null。
  const fetchImage = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { Referer: 'https://music.126.net/', 'User-Agent': 'Mozilla/5.0' },
      });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return { buf, contentType: r.headers.get('content-type') || 'image/jpeg' };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const sendImage = (r) => {
    res.set('Content-Type', r.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(r.buf);
  };

  // 1) 优先走上游图片代理（neteasemusic 容器出口，规避本容器无外网）；
  // 2) 代理失败则本服务直接抓取兜底（部分环境本容器亦可达外网）。
  if (config.imgProxy) {
    const upstream = config.imgProxy.replace(/\/$/, '') + '/?u=' + encodeURIComponent(target.toString());
    const r = await fetchImage(upstream);
    if (r) return sendImage(r);
  }
  const direct = await fetchImage(target.toString());
  if (direct) return sendImage(direct);
  return res.status(502).send('img fetch failed');
});

// ---------- 连续电台流（供 TS3AudioBot 语音引擎作为电台源拉流） ----------
// 把对应频道的点歌队列当作“网络电台”持续输出：逐首解析网易云直链并管道输出，
// 一曲结束后自动下一首；用户在面板/频道聊天切歌/暂停时本流自动跟随。
// 每个部署频道一路独立流：/api/stream?ch=<频道路径>（队列/播放器按频道隔离）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const songIdCache = {}; // <频道key>:<队列条目id> -> 网易云歌曲 id（旧数据自愈用）
const urlCache = new Map(); // 网易云歌曲 id -> { url, at }（直链缓存，账号全局共享，避免 seek/恢复时反复请求）
const URL_TTL = 8 * 60 * 1000;
let SILENCE_BUF = null; // 预生成的静音 MP3（约2秒，32kbps），暂停/空闲直接回放，零延迟零毛刺

function generateSilence() {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const chunks = [];
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-f', 'lavfi', '-i', 'anullsrc=r=' + config.audioRate + ':cl=stereo',
      '-acodec', config.audioCodec, '-b:a', '32k', '-ar', String(config.audioRate), '-t', '2',
      '-f', config.audioCodec === 'libopus' ? 'opus' : 'mp3', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', () => resolve(null));
    ff.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
  });
}

// 探测音频真实可播时长（试听片段/版权截断的文件本身较短，元数据时长不准）
function probeDuration(input) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 10000);
    p.stdout.on('data', (c) => { out += c.toString(); });
    p.on('error', () => { clearTimeout(t); resolve(0); });
    p.on('close', () => { clearTimeout(t); const v = parseFloat(out.trim()); resolve(Number.isFinite(v) && v > 0 ? v : 0); });
  });
}

app.get('/api/stream', async (req, res) => {
  // 简单令牌校验：若配置了 STREAM_TOKEN，则电台 URL 必须带 ?t= 且匹配，避免公网被随意收听
  if (config.streamTokenEnabled && config.streamToken && req.query.t !== config.streamToken) {
    return res.status(403).end('forbidden');
  }
  const ch = chOf(req);
  if (!ch) return res.status(404).end('no channel configured');
  const player = playerMod.forChannel(ch);
  const queue = queueMod.forChannel(ch);
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'no-cache');
  res.set('Connection', 'keep-alive');
  res.set('Transfer-Encoding', 'chunked');
  res.flushHeaders && res.flushHeaders();

  const { spawn } = require('child_process');
  let closed = false;
  req.on('close', () => { closed = true; });

  const pipeFf = (ff, isDone, setPumping) => new Promise((resolve) => {
    let finished = false;
    let started = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(iv);
      try { ff.kill('SIGKILL'); } catch (e) {}
      if (setPumping) setPumping(false);
      resolve();
    };
    // 状态变化（seek/暂停/切歌）时必须真正终止当前转码进程，否则 pump 会卡死
    const iv = setInterval(() => { if (isDone()) finish(); }, 300);
    ff.stdout.on('data', (chunk) => {
      if (!started) { started = true; if (setPumping) setPumping(true); }
      if (isDone()) return finish();
      if (!res.write(chunk)) {
        ff.stdout.pause();
        res.once('drain', () => { if (!isDone()) ff.stdout.resume(); });
      }
    });
    ff.on('error', () => finish());
    ff.on('close', () => finish());
    req.on('close', () => finish());
  });

  // 过渡垫片：切歌/暂停/恢复边界先补一小段干净静音帧，
  // 掩盖被 SIGKILL 的 ffmpeg 留下的半截 MP3 帧（否则解码器会出“电音”杂音）
  const padSilence = async (ms) => {
    if (!SILENCE_BUF) return;
    const bytes = Math.max(64, Math.ceil(ms / 1000 * 4000)); // 32kbps ≈ 4KB/s
    let written = 0, pos = 0;
    while (written < bytes && !closed && !res.writableEnded) {
      const n = Math.min(1024, bytes - written, SILENCE_BUF.length - pos);
      const okWrite = res.write(SILENCE_BUF.subarray(pos, pos + n));
      pos = (pos + n) % SILENCE_BUF.length;
      written += n;
      if (!okWrite) await new Promise((r) => res.once('drain', r));
    }
  };

  const pump = async () => {
    let failCount = 0;
    let pumping = false;          // ffmpeg 正在出声（转码中）
    let fillerPos = 0;
    // 持续静音垫片：任何非出声时段都补静音，杜绝流中断导致 TS3AudioBot 判定
    // “Queue empty — playback stopped” 而停播/断开点歌机器人（含切歌、队列空、暂停边界）。
    const filler = setInterval(() => {
      if (closed || res.writableEnded) { clearInterval(filler); return; }
      if (pumping || !SILENCE_BUF) return;
      const end = Math.min(fillerPos + 1024, SILENCE_BUF.length);
      const okWrite = res.write(SILENCE_BUF.subarray(fillerPos, end));
      fillerPos = (end >= SILENCE_BUF.length) ? 0 : end;
      if (!okWrite) res.once('drain', () => {});
    }, 200);
    try {
      while (!closed) {
        let st = player.get();
        if (!st.current) {
          if (queue.all().length) { player.play(); st = player.get(); }
          else { failCount = 0; await sleep(200); continue; }
        }
        if (!st.playing) { failCount = 0; await sleep(200); continue; }

        const cur = st.current;
        const curKey = cur.id; // 本流内曲目同一性标识（与 player 状态比较用）
        const cacheKey = queueMod.channelKey(ch) + ':' + cur.id; // songIdCache 按频道命名空间，避免不同频道队列 id 撞车
        // 取网易云真实歌曲 ID：新条目存了 songId；旧持久化条目按“标题+歌手”搜索自愈
        let neteaseId = cur.songId || songIdCache[cacheKey] || null;
        if (!neteaseId) {
          try {
            const kw = [cur.title, cur.artists].filter(Boolean).join(' ');
            const r = kw ? await enhanced.search(kw, 'song', 1, 0) : null;
            const first = r && r.songs && r.songs[0];
            if (first) { songIdCache[cacheKey] = first.id; neteaseId = first.id; }
          } catch (e) { /* 搜索失败走跳过 */ }
        }

        let audioUrl = '';
        if (neteaseId) {
          const cached = urlCache.get(neteaseId);
          if (cached && cached.url && Date.now() - cached.at < URL_TTL) {
            audioUrl = cached.url;
          } else {
            try {
              const r = await Promise.race([
                enhanced.songUrl(neteaseId),
                new Promise((_r, rej) => setTimeout(() => rej(new Error('songUrl 超时')), 8000)),
              ]);
              audioUrl = (r && r.url) || '';
            } catch (e) { audioUrl = ''; }
          }
        }
        // 灰色/无版权歌曲：走 UnblockNeteaseMusic 解灰兜底
        if (!audioUrl && neteaseId) {
          try {
            const m = await Promise.race([
              enhanced.songUrlMatch(neteaseId),
              new Promise((_r, rej) => setTimeout(() => rej(new Error('解灰超时')), 10000)),
            ]);
            audioUrl = (m && m.url) || '';
            if (audioUrl) console.log('[stream] 已解灰播放 id=' + neteaseId + ' title=' + (cur.title || '?'));
          } catch (e) { audioUrl = ''; }
        }
        if (audioUrl) urlCache.set(neteaseId, { url: audioUrl, at: Date.now() });
        if (!audioUrl) {
          failCount++;
          // 顺手查一下不可播原因（仅日志用，失败不影响流程）
          let reason = '';
          try {
            const c = await Promise.race([
              enhanced.checkMusic(neteaseId),
              new Promise((_r, rej) => setTimeout(() => rej(new Error('超时')), 5000)),
            ]);
            if (c && c.success === false) reason = ' (' + (c.message || '暂无版权') + ')';
          } catch (e) { /* 忽略 */ }
          console.log('[stream] 拿不到歌曲直链(title=' + (cur.title || '?') + ', id=' + neteaseId + ')' + reason + '，切下一首 #' + failCount);
          player.next();
          await sleep(failCount > 3 ? 5000 : 500);
          continue;
        }
        failCount = 0;

        // 经 neteasemusic 出口代理抓取音频（music-bot 可能无外网）
        const input = config.imgProxy
          ? config.imgProxy.replace(/\/$/, '') + '/?u=' + encodeURIComponent(audioUrl)
          : audioUrl;

        // 从当前进度起播（seek/恢复播放时 >0），-ss 走输入端快速跳转
        const startPos = Math.max(0, Math.floor(player.get().position) || 0);
        // 先垫一小段干净静音，掩盖上一段被终止的半截帧
        await padSilence(startPos > 0 ? 250 : 150);
        if (closed) break;
        const ffArgs = ['-re', '-protocol_whitelist', 'file,http,https,tcp,pipe'];
        if (startPos > 0) ffArgs.push('-ss', String(startPos));
        ffArgs.push('-i', input, '-acodec', config.audioCodec, '-b:a', config.audioBitrate, '-ar', String(config.audioRate), '-ac', String(config.audioChannels), '-f', config.audioCodec === 'libopus' ? 'opus' : 'mp3', '-');
        const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        const revAtStart = player.get().rev;
        let errTail = '';
        ff.stderr.on('data', (d) => { if (errTail.length < 2000) errTail += d.toString(); });
        ff.on('close', (code) => {
          const nowCur = player.get().current;
          const interrupted = closed || !nowCur || nowCur.id !== curKey || player.get().rev !== revAtStart;
          if (!interrupted && code !== 0) console.log('[stream] ffmpeg 提前退出 code=' + code + ' | ' + errTail.slice(-300));
        });

        // 后台探测真实可播时长（试听/版权截断文件比元数据短），修正队列时长与自动切歌
        if (!cur.realDurProbed && neteaseId) {
          cur.realDurProbed = true;
          probeDuration(input).then((realSec) => {
            if (realSec > 0) {
              const real = Math.round(realSec);
              const meta = cur.duration || 0;
              if (!meta || Math.abs(meta - real) >= 3) {
                console.log('[stream] 实际可播 ' + real + 's（元数据 ' + meta + 's）id=' + neteaseId);
                cur.duration = real;
                try { queue.save(); } catch (e) {}
              }
            }
          }).catch(() => {});
        }

        await pipeFf(ff, () => {
          const s = player.get();
          return closed || !s.current || s.current.id !== curKey || s.rev !== revAtStart;
        }, (p) => { pumping = p; });

        if (closed) break;
        const sNow = player.get();
        if (sNow.rev === revAtStart && sNow.current && sNow.current.id === curKey && sNow.playing) {
          // 期间无任何手动操作且曲子真的放完 -> 自然前进
          player.next();
        }
        // 其余情况（seek/暂停/切歌等）回到循环顶部按最新状态重新拉流
        await sleep(150);
      }
    } finally {
      clearInterval(filler);
    }
    if (!res.writableEnded) res.end();
  };
  pump();
});

// ---------- TS3AudioBot 语音引擎对接（点歌机器人进入 TeamSpeak） ----------
app.get('/api/ts-bot/status', async (req, res) => {
  try { ok(res, await tsbridge.status()); } catch (e) { ok(res, { enabled: false, error: e.message }); }
});
app.get('/api/ts-bot/config', (req, res) => {
  ok(res, {
    ts3abUrl: config.ts3abUrl,
    ts3abChannels: Array.isArray(config.ts3abChannels) ? config.ts3abChannels : [],
    ts3abBotNickname: config.ts3abBotNickname || '点歌机器人',
    ts3abChannelPassword: config.ts3abChannelPassword || '',
    streamBotUrl: config.streamBotUrl,
    streamPublicUrl: config.streamPublicUrl,
    tsHost: config.tsHost,
    tsQueryPort: config.tsQueryPort,
    tsChatEnabled: config.tsChatEnabled !== false,
    hasQueryPassword: !!config.tsQueryAdminPassword,
    chatCommands: config.chatCommands,
    streamTokenEnabled: config.streamTokenEnabled !== false,
    streamToken: config.streamToken || '',
    audioCodec: config.audioCodec,
    audioBitrate: config.audioBitrate,
    audioRate: config.audioRate,
    audioChannels: config.audioChannels,
    autoPauseEmpty: config.autoPauseEmpty !== false,
  });
});
app.put('/api/ts-bot/config', (req, res) => {
  try {
    const body = req.body || {};
    // 开启令牌且面板请求生成（streamToken===''）→ 始终随机生成，覆盖可能不安全的默认值
    if (body.streamTokenEnabled === true && body.streamToken === '') {
      body.streamToken = crypto.randomBytes(16).toString('hex');
    }
    const out = config.saveTsBridge(body);
    // 聊天点歌配置可能变化：热应用（启停/重连）
    tschat.applyConfig();
    ok(res, { ...out, tsChatEnabled: config.tsChatEnabled !== false, hasQueryPassword: !!config.tsQueryAdminPassword, streamToken: config.streamToken || '' });
  } catch (e) { fail(res, 500, 'CFG_FAIL', e.message); }
});
// 频道聊天点歌运行状态
app.get('/api/ts-bot/chat/status', (req, res) => {
  ok(res, tschat.getState());
});
app.post('/api/ts-bot/link', async (req, res) => {
  // link() 可能耗时较长（等待机器人连接最长 25s+），若同步等待会被反向代理超时断开（表现为“服务器 hangup”）。
  // 改为异步执行：立即返回，真正结果通过 /api/ts-bot/status 查看。
  res.json({ ok: true, pending: true, message: '正在连接/重建机器人，请稍后用「刷新状态」查看结果' });
  tsbridge.link()
    .then(() => console.log('[ts-bot] 重建/连接完成'))
    .catch((e) => console.log('[ts-bot] 重建/连接失败: ' + (e && e.message)));
});
app.post('/api/ts-bot/unlink', async (req, res) => {
  try { ok(res, await tsbridge.unlink()); } catch (e) { fail(res, 502, 'TS_UNLINK_FAIL', e.message); }
});
// 彻底停用我们部署的所有点歌机器人（之后可用「生成机器人 / 重建连接」重建）
app.delete('/api/ts-bot/bot', async (req, res) => {
  try { ok(res, await tsbridge.deleteBot()); } catch (e) { fail(res, 502, 'TS_DEL_BOT_FAIL', e.message); }
});
app.get('/api/ts-bot/channels', async (req, res) => {
  try { ok(res, await tsbridge.listChannels()); } catch (e) { fail(res, 400, 'TS_CHANNELS_FAIL', e.message); }
});

// ---------- 登录状态 ----------
app.get('/api/status', async (req, res) => {
  try {
    // 诊断：本次请求带上的 cookie 里是否含 MUSIC_U
    const hlc = !!enhanced.hasLoginCookie;
    const jarHas = hlc ? enhanced.hasLoginCookie() : false;
    let diskHas = 'n/a';
    try {
      const t = fs.readFileSync(path.join(config.dataDir, 'cookie.txt'), 'utf8');
      diskHas = /MUSIC_U=/.test(t);
    } catch (e) { diskHas = 'missing'; }
    console.log(`[login] 诊断 jar含MUSIC_U=${jarHas} cookie.txt含MUSIC_U=${diskHas}`);
    // 完全以真实 /login/status 为准；account/profile 任一存在即视为已登录
    const ls = await enhanced.loginStatus();
    const d = (ls && ls.data) || {};
    const account = d.account || null;
    const profile = d.profile || null;
    if (!account && !profile) return ok(res, { loggedIn: false });
    // 匿名账号（未真正登录，如扫码前的匿名 token）不算已登录
    if (account && account.anonimousUser === true) return ok(res, { loggedIn: false, anonymous: true });

    // VIP 以 account.vipType 为准（11=黑胶VIP, 3=黑胶SVIP, 0=非会员），profile.vipType 兜底
    const vt = (account && account.vipType != null ? account.vipType
      : (profile && profile.vipType != null ? profile.vipType : 0));
    const isVip = vt > 0;
    const vipLabel = vt === 11 ? '黑胶VIP' : vt === 3 ? '黑胶SVIP' : vt === 10 ? 'VIP' : isVip ? 'VIP' : '非会员';

    ok(res, {
      loggedIn: true,
      profile: profile ? {
        userId: profile.userId != null ? profile.userId : (account && account.id),
        nickname: profile.nickname || '',
        avatarUrl: profile.avatarUrl || '',
      } : null,
      account: account ? { userId: account.id, vipType: vt, anonymous: !!account.anonimousUser } : null,
      vip: { isVip, vipType: vt, label: vipLabel, expireTime: null },
    });
  } catch (e) {
    ok(res, { loggedIn: false, error: e.message });
  }
});

// 退出登录
app.post('/api/logout', async (req, res) => {
  try { ok(res, await enhanced.logout()); }
  catch (e) { fail(res, 502, 'LOGOUT_FAIL', e.message); }
});

// 独立的 VIP 信息接口
app.get('/api/vip/info', async (req, res) => {
  try {
    const r = await enhanced.vipInfo();
    const d = (r && r.data) || {};
    ok(res, { isVip: !!d.isVip, vipType: d.vipType != null ? d.vipType : null, expireTime: d.expireTime != null ? d.expireTime : null });
  } catch (e) { fail(res, 502, 'VIP_INFO_FAIL', e.message); }
});

// ---------- 扫码登录 ----------
app.post('/api/qr/create', async (req, res) => {
  try {
    const qr = await enhanced.qrCreate();
    ok(res, qr);
  } catch (e) { fail(res, 502, 'QR_FAIL', e.message); }
});

app.get('/api/qr/check', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return fail(res, 400, 'BAD_REQUEST', '缺少 key');
    const r = await enhanced.qrCheck(key);
    ok(res, r);
  } catch (e) { fail(res, 502, 'QR_FAIL', e.message); }
});

app.get('/api/login/status', async (req, res) => {
  try { ok(res, await enhanced.loginStatus()); }
  catch (e) { fail(res, 502, 'LOGIN_FAIL', e.message); }
});

// ---------- 搜索 ----------
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const type = (req.query.type || 'song').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = parseInt(req.query.offset, 10) || 0;
    if (!q) return fail(res, 400, 'BAD_REQUEST', '缺少关键词 q');
    const result = await enhanced.search(q, type, limit, offset);
    // 归一化返回
    const data = { type, total: 0, items: [] };
    if (type === 'playlist') {
      const list = result.playlists || [];
      data.total = result.playlistCount || list.length;
      data.items = list.map(p => ({
        id: p.id,
        name: p.name,
        playCount: p.playCount || 0,
        tracks: p.trackCount || 0,
        cover: p.coverImgUrl || '',
        creator: (p.creator || {}).nickname || '',
      }));
    } else {
      const list = result.songs || [];
      const privs = result.privileges || [];
      data.total = result.songCount || list.length;
      data.items = list.map((s, idx) => {
        const p = privs[idx] || {};
        // fee / 无版权标记常在平行的 privileges 数组里，song 上可能没有，这里兜底合并
        const fee = s.fee != null ? s.fee : (p.fee != null ? p.fee : null);
        const noCopyright = !!(s.noCopyrightRcmd || p.flag === 32);
        return {
          id: s.id,
          name: s.name,
          artists: (s.ar || []).map(a => a.name).join(' '),
          album: (s.al || {}).name || '',
          duration: s.dt ? Math.round(s.dt / 1000) : 0,
          cover: (s.al || {}).picUrl || '',
          fee,
          noCopyright,
        };
      });
    }
    ok(res, data);
  } catch (e) { fail(res, 502, 'SEARCH_FAIL', e.message); }
});

// ---------- 歌曲/歌单 ----
app.get('/api/song/url', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return fail(res, 400, 'BAD_REQUEST', '缺少 id');
    let r = await enhanced.songUrl(id, (req.query.level || 'standard').trim());
    // 无直链（灰色/无版权）时走解灰兜底
    if (!r.url) r = await enhanced.songUrlMatch(id, req.query.source);
    ok(res, r);
  } catch (e) { fail(res, 502, 'SONG_URL_FAIL', e.message); }
});

// 音乐是否可用：{success:true} 或 {success:false,message:'暂无版权'}
app.get('/api/check/music', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return fail(res, 400, 'BAD_REQUEST', '缺少 id');
    ok(res, await enhanced.checkMusic(id));
  } catch (e) { fail(res, 502, 'CHECK_MUSIC_FAIL', e.message); }
});

app.get('/api/playlist/tracks', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return fail(res, 400, 'BAD_REQUEST', '缺少 id');
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 100);
    const tracks = await enhanced.playlistTracks(id, limit);
    ok(res, { tracks });
  } catch (e) { fail(res, 502, 'PLAYLIST_FAIL', e.message); }
});

// 歌单全部曲目（用于"全量加入队列"与前端浏览）
app.get('/api/playlist/tracks-all', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return fail(res, 400, 'BAD_REQUEST', '缺少 id');
    const cap = Math.min(parseInt(req.query.cap, 10) || 2000, 5000);
    const tracks = await enhanced.playlistTracksAll(id, cap);
    ok(res, { tracks });
  } catch (e) { fail(res, 502, 'PLAYLIST_FAIL', e.message); }
});

// ---------- 点歌队列（按频道隔离，?ch= 指定） ----------
app.get('/api/queue', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  const all = queueMod.forChannel(ch).all();
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const filtered = q
    ? all.filter((it) =>
        [it.title, it.artists, it.album, it.requestedBy]
          .join(' ').toLowerCase().includes(q))
    : all;
  const total = filtered.length;
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 1), 100);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  const start = (page - 1) * pageSize;
  ok(res, {
    items: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    pages,
    channel: ch,
  });
});

app.post('/api/queue', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  const body = req.body || {};
  const q = queueMod.forChannel(ch);
  if (Array.isArray(body.songs) && body.songs.length) {
    const added = q.enqueueMany(body.songs, body.requestedBy);
    ok(res, { items: added, count: added.length, channel: ch });
  } else {
    const s = body;
    if (!s.id || !s.name) return fail(res, 400, 'BAD_REQUEST', '缺少歌曲信息');
    const item = q.enqueue({
      id: s.id,
      name: s.name,
      artists: s.artists || '',
      album: s.album || '',
      cover: s.cover || '',
      duration: s.duration || 0,
      fee: s.fee != null ? s.fee : null,
    }, s.requestedBy);
    ok(res, { item, channel: ch });
  }
});

app.delete('/api/queue/:id', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  const removed = queueMod.forChannel(ch).remove(req.params.id);
  if (!removed) return fail(res, 404, 'NOT_FOUND', '队列中无此条目');
  ok(res, { removed: true });
});

app.delete('/api/queue', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  queueMod.forChannel(ch).clear();
  ok(res, { cleared: true });
});

// ---------- 播放器（按频道隔离，?ch= 指定） ----------
app.get('/api/player', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  ok(res, { ...playerMod.forChannel(ch).get(), channel: ch });
});

app.post('/api/player/play', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  const id = req.body && req.body.id != null ? parseInt(req.body.id, 10) : null;
  ok(res, { ...playerMod.forChannel(ch).play(id), channel: ch });
});

app.post('/api/player/toggle', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  const st = playerMod.forChannel(ch).toggle();
  ok(res, { ...st, channel: ch });
  if (st.playing) tsbridge.resumeRadio(ch).catch(() => {});
});

app.post('/api/player/pause', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  ok(res, { ...playerMod.forChannel(ch).pause(), channel: ch });
});

app.post('/api/player/resume', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  const st = playerMod.forChannel(ch).resume();
  ok(res, { ...st, channel: ch });
  if (st.playing) tsbridge.resumeRadio(ch).catch(() => {});
});

app.post('/api/player/seek', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  const pos = Number(req.body && req.body.position);
  if (!Number.isFinite(pos) || pos < 0) return fail(res, 400, 'BAD_REQUEST', 'position 无效');
  ok(res, { ...playerMod.forChannel(ch).seek(pos), channel: ch });
});

app.post('/api/player/next', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  ok(res, { ...playerMod.forChannel(ch).next(), channel: ch });
});

app.post('/api/player/prev', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  ok(res, { ...playerMod.forChannel(ch).prev(), channel: ch });
});

app.post('/api/player/loop', (req, res) => {
  const ch = chOf(req);
  if (!ch) return fail(res, 400, 'NO_CHANNEL', '未配置部署频道');
  const mode = (req.body && req.body.mode) || 'all';
  ok(res, { ...playerMod.forChannel(ch).setLoop(mode), channel: ch });
});

// 语音播放输出接口（预留）：TS3 语音由 TS3AudioBot 引擎承担，无需在此实现
// app.post('/api/play/start', ...)

fs.mkdirSync(config.dataDir, { recursive: true });
// 每个部署频道预建队列/播放器并加载持久化数据；旧版单队列迁移到第一个频道
const bootChannels = tsbridge.configChannels();
if (bootChannels.length) {
  queueMod.migrateLegacy(bootChannels[0]);
  for (const c of bootChannels) playerMod.forChannel(c);
}

// ---------- 自动解析电台流对外地址（逻辑见 streamurl.js，支持建机器人时再次探测） ----------
const { resolveStreamPublicUrl } = require('./streamurl');

Promise.all([
  resolveStreamPublicUrl(),
  generateSilence().then((b) => { SILENCE_BUF = b; if (!b) console.log('[music-bot] 静音缓冲生成失败，暂停过渡将无垫片'); }),
]).then(() => {
  tschat.start(); // TS 频道聊天点歌监听（需 TS_QUERY_ADMIN_PASSWORD）
  const server = app.listen(config.port, config.host, () => {
    console.log(`[music-bot] 点歌服务已启动 ${config.host}:${config.port}`);
    console.log(`[music-bot] 网易云 API: ${config.apiBase}`);
  });
  server.setTimeout(60000);
}).catch((e) => { console.error('[music-bot] 启动失败', e); process.exit(1); });