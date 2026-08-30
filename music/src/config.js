'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = (k, f) => {
  const v = process.env[k];
  return v === undefined || v === '' ? f : v;
};

// 聊天点歌可用指令（面板管理开关）：dian=点歌，play=播放，pause=暂停，next=切歌，clear=清队列，search=搜索，queue=队列，loop=循环，status=状态
const CHAT_CMD_DEFAULT = { dian: true, play: true, playat: true, pause: true, next: true, clear: true, search: true, queue: true, loop: true, status: true };

const config = {
  // music-bot 自身监听
  host: env('MUSIC_HOST', '0.0.0.0'),
  port: parseInt(env('MUSIC_BOT_PORT', '3200'), 10),

  // api-enhanced（网易云 API）内网地址
  apiBase: env('NCMAPI_BASE', 'http://neteasemusic:3000'),

  // 数据持久化目录（cookie / 队列 / 桥接配置）
  dataDir: env('MUSIC_DATA_DIR', '/app/data'),

  // 图片代理上游：留空则 music-bot 直接抓取封面；
  // 若 music-bot 容器无外网，可指向 neteasemusic 容器内已开好的图片代理
  // （如 http://neteasemusic:3100），借助其外网出口绕过防盗链。
  imgProxy: env('NETEASE_IMG_PROXY', ''),

  // TS3AudioBot（点歌机器人语音引擎）对接。以下均有默认值，开箱即用，
  // 面板只需填写“频道”。改 .env 可覆盖；面板保存的配置会持久化覆盖这里。
  ts3abUrl: env('TS3AB_URL', 'http://ts3audiobot:58913'),
  // 每个频道固定部署一个点歌机器人 + 一个点歌助手（一频道一套，不跨频道移动）。
  // 逗号分隔的频道路径列表。
  ts3abChannels: String(env('TS3AB_CHANNELS', ''))
    .split(',').map((s) => s.trim()).filter(Boolean),
  // 已创建机器人的固定绑定：{ 频道路径: 机器人模板名 }（持久化，避免重复建）
  ts3abChannelBots: {},
  // 点歌机器人昵称：TS 里显示的名字。多频道时自动加「·频道名」后缀。
  // 面板可编辑并持久化。
  ts3abBotNickname: env('TS3AB_BOT_NICKNAME', '点歌机器人'),
  // TS3AudioBot 拉取本服务音频流所用的地址（引擎无 SSRF 限制，内网地址即可）。
  // 主机名会在建连时自动解析为 IP（TS3AudioBot 自带 DNS 解析器不认容器名）。
  streamBotUrl: env('STREAM_BOT_URL', 'http://' + env('STREAM_BOT_HOST', 'music') + ':3200/api/stream'),
  // 面板「收听」按钮等对外展示用的电台流地址（可选；机器人拉流不依赖它）。
  streamPublicUrl: env('STREAM_PUBLIC_URL', 'http://' + env('STREAM_PUBLIC_HOST', 'music') + ':3200/api/stream'),
  // 音频流访问令牌安全开关：开启时要求 ?t=<token>，防公网随意收听；面板可开关并生成显示。
  streamTokenEnabled: process.env.STREAM_TOKEN_ENABLED !== undefined
    ? process.env.STREAM_TOKEN_ENABLED !== '0'
    : true,
  streamToken: env('STREAM_TOKEN', ''),
  // 电台流编码质量（music-bot 输出给 TS3AudioBot 的“源音频”；引擎会再编码为 Opus 推入 TS，
  // 因此源质量越高，最终 TS 音质越好）。默认 320k / 48k / 立体声；
  // 如服务器出网带宽吃紧可调低比特率。
  audioCodec: env('STREAM_AUDIO_CODEC', 'libmp3lame'),
  audioBitrate: env('STREAM_AUDIO_BITRATE', '320k'),
  audioRate: parseInt(env('STREAM_AUDIO_RATE', '48000'), 10),
  audioChannels: parseInt(env('STREAM_AUDIO_CHANNELS', '2'), 10),
  // 频道无人时自动暂停、有人进入自动恢复（默认开启；面板可关）
  autoPauseEmpty: env('AUTO_PAUSE_EMPTY', 'true') !== 'false',
  // TeamSpeak 3 服务器连接信息（ServerQuery）
  tsHost: env('TS_HOST', 'teamspeak'),
  tsQueryPort: parseInt(env('TS_QUERY_PORT', '10011'), 10),
  // TS 服务器管理员密码（聊天点歌与机器人频道解析都需要；也可在面板点歌页填写）
  tsQueryAdminPassword: env('TS_QUERY_ADMIN_PASSWORD', ''),
  // 机器人要加入的频道密码（频道设了密码时需填；点歌助手 clientmove 与点歌机器人加入都要用）
  ts3abChannelPassword: env('TS_CHANNEL_PASSWORD', ''),
  // TS 频道聊天点歌开关：默认随密码存在而启用；面板可覆盖并持久化
  tsChatEnabled: process.env.TS_CHAT_ENABLED !== undefined
    ? process.env.TS_CHAT_ENABLED !== '0'
    : true,
  // 聊天点歌可用指令（面板管理哪些可用）：点歌/播放/暂停/切歌/循环
  chatCommands: Object.assign({}, CHAT_CMD_DEFAULT),
};

