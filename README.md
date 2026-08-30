# TeamSpeak 3 服务端管理项目

基于 **TeamSpeak 3 Server（官方 teamspeak 镜像）** 的全栈容器化解决方案：
**TS3 服务器 + Web 管理面板 + 网易云点歌机器人（TS3AudioBot 语音引擎）**，
clone 后一条命令即可完成整个部署。

```
git clone git@github.com:wozhenming/teamspeak3-server.git
cd teamspeak3-server
docker compose up -d          # 一键启动全部服务（自动构建面板/点歌镜像）
```

- 管理面板：http://`<主机IP>`:3000 （默认账号 `admin` / `admin123`，请尽快修改）
- 语音端口：9987/udp · 文件传输：30033 · ServerQuery：10011（仅本机，远程管理需改绑定并配白名单）

> 详细设计背景见 [ts3服务端开发文档.md](./ts3服务端开发文档.md)。

## 首次使用

`docker compose up -d` 启动后，打开管理面板并进入 **「部署管理」** 页：

1. **环境检测**：确认 Docker 引擎与 TS3 容器状态
2. **初始凭证**：自动从 TS3 日志提取 **serveradmin 密码** 与 **privilege key**
   （仅首次启动打印，面板会自动保存副本；若 `.env` 里设置了
   `TS_QUERY_ADMIN_PASSWORD`，则首次启动即用该密码，无需提取）
3. **查询密码**：把 serveradmin 密码粘贴到「serveradmin 查询密码配置」并保存——
   **立即生效、无需重启面板**（持久化到数据卷，重启不丢）
4. 完成后切到 **「仪表盘」** 即可看到服务器实时状态（在线人数 / 运行时长 / 带宽图表），
   并在「用户管理」「频道管理」中执行管理操作；首次连入的客户端可在
   TS 客户端里用 privilege key 领取服务器管理员权限

## 目录结构

```
teamspeak3-server/
├── docker-compose.yml         # ★ 全栈一键部署（teamspeak + panel + music + ts3audiobot）
├── .env.example               # compose 配置模板（端口/密码等）
├── query_ip_allowlist.txt     # ServerQuery 接口 IP 白名单
├── deploy/                    # 备用：仅 TS3 的裸机/独立部署方案（install.sh）
├── panel/                     # Web 管理面板（Node.js + Express，ServerQuery TCP 协议）
│   ├── Dockerfile             # 面板镜像（零 apk 依赖，经 docker.sock 直连 Docker API）
│   ├── src/                   # server/config/auth/ts3query（原始 TCP Query 客户端）/docker-api + routes
│   ├── public/                # 前端（原生 HTML/JS + Chart.js）
│   └── test/                  # mock ServerQuery + 端到端测试
├── music/                     # 点歌机器人（队列/播放器/电台流/聊天指令监听）
│   ├── Dockerfile             # music 镜像（Alpine + ffmpeg）
│   ├── src/                   # index/queue/player/enhanced/tsquery/tsbridge/tschat
│   ├── ts3ab/rights.toml      # TS3AudioBot 权限文件（compose 只读挂载）
│   └── test/                  # 聊天端到端 + 无人自动暂停 + 每频道隔离等测试
└── ts3服务端开发文档.md
```

## 配置

复制 `.env.example` 为 `.env` 后按需修改（docker compose 自动读取）：

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `PANEL_USERNAME` / `PANEL_PASSWORD` | admin / admin123 | 面板登录（⚠️ 务必修改） |
| `SESSION_SECRET` | please-change-me | 会话签名密钥（`openssl rand -hex 32`） |
| `PANEL_PORT` | 3000 | 面板端口 |
| `TS_PORT_VOICE` / `TS_PORT_FILE` | 9987 / 30033 | 语音 / 文件传输端口 |
| `TS_PORT_QUERY` | 10011 | ServerQuery 端口（宿主侧默认仅绑定 127.0.0.1） |
| `TS_QUERY_ADMIN_PASSWORD` | 空 | serveradmin 密码。设置后 TS3 首次启动即用它（面板/点歌机器人共用）；留空则首次启动随机生成并打印在容器日志 |
| `TS_CHANNEL_PASSWORD` | 空 | 点歌机器人要加入的频道密码（若频道设了密码） |
| `STREAM_TOKEN` | ts3bot | 电台流访问令牌（防公网随意收听，面板可开关） |

常用命令：

```bash
docker compose up -d          # 启动（panel/music 镜像本地构建，不从 registry 拉取）
docker compose logs -f panel  # 面板日志
docker compose ps             # 状态
docker compose restart teamspeak   # 重启 TS3（修改白名单后需要）
docker compose down           # 停止（数据卷保留）
docker compose down -v        # 停止并删除数据（⚠️ 数据丢失）
```

## 两个关键配置点

1. **ServerQuery 白名单**（`query_ip_allowlist.txt`）：不在白名单的 IP 连接 Query 会被
   立即断开。默认包含本机与常见内网/Docker 网段（面板/点歌机器人容器走内网已覆盖）；
   远程管理请把来源公网 IP 加入该文件后 `docker compose restart teamspeak`。
2. **serveradmin 密码**：TS3 没有 API Key 概念，一切管理经 ServerQuery + serveradmin 密码。
   推荐 `.env` 里直接设置 `TS_QUERY_ADMIN_PASSWORD`（三个服务自动共用）；也可以只填面板。

