# dsh-workbench-private-cloud

DSH Workbench 的**私人云端**：单用户、多设备的数据同步与文件存储服务。

它和 [`dsh-workbench-cloud`](https://github.com/ityyq777/dsh-workbench-cloud)（共享云端，多用户账号体系）共用同一套同步协议 v2，但把身份模型简化成“一个人 + 一把访问密钥”：

- 没有注册登录，只有一份主数据（`user.id = private-owner`），用预共享密钥做 Bearer 鉴权；
- 数据全部放在自己的机器上：SQLite 单文件数据库 + 本地 blob 目录；
- 零运行时依赖，只需要 Node.js ≥ 22.5（用到内置的 `node:sqlite`）。

## 快速开始

```bash
# 1. 生成访问密钥（至少 16 位）写进 .env
echo "WB_PRIVATE_SECRET=$(openssl rand -hex 32)" > .env

# 2. 启动（默认监听 0.0.0.0:8792，数据在 ./data）
npm start
```

`.env` 会在启动时自动加载（已有同名环境变量优先，不会被文件覆盖），所以不需要
`source .env`——那样只会设置 shell 变量、不 export，Node 进程读不到。想用别的文件可以设
`WB_PRIVATE_SECRET_FILE=/绝对路径`。

启动后先用健康检查确认：

```bash
curl -s http://127.0.0.1:8792/v1/health
# {"ok":true,"service":"dsh-workbench-private-cloud","mode":"private",...}
```

宿主端在「设置 → 账号」里把云端类型切到“私人云端”，填入服务端地址与同一把密钥即可。

## 命令行工具

`bin/wb-private-cloud.mjs` 负责「后台跑起来」这件麻烦事：写 PID 文件、日志重定向到数据目录、
等健康检查通过再返回。直接用 Node 运行即可，也可以 `npm link` 后全局调用 `wb-private-cloud`。

```bash
node bin/wb-private-cloud.mjs init      # 在当前目录生成 .env（随机 64 位密钥，不覆盖）
node bin/wb-private-cloud.mjs start     # 后台启动，打印地址与概览页链接
node bin/wb-private-cloud.mjs status    # 是否运行、PID、地址、服务名与版本
node bin/wb-private-cloud.mjs logs -f   # 跟踪日志（默认最近 50 行，--lines N 可调）
node bin/wb-private-cloud.mjs restart   # 重启（改完配置或升级后最常用）
node bin/wb-private-cloud.mjs stop      # 停止（10 秒不退则 SIGKILL）
node bin/wb-private-cloud.mjs open      # 在浏览器打开概览页
node bin/wb-private-cloud.mjs clear     # 清空云端数据（交互式输入确认词；--yes 跳过）
```

- `start --foreground` 就是前台运行，等价于 `npm start`，适合调试；
- 端口、数据目录、监听地址、服务名称都可以用通用选项覆盖：
  `--port 8792 --data ./data --bind 0.0.0.0 --name "我的云端"`，或对应环境变量，或 `.env`；
- PID 文件与日志都在数据目录：`private-cloud.pid`、`private-cloud.log`；
- `stop`/`status` 只读数据目录，即使 `.env` 缺密钥也能用（会提示健康检查失败但不报配置错）；
- 端口被占用时 `start` 会直接失败并打印可读原因（不会留下 PID 文件或半启动进程）；
- 退出码：`status` 运行且健康为 0、进程在但健康检查失败为 1、未运行为 3；`start` 已在运行为 1；
- `clear` 优先走运行中的服务（`POST /v1/admin/clear`），服务没跑就直接打开库清空，避免两个进程同时写；
  非交互环境（定时任务、CI）必须显式加 `--yes`，否则会直接拒绝而不是静默清空。

## 浏览器概览页

启动后用浏览器直接打开服务地址（例如 `http://127.0.0.1:8792/`），输入访问密钥即可看到：

- 运行时长、版本、当前同步会话；
- 存储用量（已用/配额进度条、文件数、业务引用数、单文件上限）；
- 设备列表（名称、设备 ID、最后同步时间、累计变更数）；
- 数据表（行数、墓碑行、树形表版本、同步模式、最后更新时间）；
- 同步活动（变更总数、序号范围、全量重置次数、按设备分布）。

页面本身是静态外壳，数据由 `GET /v1/stats` 提供，密钥只存在浏览器 localStorage 里，不写进 HTML；
每 15 秒自动刷新一次。需要给机器或脚本看数据时，直接用 `/v1/health` 与 `/v1/stats` 即可。

页面底部的「数据清空」卡片与 CLI `clear` 等价：输入确认词「清空云端数据」后按钮才可用，
清空成功会提示清掉多少行与多少个文件，并立即刷新统计。

## 环境变量

| 变量                              | 默认值         | 说明                                                     |
| --------------------------------- | -------------- | -------------------------------------------------------- |
| `WB_PRIVATE_SECRET`               | 必填           | 访问密钥，至少 16 位；也可用 `WB_PRIVATE_SECRET_FILE` 从文件读 |
| `WB_PRIVATE_BIND`                 | `0.0.0.0`      | 监听地址                                                 |
| `WB_PRIVATE_PORT`                 | `8792`         | 监听端口                                                 |
| `WB_PRIVATE_DATA`                 | `./data`       | 数据目录（数据库、blob、临时文件）                       |
| `WB_PRIVATE_SERVER_NAME`          | `我的私人云端` | 在宿主里显示的云端名称                                   |
| `WB_PRIVATE_MAX_FILE_BYTES`       | `209715200`    | 单文件上限，默认 200 MB                                  |
| `WB_PRIVATE_QUOTA_BYTES`          | `21474836480`  | 总配额，默认 20 GB                                       |
| `WB_PRIVATE_SESSION_TTL_SECONDS`  | `300`          | 同步会话有效期（秒），实际会夹到 10..600                 |
| `WB_PRIVATE_TRUST_PROXY`          | `0`            | 设为 `1` 时信任 `x-forwarded-for`，仅在反代之后打开      |

## 接口

除 `GET /` 与 `GET /v1/health` 外，所有请求都要带 `Authorization: Bearer <密钥>`。
浏览器用 `Accept: text/html` 访问 `GET /` 会拿到概览页，其它请求仍返回 JSON。

| 方法   | 路径                            | 说明                                     |
| ------ | ------------------------------- | ---------------------------------------- |
| GET    | `/v1/health`                    | 健康检查（公开）                         |
| GET    | `/v1/me`                        | 单用户信息、已登记设备、存储配额         |
| GET    | `/v1/stats`                     | 概览页用的统计快照（设备、数据表、变更） |
| DELETE | `/v1/devices/:id`               | 移除一台设备记录                         |
| POST   | `/v1/admin/clear`               | 清空云端数据 `{confirm:"清空云端数据"}`  |
| POST   | `/v1/sync/open`                 | 打开同步会话 `{protocol:2,device_id}`    |
| POST   | `/v1/sync/push`                 | 推送变更（最多 500 条/批）               |
| POST   | `/v1/sync/pull`                 | 按表游标拉取变更                         |
| POST   | `/v1/sync/snapshot`             | 取某张表的全量快照                       |
| POST   | `/v1/sync/full`                 | 整表重置（树形表的版本协商）             |
| POST   | `/v1/sync/close`                | 关闭会话，成功时记录设备游标             |
| POST   | `/v1/files/check`               | 批量查询 blob 是否已存在（≤200 个）      |
| GET    | `/v1/files/quota`                | 已用容量与配额                           |
| PUT    | `/v1/files/blobs/:sha256`       | 上传文件（路径即内容 sha256，自动去重）  |
| GET    | `/v1/files/blobs/:sha256`       | 下载文件（须被文件行引用，支持 Range）   |
| HEAD   | `/v1/files/blobs/:sha256`       | 查询文件大小与类型                       |

错误统一是 `{ok:false,error:"机器可读码",message:"说明"}`；鉴权失败 401，失败次数过多 429，协议不匹配 426，版本冲突 409。

## 部署

### Docker

```bash
export WB_PRIVATE_SECRET="$(openssl rand -hex 32)"
docker compose up -d
```

数据保存在名为 `private-cloud-data` 的卷里。

### 裸机 + systemd

```ini
[Unit]
Description=DSH Workbench 私人云端
After=network.target

[Service]
Environment=WB_PRIVATE_SECRET=换成你的密钥
Environment=WB_PRIVATE_DATA=/var/lib/dsh-private-cloud
ExecStart=/usr/bin/node /opt/dsh-workbench-private-cloud/src/index.js
Restart=always
User=dsh

[Install]
WantedBy=multi-user.target
```

**公网访问必须套 HTTPS 反向代理**（Caddy / Nginx / Tailscale 均可），否则密钥与数据都是明文传输。Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8792;
    proxy_set_header X-Forwarded-For $remote_addr;
    client_max_body_size 200m;
}
```

反向代理之后记得设置 `WB_PRIVATE_TRUST_PROXY=1`，这样鉴权失败的限流才按真实客户端 IP 计算。

## 数据清空

`POST /v1/admin/clear`（CLI `clear`、概览页按钮）清掉这台服务上的全部业务数据：

- 表：`change_log`、`row_states`、`sync_table_state`、`sync_sessions`、`devices`、`blob_refs`、`blobs`；
- 磁盘：数据目录下的 `blobs/` 与 `tmp/` 整个删除后重建；
- `meta` 只保留 `instance_id`（服务身份不变，宿主不用重新绑定），并写入 `last_clear_at`。

确认词必须原样传 `"清空云端数据"`，否则 400 `confirm_required`；成功返回
`{ok:true, tables, rows, blobs, devices, cleared_at}`，重复调用是幂等的（第二次为 0）。
清空不删库文件、不改端口与密钥，也不影响其它实例。

注意：清空后，**仍连着这台云端的宿主会在下一轮同步把本地数据重新推上来**
（树形表会走整表重置），所以「本机也要清」时请在宿主侧先清空并断开云端，
顺序是「宿主清空 → 云端清空」，或者反过来清空云端后不要再让旧数据上传。

## 备份与恢复

需要备份的只有 `WB_PRIVATE_DATA` 整个目录：

- `private-cloud.db`（含 `-wal` / `-shm`）是同步元数据；
- `blobs/` 是按 sha256 分桶的文件内容。

最稳妥的做法是停服务后整目录复制；在线备份可用 `sqlite3 private-cloud.db ".backup 'backup.db'"` 再连同 `blobs/` 一起打包。恢复时把目录放回原位并启动即可。

## 开发

```bash
npm test          # node --test，24 个用例覆盖鉴权、同步协议、文件接口、概览页与 CLI
npm start
```

目录结构：

```
src/config.js   环境变量读取与校验
src/db.js       SQLite 结构与打开逻辑
src/auth.js     Bearer 密钥校验与失败限流
src/sync.js     同步协议 v2（与共享云端逐条对齐）
src/files.js    blob 上传/下载、配额、引用维护
src/stats.js    概览统计快照
src/dashboard.js 浏览器概览页（内联样式与脚本，无外部依赖）
src/server.js   HTTP 路由
src/index.js    进程入口
test/           协议与接口测试
```

## 与共享云端的关系

私人云端只实现“单用户多设备”这一条路径，**不提供**注册、登录、多用户隔离、访问令牌刷新等能力；`/v1/auth/*` 系列接口在这里不存在。宿主会按云端类型选择对应的配置方式与凭据形态。
