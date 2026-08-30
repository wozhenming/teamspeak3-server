#!/usr/bin/env bash
# ============================================================================
# TeamSpeak 3 Server 一键部署脚本 (Linux / Docker Compose)
#
# 功能：
#   1. 检测 Docker 与 Docker Compose，缺失时按发行版给出安装指引
#   2. 生成 docker-compose.yml（端口/目录可通过环境变量覆盖）
#   3. 执行 docker compose up -d 启动服务
#   4. 从容器日志中自动提取初始管理员凭证并展示
#   5. 输出 serveradmin 查询密码使用指引（管理面板必需）
#
# 用法：
#   ./install.sh            # 一键安装
#   ./install.sh status     # 查看容器状态
#   ./install.sh logs       # 跟踪容器日志
#   ./install.sh help       # 帮助
#
# 可覆盖的环境变量：
#   TS_INSTALL_DIR          安装目录（默认：脚本所在目录）
#   TS_CONTAINER_NAME       容器名（默认：teamspeak-server）
#   TS_PORT_VOICE           语音端口 9987/udp（默认 9987）
#   TS_PORT_FILE            文件传输端口 30033/tcp（默认 30033）
#   TS_PORT_QUERY           ServerQuery 端口 10011/tcp（默认 10011，可留空禁用宿主映射）
#   TS_LICENSE_ACCEPTED     许可证接受标记（默认 accept）
# ============================================================================

set -euo pipefail

# ---------- 颜色输出 ----------
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_BOLD=""; C_RESET=""
fi
info()  { printf '%s[*]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()    { printf '%s[+]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s[!]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail()  { printf '%s[x]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }

# ---------- 配置 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${TS_INSTALL_DIR:-$SCRIPT_DIR}"
CONTAINER_NAME="${TS_CONTAINER_NAME:-teamspeak-server}"
PORT_VOICE="${TS_PORT_VOICE:-9987}"
PORT_FILE="${TS_PORT_FILE:-30033}"
PORT_QUERY="${TS_PORT_QUERY:-10011}"
LICENSE_ACCEPTED="${TS_LICENSE_ACCEPTED:-accept}"

COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ---------- Docker 检测与引导 ----------
detect_docker() {
  DOCKER_BIN=""
  COMPOSE_CMD=""

  if command -v docker >/dev/null 2>&1; then
    DOCKER_BIN="$(command -v docker)"
  fi

  if [ -n "$DOCKER_BIN" ]; then
    if docker compose version >/dev/null 2>&1; then
      COMPOSE_CMD="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
      COMPOSE_CMD="docker-compose"
    fi
  fi

  if [ -z "$DOCKER_BIN" ]; then
    warn "未检测到 Docker，请先安装 Docker 后重新运行本脚本。"
    guide_install_docker
    return 1
  fi

  if [ -z "$COMPOSE_CMD" ]; then
    warn "已检测到 Docker，但缺少 Docker Compose 插件（v2）或 docker-compose（v1）。"
    guide_install_compose
    return 1
  fi

  ok "Docker:      $("$DOCKER_BIN" --version)"
  ok "Compose:     $("$DOCKER_BIN" compose version 2>/dev/null || docker-compose --version)"
}

# 根据发行版输出安装指引
detect_distro() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    echo "${ID:-unknown}-${VERSION_ID:-}"
  else
    echo "unknown"
  fi
}

guide_install_docker() {
  local distro
  distro="$(detect_distro)"
  info "按发行版安装 Docker："
  case "$distro" in
    ubuntu*|debian*)
      printf '  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2\n'
      printf '  或使用官方脚本：curl -fsSL https://get.docker.com | sudo sh\n'
      ;;
    centos*|rhel*|fedora*|rocky*|almalinux*)
      printf '  sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin\n'
      printf '  （或：sudo yum install -y docker && sudo systemctl enable --now docker）\n'
      ;;
    arch*|manjaro*)
      printf '  sudo pacman -S --needed docker docker-compose\n'
      ;;
    *)
      printf '  请参考官方文档安装 Docker：https://docs.docker.com/engine/install/\n'
      ;;
  esac
  printf '\n安装完成后执行：\n  sudo usermod -aG docker "$USER" && newgrp docker\n'
}

guide_install_compose() {
  local distro
  distro="$(detect_distro)"
  case "$distro" in
    ubuntu*|debian*)
      printf '  sudo apt-get install -y docker-compose-v2\n'
      ;;
    centos*|rhel*|fedora*|rocky*|almalinux*)
      printf '  sudo dnf install -y docker-compose-plugin\n'
      ;;
    arch*|manjaro*)
      printf '  sudo pacman -S --needed docker docker-compose\n'
      ;;
    *)
      printf '  官方二进制安装：https://docs.docker.com/compose/install/\n'
      ;;
  esac
}

