# 我的 pi 配置

换电脑？一条命令的事。

```bash
git clone git@github.com:conglinyizhi/my-pi-agent-config.git ~/.pi/agent
cd ~/.pi/agent && pnpm install
pi
```

第一次启动，`skill-sync` 会自动把第三方 skill 全拉下来，不用你操心。

## 里面有什么

### 扩展

写了十几个扩展，都是日常用着用着觉得"这活该自动化"就加上的：

**skill-sync** — 启动时扫一眼 skill 目录，缺了谁就帮你 git clone 回来。换机器的底气全靠它。

**settings-sync** — settings.json 里有几个字段是 pi 自己改的（比如 lastChangelogVersion），不适合进 git。这个扩展把它们剔出去，只留干净的到 tracked.json。

**task-notification** — 任务跑完了弹个桌面通知，省得你时不时切回来看。

**session-search** — 翻历史对话。AI 觉得你可能问过类似问题时自己会搜，注册了一个 search_sessions 工具。

**permission-gate** 和 **confirm-destructive** — 一个拦危险命令（rm -rf 之类），一个在切换/分叉 session 前提醒，防手滑。

**protected-paths** — .env、node_modules 之类碰不得的路径直接挡住，免得不小心写坏。

**plan-mode** — 注册了 `/plan` 和 `/todos` 两个命令。切到计划模式后只读探索不乱改，先想清楚再动手。

**custom-providers** — `/provider fast-add` 快速加模型供应商。

**opencode-models** — `/model-more` 切换到从 opencode 导入的模型列表。

**stream-monitor** — 偷偷盯着流式响应，变慢了你能察觉。

**questionnaire** — 注册了一个工具让 AI 能弹选项框问你，不用打字的确认体验好很多。

**system-prompt-filter** 和 **editor-margin** — 前者过滤系统提示里的敏感路径，后者调编辑器边距，都属于"虽然小但舒服"的类型。

### Skill

自己写的三个：

**data-name** — 前端元素标注，给关键交互节点加 data-name 属性，AI 定位元素不用猜 class 名。

**lazycat-dev** — 懒猫微服那套开发流程，打包、部署、认证全涵盖。

**pi-docs** — pi 自身的文档导航。问 pi 本身的问题时会自动翻。

另外收录了华夏十大（wuji-labs/huaxia-skills）全部 10 个 skill，从道德经到庄子，从孙子兵法到黄帝内经，按场景自动触发。来源和版本记录在 `skills/_repo/repo.toml` 里，skill-sync 扩展负责维护。

## 通知音效

完成任务那一声的音效素材来自 Freesound 上的 Coghezzi，CC BY 4.0 授权。详情可见 [assets/sounds/ATTRIBUTION.md](assets/sounds/ATTRIBUTION.md)
