# zhipu-search

通过智谱（大模型） Web Search API 提供**结构化联网搜索**。

搜索由智谱服务端执行（不是本地搜索），一次 query 一次搜索，返回 `search_result[]` 原始条目列表（标题、摘要、链接、来源、时间）。本扩展只负责把 query 送过去、取回结构化结果，**不做代理式总结**。

## 工作原理

- 注册 `web_search` 工具，参数：`search_query`（必填）、`search_engine`、`count`、`search_recency_filter`、`content_size`
- 内部调 `https://open.bigmodel.cn/api/paas/v4/web_search`，鉴权 `Authorization: Bearer <zhipu.key>`
- 智谱返回 `search_result[]`（title/content/link/media/icon/refer/publish_date）与 `search_intent[]`（意图识别）
- 本扩展把原始条目格式化后返回给模型，格式：

```
搜索完成（搜索引擎：search_std，共 10 条）：

1. 标题
   摘要：...
   链接：https://...
   来源：xx | 时间：2026-08-06
```

- 若服务端返回了 `search_intent[]`（意图识别结果），会附加到结果开头作说明

## 已知边界

- 返回的是**原始搜索结果列表**，不是代理式总结：调用方（模型）需自行综合多个结果得到结论
- 智谱 Web Search API 只做搜索，不含总结模型：需要"直接给结论"的场景，由调用方结合自身推理
- `search_query` 上限 70 字符；搜索引擎不同支持度不同（如 `search_pro_sogou` 的 `count` 仅支持 10/20/30/40/50）
- 需要代理式/自主多轮搜索总结的场景：这类需求在服务端无内置模型，需调用方自己多次搜索后综合

## 依赖

- API key：`~/.pi/agent/auth.json` 的 `zhipu.key`（gitignore，不入库）
- 端点：`POST https://open.bigmodel.cn/api/paas/v4/web_search`

## 限制

- 无状态 API：每次搜索调用独立，不维护会话
- 搜索结果会进入模型上下文，token 计入账单
- 搜索并发有限：错误码 1701=并发上限、1702=无可用引擎、1703=引擎未返回有效数据

## 测试

```bash
node --experimental-strip-types --test extensions/zhipu-search/zhipu-search.test.ts
```

真实调用验证（需要网络 + key）：

```bash
node --experimental-strip-types -e "
import { getZhipuKey, zhipuWebSearch } from './extensions/zhipu-search/index.ts';
const r = await zhipuWebSearch('搜索主题', getZhipuKey());
console.log(r.search_result);
"
```
