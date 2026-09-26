# pi-photo

手机拍照 → 存成短编号，给 pi 会话按编号取用。一台机器一个进程，只干两件事：

- **局域网 HTTP**：手机打开一个页面，调系统相机拍完在浏览器里压到长边 1600，POST 上来落盘
- **短编号池**：每张图登记一个编号（`1..pool`，默认 99），用户在输入框里用 `&img(3)` 引用

图不再自动推给某个会话：落盘、登记完这个进程的事就结束了。
所以锁、心跳、抢占、Unix socket 协议一概没有——要的是编号，不是独占。

## 落盘

```
~/.pi/agent/photo-state/          (-state)
  archive/YYYYMMDD/<id>.jpg       图片本体，落了就不删
  refs/index.json                 短编号表
  token                           HTTP 口令，32 位 hex，0600
```

- `<id>` 形如 `1758859200123-0007-a1b2c3d4`：毫秒时间戳 + 同毫秒序号 + 随机后缀，
  字符串序就是拍摄顺序。它只是文件名，**编号与它的对应关系全在 `refs/index.json` 里**。
- 图片一旦落盘就不再移动；编号被回收时只摘表项，文件留在 `archive/`，
  用户照样能用绝对路径引用。文件被真正删除只有一种情形：管理页上手动删（见下）。
- `index.json` 是编号表的唯一事实来源，写盘走「临时文件 + `rename`」，
  不会留下半截索引。启动时读它恢复编号，重启前后编号不变。
- 索引坏掉（手改坏了）时不挡启动：改名留档成 `index.json.bad-<时间>`，
  按空表起。图片文件都还在，重传一次或直接用路径都能救回来。

## 编号池

```json
{"items":[{"ref":3,"path":"/home/u/.pi/agent/photo-state/archive/20250926/1758859200123-0007-a1b2c3d4.jpg",
           "bytes":123456,"ts":"2025-09-26T12:48:00.123Z","lastUsed":"2025-09-26T13:01:02.456Z"}]}
```

分配与回收的规则，按顺序：

1. 取 `1..pool` 里**最小的空号**。
2. 一个空号都没有（池满）时，**回收** `lastUsed` 最早的那条；没有 `lastUsed` 就比 `ts`。
3. 时间完全相同时回收**编号最小**的那条：同一批图在池满时，回收谁不该随 map 遍历顺序变。
4. 回收只摘表项，**不删文件**。原图还在 `archive/`，绝对路径继续可用。

- `lastUsed` 由 `POST /refs/<n>/use` 刷成当下，含义是「这张刚被用过」，
  池满时就不会先砍到它。刷完立刻落盘：只在内存里记，重启后回收会开始按入库时间乱砍。
- 两个时间戳都是 RFC3339（UTC，带小数秒）。小数秒是必要的：同一秒里连传几张图时，
  回收顺序要靠它排出来。时间解析不出来时按零值算，也就是最先被回收。
- 池子大小由 `-pool` 控制，默认 99。调大不拦，只是编号会长，不再「短」。
- 池调小之后留在表里的越界编号不参与回收：它们既不是空号，也不该被当成候选砍掉。

## HTTP（默认 `0.0.0.0:8787`，`-addr`）

所有接口都要带 `?k=<token>`，缺失或不匹配一律 `401`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/?k=` | 页面：拍照 / 相册多选 / canvas 压缩，顶部显示池子用量，底部列最近的编号 |
| GET | `/manage?k=` | 管理页：缩略图网格 + 大图 + 删除。**只给回环来源**，手机等非本机来源回 `403` |
| POST | `/upload?k=` | body `{"images":[{"name":"x.jpg","dataUrl":"data:image/jpeg;base64,..."}]}` |
| GET | `/refs?k=` | `{"pool":99,"items":[{ref,path,bytes,ts,lastUsed?}...]}`，按 ref 升序 |
| GET | `/refs/<n>?k=` | 单条，就是上面 items 里的那个对象；不存在回 `404` 与 `{"error":"..."}` |
| GET | `/refs/<n>/raw?k=` | 该编号的图片二进制，`Content-Type` 按扩展名；不存在回 `404`。不限来源 |
| POST | `/refs/<n>/use?k=` | 刷新该条的 `lastUsed`，回 `{"ok":true}`；不存在回 `404` |
| POST | `/refs/<n>/delete?k=` | 删文件 + 释放编号，回 `{"ok":true,"ref":n}` |
| GET | `/status?k=` | `{"pool":99,"used":<已用号数>}` |

字段口径：

- `/upload` 回 `{"saved":[{"ref":3,"path":"/abs/x.jpg","bytes":123}],"rejected":0}`。
  `saved` 按接受顺序排列，`path` 是绝对路径；`rejected` 是本批被拒的张数，
  被拒的图不落盘、不占号。一张都没存下时 `saved` 是 `[]`，不是 `null`。
- `used` = 编号表里的条数（≤ pool）。回收之后它会降回去。
- 任何回执都不回 token：手机拿着 URL 里那个就够了，回显只是白白多一份副本。
- `/refs/<n>/raw` 的 `Content-Type` 按文件扩展名：`.jpg`/`.jpeg` → `image/jpeg`、
  `.png` → `image/png`、`.webp` → `image/webp`，别的后缀一律 `application/octet-stream`。
  表里没这个编号、或登记了但文件已经不在磁盘上，都是 `404`。
- `/refs/<n>/delete` 删掉文件并摘掉表项，编号随即回到空闲池，下次上传会重用它。
  编号没登记、或登记了但文件已经不在，两种都回 `404`（后者照样把号还回去），
  不报错；真删不掉（权限、路径不在归档目录内等）回 `500` 与原因，此时编号表不动。
  路径只从编号表取，`<n>` 不参与拼路径，这个接口删不到表里没登记的文件。

接受的图片类型只有 `image/jpeg`、`image/png`、`image/webp`，扩展名按类型落。
页面永远发 JPEG（canvas 压完就是 JPEG），另两种是给手搓请求留的路，免得默默丢图。
请求体上限 64 MiB。

## 管理页（只在本机开）

电脑上打开 `http://127.0.0.1:8787/manage?k=<token>`：缩略图网格列出全部编号，
每格显示缩略图、`#n`、入库时间与大小，点开看大图（就是 `/refs/<n>/raw`），
每格带删除按钮（删前浏览器 `confirm` 确认）；页顶显示当前用量与归档目录路径，
池子空时给一句提示。页面里的请求自己带上地址栏里的 `k`，token 不内联进 HTML。

