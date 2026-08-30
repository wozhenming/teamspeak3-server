'use strict';

const express = require('express');
const path = require('path');
const { config, warnings } = require('./config');
const auth = require('./auth');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// ---------- 会话 ----------
app.use((req, res, next) => {
  req.sessionToken = auth.getSessionToken(req);
  req.session = req.sessionToken ? auth.getRequestSession(req) : null;
  next();
});

// ---------- API 路由 ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const token = auth.login(username, password);
  if (!token) {
    return res.status(401).json({ ok: false, error: { code: 'BAD_CREDENTIALS', message: '用户名或密码错误' } });
  }
  const maxAge = auth.SESSION_TTL_MS;
  res.setHeader(
    'Set-Cookie',
    `${auth.COOKIE_NAME}=${auth.sessionCookieValue(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAge / 1000)}`
  );
  res.json({ ok: true, data: { username } });
});

app.post('/api/logout', (req, res) => {
  if (req.sessionToken) auth.logout(req.sessionToken);
  res.setHeader('Set-Cookie', `${auth.COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', auth.requireAuth, (req, res) => {
  res.json({ ok: true, data: { username: req.session.username } });
});

// ---------- 业务 API（受面板认证保护） ----------
const apiRouter = express.Router();
apiRouter.use(auth.requireAuth);
app.use('/api', apiRouter);

apiRouter.use('/overview', require('./routes/overview'));
apiRouter.use('/servers', require('./routes/servers'));
apiRouter.use('/servers/:sid/clients', require('./routes/clients'));
apiRouter.use('/servers/:sid/channels', require('./routes/channels'));
apiRouter.use('/deploy', require('./routes/deploy'));
apiRouter.use('/stats', require('./routes/stats'));
apiRouter.use('/music', require('./routes/music'));

// ---------- 静态资源 ----------
app.use(express.static(config.publicDir));

// ---------- 统一错误处理 ----------
app.use((err, req, res, next) => {
  const status = err.status || 500;
  console.error(`[panel] 请求失败 ${req.method} ${req.originalUrl}:`, err.message);
  res.status(status).json({ ok: false, error: { code: err.code || 'INTERNAL', message: err.message || '服务器内部错误' } });
});

// ---------- 启动 ----------
// 指标采样器（仪表盘历史图表 / 最近加入用户）
require('./metrics').start();

app.listen(config.port, config.host, () => {
  console.log('==============================================');
  console.log(` TeamSpeak 3 管理面板已启动`);
  console.log(` 地址: http://${config.host}:${config.port}`);
  console.log(` ServerQuery: ${config.tsQueryHost}:${config.tsQueryPort}${config.tsQueryPassword ? ' (密码已配置)' : ' (未配置密码)'}`);
  console.log('----------------------------------------------');
  for (const w of warnings) console.log(` [警告] ${w}`);
  console.log('==============================================');
});
