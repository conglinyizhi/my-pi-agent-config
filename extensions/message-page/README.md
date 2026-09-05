# message-page 插件

把当前会话**最后一条 AI 消息**渲染成一个自包含的 HTML 网页，方便在浏览器里长文阅读。

- **Markdown 渲染** + **代码块语法高亮**（highlight.js）
- **决策卡片**：用大模型把消息里"需要你拍板的问题"提炼成结构化卡片
- **多模板**：`clean` / `cards` / `paper` 三套排版
- 生成到 `~/.pi/message-pages/`，生成即用默认浏览器打开

## 安装

插件在 `~/.pi/agent/extensions/message-page/`，pi 会自动发现（`/reload` 即可加载，无需手动注册）。

依赖（`marked` / `highlight.js` / `marked-highlight`）挂在 `~/.pi/agent/package.json` 上，已随安装拉取到 `~/.pi/agent/node_modules`。

## 用法

```
/gen-page-use-latest-msg                 # 默认 clean 模板，弹选择器挑模型
/gen-page-use-latest-msg cards           # 指定 cards 模板
/gen-page-use-latest-msg paper --model openai/gpt-5.2   # 指定模板 + 指定模型（跳过模型选择）
```

- 模板参数：`clean` / `cards` / `paper`
- 模型参数：`--model provider/model`（不填则每次都弹模型选择器）

## 决策卡片

模型从消息里提取"待拍板的问题"，每张卡片包含：

- **优先级**：high / medium / low
- **问题**：需要决策的一句话
- **选项**：2~4 个可选项
- **建议**：消息里若有倾向则给出
- **理由**：简短的判断依据

如果消息里没有真正要求用户决定的内容，卡片为空，页面仍会渲染原文。

## 文件

- `index.ts` — `/gen-page-use-latest-msg` 命令入口
- `src/markdown.ts` — markdown → HTML + 代码高亮
- `src/cards.ts` — 决策卡片生成（大模型 + JSON 解析）
- `src/model.ts` — 模型选择
- `src/templates.ts` — 三套 HTML 模板
- `src/open.ts` — 浏览器打开
- `test-render.mts` — 独立渲染回归测试（`tsx extensions/message-page/test-render.mts`）

## 开发者备注

- 扩展通过 `~/.pi/agent/node_modules` 解析 pi / pi-ai 依赖（与仓库其他扩展一致）。
- 决策卡片用 `@earendil-works/pi-ai/compat` 的 `complete` + `ctx.modelRegistry.getApiKeyAndHeaders` 做嵌套 LLM 调用。
- 不修改系统提示词 / 工具集，符合 KV 缓存稳定前缀要求。
