# TeamSpeak 3 服务端开发文档

本项目对接 **TeamSpeak 3 Server 3.13.x**（官方 `teamspeak:3.13` Docker 镜像）。
本文档记录面板与点歌机器人所依赖的服务端接口与部署要点。

## 1. 端口与组件

| 端口 | 协议 | 用途 |
| ---- | ---- | ---- |
| 9987/udp | TS3 语音 | 客户端语音连接 |
| 30033/tcp | 文件传输 | TS3 文件传输 |
| 10011/tcp | ServerQuery (raw TCP) | 管理面板 / 点歌机器人 / 点歌助手 |

镜像要点（Dockerfile 实测）：
- 数据卷：`/var/ts3server`（= WorkingDir，数据库/日志/白名单都在这里）
- entrypoint 生成 `/var/run/ts3server/ts3server.ini`，支持 `TS3SERVER_*` 环境变量覆盖：
  - `TS3SERVER_LICENSE=accept` 接受许可
  - `TS3SERVER_SERVERADMIN_PASSWORD` 直接指定 serveradmin 密码（等同启动参数 `serveradmin_password`）
  - `TS3SERVER_IP_ALLOWLIST` 白名单文件路径（支持 CIDR 网段）
- 首次启动在日志打印：`loginname= "serveradmin", password= "xxx"` 与
  `token=xxx`（ServerAdmin privilege key）

## 2. ServerQuery 行协议（raw TCP）

```
客户端连接后服务端发送横幅：
  TS3\n\r
  Welcome to the TeamSpeak 3 ServerQuery interface, type "help" ...\n\r
横幅结束后才允许发命令。每条命令以 \n 结尾；应答行尾为 \n\r。
```

- **登录/选服**：`login serveradmin <password>` → `use <sid>`
- **应答**：数据行（key=value，多行结果用 `|` 拼接在同一物理行）+ `error id=<n> msg=<m>`；
  id=0 为成功。错误示例：512 invalid login / 770 already member of channel / 1540 convert error
- **转义**：值中空格→`\s`、竖线→`\p`、反斜杠→`\`、斜杠→`\/`、换行→`\n`
- **通知**：`servernotifyregister event=textchannel|textprivate|textserver`（或
  `event=server|channel id=<cid>`）后，服务端异步推送 `notifytextmessage`、
  `notifycliententerview` 等行
- **常用字段差异（相对 TS6 WebQuery）**：
  - `whoami` 返回 `client_id` / `channel_id`（不是 clid/cid）
  - `clientinfo.connection_connected_time` 是连接时刻的 Unix 毫秒时间戳（非时长）
  - `clientinfo.client_idle_time` 单位毫秒
  - `clientkick` 的 `reasonid`：4=踢出频道，5=踢出服务器
  - `serverinfo` 直接携带 `connection_bandwidth_sent_last_second_total`（无独立连接信息接口）
  - Query 客户端可作为真实频道成员存在（`clientmove` 进频道，error id=770 表示已在频道）
  - 单条 `sendtextmessage` 消息长度上限约 1024 字节

## 3. 白名单与安全

- `query_ip_allowlist.txt`：每行一个 IP 或 CIDR 网段；**文件中出现任何无法解析的行
  会导致整份白名单回退为默认的 127.0.0.1/::1**（改文件后需重启容器）
- 面板与点歌机器人容器走 Docker 内网（172.16.0.0/12 已覆盖）
- 远程管理：把来源公网 IP 加入白名单并放开宿主端口绑定

## 4. TS3AudioBot 0.12.0（语音引擎）

镜像 `ancieque/ts3audiobot:0.12.0`（.NET Core 3.1 + BASS/libopus + ffmpeg + youtube-dl）。

### 4.1 目录与权限
- 数据目录 `/app/data`：`ts3audiobot.toml`（主配置）、`rights.toml`（权限）、
  `bots/<模板名>/bot.toml`（机器人模板，含身份密钥）、`ts3audiobot.db`（LiteDB）
- Web API 默认 `0.0.0.0:58913`；本项目仅内网暴露，`rights.toml` 用 `isapi` 匹配器
  只授予 API 全权限

### 4.2 Web API
- URL 即命令链：`/api/<cmd>/<arg>/...`，`/` 分隔参数；**嵌套命令用字面量括号且括号后
  紧跟 `/`：`(/cmd/arg)`**；参数值 `encodeURIComponent`（服务端解析后统一 URL 解码）
- 认证：无 Authorization 头 = 匿名调用（`AllowAnonymousRequest` 默认 true），
  权限由 rights.toml 决定；带 Basic 认证（uid:token，token 经 `!api token` 生成）走
  用户身份
- 常用端点：
  - `GET /api/version`、`GET /api/bot/list`
  - `GET /api/bot/connect/to/<host:port>`、`GET /api/bot/connect/template/<name>`
  - `GET /api/bot/use/<id>/(settings/set/connect.name/<昵称>)`
  - `GET /api/bot/use/<id>/(settings/set/connect.channel//<cid>)`
  - `GET /api/bot/use/<id>/(bot/save/<模板名>)`、`GET /api/bot/use/<id>/(bot/disconnect)`
  - `GET /api/bot/use/<id>/(play/<url>)`、`(/stop)`、`(/song)`、`(/volume/<n>)`
- 机器人状态：`bot/list` 的 `Status` 0=Offline（启动失败的死实例 Id=null）、
  1=Connecting、2=Connected
- 配置键（`settings set <key> <value>`，TOML 值需带引号的必须带引号）：
  - `connect.name`（TS3 昵称，**连接时才生效**）、`connect.channel`（`/<cid>` 或路径）、
    `connect.channel_password.pw`、`commands.matcher`（exact 可避免未知 !指令模糊匹配）
- 机器人模板名只允许 `[a-zA-Z0-9_-]`；身份密钥首次连接自动生成（安全等级自动满足）

### 4.3 已知行为
- 对频道内 `!` 开头的聊天消息做命令分发（先于权限检查），未知指令会公开回复错误；
  本项目用 `commands.matcher=exact` + 仅授予 API 权限把它的影响降到最低
- TS3AB 自带 DNS 解析器不认 Docker 容器名：下发给它的地址需先解析成 IP
- 重启后机器人不会自动运行，需调用 `bot connect template`（本项目看门狗负责）

## 5. 项目内实现索引

| 文件 | 说明 |
| ---- | ---- |
| panel/src/ts3query.js | 面板 ServerQuery 长连接（命令 FIFO + 自动重连） |
| music/src/tsquery.js  | 通用 ServerQuery 客户端（横幅/登录/通知分发，供 tschat/tsbridge） |
| music/src/tschat.js   | 点歌助手（每频道一条连接，监听频道聊天指令） |
| music/src/tsbridge.js | TS3AudioBot 对接（每频道固定部署 + 看门狗自愈 + 无人自动暂停） |
| music/ts3ab/rights.toml | 引擎权限（API 全权限 / 聊天仅 cmd.xecute） |
| panel/test/mock-ts3-query.js | 假 TS3 ServerQuery 服务器（测试用） |
| music/test/fake-ts3-query.js | 测试用可编程假 Query 服务器 |
