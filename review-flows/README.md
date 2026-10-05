# 自写的审核流程（review-flows）

这个目录里的每个 `*.ts` 文件对应一条审核流程，**文件名就是流程 id**：

```
bash-pre.ts            覆盖内置的 bash-pre（bash 预审，默认档位 chain）
bash-pre-chat.ts       覆盖只跑对话模型那条
bash-pre-classifier.ts 覆盖只跑分类器那条
```

加载不上、校验不过的流程**不影响审核面**：它自己退回内置那条，并在
`~/.pi/agent/ab_update.crash.md` 里留一条报告。

## 怎么写

```ts
import type { ReviewKit } from "../lib/review-flow/kit.ts";   // 只借类型，运行时会擦掉

export default (kit: ReviewKit) => kit.flow({
	id: "bash-pre",
	deadlineMs: 60_000,
	budget: { calls: 5 },
	nodes: [
		// 内置种类的节点：实现由 pi 提供，你只声明位置与参数
		kit.node("chatreview", { id: "chat", next: "classify" }),
		kit.node("classifier", { id: "classify", after: ["chat"], next: "judge" }),
		// 你自己的节点：函数怎么写，它就怎么判
		kit.custom("judge", async (ctx) => {
			const verdict = (ctx.upstream.classify as { verdict?: string } | undefined)?.verdict;
			if (verdict === "safe") return { status: "ok", terminal: "allow", verdict: "allow" };
			return { status: "abstain", reason: "拿不准，交给人" };
		}, { after: ["classify"], onEmpty: "deny" }),
	],
	// ...节点的边见下
});
```

两条规矩值得记住：

- `after` 是**数据流**（我要用哪些节点的产物），往哪走是**控制流**（`next` / `onError` / `onTimeout` / `onEmpty`）。
  顺序不该由依赖推出来
- 每个节点都要能走到终点（`allow` / `deny`，或 `terminal` 节点，或 `gate` / `custom` 自己给决定），
  否则加载就报错——不许静默挂住

## 工具集（kit）

| 东西 | 用途 |
| --- | --- |
| `kit.node(kind, opts)` | 声明内置种类的节点（种类见下表） |
| `kit.custom(id, fn, opts)` | 你自己的节点，`fn` 就是判定 |
| `kit.flow({...})` | 收口，返回加载器要的形状 |
| `kit.verdict` | 结论常量，免得拼错 |

内置种类：`chatreview`（对话模型）、`classifier`（分类器，判决者）、`merge`（合并）、
`autoapprove`（自动放行）、`gate`（人工闸门）、`terminal`（出口）。

`custom` 节点的返回值三选一：

- `{ status: "ok", terminal: "allow" | "deny" }` — 直接给决定
- `{ status: "abstain", reason }` — 拿不准，走 `onEmpty`
- `{ status: "error", message }` — 失败，走 `onError`

## 生效与排查

- 改完流程要 `/reload`（或重开会话）才生效：目录只在第一次用到时扫一次
- 校验你的流程：`make flows-check`
- 没生效先看 `~/.pi/agent/ab_update.crash.md`，那里写着哪个文件、哪一步没过

## 越界检查（说清：它不是安全边界）

流程在 pi 进程里跑，与插件同权限。加载前会先扫一遍源码，出现这些直接拒（文件根本不会被执行）：

| 拒绝的东西 | 为什么 |
| --- | --- |
| 任何**非 type-only** 的导入 | 流程是单文件。`import fs from "fs"` 与 `import ... from "node:fs"` 是同一个东西；`from "lodash"`、`from "./helper.ts"`、`import "x"`（副作用导入）同样拒 |
| `require(...)` / `import x = require(...)` | CommonJS 载入，绕过导入检查 |
| `await import(...)` | 动态导入，同上 |
| `process` | 退出、环境变量、信号 |
| `global` / `globalThis` | 往全局上挂东西 |
| `__dirname` / `__filename` | 文件系统路径 |

**只借类型是允许的**：`import type { ReviewKit } from "../lib/review-flow/kit.ts"`（或者具名里逐项写 `type`）——
type-only 会被整段擦掉，运行期没有任何耦合，编辑器照样有全套提示。

属性的名字（`ctx.settings.process`）与参数的名字不算引用，不会误报。

需要外部库怎么办：**写在 pi 扩展里**，由扩展给流程提供节点（流程本身保持单文件）。

**这不是安全边界，能绕**（`eval`、从别的包间接拿到原生模块，都拦不住）。它拦的是手滑，
以及把"越界"变成一句明话：*流程只做判定；要碰原生接口，就别写成流程*。

真要跑别人的流程，得靠隔离（worker + Node 的 permission model），那是另一件事。
