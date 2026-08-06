# deepseek-search

通过 DeepSeek Responses API 的服务端内置 `web_search` 工具提供**代理式联网搜索**。

搜索由 DeepSeek 服务端执行（不是本地搜索），服务端模型自主决定搜索词、多次搜索并打开页面，综合来源后返回总结。本扩展只负责把 query 送过去、取回总结文本。

## 工作原理

- 注册 `web_search_agent` 工具，参数 `query: string`
- 内部调 `https://api.deepseek.com/responses`（Responses API），声明 `tools: [{ "type": "web_search" }]`
- DeepSeek 服务端执行代理式搜索（search + open_page 多次循环），结果经 `web_search_call` 事件回传
- 提取 `message` 的 `output_text`（服务端模型整理好的总结）作为结果返回给模型

## 已知边界

- 返回的是**总结**，不是原始搜索结果列表：DeepSeek 响应不暴露搜索结果数据（无 search_results 字段），只记录 action 轨迹（搜了什么 query、打开/尝试打开哪些 URL）
- 反 GEO / 需要原始 SERP 数据的场景：换用 Brave/Tavily/Serper 等结构化搜索 API

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
