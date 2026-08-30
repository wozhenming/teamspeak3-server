'use strict';

/**
 * 面板自带认证：内存会话 + HMAC 签名 Cookie。
 * 设计说明：管理面板的认证与 TeamSpeak 6 原生认证完全隔离，
 * 登录凭证来自 .env（PANEL_USERNAME / PANEL_PASSWORD）。
 */

const crypto = require('crypto');
const { config } = require('./config');

const COOKIE_NAME = 'tspanel_sid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时

// token -> { username, createdAt, expiresAt }
const sessions = new Map();

function hmac(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

function sign(token) {
  return `${token}.${hmac(token)}`;
}

function unsign(value) {
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null;
  const token = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  // 恒定时间比较，防止时序攻击
  const expected = hmac(token);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return token;
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { username, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** 从请求中解析并校验会话 token；未登录返回 null */
function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const token = unsign(raw);
  if (!token) return null;
  return getSession(token) ? token : null;
}

/** 从请求中解析会话；未登录返回 null */
function getRequestSession(req) {
  const token = getSessionToken(req);
  return token ? getSession(token) : null;
}

/** Express 中间件：API 认证 */
function requireAuth(req, res, next) {
  const token = getSessionToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: '未登录或会话已过期' } });
  }
  req.session = getSession(token);
  req.sessionToken = token;
  next();
}

function login(username, password) {
  const u = Buffer.from(String(username));
  const p = Buffer.from(String(password));
  const eu = Buffer.from(config.panelUsername);
  const ep = Buffer.from(config.panelPassword);
  const okUser = u.length === eu.length && crypto.timingSafeEqual(u, eu);
  const okPass = p.length === ep.length && crypto.timingSafeEqual(p, ep);
  if (!okUser || !okPass) return null;
  return createSession(username);
}

function logout(token) {
  destroySession(token);
}

function sessionCookieValue(token) {
  return sign(token);
}

module.exports = {
  COOKIE_NAME,
  login,
  logout,
  requireAuth,
  getRequestSession,
  getSessionToken,
  sessionCookieValue,
  SESSION_TTL_MS,
};
