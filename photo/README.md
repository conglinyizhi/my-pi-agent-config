# pi-photo

手机拍照 → 直接进 pi 会话的常驻网关。一台机器一个进程，干两件事：

- **局域网 HTTP**：手机打开一个页面，调系统相机拍完在浏览器里压到长边 1600，POST 上来落盘
- **Unix socket**：pi 侧连上来拿「谁在收听」的独占锁，图片一到就推给它

锁是这块的核心：同一时刻只有一个 pi 会话收图，别的会话要么等、要么显式抢。没有会话在听时上传的图**一律落盘入队**，等 pi 上来再投递，不丢。

## 落盘

```
~/.pi/agent/photo-state/       (-state)
  queue/<id>.jpg               待投递 / 已推未 ack
  archive/YYYYMMDD/<id>.jpg    已被 pi ack
  token                        HTTP 口令，32 位 hex，0600
~/.pi/agent/run/photo.sock     (-socket)，0600，只收同一 UID
```

- `<id>` 形如 `1758859200123-0007-a1b2c3d4`：毫秒时间戳 + 同毫秒序号 + 随机后缀。
  字符串序就是投递顺序，重启后扫 `queue/` 重建的顺序与拍的时候一致。
  id 一经发出不再变，pi 侧可以拿它去重。
- 队列以文件为唯一事实来源，不另存索引：索引和文件一旦不同步，就得临时决定信谁。
- `queue/` 里的项只有在 pi 发 `ack` 之后才移到 `archive/`（按 ack 当天分目录）。
  ack 前重启守护，那些项会重新推给下一个 holder。

## HTTP（默认 `0.0.0.0:8787`，`-addr`）

