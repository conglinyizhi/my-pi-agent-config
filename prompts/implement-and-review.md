---
description: 执行者负责实现，审查者负责审查，执行者根据反馈进行修改
---
使用 subagent 工具，并通过 chain 参数执行这个工作流：

1. 首先，使用 "worker" agent 实现：$@
2. 然后，使用 "reviewer" agent 审查上一步的实现结果（使用 {previous} 占位符）
3. 最后，使用 "worker" agent 根据审查反馈进行修改（使用 {previous} 占位符）

将其作为 chain 执行，并通过 {previous} 在步骤之间传递输出。