**按来源分流**：只有 TCP 对端地址是回环（`127.0.0.0/8` / `::1`）才回页面，
其他来源一律 `403` 加一句话。手机走局域网 IP 进不来，所以「看照片、能删照片」
这一页不会因为同一个 wifi 的人随手打开上传页地址而暴露。分流只看连接对端，
不看 `X-Forwarded-For` 这类请求头，那些头谁都能填，拿它分流等于把门交给请求方。
代价是前面若加了反向代理，`RemoteAddr` 会变成代理的地址，管理页就进不去了；
真需要就把代理放在本机上转发。

`/refs/<n>/raw` 不限回环：上传页的缩略图列表也在用它，限了会让页面一离开本机就瞎掉；
它是只读的，比删除那一路温和得多。

删除是破坏性的，所以有两道约束：文件路径只从 `refs/index.json` 取，
请求里的 `<n>` 只用来查表、绝不参与拼路径；取到的路径还必须落在 `archive/` 里，
表被手改过指向 `/etc/...` 或 state 目录里的别的东西时直接拒绝（`500`）而不是照着删。

## pi 侧怎么用

- 用户在输入框里写 `&img(3)`，pi 侧把这个短编号换成真实路径。
- 查编号：`GET /refs/3`，或者一次看全表 `GET /refs`。
- 真用上了就 `POST /refs/3/use`，这样池满回收时不会先动刚用过的图。
- `path` 是绝对路径，pi 直接读，不去猜目录布局。

## 安全

- HTTP 没有 TLS：局域网里本来就不设防，token 的作用是「别让同一个 wifi 的人随手打开
  你的页面」，不是鉴权边界。token 走 URL query，会被浏览器历史记下来。
- token 只存在 `state/token`（0600），不进 journal，任何接口都不回显；
  要看就 `cat <state>/token`。
- 管理页（能看全部照片、能删文件）额外限了来源：只回环地址能打开，见上一节。
  它仍然在同一个端口上，所以「非回环拿不到页面」靠的是这个判断，不是另一个监听地址。

## 装

```bash
photo/install.sh            # 测、编、装 unit、enable --now
photo/install.sh --reload   # 改完代码：编完 restart 已在跑的服务
photo/install.sh --status   # 只看状态
```

手工跑（临时目录，不碰 systemd、不碰真实 state）：

```bash
cd photo && go run . -state /tmp/photo-state -pool 3 -addr 127.0.0.1:8787
```

### systemd 一个坑

**unit 里别写 `After=default.target`。** 凡 `WantedBy=default.target` 的单元，
systemd 都隐含 `Before=default.target`；自己再写一条 `After=default.target` 就成了自指，
叠上别的单元的依赖会凑成启动环，开机时 systemd 为了破环会删掉某条 start job
（表现为 unit enabled 却没 active）。要等图形会话就写 `After=graphical-session.target`。
hub 踩过一次，`hub/README.md` 有完整经过，这里只等 `network.target`。

## 测试

```bash
go test ./...          # 加 -race 也行
```

单测不碰真实端口与用户目录：state 用 `t.TempDir()`，HTTP 走 `httptest`（随机端口）。
覆盖 token 校验（含所有接口不回显 token）、上传分配编号（连续上传拿 1/2/3）、
最小空号优先、池满回收最久未用（`lastUsed` 优先、无 `lastUsed` 看 `ts`）、
`/refs/<n>` 与 404、`/refs/<n>/use` 刷新并落盘 `lastUsed`、
管理页只认回环来源（在请求对象上伪造 `RemoteAddr` 验 403）、
`/refs/<n>/raw` 的类型与逐字节回包、`/refs/<n>/delete` 删文件 + 释放编号
（删后再传拿回同一个号、重复删除 404、删失败 500 且表不动）、
拒绝删除 state 目录外的路径、
回收后文件仍在 `archive/`、重启后编号表从 `index.json` 恢复、索引原子写。
