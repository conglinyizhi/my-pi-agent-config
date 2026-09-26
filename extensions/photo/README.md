# photo —— 手机拍照，直接发进当前 pi 会话

用手机拍完照不用先传文件、再拖进输入框：`/photo:wait` 抢下本机 photo 守护的独占锁，
手机浏览器打开 `/photo:url` 给的局域网地址就能拍；照片落盘后由守护推给 pi，
作为用户消息（图片附件）注入当前会话。

pi 这边只做三件事：抢锁、注入、回执。HTTP 服务与图片落盘都在 `photo/` 那个守护里。

## 命令

| 命令 | 行为 |
|---|---|
| `/photo:wait [--force]` | 向守护抢锁，成功后**立刻返回**并进入后台监听态；状态栏显示 `📷 监听中 · 已收 n 张`。锁被别人占着时提示持有者（会话名 / sessionId / since），要抢加 `--force` |
| `/photo:stop` | detach 释放锁、停心跳、清状态栏，并报本次收了几张；没在监听时只提示一句 |
| `/photo:url` | 向守护要手机上传地址，用通知展示，并附一个 `qrencode` 渲染的终端二维码（手机直接扫） |

## 行为细节

- **心跳**：进监听态后每 10 秒发一次 `ping`。守护超过 30 秒没收到 ping 就判这个监听者假死，
  锁可以被别人抢走（推 `preempted`，reason=`stale`）。
- **收到图**（`arrived`）：逐张读文件 → `pi.sendUserMessage([{text},{image}], {deliverAs:"followUp"})`
  注入当前会话 → 收齐这一批成功的 id 后一次性 `ack`。某张读文件失败或注入失败时**不 ack 那张**
  （守护会留着，下次监听还能收到），只报一行错，不影响同批其它张。
  图片不写进系统提示词或工具描述——那些位置一动，prompt 缓存全废。
- **`finish`**（手机端按了结束）：只提示「本轮共收 n 张」，**不释放锁**；退出监听要 `/photo:stop`。
- **`preempted`**：清监听态与状态栏，提示是被判假死收回还是被 `--force` 抢走。
- **断线**：清监听态、状态栏去掉，提示一行；**不自动重连**（守护没在跑时重连只会刷屏），
  下一次 `/photo:wait` 重新连。
- **`session_shutdown`**（quit / reload / 换会话）：幂等地 detach、停心跳、关连接。
  pi 被硬杀（SIGKILL）时来不及 detach，锁会由守护按心跳超时收回。
- `/photo:url` 在监听中用当前这条连接问；没在监听则另开一条短连接问完即关（能不能问到
  取决于守护：它可能要求先有活跃会话）。

## 文件

- `index.ts`：命令、监听态、注入与回执的接线。长连接与心跳定时器**只在命令执行时**才开
  （扩展 factory 里不建 socket、不起定时器，reload / 启动阶段不该有网络副作用）
- `../../lib/photo-channel.ts`：socket 客户端（hello 握手、attach/busy、url/detach/ack/ping、
  推送回调、断线处理）与 `qrencode` 渲染封装
- `channel.test.ts` / `index.test.ts`：单测

## 单测

```bash
node --experimental-strip-types extensions/photo/channel.test.ts   # 协议：握手 / attach / busy / 推送 / 断线
node --experimental-strip-types extensions/photo/index.test.ts     # 接线：命令、注入与 ack、幂等清理、心跳
```

两个测试都在临时目录里起假守护 socket，不依赖真实 photo 守护，也不碰真会话。

## 协议（守护那一侧的实现见 `photo/`）

Unix socket `~/.pi/agent/run/photo.sock`，JSON 行，`v:1`（可用 `PI_PHOTO_SOCKET` 覆盖路径）。

pi → 守护：`hello`(role=pi) / `attach`(sessionId,name,force) / `detach` / `ping` / `ack`(ids) / `url`
守护 → pi：`hello-ok` / `attach-ok`(queued) / `busy`(holder) / `detach-ok` / `pong` / `ack-ok`(moved) /
`url-ok`(url) / `arrived`(items) / `finish`(by,count) / `preempted`(reason) / `error`(message)
