// lib/review-flow/kit.ts — 给流程作者的工具集
//
// 作者写的是 ~/.pi/agent/review-flows/*.ts（默认目录），形状：
//
//   export default (kit) => kit.flow({
//     id: "bash-pre",
//     nodes: [
//       kit.node("chatreview", { id: "chat", next: "judge" }),
//       kit.custom("judge", async (ctx) => ({ status: "ok", terminal: "deny" })),
//     ],
//   });
//
// 运行时一个 import 都不需要：工具集由加载器递进来（见 load.ts），
// 这样换版本、换目录都不会因为路径解析而炸。编辑器提示靠目录里那份 tsconfig 与 .d.ts。

import type { Flow, FlowNode, NodeKind } from "./types.ts";
import type { NodeImpl } from "./runner.ts";

/** 版本号与能力清单：加载器按它判断这份工具集能不能满足作者（对照 preshell --spec 的做法） */
export const KIT_SPEC = { protocol: 1, kinds: ["chatreview", "classifier", "merge", "autoapprove", "gate", "terminal", "custom"] } as const;

export interface NodeOptions {
	id?: string;
	after?: string[];
	next?: string;
	onError?: string;
	onTimeout?: string;
	onEmpty?: string;
	settings?: Record<string, unknown>;
}

export interface ReviewKit {
	readonly spec: typeof KIT_SPEC;
	/** 声明一个内置种类的节点（实现由 pi 提供） */
	node(kind: NodeKind, options?: NodeOptions): FlowNode;
	/** 声明一个自己的节点：函数怎么写，它就怎么判 */
	custom(id: string, impl: NodeImpl, options?: Omit<NodeOptions, "id">): FlowNode;
	/** 收口：把声明与自己的实现打包成加载器要的形状 */
	flow(flow: Omit<Flow, "id"> & { id?: string }): { flow: Flow; nodes: Record<string, NodeImpl> };
	/** 结论常量，免得拼错 */
	readonly verdict: { safe: "safe"; risky: "risky"; dangerous: "dangerous"; error: "error" };
}

export function createKit(): ReviewKit {
	const impls: Record<string, NodeImpl> = {};
	return {
		spec: KIT_SPEC,
		// 不给 id 就用种类名当 id：同一个种类出现两次会被校验器抓出来（id 重复）
		node: (kind, options = {}) => ({ kind, ...options, id: options.id ?? kind }),
		custom: (id, impl, options = {}) => {
			impls[id] = impl;
			return { id, kind: "custom", ...options };
		},
		flow: (flow) => ({
			flow: { id: flow.id ?? "custom", ...flow },
			nodes: { ...impls },
		}),
		verdict: { safe: "safe", risky: "risky", dangerous: "dangerous", error: "error" },
	};
}
