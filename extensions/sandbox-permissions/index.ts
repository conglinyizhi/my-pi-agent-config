// sandbox-permissions 入口的壳体（真正的实现见 impl.ts）
//
// 槽在就用槽里那份实现：这个扩展的一堆同级模块（guard / gate / allow / paths / network /
// review 命令…）会跟着 impl.ts 一起从槽里加载，于是整条审批链同版本。
// 槽不在、槽里没这个扩展、或那份起不来，就用仓库里的 impl.ts，并留一条提示。
// 这一层永远不该把 pi 弄死。
//
// 为什么用 async 工厂而不是顶层 await：宿主是 await factory(api) 的（loader 里就这么写）。
//
// 注意：subagent 子进程那条路（lib/subagent-run.ts 以 --extension 直接加载 guard.ts）
// 不走这里，它照旧用仓库那份。子进程侧只做拦截、不做判定，属于已知边界。
//
// 背景见 docs/plans/2026-10-05-ab-update.md 第 4.5 / 4.6 节。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { loadSlotExtension } from "../../lib/ab-shell.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	const loaded = await loadSlotExtension<typeof import("./impl.ts")>("audit", {
		extension: "sandbox-permissions",
		fallback: () => import("./impl.ts"),
		selfPath: fileURLToPath(import.meta.url),
	});
	await loaded.module.default(pi);
}
