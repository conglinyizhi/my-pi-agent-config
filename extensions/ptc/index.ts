// ptc 入口的壳体（真正的实现见 impl.ts）
//
// 槽在就用槽里那份实现（它 import 的 lib 也落在槽里，整条链同版本）；
// 槽不在、槽里没这个扩展、或那份起不来，就用仓库里的 impl.ts，并留一条提示。
// 这一层永远不该把 pi 弄死，也不必知道槽里是什么版本。
//
// 为什么用 async 工厂而不是顶层 await：宿主是 await factory(api) 的（loader 里就这么写），
// 这条路不依赖 jiti 对顶层 await 的支持。
//
// 背景见 docs/plans/2026-10-05-ab-update.md 第 4.5 / 4.6 节。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { loadSlotExtension } from "../../lib/ab-shell.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	const loaded = await loadSlotExtension<typeof import("./impl.ts")>("audit", {
		extension: "ptc",
		fallback: () => import("./impl.ts"),
		selfPath: fileURLToPath(import.meta.url),
	});
	await loaded.module.default(pi);
}
