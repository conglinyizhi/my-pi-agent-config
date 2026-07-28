# 三叉戟 TODO

## 现在就做

- [ ] `cp providers.roles.example.toml providers.roles.toml` 并填入实际模型
- [ ] `/reload` 加载新扩展和 SYSTEM.md
- [ ] 测试：对 OC Agent 说一句带任务意图的话，看它是否调 translate_task
- [ ] push 到远程

## 你自己来

- [ ] 写 OC 角色卡（舰队副官人设）
- [ ] 迭代 SYSTEM.md 人格（角色卡完成后替换或增强）

## Phase 2（编排层 + 事项队列）

- [ ] 扩展 subagent 系统：任务拆解 + 模型路由
- [ ] 事项队列（`~/.pi/agent/queue/`，JSON 文件，跨 session）
- [ ] 状态指示器 UI（基于 task-notification 扩展增强）
- [ ] planner/worker/reviewer 模型路由实际生效

## Phase 3（高级特性）

- [ ] 模型路由降级策略（便宜模型失败→自动升级）
- [ ] 按技术栈路由（MoonBit worker 用专用模型等）
- [ ] 快速调整模型配置的 UI
- [ ] OC Agent 定期总结

## 远期

- [ ] 独立进程集群架构（每个 agent 独立 pi 进程 + socket 通信）
