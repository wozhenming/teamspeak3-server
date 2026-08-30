# NetEase Cloud Music API (api-enhanced) 镜像
# 构建：docker compose build neteasemusic（或 up -d 自动构建）
# 来源：https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced
# 仅在内网监听（供 panel / music-bot 连接），不暴露宿主端口
#
# 针对国内网络：npm/pnpm 使用 npmmirror 镜像源，git clone 失败时回退代理镜像

FROM node:20-alpine

RUN apk add --no-cache git tini

# 切换到国内 npm 镜像源（registry.npmjs.org 直连常超时）
RUN npm config set registry https://registry.npmmirror.com \
    && npm i -g pnpm@9 --registry=https://registry.npmmirror.com

ENV NODE_ENV=production \
    PORT=3000

# 克隆源码（github 直连失败时回退到 gh 代理镜像）
RUN git clone --depth 1 https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git /app \
    || git clone --depth 1 https://ghfast.top/https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git /app \
    || git clone --depth 1 https://gh-proxy.com/https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git /app

WORKDIR /app

# pnpm 也走镜像源；frozen 失败回退到宽松安装
RUN pnpm config set registry https://registry.npmmirror.com \
    && (pnpm install --frozen-lockfile --prod --ignore-scripts 2>/dev/null \
        || pnpm install --no-frozen-lockfile --prod --ignore-scripts)

COPY music/ncm-start.js /app/ncm-start.js

EXPOSE 3000

CMD ["/sbin/tini", "--", "node", "ncm-start.js"]