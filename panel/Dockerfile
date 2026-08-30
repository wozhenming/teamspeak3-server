# TeamSpeak 3 管理面板镜像
# 构建：docker compose build panel（或直接 docker compose up -d 自动构建）

FROM node:20-alpine

# 说明：面板容器不安装 docker CLI —— 容器化模式下通过挂载的
# /var/run/docker.sock 直连 Docker Engine API（见 src/docker-api.js），
# 因此镜像无 apk 依赖，构建快、体积小、不依赖系统包源网络。

WORKDIR /app

COPY package.json package-lock.json ./
# 依赖安装：默认官方源；网络不通时自动切换国内镜像源重试
RUN npm ci --omit=dev --no-audit --no-fund \
    || (npm config set registry https://registry.npmmirror.com \
        && npm ci --omit=dev --no-audit --no-fund)

COPY src ./src
COPY public ./public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