## 管理面板功能

- **部署管理**：环境检测、初始凭证提取、查询密码配置、TS3 容器快捷启停、日志查看
- **仪表盘**：在线用户、运行时长、带宽实时图表、服务器信息、最近加入用户
- **用户管理**：在线列表、踢出 / 封禁（含 IP）/ 移动 / 私聊 / Poke
- **频道管理**：频道树、创建 / 编辑 / 删除（名称 / 主题 / 密码 / 最大用户 / 排序）
- **点歌页**：网易云扫码登录、每频道独立队列与播放器、推流部署（TS3AudioBot）、
  频道聊天点歌开关

## 面板 API

面板 API 经 `/api` 前缀暴露，需面板登录会话（Cookie），前端不直接接触 TS3
（查询密码只存在服务端）：

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/login` `/api/logout` | 登录 / 登出 |
| GET | `/api/overview?sid=1` | 仪表盘聚合（服务器信息 + 带宽速率 + 用户 + 频道） |
| GET | `/api/servers` | 虚拟服务器列表 |
| GET | `/api/deploy/status` | 部署综合状态（Docker/容器/ServerQuery） |
| POST | `/api/deploy/up` `/down` `/restart` | 启动 / 停止 / 重启（后台任务） |
| GET | `/api/deploy/task/:id` | 任务进度（实时输出行） |
| GET | `/api/deploy/logs?tail=N` | TS3 容器日志 |
| GET | `/api/deploy/credentials` | 提取初始管理员凭证 |
| POST | `/api/deploy/password` | 保存 serveradmin 查询密码（持久化 + 立即生效） |
| GET | `/api/deploy/check` | 检测 ServerQuery 连通性 |
| GET | `/api/servers/:sid/clients` | 在线用户列表 |
| POST | `/api/servers/:sid/clients/:clid/kick` `/ban` `/move` `/poke` `/message` | 用户操作 |
| GET | `/api/servers/:sid/channels` | 频道列表 |
| POST | `/api/servers/:sid/channels` · PUT `/:cid` · DELETE `/:cid` | 频道增改删 |

## 点歌机器人

架构：`面板/频道聊天点歌 → music（队列/播放器，按频道隔离）→ /api/stream 电台流
→ ts3audiobot（TS3AudioBot，真实 TS3 语音客户端）拉流推进频道`。

- 面板「点歌页」配置部署频道后点「生成机器人 / 重建连接」即可，每频道固定部署
  一个点歌机器人 + 一个点歌助手（网易云账号全局共享）
- 频道聊天指令（由点歌助手监听应答）：

```
/点歌 <歌曲ID或链接>     /播放(第N首)  /暂停  /切歌  /清队列
/搜索 <关键词>           /队列 [页码]  /循环 <列表|单曲|随机|关>  /状态
```

## 测试（无需真实 TS3）

```bash
cd panel
node test/mock-ts3-query.js 10021        # 终端 1：模拟 TS3 ServerQuery
$env:PORT='3100'; $env:TSSERVER_QUERY_HOST='127.0.0.1'; $env:TSSERVER_QUERY_PORT='10021'; $env:TSSERVER_QUERY_PASSWORD='test-password'; $env:TSSERVER_CONTAINER_NAME='ts3-test-nonexistent'; node src/server.js  # 终端 2
$env:TEST_BASE='http://127.0.0.1:3100'
node test/api.test.js                    # 业务 API（49 项）
node test/deploy.test.js                 # 部署管理 API（35 项）
node test/metrics.test.js                # 指标采样器（8 项，需再起一个 mock 在 10022）
node test/task.test.js                   # 后台任务流（8 项）

cd ../music
npm install
node test/tschat-parser.test.js          # 行协议解析（10 项）
node test/tschat-e2e.test.js             # 点歌助手端到端（18 项，假 Query 服务器）
node test/autopause.test.js              # 频道无人自动暂停（8 项）
node test/per-channel.test.js            # 每频道隔离（16 项）
node test/watchdog-restart.test.js       # 看门狗重启自愈（1 项）
```

> 已用真实 TS3（teamspeak:3.13 / 3.13.8）+ TS3AudioBot 0.12.0 完成端到端验证：
> 凭证提取、ServerQuery 认证、服务器/频道/用户数据拉取与操作、机器人部署推流、
> 频道聊天点歌、看门狗断线自愈。

## 备用方案：仅 TS3 独立部署（不使用面板容器）

```bash
cd deploy && ./install.sh
```

脚本自动：检测 Docker → 生成 compose（含 Query 端口与白名单）→ 启动 →
提取初始管理员凭证 → 输出查询密码配置指引。面板以独立进程运行（见 `panel/.env.example`）。

## 安全注意事项

- 修改默认面板密码与 `SESSION_SECRET`（`.env`）
- ServerQuery 默认仅绑定 127.0.0.1，远程管理需改端口绑定并把来源 IP 加入
  `query_ip_allowlist.txt`
- serveradmin 密码只存服务端（数据卷），不写入前端与代码仓库
- TS3AudioBot 的 Web API（58913）只在 docker 内网暴露，未发布到宿主机
- TS3 服务器免费许可最多 32 槽位
