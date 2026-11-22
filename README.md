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

## 浏览器概览页

启动后用浏览器直接打开服务地址（例如 `http://127.0.0.1:8792/`），输入访问密钥即可看到：

- 运行时长、版本、当前同步会话；
- 存储用量（已用/配额进度条、文件数、业务引用数、单文件上限）；
- 设备列表（名称、设备 ID、最后同步时间、累计变更数）；
- 数据表（行数、墓碑行、树形表版本、同步模式、最后更新时间）；
- 同步活动（变更总数、序号范围、全量重置次数、按设备分布）。

页面本身是静态外壳，数据由 `GET /v1/stats` 提供，密钥只存在浏览器 localStorage 里，不写进 HTML；
每 15 秒自动刷新一次。需要给机器或脚本看数据时，直接用 `/v1/health` 与 `/v1/stats` 即可。

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

## 备份与恢复

需要备份的只有 `WB_PRIVATE_DATA` 整个目录：

- `private-cloud.db`（含 `-wal` / `-shm`）是同步元数据；
- `blobs/` 是按 sha256 分桶的文件内容。

最稳妥的做法是停服务后整目录复制；在线备份可用 `sqlite3 private-cloud.db ".backup 'backup.db'"` 再连同 `blobs/` 一起打包。恢复时把目录放回原位并启动即可。

## 开发

```bash
npm test          # node --test，20 个用例覆盖鉴权、同步协议、文件接口与概览页
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
