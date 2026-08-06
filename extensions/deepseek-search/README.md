# deepseek-search

通过 DeepSeek Responses API 的服务端内置 `web_search` 工具提供联网搜索。

搜索由 DeepSeek 服务器执行（不是本地搜索），本扩展只负责把 query 送过去、取回搜索结果文本。

## 工作原理

- 注册 `web_search` 工具，参数 `query: string`
- 内部调 `https://api.deepseek.com/responses`（Responses API），声明 `tools: [{ "type": "web_search" }]`
- DeepSeek 服务端执行搜索，结果经 `web_search_call` 事件回传
- 提取 `message` 的 `output_text` 作为搜索结果返回给模型

## 依赖

- API key：`~/.pi/agent/auth.json` 的 `deepseek.key`（gitignore，不入库）
- 模型：`deepseek-v4-flash`（Responses API 目前仅支持该模型）

## 限制

- 无状态 API：`previous_response_id`/`conversation` 不支持，每次搜索调用独立
- 搜索结果会进入模型上下文，token 计入账单
- 不支持的参数被静默忽略（OpenAI Responses 客户端可无缝接入）

## 测试

```bash
node --experimental-strip-types --test extensions/deepseek-search/deepseek-search.test.ts
```

真实调用验证（需要网络 + key）：

```bash
node --experimental-strip-types -e "
import { getDeepSeekKey, deepseekWebSearch } from './extensions/deepseek-search/index.ts';
const r = await deepseekWebSearch('搜索主题', getDeepSeekKey());
console.log(r.text);
"
```
