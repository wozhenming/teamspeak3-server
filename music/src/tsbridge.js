'use strict';

/**
 * 与点歌机器人语音引擎 TS3AudioBot 对接（每频道固定部署模式）：
 * - 每个配置的频道固定部署一个点歌机器人（一个频道一个，绝不跨频道移动）
 * - 每个机器人播放自己频道的独立电台流（本服务 /api/stream?ch=<频道>）
 * - 机器人命名：单频道用配置昵称原名；多频道自动加「·频道名」后缀区分
 * - 频道无人自动暂停：哪个频道无人就只暂停哪个频道；有人进入即恢复
 *
 * TS3AudioBot（https://github.com/Splamy/TS3AudioBot）以真实语音客户端身份
 * 加入 TS3 频道。本服务通过其本地 Web API（默认 58913）管理机器人实例：
 *   /api/bot/list                          正在运行的机器人
 *   /api/bot/connect/to/<address>          新建并连接一个机器人
 *   /api/bot/connect/template/<name>       从已保存模板启动机器人
 *   /api/bot/use/<id>/(<command chain>)    在指定机器人上下文里执行命令
 *   /api/bot/save/<name>                   把运行中的机器人保存为模板
 * 命令链语法：'/' 分隔参数，嵌套命令需用字面量括号包裹（如 (/play/<url>)），
 * 参数值需 encodeURIComponent（TS3AudioBot 在解析后统一做 URL 解码）。
 *
 * 注意：TS3AudioBot 自带 DNS 解析器不认 Docker 容器名，因此发给它的
 * TS 服务器地址与电台流地址都会先在本服务解析成 IP 再下发。
 */

const crypto = require('crypto');
const dns = require('dns').promises;
const { config } = require('./config');
const { withQuery, esc: qesc } = require('./tsquery');
const playerMod = require('./player');

// ---------- TS3AudioBot HTTP API 小客户端 ----------
function cfg() {
  return {
    url: (config.ts3abUrl || '').replace(/\/$/, ''),
    channels: configChannels(),
    nickname: (config.ts3abBotNickname || '点歌机器人').trim() || '点歌机器人',
    streamUrl: (config.streamBotUrl || 'http://music:3200/api/stream'),
    streamTokenEnabled: config.streamTokenEnabled !== false,
    streamToken: config.streamToken || '',
    tsHost: config.tsHost || '',
    tsQueryPort: config.tsQueryPort || 10011,
    tsQueryAdminPassword: config.tsQueryAdminPassword || '',
    channelPassword: config.ts3abChannelPassword || '',
  };
}

async function api(path, timeoutMs = 30000) {
  const c = cfg();
  const url = c.url + '/api' + path;
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ } }
  if (!r.ok) {
    const msg = (json && (json.ErrorMessage || json.message)) || ('HTTP ' + r.status);
    const err = new Error('TS3AudioBot 接口失败（' + path.split('/').slice(0, 3).join('/') + '）: ' + msg);
    err.status = r.status;
    throw err;
  }
  return json;
}

// 在指定机器人上下文执行命令链。chain 为 JS 数组（命令与参数按序）。
// TS3AudioBot 命令链语法：URL 路径里用 '/' 分隔参数，嵌套命令需用字面量
// 括号包裹且括号后必须紧跟 '/'（即 (/cmd/arg)），否则整个括号会被当成自由字符串。
// 参数值需 encodeURIComponent（TS3AudioBot 在解析后统一做 URL 解码）。
async function botCmd(botId, chain, timeoutMs = 30000) {
  const path = chain.map((x) => encodeURIComponent(String(x))).join('/');
  return api('/bot/use/' + botId + '/(/' + path + ')', timeoutMs);
}

// 检查引擎是否可达
async function ping() {
  const j = await api('/version', 8000);
  return j && j.Version ? ('TS3AudioBot ' + j.Version) : 'TS3AudioBot';
}

