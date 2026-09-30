// classifier-key.test.ts — API key 的读取与保存（全在临时目录，不碰真 auth.json）
//
// 跑法：node --test --experimental-strip-types extensions/sandbox-permissions/classifier-key.test.ts

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AUTH_PROVIDER, readKeyFromAuth, resolveReviewApiKey, saveKeyToAuth } from "./classifier-key.ts";

const dirs: string[] = [];

function tempAuth(initial?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "classifier-key-"));
	dirs.push(dir);
	const path = join(dir, "auth.json");
	if (initial !== undefined) writeFileSync(path, initial, "utf8");
	return path;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readKeyFromAuth", () => {
	it("读顶层 siliconflow-cn.key", () => {
		const path = tempAuth(JSON.stringify({ [AUTH_PROVIDER]: { key: "sk-abc" } }));
		assert.equal(readKeyFromAuth(path), "sk-abc");
	});

	it("兼容 providers 嵌套", () => {
		const path = tempAuth(JSON.stringify({ providers: { [AUTH_PROVIDER]: { key: "sk-nested" } } }));
		assert.equal(readKeyFromAuth(path), "sk-nested");
	});

	it("兼容 apiKey / api_key 写法和裸字符串", () => {
		assert.equal(readKeyFromAuth(tempAuth(JSON.stringify({ [AUTH_PROVIDER]: { apiKey: "sk-1" } }))), "sk-1");
		assert.equal(readKeyFromAuth(tempAuth(JSON.stringify({ [AUTH_PROVIDER]: { api_key: "sk-2" } }))), "sk-2");
		assert.equal(readKeyFromAuth(tempAuth(JSON.stringify({ [AUTH_PROVIDER]: "sk-3" }))), "sk-3");
	});

	it("文件不存在 / JSON 损坏 / 没有该 provider → undefined", () => {
		assert.equal(readKeyFromAuth(tempAuth()), undefined);
		assert.equal(readKeyFromAuth(tempAuth("{broken")), undefined);
		assert.equal(readKeyFromAuth(tempAuth(JSON.stringify({ other: { key: "x" } }))), undefined);
	});

	it("空白 key 视为没有", () => {
		assert.equal(readKeyFromAuth(tempAuth(JSON.stringify({ [AUTH_PROVIDER]: { key: "   " } }))), undefined);
	});
});

describe("saveKeyToAuth", () => {
	it("新文件：建出 siliconflow-cn.key，权限 600", () => {
		const path = tempAuth();
		const result = saveKeyToAuth("sk-new", path);
		assert.equal(result.ok, true);
		assert.equal(readKeyFromAuth(path), "sk-new");
		assert.equal(statSync(path).mode & 0o777, 0o600);
	});

	it("保留其它 provider 凭据，只动自己那个键", () => {
		const path = tempAuth(JSON.stringify({ deepseek: { key: "keep-me" }, other: { token: "keep-too" } }));
		saveKeyToAuth("sk-added", path);
		const doc = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(doc.deepseek, { key: "keep-me" });
		assert.deepEqual(doc.other, { token: "keep-too" });
		assert.equal(doc[AUTH_PROVIDER].key, "sk-added");
	});

	it("已有 providers 嵌套形态时跟着嵌套写，不多造一层", () => {
		const path = tempAuth(JSON.stringify({ providers: { deepseek: { key: "k" } } }));
		saveKeyToAuth("sk-nested", path);
		const doc = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(doc.providers[AUTH_PROVIDER].key, "sk-nested");
		assert.equal(doc[AUTH_PROVIDER], undefined);
	});

	it("覆盖旧 key 时保留该条目的其它字段，并留 .bak", () => {
		const path = tempAuth(JSON.stringify({ [AUTH_PROVIDER]: { key: "old", baseURL: "https://api.siliconflow.cn" } }));
		saveKeyToAuth("new-key", path);
		const doc = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(doc[AUTH_PROVIDER].key, "new-key");
		assert.equal(doc[AUTH_PROVIDER].baseURL, "https://api.siliconflow.cn");
		const backup = JSON.parse(readFileSync(`${path}.bak`, "utf8"));
		assert.equal(backup[AUTH_PROVIDER].key, "old");
	});

	it("现有 auth.json 坏了就拒绝覆盖（不能把用户凭据炸掉）", () => {
		const path = tempAuth("{not json");
		const result = saveKeyToAuth("sk-x", path);
		assert.equal(result.ok, false);
		assert.equal(readFileSync(path, "utf8"), "{not json");
	});

	it("空 key 拒绝保存", () => {
		const path = tempAuth();
		const result = saveKeyToAuth("   ", path);
		assert.equal(result.ok, false);
	});
});

describe("resolveReviewApiKey", () => {
	it("环境变量优先于 auth.json", () => {
		const path = tempAuth(JSON.stringify({ [AUTH_PROVIDER]: { key: "from-file" } }));
		assert.equal(resolveReviewApiKey({ TYPESAFE_API_KEY: "from-env" } as NodeJS.ProcessEnv, path), "from-env");
		assert.equal(resolveReviewApiKey({} as NodeJS.ProcessEnv, path), "from-file");
	});

	it("都没有 → undefined", () => {
		assert.equal(resolveReviewApiKey({} as NodeJS.ProcessEnv, tempAuth()), undefined);
	});
});