所有接口都要带 `?k=<token>`，缺失或不匹配一律 `401`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/?k=` | 页面：拍照 / 相册多选 / canvas 压缩，顶部状态行每 3 秒轮询 `/status`，底部「结束」按钮 |
| GET | `/status?k=` | `{"listener":{...}\|null,"queued":n,"delivered":n}` |
| POST | `/upload?k=` | 请求体 `{"images":[{"name":"x.jpg","dataUrl":"data:image/jpeg;base64,..."}]}` |
| POST | `/finish?k=` | `{"ok":true}`，释放锁并给 holder 发 `finish` |

字段口径：

- `queued` = `queue/` 里还没被 ack 的张数（跟着磁盘走，重启后口径不变）
- `delivered`（`/status`）= `archive/` 里已归档的总张数
- `delivered`（`/upload` 回执）= 本批里已经推给当前 holder 的张数
- `accepted` = 本批落盘的张数；`rejected` = 本批被拒的张数（口令之外的额外字段，便于页面提示）

`/status` 不回 token，也不回 socket 路径：状态行是给手机看的，手机不需要新口令。

接受的图片类型只有 `image/jpeg`、`image/png`、`image/webp`，扩展名按类型落。
页面永远发 JPEG（canvas 压完就是 JPEG），另两种是给手搓请求留的路，免得默默丢图。
请求体上限 64 MiB。

## socket 协议（JSON 行，`v:1`）

连上先 `hello`，之后任意顺序。未知 `type` 回 `error{message}`，连接不断。

pi → 守护：

| type | 字段 | 回执 |
| --- | --- | --- |
| `hello` | `role:"pi"` | `hello-ok` |
| `attach` | `sessionId`,`name`,`force` | `attach-ok{queued}` / `busy{holder}` |
| `detach` | | `detach-ok` |
| `ping` | | `pong`（同时刷新该连接的心跳） |
| `ack` | `ids:[...]` | `ack-ok{moved}` |
| `url` | | `url-ok{url}` |

守护 → pi：

| type | 字段 | 时机 |
| --- | --- | --- |
| `arrived` | `items:[{id,path,mime,bytes,ts}]` | attach 后推积压；有 holder 时上传立即推 |
| `finish` | `by:"web"`,`count` | 页面点了「结束」 |
| `preempted` | `reason:"stale"\|"forced"` | 锁被抢（随后连接被关） |
| `error` | `message` | 请求无法处理 |

`path` 是绝对路径，pi 直接读，不去猜目录布局。`count` 是这一任 holder 任期内收到过的张数。

## 锁的语义

| 情况 | 结果 |
| --- | --- |
| 无 holder | attach 成功 |
| holder 的连接已断 | 锁在断连那一刻已释放，attach 直接成功 |
| holder 心跳超期（`-stale`，默认 30s） | 判假死：给旧连接 `preempted{stale}` 并关掉，锁给新来的 |
| holder 正常 | 回 `busy{holder}`，不静默抢 |
| `attach` 带 `force:true` | 抢占：给旧连接 `preempted{forced}` 并关掉，锁给新来的 |
| `detach` 或 holder 断连 | 释放锁 |
| 同一个连接重复 attach | 幂等更新会话名，不重推图 |

细节：

- 心跳由 pi 侧每 10 秒 `ping` 一次，守护记 `lastSeen`。连接还在但进程冻住时，
  TCP 层不会给任何提示，只能靠心跳判出来。
- 每一步都是「先换锁，再通知旧连接」：关连接会触发旧连接的清理路径，
  那时它不是 holder，不会把刚给新人的锁顺手释放掉。
- 守护每 `-tick`（默认 5s）主动扫一次假死 holder：没人来抢时锁也不会一直挂在
  一条没人读的连接上，页面状态行才不会一直显示「有人在收」。
- 新 holder 接手时，`queue/` 里所有未 ack 的项全部重置为未投再推。
  上一任收了没 ack 就断了，那些图只有靠这一步才能回到下一任手上；
  重复投递由 pi 按 id 去重。
- `finish` 只释放锁，不关连接，也不归档：pi 想再 attach 就再 attach。

## 对接要点（pi 侧）

- 连上先 `hello`，然后 `attach`；`attach-ok` 之后才可能收到 `arrived`。
- **`ack` 会把文件从 `queue/` 移走**：先把 `path` 的内容读走，再 `ack`。
  ack 之后原路径就不存在了（新的位置在 `archive/YYYYMMDD/`）。
- 同一个 id 可能重推：被抢占、断线重连、守护重启之后，`queue/` 里未 ack 的项会再推一遍。
  按 id 去重，不要假设「一张图只来一次」。
- 每 10 秒发一次 `ping`，回 `pong`；超过 `-stale` 没心跳会被判假死抢锁。
- 收到 `busy` 就等或问用户要不要抢；收到 `preempted` 说明锁已经不在自己手上，
  连接随后会被关，重连后重新 `attach` 即可。
- `finish` 表示用户在网页上结束了这一轮：锁已释放，该收尾的收尾，连接还在。

## 安全

- socket `0600` + Linux `SO_PEERCRED` 只接受同一 UID（`peer_linux.go`）
- HTTP 没有 TLS：局域网里本来就不设防，token 的作用是「别让同一个 wifi 的人随手打开
  你的页面」，不是鉴权边界。token 走 URL query，会被浏览器历史记下来。
- token 不进 journal，`/status` 也不回显；要拿它去 `cat <state>/token`。

## 装

```bash
photo/install.sh            # 测、编、装 unit、enable --now
photo/install.sh --reload   # 改完代码：编完 restart 已在跑的服务
photo/install.sh --status   # 只看状态
```

手工跑（临时目录，不碰 systemd、不碰真实 state）：

```bash
cd photo && go run . -state /tmp/photo-state -socket /tmp/photo.sock -addr 127.0.0.1:8787
```

### systemd 一个坑

**unit 里别写 `After=default.target`。** 凡 `WantedBy=default.target` 的单元，
systemd 都隐含 `Before=default.target`；自己再写一条 `After=default.target` 就成了自指，
叠上别的单元的依赖会凑成启动环，开机时 systemd 为了破环会删掉某条 start job
（表现为 unit enabled 却没 active）。要等图形会话就写 `After=graphical-session.target`。
hub 踩过一次，`hub/README.md` 有完整经过，这里只等 `network.target`。

## 测试

```bash
go test ./...
```

单测不碰真实端口与用户目录：state 用 `t.TempDir()`，socket 在临时目录，
HTTP 走 `httptest`（随机端口）。覆盖 token 校验、上传入队与 attach 后 flush、
ack 归档、busy/detach、心跳超期抢占、force 抢占、holder 断连释锁。
