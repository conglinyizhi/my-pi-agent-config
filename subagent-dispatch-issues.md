# subagent 派工参数的问题

记录日期：2026-09-23
记录者：主调度（林汐），在一个业务项目里连续踩到

> 状态（2026-09-23 晚）：核心问题与附带问题 1/3/4 已修，4（readonly 语义）按「强制 + 文档」一起落地。
> 逐条对应见文末「修复记录」。

---

## 核心问题：`task` 数组会静默吃掉误写的裸字符串

### 现象

主调度派 1 个 worker，实际派出 2 个；第 2 个收到的任务文本是单个词 `timeout`。

```json
{
  "task": [ { "objective": "……完整简报……" }, "timeout" ],
  "sandbox_dir": "/path/to/project"
}
```

`"timeout"` 被当成**第二个 worker 的完整任务简报**派了出去。

**同一个手误在一天内发生六次**，每次浪费一个 worker 的完整预算。

第六次的形态变了但成因相同：裸字符串是 `sandbox_dir` 而不是
`timeout`。**而且这一批是两个 worker 一起受损**：跑偏的那个拿到 `"sandbox_dir"`
这个词，正常的那个则因为顶层 `sandbox_dir` 缺失而整批落到 readonly 档
（`workerReadonly` 的推导是 `profile = sandbox_profile ?? (sandbox_dir ? "worktree" : "readonly")`）。
也就是说：**一个参数写坏，整批 worker 的沙箱档位都跟着降级**，而且这件事在派工结果里
完全看不出来（返回仍然是“全部返航”）。

### 为什么会写成这样

`timeout` 本意是**顶层数值参数**，但长任务书的 `task` 数组往往写得很长（几百行）。
写完 `required_files: [...]` 之后接着想写 `"timeout": 2700`，容易：

1. 少写冒号和值，只剩 `"timeout"`
2. 忘记先给 `task` 数组收尾的 `]`

两者叠加，`"timeout"` 就落进数组了。**没有任何报错**。

### 建议修法（按优先级）

**① 数组元素只允许对象（最小改动，收益最大）**

`task` 是数组时，校验每个元素必须是 `TaskSpec`（至少要有非空 `objective`）。
是裸字符串就**直接报错**并指出是第几个元素，不要静默降级。

**② 或：收窄参数类型**

把 `task` 固定成 `TaskSpec | Array<TaskSpec>`，去掉 union 里的 `string`。
确实要传纯文本时，让调用方显式包成 `{ objective: "..." }`。

**③ 派工时回显每个 worker 的 objective 首 40 字**

现在只回「subagent 全部返航（2/2）」，派错时**要等 worker 跑完才发现**。
如果派工那一刻就回显每个 worker 的 objective，这类错误一眼可见。

**④ 顶层与数组内的键名互斥检查**

顶层出现 `timeout` / `sandbox_dir` 时，若 `task` 数组里也有同名裸字符串，报错。

## 建议的落地位置

- **① 的落点**：`extensions/trident-subagent/index.ts:353-355`，在
  `rawTasks.map(normalizeWorkerBrief)` 之前加一道校验：仅当 `Array.isArray(params.task)`
  时逐元素拒绝裸字符串并报出是第几个；单个字符串的兼容路径 `task: "..."` 保持可用。
  只改校验、不动执行路径。
- **③ 的落点**：`renderCall`（`index.ts:326-345`）加一行回显每个 worker 的 objective 首 40 字。
- **`normalizeSubagentArgs` 只折复数的 `tasks`，不校验数组元素**（`tool-args.ts`），
  所以裸字符串一路静默通过——这是 ① 未实现的确切位置。

---

## 附带观察到的问题

### 1. worker 收到无意义任务时不会硬性拒绝

两次收到单个词的 worker，都自己去反查那个词在仓库里指什么：

- 一次把仓库的沙箱机制翻了一遍（发现 `readonly` 只收紧 bash，`write`/`edit` 仍能改工作区）
- 一次把仓库里所有 `timeout` 出现的位置列了一遍

**做得没错**（没有瞎改代码），但**消耗了整个预算做无关侦察**。
建议在 worker 侧加一条：任务缺少 `objective` 时应立即回「简报不完整」并停止。

### 2. `readonly` 档的语义与字面不同

实测：`readonly` 只收紧 **bash**；worker 的工具白名单里有 `write` / `edit`，
这两个**不走 Landlock**，只过命令黑名单。

所以「readonly」实际是「**bash 不能写**」，不是「worker 不能写」。
本次实证：只读工作区下，worker 用 `write` 工具成功创建了文件，无任何审批。

建议：改名，或在文档里写明这条边界。

### 3. `sandbox_dir` 指向不存在的目录会静默降级

`filterExisting` 把它丢掉、只在 stderr 打一行警告，worker 静默降级成「只有 /tmp 可写」。

建议：直接报错。这类「静默降级」在派工场景里代价很高（worker 跑到一半才发现写不了）。

### 4. `sandbox_dir` 与 `readonly` 同时给时，readonly 赢

安全默认是对的，但和字面预期不同（调用方以为自己指定了可写目录）。
建议报错或至少警告。

---

## 已验证正常的行为（供参考）

