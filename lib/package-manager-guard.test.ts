// package-manager-guard 单测：拦 npm / npx / yarn，别误伤路径与字符串里的同名片段。
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { findForeignPackageManager, foreignPackageManagerMessage } from "./package-manager-guard.ts";

describe("findForeignPackageManager：该拦的", () => {
	const cases: Array<[string, string]> = [
		["npm install", "npm"],
		["npm ci", "npm"],
		["npm test", "npm"],
		["npx tsc --noEmit", "npx"],
		["npx --yes some-cli", "npx"],
		["yarn add lodash", "yarn"],
		["yarn", "yarn"],
		["cd /home/x/proj && npm install", "npm"],
		["pnpm build; npx vitest", "npx"],
		["sudo npm i -g typescript", "npm"],
		["FOO=1 BAR=2 npm run build", "npm"],
		["timeout 60 npm install", "npm"],
		["/usr/bin/npm install", "npm"],
		["NPM install", "npm"],
	];
	for (const [command, expected] of cases) {
		it(`${JSON.stringify(command)} → ${expected}`, () => {
			assert.equal(findForeignPackageManager(command), expected);
		});
	}
});

describe("findForeignPackageManager：不该拦的", () => {
	const cases = [
		"pnpm install",
		"pnpm add lodash",
		"pnpm dlx some-cli",
		"pnpm run build",
		"pnpm exec tsc",
		"bun install", // 另一个运行时，不属这件事
		"ls -la ~/.pi/agent/npm/node_modules",
		"grep -rn npm lib/",
		'echo "npm install"',
		"cat package.json | grep npm",
		"sed -n '1,5p' npm-lock.txt",
		"",
	];
	for (const command of cases) {
		it(`${JSON.stringify(command)} → 放行`, () => {
			assert.equal(findForeignPackageManager(command), undefined);
		});
	}

	it("非字符串输入不抛错", () => {
		assert.equal(findForeignPackageManager(undefined as unknown as string), undefined);
		assert.equal(findForeignPackageManager(null as unknown as string), undefined);
	});
});

describe("拒绝文案", () => {
	it("点出被拦的名字，并给出 pnpm 的三种替换", () => {
		const text = foreignPackageManagerMessage("npx");
		assert.match(text, /npx/);
		assert.match(text, /pnpm dlx/);
		assert.match(text, /pnpm install/);
		assert.match(text, /pnpm run/);
		assert.match(text, /pnpm exec/);
		assert.match(text, /pnpm-lock\.yaml/);
	});
});
