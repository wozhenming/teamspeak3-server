# TeamSpeak 3 点歌机器人 + 管理面板

Docker 一键部署的全栈项目：TeamSpeak 3 服务器 + Web 管理面板 + 网易云音乐点歌机器人。
点歌机器人以真实语音客户端身份（TS3AudioBot）加入 TS 频道推流，并支持在 TS 客户端内
用聊天指令点歌。

---

## 一、总体架构

```
┌──────────────────────────── Docker 网络(ts3) ───────────────────────────┐
│                                                                          │
│  teamspeak ················ TS3 服务器(语音:9987/ServerQuery:10011)      │
│  neteasemusic ············· 网易云 API(api-enhanced)，含图片/音频代理     │
│  music (点歌机器人) ········ 队列/播放器/电台流/点歌助手(ServerQuery 监听) │
│  panel (管理面板) ·········· WebUI + ServerQuery 管理 + 代理 /api/music   │
│  ts3audiobot ·············· TS3AudioBot 语音引擎（真实 TS3 客户端推流）   │
└──────────────────────────────────────────────────────────────────────────┘
```

**核心链路（音频）**：面板/频道聊天点歌 → 对应频道的 `music` 队列/播放器 →
`/api/stream?ch=<频道>` 实时转码 MP3 小广播电台流 → ts3audiobot 中该频道的音乐机器人
拉流 → 推进 TeamSpeak 频道。
**网易云账号全局共享，队列/播放器/机器人/点歌助手按频道隔离。**

与 TS6 版（teamspeak6-server 项目）的关键差异：

| 维度 | TS6 版 | 本项目（TS3 版） |
| ---- | ------ | ---------------- |
| 服务器 | teamspeak6-server Beta | 官方 `teamspeak:3.13` 镜像 |
| 管理协议 | WebQuery(HTTP REST) + API Key | ServerQuery(原始 TCP 10011) + serveradmin 密码 |
| 语音引擎 | ts6-manager（WebRTC 引擎，backend/sidecar/frontend 三容器） | TS3AudioBot 0.12.0（单容器，`ancieque/ts3audiobot` 镜像） |
| 聊天监听 | SSH ServerQuery(10022, ssh2) | 原始 TCP ServerQuery(10011, net) |
| 密码下发 | apikeyadd 生成 API Key | `.env` 直接设 `TS_QUERY_ADMIN_PASSWORD`（映射镜像的 `TS3SERVER_SERVERADMIN_PASSWORD`） |

---

## 二、功能清单 + 实现方法

### 1. 网易云登录（music/src/enhanced.js, index.js）
- **扫码登录**：`/login/qr/create` `/login/qr/check`。
- **登录持久化**：cookie jar 持久化到 `music-data` 卷的 `cookie.txt`；启动时重读。
- **登录态判定**：`/api/status` 以真实 `/login/status` 返回为准；匿名账号判为未登录。
- **显示**：头像 + 昵称 + VIP（黑胶VIP/SVIP/非会员）。**退出**：`/logout` + 清空 jar。

### 2. 点歌队列与播放器（music/src/queue.js, player.js, index.js）
- **每频道一套独立队列与播放器**：`queue.forChannel(ch)` / `player.forChannel(ch)`
  实例注册表；独立持久化 `queue_<key>.json` / `player_<key>.json`。
- 每个条目保留网易云真实 `songId`；直链缓存 `urlCache` 全局共享（同一网易云账号）。
- `player.js`：播放/暂停/继续/切歌/进度/循环(列表/单曲/随机/关)状态机。
- 播放/暂停/seek/切歌都会 **`rev++`**（频道内独立计数），驱动该频道电台流按需重启转码进程。
- 所有队列/播放器 REST 接口都带 `?ch=<频道路径>`（缺省取第一个部署频道）。

### 3. 电台音频流（music/src/index.js `/api/stream?ch=<频道>`）
- **每频道一路独立流**：`?ch=` 指定频道，各频道的播放/暂停/切歌互不影响。
- **ffmpeg 实时转码**为稳定 MP3(默认 320k/48k，可调)，`-re` 按原速推送。
- **真实时长探测**：用 `ffprobe` 探测直链文件真实时长，修正队列/自动切歌。
- **空闲静音保底**：无歌/暂停时回放预生成的静音缓冲，电台流永不断流。
- **过渡垫片**：切歌/恢复前先补一段干净静音帧，掩盖被 kill 的 ffmpeg 留下的半截帧。
- **seek 真跳转**：`ffmpeg -ss 位置` 输入端定位；媒体代理转发 Range 头。
- **令牌校验**：`?t=STREAM_TOKEN` 防随意收听。
- **版权/解灰**：拿不到直链时自动走 `/song/url/match` 解灰(UnblockNeteaseMusic)。