# ---------- 生成 docker-compose.yml ----------
generate_compose() {
  if [ -f "$COMPOSE_FILE" ]; then
    warn "已存在 $COMPOSE_FILE，跳过生成（如需重新生成请先删除）。"
    return 0
  fi

  info "生成 $COMPOSE_FILE ..."

  local query_port_line=""
  if [ -n "$PORT_QUERY" ] && [ "$PORT_QUERY" != "0" ]; then
    query_port_line="      - \"127.0.0.1:${PORT_QUERY}:10011/tcp\" # ServerQuery（远程管理去掉 127.0.0.1: 并配好白名单）"
  fi

  # Query 接口 IP 白名单（默认仅本机与内网；远程管理需要加入对应网段）
  local allowlist_mount=""
  if [ ! -f "$INSTALL_DIR/query_ip_allowlist.txt" ]; then
    cat > "$INSTALL_DIR/query_ip_allowlist.txt" <<'EOF'
# TeamSpeak 3 ServerQuery 接口 IP 白名单（每行一个 IP 或 CIDR）
# 远程管理时把来源公网 IP 加入本文件（curl ifconfig.me 查看），
# 然后重启容器：docker compose restart teamspeak
127.0.0.1
::1
172.16.0.0/12
10.0.0.0/8
192.168.0.0/16
EOF
    ok "已生成 query_ip_allowlist.txt（Query 接口 IP 白名单，可按需修改）"
  fi
  allowlist_mount="      - ./query_ip_allowlist.txt:/teamspeak3-server/query_ip_allowlist.txt:ro"

  cat > "$COMPOSE_FILE" <<EOF
version: '3'

services:
  teamspeak:
    image: teamspeak:3.13
    container_name: ${CONTAINER_NAME}
    restart: unless-stopped
    environment:
      - TS3SERVER_LICENSE=${LICENSE_ACCEPTED}  # 接受许可证（免费，最多 32 槽位）
    ports:
      - "${PORT_VOICE}:9987/udp"      # 语音端口（必须）
      - "${PORT_FILE}:30033/tcp"      # 文件传输端口
${query_port_line}
    volumes:
      - teamspeak-data:/teamspeak3-server/     # 数据持久化
${allowlist_mount}

volumes:
  teamspeak-data:
EOF

  ok "docker-compose.yml 已生成（容器名: ${CONTAINER_NAME}）"
}

# ---------- 启动 ----------
start_server() {
  info "拉取镜像并启动服务（首次启动需下载镜像，请耐心等待）..."
  ( cd "$INSTALL_DIR" && $COMPOSE_CMD up -d )
  ok "服务已启动。"
}

# ---------- 等待初始化并提取凭证 ----------
wait_ready_and_extract_credentials() {
  info "等待服务器初始化并提取初始管理员凭证..."

  local logs="" creds="" i
  for i in $(seq 1 60); do
    logs="$(docker logs "$CONTAINER_NAME" 2>&1 || true)"
    creds="$(printf '%s\n' "$logs" | grep -aE 'loginname=|password=|token=' | grep -viE 'license|starting|stopping' | tail -8 || true)"
    if printf '%s\n' "$logs" | grep -qiE 'listening on|started'; then
      break
    fi
    sleep 2
  done

  if [ -z "$creds" ]; then
    creds="$(printf '%s\n' "$logs" | tail -20)"
  fi

  printf '\n'
  info "================ 初始管理员凭证（请立即保存） ================"
  if [ -n "$creds" ]; then
    printf '%s\n' "$creds" | sed 's/^/  /'
  else
    warn "  （未能自动提取，请执行：docker logs ${CONTAINER_NAME} 查看）"
  fi
  info "=============================================================="
  printf '\n'

  # 保存完整启动日志，便于回溯
  docker logs "$CONTAINER_NAME" > "$INSTALL_DIR/ts3-boot.log" 2>&1 || true
  info "完整启动日志已保存到: $INSTALL_DIR/ts3-boot.log"
}

# ---------- 查询密码使用指引 ----------
print_query_guide() {
  printf '\n'
  info "================ serveradmin 查询密码使用指引 ================"
  printf '%s\n' \
    "  管理面板与点歌机器人通过 ServerQuery (端口 ${PORT_QUERY}) 管理服务器，" \
    "  使用上方日志中的 serveradmin 初始密码即可："
  printf '\n'
  printf '  1. 打开管理面板（若已部署）→「部署管理」→「serveradmin 查询密码配置」\n'
  printf '     粘贴上方 serveradmin 密码并保存（立即生效，无需重启）。\n'
  printf '  2. TeamSpeak 客户端首次连接后，用 privilege key（上方 token= 行）\n'
  printf '     获取服务器管理员权限：权限 → 使用特权键。\n'
  printf '\n'
  printf '  安全提示：密码请妥善保管，不要提交到代码仓库。\n'
  info "=============================================================="
  printf '\n'
}

# ---------- 子命令 ----------
cmd_status() {
  docker ps -a --filter "name=${CONTAINER_NAME}" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

cmd_logs() {
  docker logs -f --tail 100 "$CONTAINER_NAME"
}

# ---------- 主流程 ----------
main() {
  case "${1:-install}" in
    install)
      info "TeamSpeak 3 Server 一键部署开始（目录: $INSTALL_DIR）"
      detect_docker || { warn "请先完成 Docker 安装后再运行 ./install.sh"; exit 1; }
      generate_compose
      start_server
      wait_ready_and_extract_credentials
      print_query_guide
      ok "部署完成！语音端口: ${PORT_VOICE}/udp"
      ;;
    status) cmd_status ;;
    logs)   cmd_logs ;;
    help|-h|--help) usage ;;
    *) fail "未知命令: $1（可用命令: install / status / logs / help）"; exit 1 ;;
  esac
}

main "$@"
