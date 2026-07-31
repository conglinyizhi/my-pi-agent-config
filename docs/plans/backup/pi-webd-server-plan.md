# pi-webd Server 计划书

> 状态：草案 | 日期：2025-07-30 | 依赖：pi-web-gui 完成后启动

## 目标

替换 pi-web 的 web server 层，自建 Fastify server，集成动态 token 认证。pi-web sessiond 保留不动。

## 架构

```
手机 / 浏览器
  ↕ HTTPS + Bearer Token
pi-webd (自建 Fastify)        ← 本计划产出
  ├─ auth 中间件（token 校验）
  ├─ 静态文件服务（Vue 前端 dist）
  ├─ WebSocket 代理 → sessiond
  └─ token 管理 API
  ↕ Unix socket
pi-web sessiond （不动）       ← pi agent 生命周期
  ↕ pi SDK
pi agent
```

**为什么保留 sessiond**：sessiond 负责 pi agent 生命周期——启动/停止进程、管理会话文件、加载扩展、WebSocket 流式、扩展 UI 协议。4000+ 行经过测试的代码。不重写，只替换它前面的薄层。

---

## 功能

### Token 认证

- **Bearer Token**：所有 HTTP 请求和 WebSocket 连接需带 `Authorization: Bearer <token>`
- **动态管理**：可生成、列出、吊销 token，无需重启服务
- **存储**：JSON 文件（`~/.pi-webd/tokens.json`），简单可靠
- **Token 元数据**：每个 token 记录名称、创建时间、最后使用时间

### Token 管理

通过 CLI 子命令或 admin API：

```bash
pi-webd token new --name "手机"
# → pi-webd-token-xxxx-xxxx

pi-webd token list
# name     created              last_used
# 手机     2025-07-30 20:00    2025-07-30 21:30
# 平板     2025-07-29 15:00    never

pi-webd token revoke pi-webd-token-xxxx-xxxx
```

### 静态文件服务

serve Vue 前端 dist（即 `pi-web-gui` 的构建产物）。

### WebSocket 代理

```
浏览器 ← socket.io → pi-webd ← raw ws → sessiond
        (auth+重连)              (透明代理)
```

- 浏览器侧：socket.io，自带 token 认证（`io.use` 中间件）、自动重连、事件路由
- sessiond 侧：原始 WebSocket 代理——pi-webd 只做透明转发，不解析消息内容
- sessiond 保持独立进程（Unix socket）：防止 agent OOM 拖垮 auth server，支持独立重启

---

## 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 运行时 | Node.js 22+ | 与 pi / pi-web 一致 |
| 框架 | Fastify | pi-web 同款，plugin 生态好 |
| WebSocket | `socket.io`（浏览器侧）+ `ws`（sessiond 桥接） | socket.io 自带重连、auth 中间件、事件路由，sessiond 侧用原始 ws 代理 |
| Token 存储 | JSON 文件 | 零依赖，够用。以后可换 SQLite |
| Token 生成 | `crypto.randomUUID()` | 标准库，不需要额外依赖 |
| 静态文件 | `@fastify/static` | Fastify 插件 |
| 日志 | pino（Fastify 内置） | 结构化日志 |
| 包管理 | pnpm | 统一 |

---

## 项目结构

```
pi-webd/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          ← 入口：启动 Fastify + socket.io
│   ├── config.ts         ← 配置（端口、sessiond socket 路径、tokens 文件路径）
│   ├── auth/
│   │   ├── tokenStore.ts ← Token CRUD + JSON 文件读写
│   │   └── routes.ts    ← Token 管理 API（可选，或纯 CLI）
│   ├── socket/
│   │   ├── io.ts         ← socket.io 实例 + auth 中间件
│   │   └── bridge.ts     ← socket.io ↔ sessiond raw ws 双向代理
│   └── cli.ts            ← CLI 入口（token new/list/revoke + start）
└── tokens.json           ← 运行时 token 数据（gitignore）
```

---

## API 设计

### 公开端点（需 token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `*` | `/api/*` | 代理到 sessiond |
| `GET` | `/ws` | WebSocket 升级 → sessiond |
| `GET` | `/*` | 静态文件（Vue 前端） |

