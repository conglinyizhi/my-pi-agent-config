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
