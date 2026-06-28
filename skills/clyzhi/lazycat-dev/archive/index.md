# 归档代码片段 / 经验速查

按场景分类的即插即用索引。遇到对应需求时直接打开指向的文件即可。

---

## 构建与部署

### esbuild 单文件打包 LPK 后端

> 包体从 207MB 压到 2MB，消除运行时 node_modules 依赖

- **代码**：[esbuild-bundle.js](./pi-eco-debugger/esbuild-bundle.js)
- **经验**：[lessons.md §1](./pi-eco-debugger/lessons.md#1-esbuild-单文件打包-lpk-后端)

**什么时候用**：LPK 包体过大、部署传输慢、启动时需要 `npm install`

### BUILD_ID 注入 + 部署后前端自动刷新

> 前后端共享构建时间戳，Socket.IO 握手时比对版本，不一致则自动刷新（带防死循环）

- **代码**：[version-reload.ts](./pi-eco-debugger/version-reload.ts)（含前后端完整逻辑）
- **经验**：[lessons.md §2](./pi-eco-debugger/lessons.md#2-build_id-注入jsonshell-多层转义)（转义踩坑）、[lessons.md §3](./pi-eco-debugger/lessons.md#3-部署后前端自动刷新)（刷新流程）

**什么时候用**：部署新版本后用户仍看到旧页面、需要无感热更新

---

## 调试

### debug_init：后端推送完整调试面板

> 后端 SSE 开始时推送一次性快照（messages + skills + tools），前端据此重建面板。后续增量事件追加即可

- **代码**：[debug-init.vue](./pi-eco-debugger/debug-init.vue)（Vue 组件，含模板 + 逻辑）
- **经验**：[lessons.md §4](./pi-eco-debugger/lessons.md#4-调试面板后端推送完整状态)

**什么时候用**：agent 对话调试面板数据错乱、前端手动拼凑消息顺序不一致

---

## Agent / Skill 开发

### Skill 渐进式披露

> System prompt 只放 name + description + location，全文由 Agent 用 read 按需加载

- **经验**：[lessons.md §5](./pi-eco-debugger/lessons.md#5-skill-的渐进式披露)

**什么时候用**：system prompt 过长、skill 内容注入后 token 爆炸

### 资源发现 + 符号链接安装

> 扫描 `skills/<packageId>/<resourceId>/SKILL.md` → 符号链接安装 → state.json 持久化 → chokidar 热监听

- **经验**：[lessons.md §6](./pi-eco-debugger/lessons.md#6-资源发现--符号链接安装)

**什么时候用**：实现 skill/MCP 市场、资源热加载、容器重启后自动恢复

### Agent Loop 工具调用循环

> while 循环驱动 LLM → 执行工具 → 追加结果 → 直到无 tool_calls 或达到上限

- **经验**：[lessons.md §7](./pi-eco-debugger/lessons.md#7-agent-loop-工具调用循环)

**什么时候用**：实现 agent 对话引擎、工具调用循环逻辑

---

## 文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| [debug-init.vue](./pi-eco-debugger/debug-init.vue) | 代码片段 | 调试面板组件（后端快照 + 增量） |
| [esbuild-bundle.js](./pi-eco-debugger/esbuild-bundle.js) | 代码片段 | esbuild 单文件打包脚本 |
| [version-reload.ts](./pi-eco-debugger/version-reload.ts) | 代码片段 | 版本检测 + 自动刷新（前后端） |
| [lessons.md](./pi-eco-debugger/lessons.md) | 经验文档 | 7 个主题的详细踩坑记录 |
