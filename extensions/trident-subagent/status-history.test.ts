import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { describeSnapshot, listStatusSnapshots } from "./status-history.ts";

function tmpDir(): string {
  return fs.mkdtempSync(join(os.tmpdir(), "status-history-test-"));
}

function snapshot(dir: string, name: string, doc: unknown): string {
  const path = join(dir, name);
  fs.writeFileSync(path, JSON.stringify(doc), "utf-8");
  return path;
}

test("列出会话快照与旧格式快照，坏文件跳过", () => {
  const dir = tmpDir();
  snapshot(dir, "subagent-status-aaaaaaaa.json", {
    updatedAt: "2026-09-17T10:00:00.000Z",
    session: { hash: "aaaaaaaa", cwd: "/home/x/proj-a" },
    workers: [{ id: "w1" }],
  });
  snapshot(dir, "subagent-status.json", { updatedAt: "2026-09-17T09:00:00.000Z", workers: [] });
  fs.writeFileSync(join(dir, "subagent-status-bbbbbbbb.json"), "{ 半截", "utf-8");
  fs.writeFileSync(join(dir, "unrelated.txt"), "x", "utf-8");

  const files = listStatusSnapshots(dir);
  assert.equal(files.length, 2, "坏文件与无关文件都不进列表");
  assert.deepEqual(files.map((f) => f.sessionHash), ["aaaaaaaa", undefined]);
  assert.equal(files[0].workerCount, 1);
  assert.equal(files[1].workerCount, 0);
});

test("当前会话置顶，其余按更新时间从新到旧", () => {
  const dir = tmpDir();
  snapshot(dir, "subagent-status-11111111.json", {
    updatedAt: "2026-09-17T08:00:00.000Z",
    session: { hash: "11111111" },
    workers: [],
  });
  const current = snapshot(dir, "subagent-status-22222222.json", {
    updatedAt: "2026-09-17T07:00:00.000Z", // 最旧，但它是当前会话
    session: { hash: "22222222" },
    workers: [],
  });
  snapshot(dir, "subagent-status-33333333.json", {
    updatedAt: "2026-09-17T09:00:00.000Z",
    session: { hash: "33333333" },
    workers: [],
  });

  const files = listStatusSnapshots(dir, { currentPath: current });
  assert.equal(files[0].path, current);
  assert.equal(files[0].current, true);
  assert.deepEqual(files.slice(1).map((f) => f.sessionHash), ["33333333", "11111111"]);
});

test("缺 updatedAt 时回退文件 mtime，不显示成未知", () => {
  const dir = tmpDir();
  snapshot(dir, "subagent-status-44444444.json", { workers: [] });
  const [file] = listStatusSnapshots(dir);
  assert.ok(file.updatedAt && Number.isFinite(Date.parse(file.updatedAt)));
});

test("目录不存在时返回空数组，不抛错", () => {
  assert.deepEqual(listStatusSnapshots("/tmp/__不存在的目录__/深层"), []);
});

test("选择列表一行里认得出：当前会话 / 会话哈希 / 目录 / 时间 / worker 数", () => {
  const line = describeSnapshot({
    path: "/home/clyzhi/.pi/subagent-status-aaaaaaaa.json",
    updatedAt: "2026-09-17T10:00:00.000Z",
    sessionHash: "aaaaaaaa",
    sessionCwd: "/home/clyzhi/proj/trident",
    workerCount: 3,
    current: false,
  });
  assert.match(line, /会话 aaaaaaaa/);
  assert.match(line, /proj\/trident/);
  assert.match(line, /3 个 worker/);

  const currentLine = describeSnapshot({
    path: "x",
    sessionHash: "bbbbbbbb",
    workerCount: 0,
    current: true,
  });
  assert.match(currentLine, /^当前会话/);
  assert.match(currentLine, /时间未知/);
});
