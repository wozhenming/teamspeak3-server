FROM node:20-alpine
# 切换到国内 Alpine 软件源（阿里云），加速 apk 安装（ffmpeg 等）。
# 只替换主机名、保留版本路径，兼容不同 alpine 版本。
RUN sed -i 's#dl-cdn.alpinelinux.org#mirrors.aliyun.com#g' /etc/apk/repositories
# 转码音频为稳定 MP3 流（点歌机器人作为电台源拉流所需）。
# 放在最前：这一层只依赖基础镜像，不会因源码/依赖变更而失效，避免每次 build 都重装 ffmpeg。
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
# 国内网络自动回退镜像源
RUN npm config set registry https://registry.npmmirror.com \
    && npm install --no-audit --no-fund
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3200
CMD ["node", "src/index.js"]