### 4. TS3AudioBot 对接（music/src/tsbridge.js）★核心
- **每频道固定部署**：面板配置部署频道列表（`ts3abChannels`），每个频道固定一个点歌
  机器人，绑定后不跨频道移动（频道→模板名 持久化在 `ts3abChannelBots`）。
  机器人命名：单频道用配置昵称原名，多频道自动加「·频道名」后缀。
- **Web API 驱动**（`http://ts3audiobot:58913`，仅内网）：
  - `GET /api/bot/list` —— 运行中的机器人（`Status`: 0=Offline 1=Connecting 2=Connected）
  - `GET /api/bot/connect/to/<addr>` —— 新建并连接机器人
  - `GET /api/bot/connect/template/<name>` —— 从已保存模板启动（TS3AB 重启后由看门狗拉起）
  - `GET /api/bot/use/<id>/(<cmd>)` —— 在机器人上下文执行命令链
  - `GET /api/bot/save/<name>` —— 保存模板（含自动生成的身份密钥）
- **命令链 URL 语法（踩坑重点）**：路径 `/` 分隔参数；**嵌套命令必须用字面量括号包裹
  且括号后紧跟 `/`，即 `(/cmd/arg1/arg2)`**——`(cmd)` 会被当成自由字符串返回 TailString
  而不执行；解析发生在 URL 解码之前，括号不能百分号编码；参数值需 `encodeURIComponent`。
- **创建流程**：`connect/to` → `settings set connect.name/connect.channel/commands.matcher`
  → 等首连（生成身份密钥，安全等级自动满足）→ `bot save <slug>` → **断开首连再从模板
  重启**（昵称/频道在连接时才生效）→ `(/play/<流地址>)`。
- **DNS 规避**：TS3AB 自带 DNS 解析器不认 Docker 容器名，下发给它的 TS 服务器地址与
  电台流地址都先在本服务 `dns.lookup` 解析成 IP。
- **看门狗自愈**（15s）：逐频道检查机器人（Status!=2 即修复：模板启动+重新 play）；
  同时执行「频道无人 → 只暂停该频道的播放器，有人进入 → 只恢复」（ServerQuery
  clientlist 按 `client_type` 只统计真实语音用户，排除机器人自身与 Query 客户端）。
- **部署频道选择**：ServerQuery `channellist` 直接解析（含完整频道路径）。

### 5. TS 频道聊天点歌（music/src/tschat.js + tsquery.js）★核心特色
- **每频道一个点歌助手**：每个部署频道各一条独立原始 TCP ServerQuery 连接
  （music/src/tsquery.js：横幅等待 → login → use → 命令 FIFO + 通知分发），
  昵称「点歌助手」（多频道加后缀），启动后 `clientmove` 驻留自己的频道并订阅
  `textchannel/textprivate`（textserver 仅挂在第一个会话上避免多助手重复应答）。
- **TS3 协议适配点**：横幅为 `TS3` 行 + 欢迎文本行（行尾 `\n\r`）；`whoami` 字段是
  `client_id/channel_id`（不是 clid/cid）；clientlist 的 `client_idle_time` 为毫秒、
  `connection_connected_time` 为连接时刻的 Unix 毫秒时间戳；踢人 `reasonid` 4=频道 5=服务器。
- **指令**（支持中/英文，面板可逐项开启/关闭；只作用于本频道自己的队列/播放器）：
  `/点歌 <歌曲ID|链接>`、`/播放(第N首)`/`/继续`、`/暂停`、`/切歌`/`/下一首`、`/清队列`、
  `/搜索`、`/队列 [页码]`、`/循环 <列表|单曲|随机|关>`、`/状态`。
- 长回执按行拆分多条发送（TS3 单条消息约 1024 字节上限）；断线指数退避重连；
  昵称冲突自愈（error id=770 视为已在频道）。

### 6. Web 管理面板（panel）
- **多页面**：仪表盘、服务器/频道/用户/权限管理、点歌页、部署管理、统计。
- **ServerQuery 连接层**（panel/src/ts3query.js）：面板共享一条长连接（命令 FIFO 串行、
  sid 变化自动 `use`、断线自动重连）；数据行统一解析成对象数组（单行列表也是数组）。
- **用户管理连接时长**：TS3 `connection_connected_time` 是连接时刻的时间戳，
  面板换算成秒后仍用 `utils/smooth.js` 单调时钟平滑显示。
- **部署管理**：检测 Docker/Compose、从容器日志提取 serveradmin 密码与 privilege key
  （自动持久化副本，容器重建不丢）、查询密码保存（立即生效）、连通性检测。
- **点歌机器人代理**（panel/src/routes/music.js）：`/api/music/*` → music 服务，
  保持面板登录鉴权；代理透传缓存相关响应头（封面不重复拉取）。

