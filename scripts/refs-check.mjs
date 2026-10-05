#!/usr/bin/env node
// refs-check.mjs — 删掉一个符号之后，确认仓库里没有活引用
//
// 由来：废掉审核流时删了 flowsBridge 的定义却漏了两处调用，node --check 只验语法，
// 于是把带崩溃的版本打进了槽，提督开窗时炸在 will-quit 上。
//
// 用法：node scripts/refs-check.mjs flowsBridge FLOWS_CLI
//   打印每一处命中（含注释）；命中只出现在注释里就由你自己判断。
//   有任何命中 → 退出码 1；全无命中 → 退出码 0。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const symbols = process.argv.slice(2).filter((arg) => arg && !arg.startsWith("--"));
if (symbols.length === 0) {
	console.error("用法：refs-check.mjs <符号> [符号...]");
	process.exit(2);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "sessions", "runtime", ".local-drafts", "archive"]);
const EXTS = [".ts", ".js", ".mjs", ".cjs", ".vue", ".sh", ".json", ".toml", ".md"];
const roots = ["lib", "extensions", "scripts", "gui", "bin", "docs", "skills", "review-flows"];

function walk(dir, out) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") && entry.isDirectory()) continue;
		if (SKIP_DIRS.has(entry.name)) continue;
		// 别把自己算进去：本文件的注释里就写着用法示例，那不算引用
		if (entry.name === "refs-check.mjs") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (EXTS.some((ext) => entry.name.endsWith(ext))) out.push(full);
	}
	return out;
}

const files = [];
for (const root of roots) {
	try {
		if (statSync(root).isDirectory()) walk(root, files);
	} catch {
		// 目录不在就算了：这是个开发工具，不该因为少了 docs 就报错
	}
}

let hits = 0;
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	const lines = text.split("\n");
	for (const symbol of symbols) {
		const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
		lines.forEach((line, index) => {
			if (!re.test(line)) return;
			const where = `${relative(process.cwd(), file)}:${index + 1}`;
			console.log(`${symbol}  ${where}  ${line.trim().slice(0, 100)}`);
			hits += 1;
		});
	}
}

if (hits === 0) {
	console.log(`干净：${symbols.join(" ")} 在库里没有任何引用`);
} else {
	console.log(`共 ${hits} 处命中（上面每条都看看：只出现在注释里就不算活引用）`);
}
process.exit(hits === 0 ? 0 : 1);
