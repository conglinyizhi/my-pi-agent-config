import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildSessionInfo, LazySessionSource, listSessionFiles } from "./lazy-sessions.ts";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "pi-lazy-sessions-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** 每个用例一个独立目录，避免相互数到对方的文件 */
function newRoot(): string {
  return mkdtempSync(join(root, "case-"));
}

/** 造一个 v3 session 文件 */
function sessionFile(
  dir: string,
  id: string,
  options: { cwd?: string; name?: string; firstText?: string; extraMessages?: number; at?: Date } = {},
): string {
  const timestamp = (options.at ?? new Date("2026-01-01T00:00:00.000Z")).toISOString();
  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: options.cwd ?? "/tmp/project" }),
  ];
  let parentId: string | null = null;
  const push = (role: string, text: string, ts: number) => {
    const entryId = `${id}-${role}-${ts}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id: entryId,
        parentId,
        timestamp: new Date(ts).toISOString(),
        message: { role, content: [{ type: "text", text }], timestamp: ts },
      }),
    );
    parentId = entryId;
  };
  push("user", options.firstText ?? "hello world", 1767225601000);
  for (let i = 0; i < (options.extraMessages ?? 0); i++) {
    push("assistant", `reply ${i}`, 1767225602000 + i);
  }
  if (options.name) {
    lines.push(
      JSON.stringify({ type: "session_info", id: `${id}-info`, parentId, timestamp, name: options.name }),
    );
  }
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

describe("listSessionFiles", () => {
  it("扫子目录、只收 .jsonl，并按修改时间倒序", async () => {
    const base = newRoot();
    const dir = mkdtempSync(join(base, "list-"));
    const a = sessionFile(dir, "a");
    const b = sessionFile(dir, "b");
    writeFileSync(join(dir, "notes.txt"), "ignore me", "utf8");
    await utimes(a, new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(b, new Date("2026-03-01"), new Date("2026-03-01"));

    const files = await listSessionFiles(base);
    assert.deepStrictEqual(files.map(f => f.path.split("/").pop()), ["b.jsonl", "a.jsonl"]);
  });

  it("目录不存在时返回空数组", async () => {
    assert.deepStrictEqual(await listSessionFiles(join(newRoot(), "nope")), []);
  });
});

describe("buildSessionInfo", () => {
  it("口径与 SessionManager 一致：名称取最后一条 session_info、首条消息、消息数、最后活动时间", () => {
    const dir = mkdtempSync(join(newRoot(), "info-"));
    const path = sessionFile(dir, "x", {
      cwd: "/tmp/demo",
      name: "my session",
      firstText: "first question",
      extraMessages: 2,
      at: new Date("2026-02-02T10:00:00.000Z"),
    });

    const info = buildSessionInfo(path, Date.now(), parseSessionEntries(readFileSyncUtf8(path)));
    assert.ok(info);
    assert.strictEqual(info.id, "x");
    assert.strictEqual(info.cwd, "/tmp/demo");
    assert.strictEqual(info.name, "my session");
    assert.strictEqual(info.messageCount, 3);
    assert.strictEqual(info.firstMessage, "first question");
    assert.match(info.allMessagesText, /reply 1/);
    // 最后一条 assistant 消息的时间
    assert.strictEqual(info.modified.getTime(), 1767225602001);
  });

  it("没有消息时回退到 header 时间，首条消息显示 (no messages)", () => {
    const dir = mkdtempSync(join(newRoot(), "empty-"));
    const path = join(dir, "empty.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "empty",
        timestamp: "2026-04-04T00:00:00.000Z",
        cwd: "/tmp/empty",
      })}\n`,
      "utf8",
    );

    const info = buildSessionInfo(path, Date.now(), parseSessionEntries(readFileSyncUtf8(path)));
    assert.ok(info);
    assert.strictEqual(info.messageCount, 0);
    assert.strictEqual(info.firstMessage, "(no messages)");
    assert.strictEqual(info.modified.toISOString(), "2026-04-04T00:00:00.000Z");
  });

  it("坏文件（没有 session header）返回 null", () => {
    assert.strictEqual(buildSessionInfo("/tmp/x.jsonl", Date.now(), []), null);
  });
});

describe("LazySessionSource", () => {
  it("按批加载，hasMore 反映是否还有文件", async () => {
    const base = newRoot();
    const dir = mkdtempSync(join(base, "batch-"));
    for (let i = 0; i < 5; i++) {
      const path = sessionFile(dir, `s${i}`);
      await utimes(path, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
    }

    const source = await LazySessionSource.create(base);
    assert.strictEqual(source.totalFiles, 5);
    assert.strictEqual(source.sessions.length, 0);

    assert.strictEqual(await source.loadMore(2), 2);
    assert.deepStrictEqual(source.sessions.map(s => s.id), ["s4", "s3"]);
    assert.strictEqual(source.hasMore, true);

    assert.strictEqual(await source.loadMore(2), 2);
    assert.strictEqual(await source.loadMore(2), 1);
    assert.strictEqual(source.sessions.length, 5);
    assert.strictEqual(source.hasMore, false);
    assert.strictEqual(await source.loadMore(2), 0);
  });

  it("limit 卡住总数", async () => {
    const base = newRoot();
    const dir = mkdtempSync(join(base, "limit-"));
    for (let i = 0; i < 4; i++) await sessionFile(dir, `l${i}`);

    const source = await LazySessionSource.create(base, { limit: 2 });
    await source.loadMore(10);
    assert.strictEqual(source.sessions.length, 2);
    assert.strictEqual(source.hasMore, false);
  });

  it("带过滤时一直扫描到凑够一批，或扫完所有文件", async () => {
    const base = newRoot();
    const dir = mkdtempSync(join(base, "filter-"));
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) {
      paths.push(await sessionFile(dir, `f${i}`, { firstText: i % 2 === 0 ? "kitten" : "puppy" }));
    }
    // 让 f5（puppy）最新
    for (let i = 0; i < paths.length; i++) {
      await utimes(paths[i], new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
    }

    const source = await LazySessionSource.create(base, {
      match: info => info.firstMessage.includes("kitten"),
    });
    // 只要 2 条匹配，但匹配项分散在文件列表里，需要多扫几个文件
    assert.strictEqual(await source.loadMore(2), 2);
    assert.strictEqual(source.sessions.every(s => s.firstMessage.includes("kitten")), true);
    assert.ok(source.scannedFiles >= 2);
  });

  it("跳过解析不了的文件", async () => {
    const base = newRoot();
    const dir = mkdtempSync(join(base, "broken-"));
    writeFileSync(join(dir, "broken.jsonl"), "not json\n", "utf8");
    await sessionFile(dir, "good");

    const source = await LazySessionSource.create(base);
    await source.loadMore(5);
    assert.deepStrictEqual(source.sessions.map(s => s.id), ["good"]);
  });
});

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, "utf8");
}