// ---------- 频道列表与命名（一频道一机器人一点歌助手，固定绑定） ----------
function configChannels() {
  const list = Array.isArray(config.ts3abChannels) ? config.ts3abChannels : [];
  const out = [];
  for (const c of list) {
    const t = String(c || '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function leafOf(path) {
  const leaf = String(path || '').split('/').pop().trim();
  return leaf || String(path || '');
}

// 为一组频道分配唯一显示名：单频道用原名；多频道加「·频道名」后缀；
// 频道叶子名重复时退回完整路径（/ 换成 ·）保证不冲突。
function assignNames(channels, base) {
  const chs = Array.isArray(channels) ? channels : [];
  const leaves = chs.map(leafOf);
  const dup = new Set(leaves.filter((l, i) => leaves.indexOf(l) !== i));
  const names = {};
  chs.forEach((ch, i) => {
    names[ch] = chs.length === 1
      ? base
      : (dup.has(leaves[i]) ? base + '·' + String(ch).replace(/\//g, '·') : base + '·' + leaves[i]);
  });
  return names;
}

// 某频道对应的机器人显示昵称（含后缀规则）
function botNameFor(channel) {
  const names = assignNames(configChannels(), (config.ts3abBotNickname || '点歌机器人').trim() || '点歌机器人');
  return names[channel] || (config.ts3abBotNickname || '点歌机器人');
}

// 频道 → 机器人模板名（ASCII 安全、确定性，用作 bots/<name> 目录与绑定键）。
// TS3AudioBot 模板名只允许 [a-zA-Z0-9_-]。
function botSlugFor(channel) {
  const leaf = leafOf(channel).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  const h = crypto.createHash('md5').update(String(channel)).digest('hex').slice(0, 8);
  return 'ts3bot_' + (leaf || 'ch') + '_' + h;
}

// ---------- 机器人固定绑定（频道 → 模板名） ----------
function botBindings() {
  return (config.ts3abChannelBots && typeof config.ts3abChannelBots === 'object') ? config.ts3abChannelBots : {};
}
function saveBotBinding(channel, slug) {
  const map = Object.assign({}, botBindings());
  if (slug != null && slug !== '') map[channel] = String(slug);
  else delete map[channel];
  config.saveTsBridge({ ts3abChannelBots: map });
}

// ---------- ServerQuery 助手（频道解析 / 客户端统计直连 TS3） ----------
function queryOpts(sid) {
  const c = cfg();
  if (!c.tsQueryAdminPassword) {
    throw new Error('未配置 TS 查询密码（serveradmin）：请在面板「点歌页 → 机器人管理」或 .env 的 TS_QUERY_ADMIN_PASSWORD 填写');
  }
  return { host: c.tsHost || 'teamspeak', port: c.tsQueryPort || 10011, user: 'serveradmin', password: c.tsQueryAdminPassword, sid: sid || 1 };
}

// 列出 TS 服务器现有频道（含完整路径，供面板选择要部署的频道）
async function listChannels() {
  return withQuery(queryOpts(1), async (conn) => {
    const cl = await conn.cmd('channellist');
    const items = (Array.isArray(cl) ? cl : [cl]).filter(Boolean);
    const byId = {};
    items.forEach((c) => { byId[c.cid] = c; });
    const norm = items.map((c) => {
      const id = c.cid;
      const name = c.channel_name || ('频道' + id);
      const pid = c.pid != null ? c.pid : null;
      let clients = null;
      if (c.total_clients != null) clients = Number(c.total_clients);
      else if (c.clients != null) clients = Number(c.clients);
      return { id, name, pid, clients, clientsRaw: null };
    });
    return norm.map((c) => {
      let path = c.name;
      let cur = c;
      let depth = 0;
      while (cur.pid != null && byId[cur.pid] && depth < 10) {
        cur = byId[cur.pid];
        path = cur.name + '/' + path;
        depth++;
      }
      return { id: c.id, name: c.name, path, clients: c.clients, clientsRaw: null };
    });
  });
}

// 频道路径 → cid（与 tschat 同一套匹配规则）
async function resolveChannelCid(channelPath) {
  return withQuery(queryOpts(1), async (conn) => {
    const want = String(channelPath || '').trim();
    const leaf = want.split('/').pop().trim();
    const low = (v) => String(v || '').trim().toLowerCase();
    const cl = await conn.cmd('channellist');
    const items = (Array.isArray(cl) ? cl : [cl]).filter(Boolean);
    const hit = items.find((c) => low(c.channel_name) === low(want))
      || items.find((c) => leaf && low(c.channel_name) === low(leaf))
      || items.find((c) => leaf && low(c.channel_name).endsWith(low(leaf)));
    if (hit && hit.cid != null) return String(hit.cid);
    throw new Error('找不到频道「' + want + '」');
  });
}

// 拉取在线客户端列表（失败返回 null）
async function listAllClients() {
  try {
    return await withQuery(queryOpts(1), async (conn) => {
      const cl = await conn.cmd('clientlist -uid');
      return (Array.isArray(cl) ? cl : [cl]).filter(Boolean);
    });
  } catch (e) {
    return null;
  }
}

// ---------- 主机名 → IP（TS3AudioBot 自带 DNS 解析器不认容器名） ----------
const hostIpCache = new Map(); // host -> { ip, at }
async function resolveHostIp(host) {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return host; // 已是 IP/IPv6
  const cached = hostIpCache.get(host);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.ip;
  try {
    const r = await dns.lookup(host);
    hostIpCache.set(host, { ip: r.address, at: Date.now() });
    return r.address;
  } catch (e) {
    return host; // 解析失败原样返回（TS3AudioBot 侧可能自己能解析公网域名）
  }
}

// 机器人拉流地址：内网电台流 + 频道参数 + 令牌，主机名替换为 IP
async function botStreamUrlFor(channel) {
  const c = cfg();
  let url = c.streamUrl;
  const sep = url.includes('?') ? '&' : '?';
  url = url + sep + 'ch=' + encodeURIComponent(channel);
  if (c.streamTokenEnabled && c.streamToken) url += '&t=' + encodeURIComponent(c.streamToken);
  try {
    const u = new URL(url);
    const ip = await resolveHostIp(u.hostname);
    if (ip !== u.hostname) u.hostname = ip;
    return u.toString();
  } catch (e) {
    return url;
  }
}

// TS3 服务器地址（解析为 IP:port 供机器人连接）
async function tsAddressFor() {
  const c = cfg();
  let host = c.tsHost || 'teamspeak';
  let port = 9987;
  const m = String(host).match(/^(.*):(\d+)$/);
  if (m) { host = m[1]; port = parseInt(m[2], 10); }
  const ip = await resolveHostIp(host);
  return ip + ':' + port;
}

// ---------- 运行中的机器人 ----------
async function botList() {
  const j = await api('/bot/list', 10000);
  return Array.isArray(j) ? j : [];
}

// 按模板名（保存后 Bot.Name）在运行列表里找机器人
function findRunningBot(bots, slug) {
  // Status: 0=Offline（启动失败的死实例，Id 为 null，不可用）、1=Connecting、2=Connected。
  // 优先已连接实例，其次连接中实例；死实例视同不存在。
  const ours = (Array.isArray(bots) ? bots : []).filter((b) => b && (b.Name === slug || b.name === slug));
  return ours.find((b) => Number(b.Status) === 2 && b.Id != null)
    || ours.find((b) => Number(b.Status) === 1 && b.Id != null)
    || null;
}

async function waitBotConnected(slug, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const bots = await botList();
      const b = findRunningBot(bots, slug);
      if (b && Number(b.Status) === 2) return b;
      if (b && Number(b.Status) !== 1 && i % 5 === 0) {
        console.log('[tsbridge] waitBotConnected: slug=' + slug + ' status=' + b.Status + ' (尝试 ' + (i + 1) + '/' + tries + ')');
      }
    } catch (e) { /* 忽略，继续等 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// 在运行中的机器人上下文里取当前播放（无播放返回 null）
async function botSong(botId) {
  try {
    const s = await botCmd(botId, ['song'], 8000);
    if (s && s.Link != null) return { title: s.Title || s.Link, position: s.Position, length: s.Length, paused: !!s.Paused };
    return null;
  } catch (e) {
    return null; // “There is nothing on right now” 等
  }
}

// ---------- 创建 / 部署 ----------
async function createBotForChannel(channel) {
  const c = cfg();
  const slug = botSlugFor(channel);
  const nick = botNameFor(channel);
  const cid = await resolveChannelCid(channel);
  const addr = await tsAddressFor();
  console.log('[tsbridge] 创建点歌机器人：频道「' + channel + '」昵称「' + nick + '」→ ' + addr + ' 频道cid=' + cid);
  const created = await api('/bot/connect/to/' + encodeURIComponent(addr), 40000);
  const botId = created && created.Id != null ? created.Id : null;
  if (botId == null) throw new Error('TS3AudioBot 未返回新机器人 Id');
  // 昵称与默认频道（写入运行配置，保存后随模板持久化；昵称在下次连接时生效）
  try { await botCmd(botId, ['settings', 'set', 'connect.name', nick]); } catch (e) { console.log('[tsbridge] 设置昵称失败（忽略）: ' + e.message); }
  try { await botCmd(botId, ['settings', 'set', 'connect.channel', '/' + cid]); } catch (e) { console.log('[tsbridge] 设置默认频道失败（忽略）: ' + e.message); }
  if (c.channelPassword) {
    try { await botCmd(botId, ['settings', 'set', 'connect.channel_password.pw', c.channelPassword]); } catch (e) { console.log('[tsbridge] 设置频道密码失败（忽略）: ' + e.message); }
  }
  // 命令匹配改为 exact：未知 !指令（如中文点歌词）静默忽略，不产生错误刷屏
  try { await botCmd(botId, ['settings', 'set', 'commands.matcher', 'exact']); } catch (e) { /* 忽略 */ }
  // 等首次连接完成（保存的模板里会带上自动生成的身份密钥）
  const okRun = await waitBotConnectedById(botId, 30);
  if (!okRun) throw new Error('机器人连接 TS 服务器超时（地址 ' + addr + '）');
  try { await botCmd(botId, ['bot', 'save', slug]); } catch (e) {
    throw new Error('保存机器人模板失败: ' + e.message);
  }
  // 首连的昵称是引擎默认名（connect.name 在连接时才生效），断开后从模板重启
  try { await botCmd(botId, ['bot', 'disconnect']); } catch (e) { /* 忽略 */ }
  await startTemplateBot(slug);
  if (!(await waitBotConnected(slug, 30))) throw new Error('机器人从模板启动后未能连接 TS 服务器');
  console.log('[tsbridge] 频道「' + channel + '」的机器人已创建并保存为模板 ' + slug);
  return slug;
}

// 从已保存模板启动一个机器人（相当于 !bot connect template <name>）
async function startTemplateBot(slug) {
  try {
    await api('/bot/connect/template/' + encodeURIComponent(slug), 40000);
    return true;
  } catch (e) {
    return false; // 模板不存在等
  }
}

async function waitBotConnectedById(botId, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const bots = await botList();
      const b = (Array.isArray(bots) ? bots : []).find((x) => x && Number(x.Id) === Number(botId));
      if (b && Number(b.Status) === 2) return true;
    } catch (e) { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// 确保某频道有自己的机器人：按绑定模板名 → 从模板启动 → 不存在则创建
async function ensureBotForChannel(channel) {
  const bound = botBindings()[channel];
  const slug = bound || botSlugFor(channel);
  let bots = await botList();
  let running = findRunningBot(bots, slug);
  if (!running) {
    // 尝试从已保存模板启动（TS3AudioBot 重启后机器人不会自动运行，由这里/看门狗拉起）
    await startTemplateBot(slug);
    bots = await botList();
    running = findRunningBot(bots, slug);
  }
  if (!running) {
    const createdSlug = await createBotForChannel(channel);
    saveBotBinding(channel, createdSlug);
    return createdSlug;
  }
  if (!bound) saveBotBinding(channel, slug);
  return slug;
}

// 启动/确保某频道机器人正在播放电台流
async function playRadio(channel) {
  const slug = await ensureBotForChannel(channel);
  const bots = await botList();
  const bot = findRunningBot(bots, slug);
  if (!bot) throw new Error('机器人未在运行（' + slug + '）');
  const url = await botStreamUrlFor(channel);
  await botCmd(bot.Id, ['play', url]);
  return { ok: true, botId: bot.Id, slug };
}

// ---------- 防重复部署（并发锁）+ 自动修复看门狗 ----------
let linking = null;          // 串行化 link()，避免并发点击重复建 bot
let desiredLinked = false;   // 用户意图：应保持连接（用于看门狗判断是否需自愈）
const autoPausedByEmpty = new Map(); // 频道 → 是否因“频道无人”被自动暂停
let watchdogTimer = null;
const repairing = new Set(); // 正在修复的频道（避免 15s tick 重叠修复）

// ---------- 频道在线人数统计（供“频道无人自动暂停”使用） ----------
// 注意：ServerQuery 客户端（serveradmin / 点歌助手）会驻留在频道里，
// 但它们收不到语音、不是“人”。按 client_type 只统计真实语音用户。
const clidOfClient = (cl) => (cl.clid != null ? cl.clid : (cl.client_id != null ? cl.client_id : null));
const cidOfClient = (cl) => (cl.cid != null ? cl.cid : (cl.channel_id != null ? cl.channel_id : null));
const nickOfClient = (cl) => cl.client_nickname || cl.nickname || cl.name || '';

// 机器人在 TS 里的 clid 缓存（频道 → clid）：由 status() 从 clientlist 刷新，防同名冒充干扰计数
const botClidByChannel = new Map();

function isQueryClient(cl) {
  const t = cl.client_type != null ? cl.client_type : null;
  if (t != null) return String(t) === '1'; // TS ServerQuery：client_type=1（语音客户端为 0）
  const n = String(nickOfClient(cl) || '');
  return n === 'serveradmin' || n.startsWith('serveradmin ') || /^点歌助手/.test(n);
}

// 在客户端列表里定位某频道的机器人（clid 缓存优先，昵称兜底）
function findChannelBot(clients, channel) {
  const wantClid = botClidByChannel.get(channel);
  if (wantClid != null) {
    const byClid = clients.find((cl) => String(clidOfClient(cl)) === String(wantClid));
    if (byClid) return byClid;
  }
  const name = botNameFor(channel);
  return clients.find((cl) => nickOfClient(cl) === name)
    || clients.find((cl) => String(nickOfClient(cl) || '').includes(name))
    || null;
}

// 统计每个频道的真实语音用户数（排除机器人自身与 ServerQuery 客户端）。
// 机器人不在列表/定位不到频道的记 null（无法判断）。
function countRealVoiceUsersByChannel(clients, channels) {
  const out = {};
  for (const channel of channels) {
    const bot = findChannelBot(clients, channel);
    if (!bot || cidOfClient(bot) == null) { out[channel] = null; continue; }
    const botCid = String(cidOfClient(bot));
    const botClid = clidOfClient(bot) != null ? String(clidOfClient(bot)) : null;
    out[channel] = clients.filter((cl) =>
      String(cidOfClient(cl)) === botCid
      && (botClid == null || String(clidOfClient(cl)) !== botClid)
      && !isQueryClient(cl)
    ).length;
  }
  return out;
}

// 所有已部署频道的真实语音用户总数。返回数字；完全无法判断时返回 null，调用方应忽略。
async function getChannelClientCount() {
  const channels = configChannels();
  if (!channels.length) return null;
  const clients = await listAllClients();
  if (!clients || !clients.length) return null;
  const per = countRealVoiceUsersByChannel(clients, channels);
  const vals = Object.values(per);
  if (vals.every((v) => v == null)) return null; // 一个频道都定位不到机器人
  return vals.reduce((a, v) => a + (v || 0), 0);
}

// 频道无人自动暂停（按频道独立）：每个部署频道有自己的队列/播放器，
// 哪个频道没人就只暂停哪个频道；有人进来只恢复那个频道。互不影响。
async function maybeAutoPauseEmpty() {
  if (config.autoPauseEmpty === false) return;
  const channels = configChannels();
  if (!channels.length) return;
  const clients = await listAllClients();
  if (!clients || !clients.length) return;
  const per = countRealVoiceUsersByChannel(clients, channels);
  if (!per) return;
  for (const ch of channels) {
    const count = per[ch];
    if (count == null) continue; // 该频道机器人不在/定位不到，跳过
    const p = playerMod.forChannel(ch);
    const playing = !!p.get().playing;
    if (count === 0) {
      if (playing && !autoPausedByEmpty.get(ch)) {
        p.pause();
        autoPausedByEmpty.set(ch, true);
        console.log('[tsbridge] 频道「' + ch + '」无人，自动暂停该频道播放');
      }
    } else if (autoPausedByEmpty.get(ch) && !playing) {
      p.resume();
      playRadio(ch).catch(() => {}); // 重新向该频道机器人下达播放保活
      autoPausedByEmpty.set(ch, false);
      console.log('[tsbridge] 频道「' + ch + '」有人进入，自动恢复播放');
    }
  }
}

// 周期性检查各频道机器人在线状态并修复 + 执行无人自动暂停。
// TS3AudioBot 重启后机器人不会自动运行；/api/stream 始终有静音保底，
// 重新下达 play 即可让它重新拉流、保持在线。
async function watchdogTick() {
  if (!desiredLinked || linking) return; // link 进行中时避让，避免并发重复建 bot
  try {
    const st = await status();
    if (!st || !st.enabled) return;
    for (const ch of (st.channels || [])) {
      if ((!ch.connected || !ch.playing) && !repairing.has(ch.channel)) {
        repairing.add(ch.channel);
        repairChannel(ch.channel)
          .catch((e) => console.log('[tsbridge] 修复频道「' + ch.channel + '」失败: ' + (e && e.message)))
          .finally(() => repairing.delete(ch.channel));
      }
    }
    await maybeAutoPauseEmpty();
  } catch (e) { /* 忽略本轮 */ }
}

// 修复单个频道的机器人：确保运行 → 等连接 → 重新下达播放
async function repairChannel(channel) {
  if (!botBindings()[channel] && !configChannels().includes(channel)) return;
  console.log('[tsbridge] 检测到频道「' + channel + '」的机器人离线，自动修复…');
  await playRadio(channel);
  statusCache = null; // 修复完成立即反映到面板状态
  console.log('[tsbridge] 频道「' + channel + '」的机器人已恢复在线');
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(watchdogTick, 15000);
  if (watchdogTimer.unref) watchdogTimer.unref();
}
function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  desiredLinked = false;
}

// 按频道逐一部署：确保机器人 → 播放电台流（全部失败才抛错）
async function linkImpl() {
  const channels = configChannels();
  if (!channels.length) {
    throw new Error('未配置任何部署频道：请先在面板「TeamSpeak 推流 → 部署频道」添加频道并保存，再点「生成机器人 / 重建连接」');
  }
  if (!cfg().tsQueryAdminPassword) {
    throw new Error('未配置 TS 查询密码（serveradmin）：请在「机器人管理 → 点歌助手」填写，或 .env 设置 TS_QUERY_ADMIN_PASSWORD');
  }
  console.log('[tsbridge] link: 检查 TS3AudioBot 引擎…');
  console.log('[tsbridge] link: 引擎 ' + (await ping()));
  console.log('[tsbridge] link: 按频道确保机器人（共 ' + channels.length + ' 个频道）…');
  const results = [];
  for (const channel of channels) {
    try {
      await playRadio(channel);
      results.push({ channel, ok: true });
      console.log('[tsbridge] 频道「' + channel + '」的机器人已上线并开始推流');
    } catch (e) {
      results.push({ channel, ok: false, error: (e && e.message) || String(e) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length === results.length) {
    throw new Error('全部频道部署失败：' + failed.map((f) => f.channel + '（' + f.error + '）').join('；'));
  }
  return { ok: true, results };
}

async function link() {
  if (linking) return linking;            // 并发点击：复用同一连接过程，杜绝重复建 bot
  linking = (async () => {
    try {
      const r = await linkImpl();
      desiredLinked = true;
      statusCache = null; // 部署完成立即反映到面板状态
      startWatchdog();
      return r;
    } finally {
      linking = null;
    }
  })();
  return linking;
}

// 断开：停止所有我们部署的机器人的播放（机器人留在各自频道不动）
async function unlink() {
  stopWatchdog();
  statusCache = null; // 断开后立即反映到面板状态
  let stopped = 0;
  try {
    const bots = await botList();
    const ours = ourSlugs();
    for (const b of (Array.isArray(bots) ? bots : [])) {
      const name = b.Name || b.name || '';
      if (!ours.includes(name)) continue;
      try { await botCmd(b.Id, ['stop']); stopped++; } catch (e) { /* 继续其它机器人 */ }
    }
  } catch (e) { /* 引擎不可达 */ }
  return { ok: true, stopped };
}

// 我们部署的机器人模板名集合
function ourSlugs() {
  const bindings = botBindings();
  const boundIds = new Set(Object.values(bindings).map(String));
  for (const ch of configChannels()) boundIds.add(botSlugFor(ch));
  return [...boundIds];
}

// 彻底停用我们部署的所有机器人：断开连接 + 清除绑定。
// （TS3AudioBot 无删除模板的命令；模板保留在磁盘但 run=false 不会自启，无副作用。
//   之后若想恢复，调用 link() 会按当前频道配置重新创建。）
async function deleteBot() {
  stopWatchdog();
  desiredLinked = false;
  let disconnected = 0;
  try {
    const bots = await botList();
    const ours = ourSlugs();
    for (const b of (Array.isArray(bots) ? bots : [])) {
      const name = b.Name || b.name || '';
      if (!ours.includes(name)) continue;
      try { await botCmd(b.Id, ['bot', 'disconnect']); disconnected++; } catch (e) { /* 继续 */ }
    }
  } catch (e) { /* 引擎不可达 */ }
  config.saveTsBridge({ ts3abChannelBots: {} });
  botClidByChannel.clear();
  statusCache = null;
  return { ok: true, deleted: disconnected > 0, count: disconnected };
}

// 聚合状态：每个频道的机器人状态一行；connected = 所有已部署频道都在线。
// 结果缓存 5s：面板每 15s 轮询一次 status（bot list + song 是多次 HTTP），
// 缓存可避免它与 playRadio 排队相互拖慢。
let statusCache = null; // { at, value }
const STATUS_TTL = 5000;

async function status() {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL) return statusCache.value;
  const channels = configChannels();
  if (!channels.length) {
    return { enabled: true, connected: false, status: 'empty', channels: [], nowPlaying: null };
  }
  try {
    const bots = await botList();
    const bindings = botBindings();
    // 并行取各频道机器人状态
    const chs = await Promise.all(channels.map(async (channel) => {
      const slug = bindings[channel] || botSlugFor(channel);
      const bot = findRunningBot(bots, slug);
      const connected = !!(bot && Number(bot.Status) === 2);
      let nowPlaying = null;
      if (connected) nowPlaying = await botSong(bot.Id);
      return {
        channel,
        botId: bot ? String(bot.Id) : slug,
        slug,
        nickname: botNameFor(channel),
        status: connected ? (nowPlaying && !nowPlaying.paused ? 'playing' : 'connected') : 'disconnected',
        connected,
        error: null,
        nowPlaying: nowPlaying ? nowPlaying.title : null,
        playing: !!(nowPlaying && !nowPlaying.paused),
        clid: null,
      };
    }));
    // 从 clientlist 解析各频道机器人的 clid（供面板与人数统计用）
    try {
      const clients = await listAllClients();
      if (clients && clients.length) {
        for (const ch of chs) {
          const name = botNameFor(ch.channel);
          const m = clients.find((cl) => nickOfClient(cl) === name)
            || clients.find((cl) => String(nickOfClient(cl) || '').includes(name));
          if (m && clidOfClient(m) != null) {
            ch.clid = clidOfClient(m);
            botClidByChannel.set(ch.channel, ch.clid);
          } else {
            botClidByChannel.delete(ch.channel);
          }
        }
      }
    } catch (e) { /* 无查询密码等情况忽略 */ }

    const connected = chs.length > 0 && chs.every((x) => x.connected);
    const playing = chs.find((x) => x.nowPlaying);
    const agg = connected ? 'connected'
      : chs.some((x) => x.connected) ? 'partial' : 'disconnected';
    const result = { enabled: true, connected, status: agg, channels: chs, nowPlaying: playing ? playing.nowPlaying : null };
    statusCache = { at: Date.now(), value: result };
    return result;
  } catch (e) {
    return { enabled: true, connected: false, channels: [], error: e.message };
  }
}

// 恢复播放时向对应频道的机器人重新下达播放（自愈）：暂停后机器人可能放弃
// 电台流连接，仅改本地状态不会让它重新出声。channel 缺省时对所有部署频道执行。
async function resumeRadio(channel) {
  const channels = channel ? [channel] : configChannels();
  let n = 0;
  for (const ch of channels) {
    try {
      const r = await playRadio(ch);
      if (r && r.ok) n++;
    } catch (e) { /* 继续 */ }
  }
  return { ok: n > 0, count: n };
}

module.exports = { link, unlink, deleteBot, status, cfg, listChannels, resumeRadio, configChannels, assignNames, ping };
module.exports._internal = {
  maybeAutoPauseEmpty,
  getChannelClientCount,
  countRealVoiceUsersByChannel,
  findChannelBot,
  botNameFor,
  botSlugFor,
  isLinkedDesired: () => desiredLinked,
};

// 若之前已成功连接过（频道绑定已持久化），启动看门狗，容器重启/网络抖动后自动恢复在线。
// 必须同时把 desiredLinked 置回 true：它只在 link() 成功时被置位，容器重启后恒为 false，
// 看门狗会在 tick 里直接 return——频道无人自动暂停与断线自动重连在每次重启/部署后全部失效
// （机器人本身活在 TS3AudioBot 进程里不受影响，问题因此很难被察觉）。
if (Object.keys(botBindings()).length) {
  desiredLinked = true;
  startWatchdog();
}