// 持久化桥接配置（面板可编辑，覆盖上面的环境变量）。空串不覆盖默认值。
const tsBridgeFile = path.join(config.dataDir, 'tsbridge.json');
function loadTsBridge() {
  try {
    const o = JSON.parse(fs.readFileSync(tsBridgeFile, 'utf8'));
    if (o.ts3abUrl) config.ts3abUrl = o.ts3abUrl;
    if (Array.isArray(o.ts3abChannels)) {
      config.ts3abChannels = o.ts3abChannels.map((s) => String(s).trim()).filter(Boolean);
    }
    if (o.ts3abChannelBots && typeof o.ts3abChannelBots === 'object') {
      config.ts3abChannelBots = o.ts3abChannelBots;
    }
    if (o.ts3abBotNickname) config.ts3abBotNickname = o.ts3abBotNickname;
    if (o.tsHost) config.tsHost = o.tsHost;
    if (o.tsQueryPort != null) config.tsQueryPort = parseInt(o.tsQueryPort, 10);
    // 密码优先级：环境变量 > 页面保存值（页面值仅在环境变量为空时生效）。
    // 否则 .env 设了新密码后，页面里存过的旧值会悄悄覆盖它，导致两边不一致。
    if (o.tsQueryAdminPassword && !process.env.TS_QUERY_ADMIN_PASSWORD) {
      config.tsQueryAdminPassword = o.tsQueryAdminPassword;
    }
    if (o.ts3abChannelPassword) config.ts3abChannelPassword = o.ts3abChannelPassword;
    if (o.tsChatEnabled != null) config.tsChatEnabled = !!o.tsChatEnabled;
    if (o.chatCommands && typeof o.chatCommands === 'object') {
      config.chatCommands = Object.assign({}, CHAT_CMD_DEFAULT, o.chatCommands);
    }
    if (o.streamTokenEnabled != null) config.streamTokenEnabled = !!o.streamTokenEnabled;
    if (o.streamToken) config.streamToken = o.streamToken;
    if (o.streamBotUrl) config.streamBotUrl = o.streamBotUrl;
    if (o.audioCodec) config.audioCodec = o.audioCodec;
    if (o.audioBitrate) config.audioBitrate = o.audioBitrate;
    if (o.audioRate != null) config.audioRate = parseInt(o.audioRate, 10);
    if (o.audioChannels != null) config.audioChannels = parseInt(o.audioChannels, 10);
    if (o.autoPauseEmpty != null) config.autoPauseEmpty = !!o.autoPauseEmpty;
  } catch (e) { /* 无持久化配置 */ }
}
loadTsBridge();
config.saveTsBridge = (o) => {
  const next = {
    ts3abUrl: (o.ts3abUrl || '').trim() || config.ts3abUrl,
    // 频道列表：传数组则整体替换（允许清空为 []）；不传保持原值
    ts3abChannels: Array.isArray(o.ts3abChannels)
      ? o.ts3abChannels.map((s) => String(s).trim()).filter(Boolean)
      : (Array.isArray(config.ts3abChannels) ? config.ts3abChannels.slice() : []),
    // 频道→机器人模板名 固定绑定：传对象则整体替换；不传保持原值
    ts3abChannelBots: (o.ts3abChannelBots && typeof o.ts3abChannelBots === 'object')
      ? o.ts3abChannelBots
      : (config.ts3abChannelBots || {}),
    ts3abBotNickname: (o.ts3abBotNickname || '').trim() || config.ts3abBotNickname,
    tsHost: (o.tsHost || '').trim() || config.tsHost,
    tsQueryPort: o.tsQueryPort != null ? parseInt(o.tsQueryPort, 10) : config.tsQueryPort,
    tsQueryAdminPassword: (o.tsQueryAdminPassword || '').trim() || config.tsQueryAdminPassword,
    ts3abChannelPassword: (o.ts3abChannelPassword || '').trim() || config.ts3abChannelPassword,
    tsChatEnabled: o.tsChatEnabled != null ? !!o.tsChatEnabled : (config.tsChatEnabled !== false),
    chatCommands: Object.assign({}, CHAT_CMD_DEFAULT,
      (o.chatCommands && typeof o.chatCommands === 'object') ? o.chatCommands : (config.chatCommands || {})),
    streamTokenEnabled: o.streamTokenEnabled != null ? !!o.streamTokenEnabled : (config.streamTokenEnabled !== false),
    streamToken: (o.streamToken || '').trim() || config.streamToken,
    streamBotUrl: (o.streamBotUrl || '').trim() || config.streamBotUrl,
    audioCodec: (o.audioCodec || '').trim() || config.audioCodec,
    audioBitrate: (o.audioBitrate || '').trim() || config.audioBitrate,
    audioRate: o.audioRate != null ? parseInt(o.audioRate, 10) : config.audioRate,
    audioChannels: o.audioChannels != null ? parseInt(o.audioChannels, 10) : config.audioChannels,
    autoPauseEmpty: o.autoPauseEmpty != null ? !!o.autoPauseEmpty : config.autoPauseEmpty,
  };
  Object.assign(config, next);
  try { fs.writeFileSync(tsBridgeFile, JSON.stringify(next, null, 2)); } catch (e) { /* 忽略 */ }
  return next;
};

module.exports = { config };
