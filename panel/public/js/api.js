'use strict';

/**
 * 面板前端 API 封装。
 * 所有请求都经由面板后端代理，浏览器不直接接触 TS3 服务器（查询密码只存在面板后端）。
 */

const API = (function () {
  async function request(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new Error('无法连接管理面板，请检查面板服务是否运行');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
    if (res.status === 401) {
      // 会话失效：跳转登录页
      if (location.pathname.endsWith('login.html')) {
        throw new Error('登录失败');
      }
      location.href = '/login.html';
      throw new Error('会话已过期，请重新登录');
    }
    if (!res.ok || !json || !json.ok) {
      const msg = (json && json.error && json.error.message) || ('请求失败 (HTTP ' + res.status + ')');
      const err = new Error(msg);
      if (json && json.error && json.error.code) err.code = json.error.code;
      throw err;
    }
    return json.data;
  }

  return {
    login: (username, password) => request('POST', '/api/login', { username, password }),
    logout: () => request('POST', '/api/logout'),
    me: () => request('GET', '/api/me'),

    overview: (sid) => request('GET', `/api/overview?sid=${encodeURIComponent(sid)}`),
    overviewHistory: (minutes) => request('GET', `/api/overview/history?minutes=${minutes || 60}`),
    recentClients: () => request('GET', '/api/overview/recent-clients'),
    servers: () => request('GET', '/api/servers'),
    editServer: (sid, name) => request('PUT', `/api/servers/${sid}`, { virtualserver_name: name }),

    // 用户管理
    clients: (sid) => request('GET', `/api/servers/${sid}/clients`),
    kickClient: (sid, clid, reason) => request('POST', `/api/servers/${sid}/clients/${clid}/kick`, { reason }),
    banClient: (sid, clid, params) => request('POST', `/api/servers/${sid}/clients/${clid}/ban`, params),
    moveClient: (sid, clid, cid) => request('POST', `/api/servers/${sid}/clients/${clid}/move`, { cid }),
    pokeClient: (sid, clid, msg) => request('POST', `/api/servers/${sid}/clients/${clid}/poke`, { msg }),
    sendMessage: (sid, clid, msg) => request('POST', `/api/servers/${sid}/clients/${clid}/message`, { msg }),

    // 频道管理
    channels: (sid) => request('GET', `/api/servers/${sid}/channels`),
    createChannel: (sid, data) => request('POST', `/api/servers/${sid}/channels`, data),
    editChannel: (sid, cid, data) => request('PUT', `/api/servers/${sid}/channels/${cid}`, data),
    deleteChannel: (sid, cid) => request('DELETE', `/api/servers/${sid}/channels/${cid}`),

    // 部署管理
    deployStatus: (name) => request('GET', `/api/deploy/status${name ? '?name=' + encodeURIComponent(name) : ''}`),
    deployPreview: (p) => request('GET', '/api/deploy/preview?' + Object.keys(p || {}).map(k => `${k}=${encodeURIComponent(p[k] == null ? '' : p[k])}`).join('&')),
    deployCompose: (data) => request('POST', '/api/deploy/compose', data),
    deployUp: () => request('POST', '/api/deploy/up'),
    deployDown: () => request('POST', '/api/deploy/down'),
    deployRestart: () => request('POST', '/api/deploy/restart'),
    deployTask: (id) => request('GET', `/api/deploy/task/${id}`),
    deployLogs: (tail) => request('GET', `/api/deploy/logs?tail=${tail || 300}`),
    deployCredentials: () => request('GET', '/api/deploy/credentials'),
    deploySetPassword: (password) => request('POST', '/api/deploy/password', { password }),
    deployCheck: () => request('GET', '/api/deploy/check'),

    // 数据统计
    statsOverview: () => request('GET', '/api/stats/overview'),
    statsConnections: (limit) => request('GET', `/api/stats/connections?limit=${limit || 200}`),

    // 点歌机器人
    musicStatus: () => request('GET', '/api/music/status'),
    musicLogout: () => request('POST', '/api/music/logout'),
    musicQrCreate: () => request('POST', '/api/music/qr/create'),
    musicQrCheck: (key) => request('GET', `/api/music/qr/check?key=${encodeURIComponent(key)}`),
    musicSearch: (q, type, limit, offset) => request('GET', `/api/music/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit || 20}&offset=${offset || 0}`),
    musicPlaylistTracks: (id, limit) => request('GET', `/api/music/playlist/tracks?id=${id}&limit=${limit || 30}`),
    musicPlaylistTracksAll: (id, cap) => request('GET', `/api/music/playlist/tracks-all?id=${id}&cap=${cap || 2000}`),
    // 点歌队列/播放器（按频道隔离，ch = 部署频道路径）
    musicQueue: (ch, page, pageSize, q) => request('GET', `/api/music/queue?ch=${encodeURIComponent(ch || '')}&page=${page || 1}&pageSize=${pageSize || 10}&q=${encodeURIComponent(q || '')}`),
    musicEnqueue: (ch, song) => request('POST', '/api/music/queue', { ...song, ch }),
    musicEnqueueMany: (ch, songs, requestedBy) => request('POST', '/api/music/queue', { ch, songs, requestedBy }),
    musicDequeue: (ch, id) => request('DELETE', `/api/music/queue/${id}?ch=${encodeURIComponent(ch || '')}`),
    musicClearQueue: (ch) => request('DELETE', `/api/music/queue?ch=${encodeURIComponent(ch || '')}`),

    // 播放器（按频道隔离）
    musicPlayer: (ch) => request('GET', `/api/music/player?ch=${encodeURIComponent(ch || '')}`),
    musicPlay: (ch, id) => request('POST', `/api/music/player/play?ch=${encodeURIComponent(ch || '')}`, { id }),
    musicToggle: (ch) => request('POST', `/api/music/player/toggle?ch=${encodeURIComponent(ch || '')}`),
    musicPause: (ch) => request('POST', `/api/music/player/pause?ch=${encodeURIComponent(ch || '')}`),
    musicResume: (ch) => request('POST', `/api/music/player/resume?ch=${encodeURIComponent(ch || '')}`),
    musicSeek: (ch, position) => request('POST', `/api/music/player/seek?ch=${encodeURIComponent(ch || '')}`, { position }),
    musicNext: (ch) => request('POST', `/api/music/player/next?ch=${encodeURIComponent(ch || '')}`),
    musicPrev: (ch) => request('POST', `/api/music/player/prev?ch=${encodeURIComponent(ch || '')}`),
    musicLoop: (ch, mode) => request('POST', `/api/music/player/loop?ch=${encodeURIComponent(ch || '')}`, { mode }),

    // 点歌机器人接入 TeamSpeak（TS3AudioBot 语音引擎）
    musicTsStatus: () => request('GET', '/api/music/ts-bot/status'),
    musicTsConfig: () => request('GET', '/api/music/ts-bot/config'),
    musicTsSaveConfig: (cfg) => request('PUT', '/api/music/ts-bot/config', cfg),
    musicTsLink: () => request('POST', '/api/music/ts-bot/link'),
    musicTsDeleteBot: () => request('DELETE', '/api/music/ts-bot/bot'),
    musicTsUnlink: () => request('POST', '/api/music/ts-bot/unlink'),
    musicTsChannels: () => request('GET', '/api/music/ts-bot/channels'),
    musicTsChatStatus: () => request('GET', '/api/music/ts-bot/chat/status'),

    // 图片代理：返回同源 URL，绕过网易云外链防盗链 / 混合内容限制
    // size 形如 '80y80'，会拼到网易云封面 URL 的 ?param= 上以控制分辨率
    musicImg: (u, size) => {
      let t = u || '';
      if (size) t += (t.indexOf('?') >= 0 ? '&' : '?') + 'param=' + size;
      return '/api/music/img?u=' + encodeURIComponent(t);
    },
  };
})();
