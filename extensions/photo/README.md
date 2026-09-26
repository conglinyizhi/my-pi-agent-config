# photo —— 手机拍照进编号池，想用哪张就 `&img(编号)`

用手机拍的照片不再自动推给会话。本机 photo 守护把落盘的图编成短号（1..99），
你在输入框里写哪张就展开哪张：

```
&img(3)                   引用编号池里的 3 号
&img(/abs/path/shot.jpg)  直接引用一个绝对路径（临时图、别处的图都行）
```

展开时图片直接作为**这条消息**的附件发出去，正文里只留一个 `[照片 #3]` 当锚点。
照片什么时候发、发哪张，全都由你在输入框里决定，没有后台监听、没有自动注入。

HTTP 服务（手机上传）与图片落盘在 `photo/` 那个守护里，pi 这边只做三件事：
引用时取图、列池子、给上传地址。

## 命令

| 命令 | 行为 |
|---|---|
| `/photo:list` | 列出编号池：编号、文件名、大小、最后使用时间；超过 20 行截断并提醒还剩多少。池子空时提示去 `/photo:url` 拿上传地址 |
| `/photo:url` | 给出手机上传地址（带口令），并附一个 `qrencode` 渲染的终端二维码；画不出来就只给地址 |

拍完的照片由守护编进池子；要看现在有哪些号就 `/photo:list`。

## `&img` 的展开规则

`&` 体系的接线在 `lib/fragment-providers.ts`：这里注册一个 `name="img"` 的 provider，
fragments 扫到 `&img(…)` 就把括号里的原文交给它。规则：

| 括号里 | 行为 |
|---|---|
| 纯数字 `3` | 问守护 `GET /refs/3` → 读那个路径的文件 → 成功就发一笔 `POST /refs/3/use`（不 await） |
| 以 `/` 开头 | 直接读这个路径，不走池子 |
| 其它（含编号不在池里、文件不存在、守护没跑、扩展名认不出） | 返回 `undefined`，fragments 按「未知引用」处理：原文留在文本里 + 提示一句 |

展开结果是 `{ text, images }`：`text` 是留给正文的锚点（`[照片 #3]` / `[照片 shot.png]`），
`images` 是 base64 + mimeType 的图片附件。mime 按扩展名判：`.jpg`/`.jpeg` → `image/jpeg`，
`.png` → `image/png`，`.webp` → `image/webp`；其它扩展名一律不展开（mime 塞错模型就看不到图）。

展开失败的**原因**放在模块里的 `lastError`，由 `/photo:list` 带出来一行
（provider 手上没有 ctx，展开当下没法弹提示）。

## 编号池与回收

- 号池是守护那边的概念：1..99 的短号，一个号对应一张已落盘的图（`ref` → 绝对路径）。
- pi 侧只认 `ref` 与 `path`；`bytes` / `ts` / `lastUsed` 有就展示，没有不影响引用。
- `useRef` 是「这张被用过了」的软回执，发给守护做回收参考。它**不 await、不抛错**：
  发不出去只记一行日志，不影响这次展开。回收策略（什么时候把号让出来）由守护定。
- 编号被回收后再引用同号，可能拿到别的图或直接 404（`getRef` 404 → 不当成本次展开）。

## 依赖的守护接口

地址默认 `http://127.0.0.1:8787`，用 `PI_PHOTO_BASE` 覆盖；
口令从 `~/.pi/agent/photo-state/token` 读（`PI_PHOTO_TOKEN_FILE` 可覆盖），
所有请求都带 `?k=<token>`。口令只出现在请求里，不进错误消息、不进日志。

`/photo:url` 给的地址是给**手机**打的，回环地址没用：用默认 BASE 时，
把它里面的 `127.0.0.1` 换成本机一个真实存在的局域网 IPv4（挑法与 `photo/netinfo.go` 一致：
私有网段优先，其次第一个非回环 IPv4）；显式设过 `PI_PHOTO_BASE` 就一个字节也不改。
挑错网卡（docker0 / tun0）时用 `PI_PHOTO_BASE` 指定正确的那个就行。

| 方法 | 路径 | 用途 | 期望返回 |
|---|---|---|---|
| GET | `/refs` | 列池子 | `{"pool": <数>, "items": [{"ref": 3, "path": "/abs/3.jpg", "bytes": 1234, "ts": "...", "lastUsed": "..."}]}` |
| GET | `/refs/<n>` | 取某号 | 同上单条；**404 = 没有这个号**（返回 `undefined`，不当异常） |
| POST | `/refs/<n>/use` | 记一笔使用 | 2xx 即可；非 2xx 只记日志 |
| GET | `/status` | 试着拿上传地址 | 有 `url` 字段就用它（缺 `?k=` 会补上），没有就按 `BASE/?k=<token>` 拼（回环地址会换成本机局域网 IPv4，见上） |

超时：连接与整体都封顶 5 秒（`DEFAULT_TIMEOUT_MS`）。连不上 / 超时 / 401 都抛**可读**的错误：
「连不上 photo 守护（…）」「photo 守护没响应（…超时）」「photo 守护不认这个口令（…）」；
口令文件不在或为空时报「photo 守护还没初始化」，不是裸 ENOENT。

注：当前守护的 `/status` 回的是 `{pool, used}`，没有 `url`，所以 `/photo:url` 走的是上面的兜底拼接；
局域网地址只在守护的 journal 里（不带 token）。守护哪天在 `/status` 里加上 `url`，pi 这边不用改就会用它。

守护那一侧的实现与协议细节见 `photo/README.md`。

## 文件

- `index.ts`：`&img` 的 provider、`/photo:list`、`/photo:url`、二维码与排版小工具。
  factory 里只做注册（纯内存）：不碰网络、不起定时器，reload / 启动阶段没有副作用
- `../../lib/photo-refs.ts`：守护的 HTTP 客户端（地址、口令、超时、错误文案），不 import pi API
- `fake-daemon.ts`：单测共用的假守护（真 HTTP，临时端口；不是扩展入口）
- `load-check.test.ts`：冒烟脚本，用 jiti（pi 加载扩展的方式）载入本扩展并检查注册结果
- `index.test.ts` / `photo-refs.test.ts`：单测

## 单测与自检

```bash
node --experimental-strip-types extensions/photo/photo-refs.test.ts   # HTTP 客户端：口令 / 404 / 超时 / useRef 不抛
node --experimental-strip-types extensions/photo/index.test.ts        # &img 三种参数、读不到文件、两条命令
node --experimental-strip-types extensions/photo/load-check.test.ts   # 扩展能被 pi 的方式载入，注册出 img provider
```

单测都起真 HTTP 的假守护（临时端口），不依赖真实 photo 守护，也不碰真会话；
`PI_PHOTO_BASE` / `PI_PHOTO_TOKEN_FILE` 在每个用例里指到假守护，用完恢复。
