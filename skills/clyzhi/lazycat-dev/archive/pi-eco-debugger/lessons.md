# pi-eco-debugger 项目优质经验总结

## 1. esbuild 单文件打包 LPK 后端

**问题**：源码 ~200KB，但 LPK 包体 207MB（含 node_modules）。

**方案**：用 esbuild 将 TypeScript 后端打包为单个 CommonJS 文件，消除所有运行时 npm 依赖。

**文件**：[esbuild-bundle.js](./esbuild-bundle.js)

**关键收益**：

- 包体：207MB → ~2.1MB
- 部署：边端传输时间从分钟级降至秒级
- 启动：`node dist/server-bundle.cjs` 一行搞定

**注意事项**：

- esbuild 不支持 `__dirname` 等 CJS 全局，需使用 `import.meta.url` 或手动构造
- `declare const` 配合 `--define` 注入构建 ID 是常见的编译期常量注入模式
- Shell 变量传递给 esbuild 时涉及 JSON → shell 两层转义，见下文 BUILD_ID 一节

---

## 2. BUILD_ID 注入：JSON/Shell 多层转义

**问题**：需要将构建时生成的 `BUILD_ID`（时间戳）同时注入前端（Vite define）和后端（esbuild define），用于部署后自动刷新。

**教训**：`package.json` 的 npm scripts 字符串经过 JSON 解析 → shell 展开两层处理，转义极易出错。

**正确写法**（`package.json`）：

```json
"build": "export BUILD_ID=$(node -p 'Date.now()') && pnpm run build:server-bundle && pnpm run build:client && pnpm run build:copy-assets",
"build:server-bundle": "esbuild ... --define:BUILD_ID=\\\"$BUILD_ID\\\""
```

**文件**：[version-reload.ts](./version-reload.ts)

---

## 3. 部署后前端自动刷新

详见 [version-reload.ts](./version-reload.ts)，三个关键点：

| 要点     | 做法                                                                                |
| -------- | ----------------------------------------------------------------------------------- |
| 版本注入 | 构建时同一 BUILD_ID 注入前后端                                                      |
| 检测     | Socket.IO 握手时客户端传 `clientVersion`，服务端比对后回复 `{ reload: true/false }` |
| 防死循环 | `sessionStorage` 标记，刷新后若仍不一致则停止                                       |
| 跳过缓存 | `location.replace(url + '?_v=新版本号')` 而非 `location.reload()`                   |

---

## 4. 调试面板：后端推送完整状态

**场景**：agent 对话调试器需要展示 system prompt、每条消息、工具调用等。前端自己拼凑会导致顺序错乱、数据不一致。

**方案**：`debug_init` — 后端在 SSE 开始时推送一次性的完整快照（`fullMessages` + skills + tools），前端用此数据重建调试面板。后续增量的 tool_call/tool_result 来自后端真实回调。

**文件**：[debug-init.vue](./debug-init.vue)

**关键设计**：

- 单一真相来源：数据只从后端来
- 一次性快照 + 增量更新：debug_init 建基础，后续事件追回
- 前端不再手动 addDebugEntry 任何后端可知的内容

---

## 5. Skill 的渐进式披露

参考 Pi 源码 `dist/core/skills.js` 的 `formatSkillsForPrompt()`：

```xml
<available_skills>
  <skill>
    <name>skill-name</name>
    <description>What this skill does</description>
    <location>/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

**原则**：

- System prompt 中只放 name + description + location
- 不注入 SKILL.md 全文
- Agent 用 `read` 工具按需加载

---

## 6. 资源发现 + 符号链接安装

- 扫描目录结构：`skills/<packageId>/<resourceId>/SKILL.md`（懒猫资源导入格式）
- 安装到：`/lzcapp/var/pi-agent/skills/<id>` → 符号链接指向源目录
- 安全校验：`PiConfigManager.assertSafeSkillPath()` 防止路径遍历
- 状态持久化：`state.json` 记录安装映射，容器重启后自动恢复
- 热监听：chokidar 监听资源目录变化，通过 Socket.IO 推送给前端

---

## 7. Agent Loop 工具调用循环

基本结构（`chat.ts`）：

```text
while toolRound < MAX:
  调用 LLM（无 stream，检测 tool_calls）
  if 有 tool_calls:
    逐个执行（bash / read / write / edit / MCP）
    追加 tool 结果到 messages
    toolRound++
  else:
    流式输出最终回复
```

教训：

- 轮次上限触发时需追加 system 消息阻止模型伪造工具调用
- tool_call_id 必须使用 OpenAI 返回的真实 ID，不能用工具名
- 非 user/assistant 的消息不应包含在客户端发送的对话历史中
