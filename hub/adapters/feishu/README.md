# 飞书适配器

本机 `lark-cli` 的薄包装：收事件、发卡片，翻译成 hub 的 pair / decide / list。

没有 `lark-cli` 或未登录就退出码 78，systemd 不再狂重启。pi 里 `/remote:status` 能看见；若 unit 已 enable 却没在跑，开新会话会 notify 一次安装说明。不另写一套 OpenAPI。密钥只活在 CLI 登录态里。

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
