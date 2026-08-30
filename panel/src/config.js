'use strict';

const path = require('path');
const fs = require('fs');

// 配置文件路径：容器内由 PANEL_ENV_FILE 指向持久化 volume（重启不丢），本地默认 panel/.env
const envFile = process.env.PANEL_ENV_FILE || path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envFile });

function env(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** 从持久化配置文件中读取查询密码（环境变量为空时的回退，保证部署页保存后重启仍生效） */
function readPasswordFromEnvFile(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const m = txt.match(/^TSSERVER_QUERY_PASSWORD=(.*)$/m);
    return m ? m[1].trim() : '';
  } catch (e) {
    return '';
  }
}

const config = {
  // 面板自身
  host: env('HOST', '127.0.0.1'),
  port: parseInt(env('PORT', '3000'), 10),
  panelUsername: env('PANEL_USERNAME', 'admin'),
  panelPassword: env('PANEL_PASSWORD', 'admin123'),
  sessionSecret: env('SESSION_SECRET', 'please-change-me'),

  // TeamSpeak 3 ServerQuery（原始 TCP，默认 10011）
  tsQueryHost: env('TSSERVER_QUERY_HOST', '127.0.0.1'),
  tsQueryPort: parseInt(env('TSSERVER_QUERY_PORT', '10011'), 10),
  tsQueryUser: env('TSSERVER_QUERY_USER', 'serveradmin'),
  tsQueryPassword: (() => {
    const k = env('TSSERVER_QUERY_PASSWORD', '');
    return k || readPasswordFromEnvFile(envFile);
  })(),
  tsDefaultSid: parseInt(env('TSSERVER_DEFAULT_SID', '1'), 10),

  // 部署管理
  deployDir: env('DEPLOY_DIR', path.join(__dirname, '..', '..', 'deploy')),
  // 容器化模式（container=由根目录 docker-compose 管理，部署页操作主机 Docker 容器）
  runMode: env('PANEL_RUN_MODE', 'standalone'),
  // TS3 容器名（容器化模式下读取日志/凭证、快捷启停）
  tsContainerName: env('TSSERVER_CONTAINER_NAME', 'teamspeak-server'),

  // 派生路径
  publicDir: path.join(__dirname, '..', 'public'),
  // 初始管理员凭证持久化文件（与配置文件同目录：容器内为数据卷）
  credentialFile: path.join(path.dirname(envFile), 'ts3-credentials.txt'),
  // 指标采样历史持久化文件（仪表盘图表重启不丢）
  metricsFile: path.join(path.dirname(envFile), 'ts3-metrics.json'),

  // 点歌机器人（music-bot）内网地址（后端代理）
  musicBaseUrl: env('MUSIC_BASE_URL', 'http://music:3200'),
};

/**
 * 运行时更新 serveradmin 查询密码：立即生效（内存）并持久化到配置文件。
 * 容器内写入 /app/config/panel.env（volume），重启不丢失。
 */
function setQueryPassword(password) {
  config.tsQueryPassword = String(password || '').trim();
  try {
    let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    const re = /^TSSERVER_QUERY_PASSWORD=.*$/m;
    if (re.test(content)) {
      content = content.replace(re, `TSSERVER_QUERY_PASSWORD=${config.tsQueryPassword}`);
    } else {
      content += (content.endsWith('\n') ? '' : '\n') + `TSSERVER_QUERY_PASSWORD=${config.tsQueryPassword}\n`;
    }
    fs.writeFileSync(envFile, content, 'utf8');
  } catch (err) {
    // 持久化失败不阻断（本次运行仍生效）
    console.warn('[config] 无法写入配置文件（查询密码仅在本次运行生效）:', err.message);
  }
  return config.tsQueryPassword;
}

// 启动时的安全提示（不阻断启动）
const warnings = [];
if (config.panelPassword === 'admin123') {
  warnings.push('面板使用默认密码 admin/admin123，请立即修改 PANEL_PASSWORD！');
}
if (config.sessionSecret === 'please-change-me') {
  warnings.push('SESSION_SECRET 使用默认值，请修改为随机字符串！');
}
if (!config.tsQueryPassword) {
  warnings.push('未配置 TSSERVER_QUERY_PASSWORD，请进入「部署管理」页填写 serveradmin 密码。');
}

module.exports = { config, warnings, setQueryPassword, envFile };
