#!/usr/bin/env node
// A/B 的压缩入口：一个动作，两条路。状态层见 lib/ab-tag.ts。
//
//   ab-cli status    --component gui
//   ab-cli update    --component gui --ref HEAD --force    强制切（打完直接生效）
//   ab-cli update    --component gui --ref HEAD            打完挂成候选，等 5 次干净往返
//   ab-cli clean     --component gui                       记一次干净往返；到阈值切候选
//   ab-cli rollback  --component gui                       退回 prev-tag
//
// 桥接期：产物仍由 scripts/ab-pack.ts 打进 <组件>/dev，这里只维护 tag 那几行状态。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { PROMOTE_THRESHOLD, appendLog, bumpClean, rollback, setCandidate, setTag, stateOf } from "../lib/ab-tag.ts";

function arg(name: string): string | undefined {
	const at = process.argv.indexOf(`--${name}`);
	return at >= 0 ? process.argv[at + 1] : undefined;
}

const command = process.argv[2] ?? "status";
const component = arg("component");
const runtimeRoot = arg("runtime-root") ?? join(homedir(), ".pi", "runtime");
if (command !== "status" && !component) {
	process.stderr.write("需要 --component（gui 或 audit）：组件坏起来的样子不一样，不给默认值\n");
	process.exit(2);
}
const root = component ? join(runtimeRoot, component) : runtimeRoot;

function show(): void {
	const state = stateOf(root);
	process.stdout.write(`tag        ${state.tag || "(未挂)"}\n`);
	process.stdout.write(`prev-tag   ${state.prevTag || "(空)"}\n`);
	process.stdout.write(`candidate  ${state.candidate || "(空)"}\n`);
	process.stdout.write(`dir        ${state.dir || "(空)"}\n`);
	process.stdout.write(`计数       ${state.count} / ${PROMOTE_THRESHOLD}\n`);
}

if (command === "status") {
	show();
} else if (command === "seed") {
	// 桥接用：把现有 current 槽的真相搬进新状态（tag / prev-tag / dir），只做一次
	const link = join(root, "current");
	const slot = existsSync(link) ? basename(realpathSync(link)) : "";
	if (!slot) throw new Error(`没有 current 可搬：${link}`);
	const manifest = JSON.parse(readFileSync(join(root, slot, "manifest.json"), "utf8"));
	const tag = String(manifest.sha ?? "").slice(0, 7);
	const before = stateOf(root);
	writeFileSync(join(root, "tag"), tag + "\n", { mode: 0o600 });
	if (before.tag) writeFileSync(join(root, "prev-tag"), before.tag + "\n", { mode: 0o600 });
	writeFileSync(join(root, "dir"), slot + "\n", { mode: 0o600 });
	writeFileSync(join(root, "count"), "0\n", { mode: 0o600 });
	appendLog(root, { event: "note", outcome: "seed", to: tag, note: `搬自 ${slot} 槽` });
	show();
} else if (command === "update") {
	const ref = arg("ref") ?? "HEAD";
	// 打包沿用现成那条（桥接期写进 dev 目录）
	// 打包器的入口是 scripts/ab-pack.ts（那个 bin/ab-pack.sh 外壳随四槽模型一起删了）。
	// execFileSync 的第一个参数是二进制，不是命令行——别把整条命令塞进去（踩过）
	execFileSync(
		process.execPath,
		[
			"--experimental-strip-types",
			join(import.meta.dirname, "ab-pack.ts"),
			component!,
			"--ref",
			ref,
			"--dir",
			"dev",
			"--runtime-root",
			runtimeRoot,
		],
		{ stdio: "inherit" },
	);
	const manifest = JSON.parse(readFileSync(join(root, "dev", "manifest.json"), "utf8"));
	const tag = String(manifest.sha ?? "").slice(0, 7);
	if (!tag) throw new Error("manifest 里没有 sha，构建可能没成功");
	const state = process.argv.includes("--force")
		? setTag(root, tag, { dir: "dev", forced: true })
		: setCandidate(root, tag, { note: "等 5 次干净授权往返" });
	show();
	process.stdout.write(process.argv.includes("--force") ? "已强制生效\n" : "已挂成候选，攒满即自动切\n");
	void state;
} else if (command === "clean") {
	const { promote } = bumpClean(root);
	if (!promote) {
		show();
	} else {
		const state = stateOf(root);
		if (state.candidate === "") {
			process.stdout.write("攒满了，但没有候选；先 ab-cli update --ref <ref>\n");
			show();
		} else {
			setTag(root, state.candidate, { dir: state.dir || "dev", note: "攒满干净往返自动切换" });
			show();
		}
	}
} else if (command === "rollback") {
	rollback(root);
	show();
} else {
	process.stderr.write(`不认得的动作：${command}\n`);
	process.exit(2);
}
