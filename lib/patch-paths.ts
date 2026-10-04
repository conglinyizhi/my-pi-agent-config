// lib/patch-paths.ts — 从补丁正文里认文件
//
// apply_patch / patch 没有 path 参数：路径写在补丁身上（*** Update File: / @@ --- a/x）。
// 认得出就给显示层一个像样的标签；认不出就明说认不出，别编一个路径出来。
//
// 放在中立模块里：审批材料与合并视图都要用，两边互相引会成环。

/** 补丁里出现的文件路径（去重，保持出现顺序） */
export function patchPathsOf(patch: string): string[] {
	const found: string[] = [];
	const push = (raw: string): void => {
		let path = raw.trim();
		if (path === "" || path === "/dev/null") return;
		if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
		if (!found.includes(path)) found.push(path);
	};
	for (const line of String(patch ?? "").split("\n")) {
		const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
		if (header) {
			push(header[1]);
			continue;
		}
		const diffHeader = /^(?:---|\+\+\+) (.+)$/.exec(line);
		if (diffHeader) push(diffHeader[1]);
	}
	return found;
}
