'use strict';

/**
 * 网易云音乐 API 客户端（对接 api-enhanced）。
 *
 * - 维护 cookie jar（扫码登录产生），持久化到数据卷，重启不丢
 * - 提供：扫码登录、登录状态、歌曲/歌单搜索、歌曲 URL、歌单内容
 * - 所有请求走后端代理（内网），不暴露 api-enhanced 端口
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

// ---------- Cookie jar ----------
const cookieFile = path.join(config.dataDir, 'cookie.txt');
const cookies = new Map(); // name -> value

function loadCookies() {
  try {
    if (!fs.existsSync(cookieFile)) return;
    const raw = fs.readFileSync(cookieFile, 'utf8');
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) cookies.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  } catch (e) { /* 忽略 */ }
}

function saveCookies() {
  try {
    const str = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    fs.writeFileSync(cookieFile, str, 'utf8');
  } catch (e) { /* 忽略 */ }
}

// 吸收 Set-Cookie 头
function absorb(setCookieHeader) {
  if (!setCookieHeader) return;
  const parts = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of parts) {
    const seg = c.split(';')[0]; // name=value
    const idx = seg.indexOf('=');
    if (idx > 0) {
      const name = seg.slice(0, idx).trim();
      const value = seg.slice(idx + 1).trim();
      if (name === 'MUSIC_U' || name === 'os' || name === 'osver' || name === 'appver' ||
          name === 'NMTID' || name === 'MUSIC_A_T' || name === 'MUSIC_A_N' || name === '__csrf') {
        // 防御：不要让「过期/清空」的 MUSIC_U（value 为空，常出现在非登录请求的 set-cookie 里）覆盖已登录的会话
        if (name === 'MUSIC_U' && !value && cookies.get('MUSIC_U')) continue;
        cookies.set(name, value);
      }
    }
  }
  saveCookies();
}

// 保存完整登录 cookie：保留所有真实会话 cookie（MUSIC_U/MUSIC_R_U/MUSIC_R_T/MUSIC_SNS/NMTID/__csrf 等），
// 仅剔除 Set-Cookie 里的属性行（Max-Age/Expires/Path/Domain/SameSite）。
// 与 absorb 不同：absorb 只收白名单，会丢掉 /login/status 判定可能用到的 cookie。
function absorbLogin(cookieStr) {
  if (!cookieStr) return;
  const parts = Array.isArray(cookieStr) ? cookieStr : String(cookieStr).split(';');
  for (const seg of parts) {
    const s = String(seg).trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const name = s.slice(0, eq).trim();
    const value = s.slice(eq + 1).trim();
    if (/^(Max-Age|Expires|Path|Domain|Secure|HttpOnly|SameSite|Priority)$/i.test(name)) continue;
    cookies.set(name, value);
  }
  saveCookies();
}