- `task` 传单个对象 + `sandbox_dir` / `timeout` 在顶层：一切正常
- `timeout` 缺省时按默认预算跑；到点会**暂存并等人类决定**（继续给预算 / 停），不会硬掐
- `subagent_resume` 续跑不重置上下文，worker 接着原来的进度跑
- 并行的多个 worker 写各自的文件时不会互相干扰（本次实测两个 worker 同改一个模块，无冲突）

---

## 修复记录

### ① 数组元素只允许对象（`extensions/trident-subagent/tool-args.ts`）

`prepareSubagentArgs` = 折叠复数的 `tasks` + 逐元素校验，接在 `prepareArguments`
（schema 校验之前）上，抛错直接变成工具错误结果，**worker 一个都不会 spawn**：

- 数组里出现裸字符串 → 报错并指出第几个元素、拒绝理由里点明「这串文本本意可能是顶层参数」
- 元素缺 `objective` / 不是对象 → 同样报错
- `task: "单条纯文本"` 的兼容路径保持可用

schema 也跟着收窄：`task` 数组的元素类型从 `string | brief` 改为 `brief`。

### ③ 派工行逐 worker 回显 objective 首 40 字

`renderCall` 里列出 `#1 …` `#2 …`（多 worker 换行，单 worker 接在标题后）。
漏写的 `]` 把参数漏进数组、简报复制错位，在派工那一刻就能看见。

### ④ 顶层与数组内键名互斥

由 ① 直接覆盖：数组里任何裸字符串都拒绝，不必再单独比对键名。

### 附带 1：worker 收到无意义任务时立即收工

`SUBAGENT_PROMPT` 增加「简报完整性」一节：任务文本不足以构成可执行简报时，
直接回一句「简报不完整：缺什么」并停止，不要拿那个词去仓库里反复反查猜意图。

### 附带 2：readonly 语义（改名不改，改成名副其实）

`readonly` / `sandbox_dir` 的边界现在**对 bash 与写入类工具一起生效**：
`guard.ts` 新增 `readWorkerWriteScope` / `workerWriteBlocked`，按同一套 env 契约
（`PI_SANDBOX_RW` / `PI_SANDBOX_READONLY` / `PI_SANDBOX_RW_EXTRA`，内置 `/tmp`）
在工具层拦写入，越界拒绝并让 worker 把目标路径报回主 agent。
schema 与 README 的描述同步改写，不再有「只读却能写」的落差。

实兵验证时又挖出一个更大的洞：**`be-*` 整条 MCP 写通道从来没被拦过**。
`guard.ts` 原先只认 `write` / `edit` 两个工具名，而 worker 的工具白名单里
better-edit-tools 的 `be-write` / `be-replace` / `be-insert` / `be-delete` 都在，
参数用的是 `file`（可带 `:行范围`）——第一次实测 readonly worker 就是用 `be-write`
把文件写进了工作区的。这也是黑名单（`~/.ssh`、auth.json 等）一直存在的一条绕过路。

修法与验证：

- 新增 `targetPathOf(toolName, input, kind)`：读写两张表分别解析目标路径
  （`read`/`be-read` 用 `path`/`file`，写类工具用 `path`/`file`/`to`，`be-insert-chip` 的
  `from` 是 `file://` 时算读，`chip://` 不是路径），黑名单与写入边界都改走它
- **修的时候自己踩了一跤**：重构后写侧误用读表解析，整个写入分支静默跳过，
  第一轮实兵探针（worktree worker 用 `be-write` 写目录外）返回成功——靠
  「派一个真 worker 去撞边界」才发现，纯函数单测看不见这类错
- 因此补了**钩子级**单测：拉起 `guard.ts` 的 `tool_call` 处理器，按真实事件形状跑
  内置工具与 be-* 两套通道（路径解析正确、写入边界生效、yolo 行为不变）
- 修后实兵复测：readonly worker 写 `/tmp` 成功、写工作区被拒；
  worktree worker 用 `be-write` 写 `sandbox_dir` 内成功、写目录外被拒

### 附带 3：`sandbox_dir` 指向不存在的目录不再静默降级

新增 `extensions/trident-subagent/sandbox-params.ts`（`planSubagentSandbox`），
派工前一次性校验三件事，任一项不合法整批拒绝并给出修法：

- `sandbox_profile=worktree` 缺 `sandbox_dir`
- `sandbox_dir` 与只读档位同时给（历史上只读赢，目录静默失效）
- `sandbox_dir` 不是已存在的目录（历史上被沙箱包装器丢掉，worker 静默退化成只有 `/tmp` 可写）

### 覆盖的测试

- `extensions/trident-subagent/tool-args.test.ts`（形状校验 + 回显文本）
- `extensions/trident-subagent/sandbox-params.test.ts`（沙箱参数三态）
- `extensions/sandbox-permissions/guard.test.ts`（可写根解析、越界判定、工具名到路径的解析，以及 tool_call 钩子的工具分发）

### 生效方式

- worker 侧的 `guard.ts` 是每次 spawn 现从磁盘加载的，写入边界**已即时生效**
- 派工侧（`tool-args.ts` / `sandbox-params.ts` / `renderCall`）在主进程启动时加载并缓存，
  需要 `/reload`（或重启 pi）后才生效；不重载的话旧版仍在跑，实测会误以为修法无效
