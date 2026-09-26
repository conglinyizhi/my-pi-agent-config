# 飞书适配器

本机 `lark-cli` 的薄包装：收事件、发卡片，翻译成 hub 的 pair / decide / list。

卡片版式（schema 2.0）的 JSON 在 `card-design/`，由 `scripts/feishu-card-gen.mjs` 生成（`pending` / `audit` / `capability` / `allowed` / `denied` 五份）。设计说明与官方文档硬约束见 `card-design/README.md`。

**审批卡推给谁，以 hub 随 `ask` 事件下发的授权名单为准**（`envelope.principals`）。适配器自己记的 `a.chats`（谁跟 bot 说过话）只用来拿 `chat_id`；不知道就直接按 `open_id` 发——实测 bot 可以不经“先说话”直发 open_id。

之所以不能只看 `a.chats`：那张表在进程内存里，适配器一重启就空，推卡循环一次不跑、也不打日志，表现为「本机窗弹了但飞书静悄悄」。现在那种情况会写一行 `ask …：本通道没有已授权账号，审批卡没推出去`。

**决断后改卡要用 `im messages patch`，不能用 `im +messages-edit`**：后者只吃文本 / 富文本（its own help 也这么写），对互动卡片消息会返回 `230054 This operation is not supported for this message type`，卡就留在原地、按钮还能点。

没有 `lark-cli` 或未登录就退出码 78，systemd 不再狂重启。pi 里 `/remote:status` 能看见；若 unit 已 enable 却没在跑，开新会话会 notify 一次安装说明。不另写一套 OpenAPI。密钥只活在 CLI 登录态里。

## 提问（kind=question）

pi 的 `ask_question` 也扇出到飞书：一题一张卡，答完一题算一题。

- 认题靠回调里的 `message_id`（不靠控件名里的题号：下拉没碰过时 `form_value` 里可能没有 `sel_i`）
- `form_value` 是 JSON **字符串**，键是控件 `name`；自由输入非空即优先于下拉选择
- **集齐所有题才 decide**：收到一半就提交，等于把半截答案当成完整答复
- 取消按钮在每张卡上，停在任意一题都能撤；撤了就整场作废
- 结算后现场留到 hub 的 `settled` 广播到达才清 —— 提前清掉，剩下几题的卡就改不了

## 延迟发卡

决策卡（审批 + 提问）收到 `event=ask` 后不立刻推，默认先压 2 分钟（`-card-delay`，`0` = 立刻）。

理由两条：用户常就在屏幕前，本机闸门窗（审批）或本地 TUI（提问）已经把决策拿走了，这张卡纯属打扰；飞书有月 API 调用额度，更不该白花。

- 压着的卡收到 hub 的 `settled` 广播（有人答了 / 超时 / abort）就撤单，卡干脆不发
- 撤不到就是已经发出去了，照常走改卡那条路（`im messages patch`）
- 到点后再问 hub 一次「用户还在不在电脑前」（`presence`）：最近 `-presence-window`（默认 `5m`）内有键鼠按键就先不推，按 `-presence-retry`（默认 `1m`）再看一次，直到人离开、或这条 ask 过期。用户一直坐在机器前的话，这类卡可能一张都不发，这是要的行为；`-presence-window 0` 关掉这道闸门
- 查询失败、或 hub 读不到输入设备（`hasInput=false`）时一律照常推：查不到不能变成把卡压死
- `urgent` 的 ask 走 `pushNow`，不过这道闸门
- 到点时已经过期的直接跳过：hub 的 expired 结算 5 秒一跳，推出去只是张按不动的死卡
- `/list` 是用户主动拉，不延迟
- 延迟期间适配器重启会丢掉未到点的卡，那条 ask 就不会再推了（重启后 hub 不会重发 ask 事件）

## 前置

```bash
pnpm add -g @larksuite/cli
lark-cli config init
lark-cli auth login
lark-cli auth status
```

开发者后台要打开 **事件与回调 → 回调配置**，否则 `card.action.trigger` 收不到。用 bot 身份。

## 装

跟 hub 一起：

```bash
~/.pi/agent/hub/install.sh           # 有 lark-cli 会顺带启飞书
~/.pi/agent/hub/install.sh --reload  # 改完适配器代码后重启
```

## 用法

陌生人找 bot → 得到 `PIHUB-` 码 → 本机 `/remote:allow-key` 或 yad 许可窗。  
已授权：`/list` 拉未决卡，点允许/拒绝，或 `/allow <id> [附言]`。
