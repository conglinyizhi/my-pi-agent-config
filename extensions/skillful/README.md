# skillful-local

从 [`pi-skillful`](https://github.com/jvm/pi-mono/tree/main/packages/pi-skillful) 迁移的本地核心逻辑。

## 当前迁移范围

- 发现 Git 仓库边界之外的 `.agents/skills/`
- 通过 `skillful.hiddenSkills` 控制技能是否出现在模型自动发现列表中
- `/skillful` 支持单个技能、来源组和全部技能的批量显隐选择
- 来源组规则是数据不是代码：写在 `extensions.toml` 的 `[skillful.skillGroups]`（`id` / `label` / `match` 路径片段），未命中规则的技能按 `skills/external` 包名或 Pi 的 source/scope 分组
- 界面采用“模型可见性”语义：`[x]` 可见，`[ ]` 隐藏，`[~]` 表示组内部分可见
- 选择界面中 `Space` 切换当前项，`v` 全部可见，`h` 全部隐藏，`Enter` 统一保存，`Esc` 放弃
- 支持在输入任意位置显式调用 `/skill:name`
- 支持全局设置 `~/.pi/agent/settings.json` 与受信项目的 `.pi/settings.json`

## 暂未迁移

- 会话技能快捷键与 toggle slots
- 原包安装遥测
- 原 `skill-boot` 的 repo clone、软链接和 vault 手动注入

## 归属与许可证

本目录的核心实现迁移自 `pi-skillful` 0.4.0，原作者为 Jose Mocito，原项目使用 MIT License。
完整许可证文本见 [`LICENSE-MIT`](LICENSE-MIT)。

迁移时排除了原项目的 `install-telemetry.ts`，不会向原作者服务器发送安装统计。
