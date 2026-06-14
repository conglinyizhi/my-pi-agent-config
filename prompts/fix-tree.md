---
description: 使用 gh cli 获取 agent:todo 标签的 issue，通过 git worktree 并行修复并自动合并关闭
argument-hint: "可指定 issue 编号，如 23 24；默认拉取所有 agent:todo issue"
---

列出计划，完成仓库中带有 `agent:todo` 标签的 issue（可指定 issue 编号）所描述的任务。当用户补充信息（user-say）和这部分冲突时，用户补充信息优先

<user-say alt="用户补充信息">$@</user-say>

执行步骤：

## 前置检查

- 确认当前目录位于 git 仓库根目录。
- 确认 `gh` 已登录且能访问当前仓库：`gh auth status`。
- 检查 issue 列表是否为空；如果为空则中止并报告。

## 获取待修复的 issue

- 如果 user-say 提供了编号或者指定的范围，只处理这些 issue。
- 使用 `gh issue list --label "agent:todo" --json number,title,body` 获取所有相关 issue。
- 如果 issue 包括评论，需要检查对应的评论是否有额外信息
- 分析每个 issue 的优先级与依赖关系，如果存在循环依赖或先后顺序冲突，先中止并报告。

## 制定并行修复计划

- 输出一个简短的计划表格：issue 编号、标题、工作区目录、预计无冲突依据。
- 确认无误后继续执行。

## 为每个 issue 创建独立的 worktree

- 在当前仓库根目录下创建子目录：`./.worktree/issue-<编号>/`。
- 运行：`git worktree add ./.worktree/issue-<编号> -b todo/issue-<编号>`。
- 将 `/.worktree/` 加入 `.gitignore`（如果尚未存在则追加一行 `/.worktree/`）。
- 确保这些目录不会被主仓库误认为子模块或未跟踪文件。

## 并行修复

- 在每个 worktree 中独立进行代码修改以解决对应 issue。
- 可读取 issue 详情（`gh issue view <编号>`）获取更多上下文。
- 修复完成后，在对应 worktree 内执行：

```bash
git add .
git commit -m "<type>(<scope>): <issue标题简述>

实现细节：<简要说明修改方式>

Closes #<编号>"
```

- commit message 必须是**中文**，遵循约定式提交格式，（如有对应 issue）包含 `Closes #编号` 关键字。

## 合并与清理

- 回到主仓库根目录，依次合并各分支：
  `git merge todo/issue-<编号> --no-ff`（解决可能冲突，确保每个 issue 独立合并）。
- 如果某个分支合并失败，保留该 worktree 和分支，不要删除，记录失败原因后跳过该 issue，继续处理下一个。
- 所有正常任务完成后，进入汇总阶段统一分析并手动解决之前保留的冲突分支。
- 合并完成后删除 worktree 及分支：
  `git worktree remove ./.worktree/issue-<编号>`（如果 worktree 中存在未提交改动导致删除失败，可先处理改动或使用 `--force`）
  `git branch -d todo/issue-<编号>`

## 最终提交汇总

- 列出所有已关闭 issue 编号，确认没有遗漏。

示例 commit message（中文）：

```
fix(auth): 登录 token 过期后无法自动刷新

基于 agent:todo 自动修复。

将刷新逻辑移到拦截器中，并在响应 401 时重新获取 token。

Closes #23
```

执行全程请确保不破坏主仓库状态。合并失败的 worktree 和分支会被保留到汇总阶段，由 agent 统一分析并手动解决冲突。
