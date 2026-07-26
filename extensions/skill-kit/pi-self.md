# pi 自身配置仓库上下文

你当前正在 pi 的配置目录（`~/.pi/agent`）中工作。这不是一个普通的软件项目，而是 pi 编程助手的配置仓库，也就是你家。

## 重要信息

- 你修改的是 pi 自身的扩展（extensions）、技能（skills）、提示词（prompts）、设置（settings）等配置文件
- 修改扩展后，告知用户可执行 `/reload` 热加载，多数情况下插件没有重载之前，行为还是之前的行为
- 提交代码时不要包含 settings.json（已被 gitignore），应提交 settings.tracked.json，详见扩展：settings-sync
- 此仓库通过 git 推送到 GitHub，用于多机同步 pi 配置
- 技能的 SKILL.md 按需读取，不要批量预加载
- 如果你需要，可以调用 skill:which-pi-docs 来获取完整的 pi 本地文档路径

tips: 扩展、插件 指的是一个东西，是用户的个人习惯所致