### Admin 端点（需 admin token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/admin/tokens` | 生成新 token |
| `GET` | `/admin/tokens` | 列出所有 token |
| `DELETE` | `/admin/tokens/:id` | 吊销 token |

### 健康检查（无需 token）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/status` | JSON 健康状态（sessiond 连通性、运行时间、版本） |
| `GET` | `/status` | HTML 状态页面（人性化展示，手机友好） |

admin token 在首次启动时自动生成并打印到控制台。

---

## 安全边界

- sessiond 只监听 Unix socket → 外部不可达
- 所有 HTTP 请求过 Fastify auth 中间件 → token 无效直接 401
- socket.io 连接通过 `io.use()` 中间件校验 token → 无效拒绝连接
- 两个进程隔离：sessiond 崩溃不拖垮 auth server；auth server 重启不断 pi agent 会话
- token 文件权限 `0600`
- 不实现密码登录、OAuth——token 即全部。需要 HTTPS（Caddy/Nginx 反代）

---

## 部署

### systemd

两个 unit，各自独立：

```ini
# /etc/systemd/system/pi-web-sessiond.service
# pi-web 自带，不动
[Service]
ExecStart=/usr/bin/node /opt/pi-web/dist/server/sessiond.js
```

```ini
# /etc/systemd/system/pi-webd.service
[Unit]
After=pi-web-sessiond.service
Requires=pi-web-sessiond.service

[Service]
ExecStart=/usr/bin/node /opt/pi-webd/dist/index.js
Restart=on-failure
Environment=PI_WEBD_PORT=8504
Environment=PI_WEBD_SESSIOND_SOCKET=/run/pi-web/sessiond.sock

[Install]
WantedBy=default.target
```

sessiond 挂了 → pi-webd 不受影响。pi-webd 挂了 → sessiond 上的会话继续跑。systemd 各自重启。

### 依赖清单

| 依赖 | 类型 | 说明 |
|------|------|------|
| Node.js 22+ | 运行时 | 系统包管理器安装 |
| pi-web sessiond | 进程 | 已有，独立 systemd unit |
| tokens.json | 文件 | 零进程，`crypto.randomUUID()` 生成 token |
| Caddy/Nginx | 可选 | 反代 + 自动 HTTPS（也可 Tailscale Serve 替代） |

不需要 Redis、PostgreSQL、SQLite 等额外数据库进程。

### 开发命令

```bash
pnpm dev
pnpm build && node dist/index.js
```

### HTTPS

配合 Caddy 反代自动 HTTPS：

```
pi.example.com {
    reverse_proxy 127.0.0.1:8504
}
```

手机连 `https://pi.example.com`，带 token 即可。

---

## 与 pi-web-gui 的关系

```
pi-web-gui（前端项目）  ──build──→  dist/  ──serve──→  pi-webd（本项目）
```

pi-web-gui 的 `vp build` 产物放到 pi-webd 的静态文件目录。两个项目独立迭代，通过 dist 目录对接。

---

## 开发阶段

### Phase A：最小可用（~200 行）

- Fastify 启动
- Token 存储 + 校验中间件
- 静态文件 serve
- WebSocket 代理
- 一个预置 admin token

### Phase B：Token 管理（~100 行）

- CLI 子命令（`token new/list/revoke`）
- Admin API（可选）
- 最后使用时间记录

### Phase C：生产加固（低优先级）

- 速率限制（防暴力猜 token）
- 日志审计
- systemd service 文件
- `/api/status` + `/status` 健康检查页面
- Docker 镜像（可选）

---

## 关键风险

| 风险 | 缓解 |
|------|------|
| sessiond 版本升级 API 变化 | 只依赖 WebSocket 路径和 Unix socket 路径，接口极窄 |
| token 文件损坏 | JSON 文件易恢复；启动时校验格式 |
| socket.io ↔ ws 桥接 | 两个 `ws` 实例互联，socket.io 消息透传，已成熟模式 |
| 与 pi-web-gui 的开发时序依赖 | API 契约先定（token header + WebSocket 路径），两边独立开发 |

---

## 下一步

1. 等项目进入 pi-web-gui Phase 2 后再启动
2. 初始化 `pnpm init` + Fastify + TypeScript
3. 先写 auth 中间件 + 一个预置 token
4. 接 sessiond 的 WebSocket，验证聊天能跑
5. 加 token 管理 CLI
