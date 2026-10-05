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