function cookieHeader() {
  return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// 当前 jar 是否含非空 MUSIC_U（诊断用）
function hasLoginCookie() {
  return !!(cookies.get('MUSIC_U') || '').trim();
}

// 启动时从持久化文件加载登录 cookie（此前漏调 loadCookies()：jar 每次启动都是空的，导致登录无法跨重启保留）
loadCookies();

// ---------- 基础请求 ----------
async function req(pathname, { method = 'GET', qs = {} } = {}) {
  const url = new URL(config.apiBase + pathname);
  qs.timestamp = Date.now(); // 防缓存
  // 登录后请求携带 cookie 参数（接口兼容 cookie 字段，登录态以此生效）
  const ck = cookieHeader();
  if (ck) qs.cookie = ck;
  for (const [k, v] of Object.entries(qs)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = {
    'User-Agent': UA,
    Referer: 'https://music.163.com',
    Accept: 'application/json',
    Cookie: ck,
  };
  let res;
  try {
    res = await fetch(url, { method, headers });
  } catch (e) {
    const cause = e.cause ? ` [${e.cause.code || e.cause.message}]` : '';
    throw new Error(`无法连接网易云 API（${config.apiBase}）：${e.message}${cause}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) absorb(setCookie);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { code: -1, message: text.slice(0, 200) }; }
  return json;
}

// ---------- 扫码登录 ----------
async function anonymousToken() {
  return req('/register/anonymous', { method: 'POST' });
}

// 生成登录二维码：使用接口返回的 base64 图片（qrimg），而非本地再生成
async function qrCreate() {
  await anonymousToken().catch(() => {});
  const keyRes = await req('/login/qr/key');
  const key = keyRes && keyRes.data && keyRes.data.unikey;
  if (!key) throw new Error('获取二维码 key 失败：' + JSON.stringify(keyRes).slice(0, 200));
  const createRes = await req('/login/qr/create', { qs: { key, qrimg: 'true', noloading: 'true' } });
  const data = createRes && createRes.data;
  // 接口返回 base64 二维码图片（可能是原始 base64，也可能已带 data:image 前缀）
  let qrDataUrl = null;
  if (data.qrimg) {
    qrDataUrl = String(data.qrimg).startsWith('data:image')
      ? data.qrimg
      : 'data:image/png;base64,' + data.qrimg;
  }
  return { key, qrurl: data.qrurl, unikey: data.unikey, qrDataUrl };
}

// 轮询扫码状态: 800 过期 / 801 等待 / 802 已扫未确认 / 803 成功
async function qrCheck(key) {
  // api-enhanced 的 /login/qr/check 需要 ua 参数才会在 803 成功时于 body 顶层返回 cookie
  const res = await req('/login/qr/check', { qs: { key, noloading: 'true', ua: process.env.NCM_QR_UA || 'pc' } });
  if (res.code === 803) {
    // body 顶层 cookie（含 MUSIC_U），data.cookie / set-cookie 头兜底
    const c = res.cookie || (res.data && res.data.cookie) || '';
    if (c) {
      console.log('[login] 803 吸收 cookie len=' + c.length + ' 含MUSIC_U=' + /MUSIC_U=/.test(c));
      absorbLogin(c); // 保留完整会话 cookie，保证 /login/status 识别
      try {
        const txt = fs.readFileSync(cookieFile, 'utf8');
        console.log(`[login] 落盘检查 size=${txt.length} 含MUSIC_U=${/MUSIC_U=/.test(txt)} 键=${(txt.split(';').map(s => s.split('=')[0].trim()).filter(Boolean).join(','))}`);
      } catch (e) { console.log('[login] 落盘读取失败：' + e.message); }
    } else {
      console.log('[login] 803 但响应无 cookie 字段');
    }
  }
  return { code: res.code, message: res.message || (res.data && res.data.message) || '' };
}

async function loginStatus() {
  const res = await req('/login/status');
  return res;
}

async function logout() {
  try { await req('/logout'); } catch (e) { /* 即使上游报错也清本地 cookie */ }
  cookies.clear();
  saveCookies();
  return { ok: true };
}

// 用户详情（登录后，传入 uid）——含头像/昵称/等级等
async function userDetail(uid) {
  return req('/user/detail', { qs: { uid } });
}

// 账号信息（登录后）——含 VIP/等级/绑定等
async function userAccount() {
  return req('/user/account');
}

// 当前登录账号的 VIP 信息（登录态经 cookie 生效）
// 典型返回 data: { isVip: bool, vipType: 0无/10普通/11年费..., expireTime: 毫秒时间戳 }
async function vipInfo() {
  return req('/vip/info');
}

// ---------- 搜索 ----------
const SEARCH_TYPES = { song: 1, playlist: 1000, album: 10, artist: 100, singer: 100 };
async function search(keywords, type = 'song', limit = 20, offset = 0) {
  const typeId = SEARCH_TYPES[type] || 1;
  const res = await req('/cloudsearch', { qs: { keywords, type: typeId, limit, offset } });
  return res.result || { songs: [], playlists: [] };
}

// ---------- 歌曲 / 歌单 ----------
async function songDetail(ids) {
  const res = await req('/song/detail', { qs: { ids: Array.isArray(ids) ? ids.join(',') : String(ids) } });
  return res;
}

async function songUrl(id, level = 'standard') {
  const res = await req('/song/url/v1', { qs: { id, level } });
  const arr = (res.data && Array.isArray(res.data)) ? res.data : ((res.data && res.data[0]) ? [res.data[0]] : []);
  const item = arr[0] || {};
  return { url: item.url || '', br: item.br || 0, size: item.size || 0, type: item.type || '' };
}

// 音乐是否可用：{ success: true, message: 'ok' } 或 { success: false, message: '亲爱的,暂无版权' }
async function checkMusic(id, br = 999000) {
  return req('/check/music', { qs: { id, br } });
}

// 灰色歌曲解灰（UnblockNeteaseMusic）：返回直链或空
async function songUrlMatch(id, source) {
  const qs = { id };
  if (source) qs.source = source;
  let res;
  try {
    res = await req('/song/url/match', { qs });
  } catch (e) {
    return { url: '', br: 0, size: 0, type: '' };
  }
  const d = (res && res.data) || res || {};
  const item = Array.isArray(d) ? (d[0] || {}) : d;
  return {
    url: item.url || item.sourceUrl || '',
    br: item.br || item.bitrate || 0,
    size: item.size || 0,
    type: item.type || item.encodeType || '',
  };
}

async function playlist(id) {
  const res = await req('/playlist/detail', { qs: { id } });
  return res;
}

async function playlistTracks(id, limit = 60, offset = 0) {
  const res = await req('/playlist/track/all', { qs: { id, limit, offset } });
  return (res.songs || []).map((s, idx) => {
    const p = (res.privileges || [])[idx] || {};
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

// 拉取歌单全部曲目（分页循环，封顶 cap 防止超长歌单拖垮），用于"全量加入队列"
async function playlistTracksAll(id, cap = 2000) {
  const pageSize = 300;
  const out = [];
  for (let offset = 0; offset < cap; offset += pageSize) {
    const page = await playlistTracks(id, pageSize, offset);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out.slice(0, cap);
}

module.exports = {
  qrCreate,
  qrCheck,
  loginStatus,
  logout,
  userDetail,
  userAccount,
  vipInfo,
  search,
  songDetail,
  songUrl,
  songUrlMatch,
  checkMusic,
  playlist,
  playlistTracks,
  playlistTracksAll,
  hasLoginCookie,
};