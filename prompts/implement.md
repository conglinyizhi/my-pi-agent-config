---
description: 完整实现工作流：侦察者收集上下文，规划者制定计划，执行者完成实现
---
使用 subagent 工具，并通过 chain 参数执行这个工作流：

1. 首先，使用 "scout" agent 找出所有与以下任务相关的代码：$@
2. 然后，使用 "planner" agent 基于上一步提供的上下文，为 "$@" 制定实现计划（使用 {previous} 占位符）
3. 最后，使用 "worker" agent 根据上一步的计划完成实现（使用 {previous} 占位符）

将其作为 chain 执行，并通过 {previous} 在步骤之间传递输出。
