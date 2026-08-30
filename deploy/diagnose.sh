#!/usr/bin/env bash
# ============================================================================
# 一键诊断脚本：面板 / 点歌机器人连不上 TeamSpeak 时使用
#
# 用法：cd 项目根目录 && bash deploy/diagnose.sh
# 只读操作，不会修改任何容器与数据。
#
# 排查逻辑（与 .env / 页面保存密码的优先级规则一致）：
#   1. TS3 的实际 serveradmin 密码 = .env 的 TS_QUERY_ADMIN_PASSWORD（每次启动都会
#      应用）；.env 未设置时 = 首次启动日志里生成的随机密码；
#   2. panel / music 的生效密码 = 容器环境变量；环境变量为空时回落到各自数据卷里
#      页面保存的值（panel.env / music 的 tsbridge.json，优先级高于 .env）；
#   3. 三者必须一致，否则出现 520 invalid login / 3329 自动封禁。
# ============================================================================

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_RESET=$'\033[0m'
ok()   { printf '%s[+]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
bad()  { printf '%s[!]%s %s\n' "$C_RED" "$C_RESET" "$*"; }
info() { printf '%s[*]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
mask() { local s="$1"; if [ -z "$s" ]; then echo "(空)"; else echo "${s:0:2}***${s: -2}（长度 ${#s}）"; fi }

TS_CONTAINER="${TS_CONTAINER_NAME:-teamspeak-server}"
PANEL_CONTAINER="${PANEL_CONTAINER_NAME:-ts3-panel}"
MUSIC_CONTAINER="${MUSIC_CONTAINER_NAME:-ts3-music-bot}"

# 容器名可被 .env 覆盖（与 compose 的默认值保持一致）；.env 未设置时用默认名
getenv() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r'; }
TS_CONTAINER="$(getenv TS_CONTAINER_NAME)"; [ -n "$TS_CONTAINER" ] || TS_CONTAINER="teamspeak-server"
PANEL_CONTAINER="$(getenv PANEL_CONTAINER_NAME)"; [ -n "$PANEL_CONTAINER" ] || PANEL_CONTAINER="ts3-panel"
MUSIC_CONTAINER="$(getenv MUSIC_CONTAINER_NAME)"; [ -n "$MUSIC_CONTAINER" ] || MUSIC_CONTAINER="ts3-music-bot"

DC="docker compose"
docker compose version >/dev/null 2>&1 || DC="docker-compose"

info "=== 1. 容器状态（重点看 teamspeak 是否 Restarting） ==="
docker ps -a --format 'table {{.Names}}\t{{.Status}}' | grep -E "$TS_CONTAINER|$PANEL_CONTAINER|$MUSIC_CONTAINER|ts3audiobot|neteasemusic" || bad "没有发现本项目的容器（先 docker compose up -d）"

info "=== 2. .env 里的 TS_QUERY_ADMIN_PASSWORD ==="
ENV_PWD="$(grep -E '^TS_QUERY_ADMIN_PASSWORD=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true)"
if [ -n "$ENV_PWD" ]; then
  ok "已设置：$(mask "$ENV_PWD")"
else
  bad "未设置——TS3 首次启动会生成随机密码，需要在面板「部署管理」和「点歌页」两处手动填写"
fi

info "=== 3. TS3 首次启动日志里的生成密码 ==="
LOG_PWD="$(docker logs "$TS_CONTAINER" 2>&1 | grep -a 'password=' | tail -1 | sed 's/.*password= *"//;s/".*//' || true)"
if [ -n "$LOG_PWD" ]; then
  ok "$(mask "$LOG_PWD")"
else
  info "日志里没有密码行（设置过 TS_QUERY_ADMIN_PASSWORD 时不打印，属正常）"
fi

info "=== 4. TS3 是否正常监听（无 license 崩溃循环） ==="
if docker logs --tail 30 "$TS_CONTAINER" 2>&1 | grep -q 'listening for query'; then
  ok "Query 正在监听"
else
  bad "日志末尾没有 listening for query —— 容器可能在崩溃循环，最后 12 行："
  docker logs --tail 12 "$TS_CONTAINER" 2>&1
  bad "常见原因：镜像过旧（3.13.6 内置许可已过期，需 teamspeak:3.13.8）/ 白名单文件挂载失败"
fi

# TS3 实际生效密码：.env 优先（每次启动都会应用），其次首启生成的随机密码
EXPECTED_PWD="$ENV_PWD"
[ -z "$EXPECTED_PWD" ] && EXPECTED_PWD="$LOG_PWD"

info "=== 5. panel 实际生效的密码 ==="
PANEL_PWD="$(docker exec "$PANEL_CONTAINER" node -e "console.log(require('./src/config').config.tsQueryPassword)" 2>/dev/null || true)"
ok "$(mask "$PANEL_PWD")"

info "=== 6. panel → TS3 认证测试 ==="
docker exec "$PANEL_CONTAINER" node -e "require('./src/ts3query').ts.version().then(v=>{console.log('OK: TeamSpeak '+v.version);process.exit(0)}).catch(e=>{console.log('ERR:',e.message);process.exit(1)})"

info "=== 7. music 实际生效的密码 ==="
MUSIC_PWD="$(docker exec "$MUSIC_CONTAINER" node -e "console.log(require('./src/config').config.tsQueryAdminPassword)" 2>/dev/null || true)"
ok "$(mask "$MUSIC_PWD")"

info "=== 8. music 数据卷里页面保存的密码（优先级高于 .env） ==="
docker exec "$MUSIC_CONTAINER" node -e "
const fs=require('fs');
try{const o=JSON.parse(fs.readFileSync('/app/data/tsbridge.json','utf8'));
console.log(o.tsQueryAdminPassword?('有：'+o.tsQueryAdminPassword.slice(0,2)+'***（与 .env 不一致时会覆盖 .env！）'):'无');}catch(e){console.log('无 tsbridge.json');}"

info "=== 9. 最近 10 条错误日志 ==="
$DC logs --tail 300 2>/dev/null | grep -aiE 'error|断开|失败|banned|invalid' | tail -10 || info "（无）"

info "=== 10. 结论对照 ==="
if [ -z "$EXPECTED_PWD" ]; then
  bad "无法确定 TS3 的实际密码（.env 未设置且日志无密码行）——先在 .env 设置 TS_QUERY_ADMIN_PASSWORD 并 docker compose up -d"
elif [ "$PANEL_PWD" = "$EXPECTED_PWD" ] && [ -n "$PANEL_PWD" ]; then
  ok "panel 密码与 TS3 一致"
else
  bad "panel 密码与 TS3 不一致（第 5 项 vs 期望值）——到面板「部署管理 → 查询密码配置」保存正确密码并检查 .env"
fi
if [ "$MUSIC_PWD" = "$EXPECTED_PWD" ] && [ -n "$MUSIC_PWD" ]; then
  ok "music 密码与 TS3 一致"
else
  bad "music 密码与 TS3 不一致（第 7 项 vs 期望值）——到面板「点歌页 → 机器人管理 → 查询密码」保存正确密码"
fi
info "提示：改 .env 后需 docker compose up -d 重建容器才会生效；页面保存的密码立即生效但会优先于 .env，两边不要填不同的值。"