### 7. Docker 部署（docker-compose.yml）
- 全部服务同一 `ts3` 网络；services：teamspeak / neteasemusic / music / panel / ts3audiobot。
- **teamspeak 卷必须挂 `/var/ts3server`（镜像声明的数据卷，WorkingDir）**——挂错位置
  白名单/数据都不会生效；白名单文件单独只读挂到 `/etc/ts3server/` 并用
  `TS3SERVER_IP_ALLOWLIST` 指向（数据卷会被 entrypoint `chown -R`，只读挂载在那里会
  导致容器启动失败）。`TS3SERVER_IP_ALLOWLIST` 支持 CIDR 网段。
- TS3AudioBot（`ancieque/ts3audiobot:0.12.0`，内置 ffmpeg/youtube-dl）数据卷
  `/app/data`；`music/ts3ab/rights.toml` 只读挂载为权限文件（API 全权限 + 聊天用户仅
  cmd.xecute），58913 端口仅内网。
- 国内加速：npm 走 npmmirror、Alpine ffmpeg 走阿里云镜像源。

---

## 三、关键问题排查经验（移植/联调踩过的坑）

| 现象 | 根因 | 解法 |
| ---- | ---- | ---- |
| 命令链 API 返回 `{"Content":"x","Tail":"x"}` 不执行 | TS3AB 括号命令语法是 `(/cmd/args)`，括号后必须紧跟 `/`；`(cmd)` 被解析成自由字符串（TailString 原样返回） | botCmd 统一生成 `(/...)` 形式 |
| 白名单 CIDR 不生效 / 机器人被断开 | 镜像 WorkingDir 是 `/var/ts3server`，`query_ip_allowlist=query_ip_allowlist.txt` 读的是数据卷里的文件，挂到 `/teamspeak3-server` 无效；且数据卷被 entrypoint `chown -R`，只读单文件挂载在数据卷内会让容器启动崩溃 | 白名单挂到 `/etc/ts3server/` + `TS3SERVER_IP_ALLOWLIST` 指向；数据卷挂 `/var/ts3server` |
| 机器人昵称一直是 TS3AudioBot | `connect.name` 只在**连接时**生效，创建流程先连接后设置 | 保存模板后 disconnect，再从模板重启 |
| 看门狗反复 `/bot/use/null` | TS3AB 启动失败的实例 Status=0（Offline）且 Id=null；link 与看门狗并发重建 | findRunningBot 跳过 Status=0/Id=null；watchdogTick 遇 `linking` 避让 |
| 机器人对聊天指令报错刷屏 | TS3AB 对所有 `!` 开头的聊天消息做命令分发（先于权限检查），未知指令公开报错 | 点歌指令前缀改为 `/`（`TS_CHAT_PREFIX` 可配）——引擎源码只拦截 `!` 开头的消息，其他前缀完全忽略，噪音彻底消除 |
| panel overview 全部“连接未就绪” | 面板 Query 客户端 rawCmd 的就绪检查要求已登录，但登录命令本身发出时还未登录 | rawCmd 只检查 socket 可写 |
| serverlist 只有一台时返回对象而非数组 | 单行结果被折叠成对象，列表消费方拿到 `{}` | 统一解析成数组；单对象消费方走 `one()` |
| TS3 whoami 取不到 clid | TS3 字段是 `client_id/channel_id` | myInfo 做字段兼容 |
| TS 消息长队列表发送失败 | TS3 单条消息约 1024 字节上限 | 回执按行拆分多条发送 |
| 电台流地址被引擎拒收 | TS6 版 ts6-manager 有 SSRF 防护；TS3AB 无此限制但也解析不了容器名 | 内网地址 + 本服务 `dns.lookup` 解析成 IP 后下发 |
| 忘记 serveradmin 密码 | TS3 首次启动生成并打印在日志 | 面板「部署管理」提取；或在 `.env` 设置 `TS_QUERY_ADMIN_PASSWORD`（映射镜像 `TS3SERVER_SERVERADMIN_PASSWORD`）后重建容器 |

---

## 四、常用指令/命令

**点歌机器人 API（`http://music:3200`）**
- `/api/status` 登录状态（含 profile/vip）
- `/api/player/*?ch=<频道>` 播放器控制（play/pause/resume/toggle/seek/next/prev/loop）
- `/api/queue?ch=<频道>` 队列增删查
- `/api/stream?ch=<频道>&t=<TOKEN>` 该频道的电台音频流
- `/api/ts-bot/config`+`/link`+`/unlink`+`/channels`+`/chat/status` 语音引擎对接与设置

**TS 频道聊天指令**
```
/点歌 <歌曲ID或网易云链接>
/播放  /暂停  /切歌  /循环 <列表|单曲|随机|关>  /状态
```

**部署**
```bash
cd teamspeak3-server && git pull
docker-compose up -d --build --remove-orphans music panel   # 更新
```
