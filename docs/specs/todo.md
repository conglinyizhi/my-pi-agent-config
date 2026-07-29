# 三叉戟 TODO

## 立即验证

- [x] `cp providers.roles.example.toml providers.roles.toml` 并填入实际模型
- [x] `/reload` → 加载 OC 林汐 + 4 个新扩展 + 3 个 GUI
- [x] 聊天测试：跟林汐说「帮我记个 todo：修 Go 项目的 air 多进程管理」
- [x] 权限闸门测试：在 pi 里执行 `rm -rf /tmp/test-dir` 看 GUI 是否弹出

## Phase 1 — OC Agent + 翻译层

- [x] SYSTEM.md 注入林汐人格（98 行完整角色卡）
- [x] translate_task 扩展（trident-translator）✅ 已编码，⏳ 未测试
- [x] 隐私剥离规则 ✅ SYSTEM.md + 翻译工具均包含
- [x] 模型路由模板 ✅ providers.roles.example.toml

## Phase 2 — 编排层 + 事项队列

- [x] 事项队列 CRUD 工具（task_create/list/update/delete）✅ 已编码，⏳ 未测试
- [x] stutus widget（舰队事项面板）✅ 已编码
- [x] subagent 模型路由集成 ✅ resolveModelName() 解析 providers.roles.toml
- [x] planner/worker/reviewer 模型角色 ✅ 每个 agent 标注 model 字段

## Phase 3 — 高级特性

- [x] 降级策略 ✅ 便宜模型失败→planner 重试（single/parallel/chain 三种模式）
- [x] 技术栈路由 ✅ providers.roles.example.toml 预留 [workers.Go] 等节
- [x] /trident-models 模型查看/切换
- [x] 定期总结 ✅ SYSTEM.md 新增"本周完成了什么"行为
- [x] /trident-setup Electron GUI ✅ 搜索+供应商过滤+模型下拉
- [x] /prompt-edit-gui + Ctrl+C 历史保存

## GUI 系统（bonus）

- [x] lib/gui-kit.mjs 骨架 ✅ createGuiApp() 10行启动新GUI
- [x] lib/gui-theme.css 共享样式 ✅ 暗色主题 + 按钮/对话框/覆盖层
- [x] 三个 Vue GUI 全部迁移 ✅ 统一 esbuild+rsbuild 构建
- [x] 调试菜单 ✅ 元素探测 (Ctrl+Shift+I) + DevTools
- [x] data-name 标注 ✅ 所有交互元素
- [x] skill gui-standards ✅ 开发规范文档

## 远期

- [ ] 独立进程集群架构
