// lib/subagent-supplement.test.ts — Task 1: 原子补充队列存储测试
//
// 覆盖：FIFO enqueue/claim、空白/超长/容量上限、claim 一次一条且不接受工具结果、
// withdraw 拒绝 handoff、merge 所有 pending 顺序与 handoff 稳定、bad ID、
// 返回 snapshot 不被后续操作变异、重复 claim 无 pending 返回 null、锁的 stale 恢复与超时。
import assert from "node:assert";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  INBOX_ROOT,
  MAX_SUPPLEMENT_TEXT,
  MAX_SUPPLEMENT_ENTRIES,
  SUPPLEMENT_MESSAGE_PREFIX,
  createInbox,
  readInbox,
  enqueueSupplement,
  claimNextSupplement,
  withdrawSupplement,
  releaseSupplement,
  mergePendingSupplements,
  isValidInboxId,
  encodeSupplementMessage,
  decodeSupplementMessage,
} from "./subagent-supplement.ts";

/** 每个测试一个独立临时根目录，结束后清理。 */
function tmpRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supp-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

interface Overrides {
  now?: () => string;
  id?: () => string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

/** 注入 now/id（确定性递增）与 root 的默认选项。 */
function opts(root: string, over: Overrides = {}) {
  let tick = 0;
  let idSeq = 0;
  return {
    root,
    now: () => `T${++tick}`,
    id: () => `e${++idSeq}`,
    ...over,
  };
}

describe("constants and id validation", () => {
  it("exports documented limits", () => {
    assert.strictEqual(MAX_SUPPLEMENT_TEXT, 4000);
    assert.strictEqual(MAX_SUPPLEMENT_ENTRIES, 30);
  });

  it("INBOX_ROOT points at ~/.pi/subagent-supplements", () => {
    assert.ok(INBOX_ROOT.endsWith(path.join(".pi", "subagent-supplements")));
  });

  it("isValidInboxId accepts safe identifiers", () => {
    assert.strictEqual(isValidInboxId("abc123"), true);
    assert.strictEqual(isValidInboxId("a_b-c"), true);
    assert.strictEqual(isValidInboxId("A".repeat(128)), true);
    assert.strictEqual(isValidInboxId("batch-42_worker-7"), true);
  });

  it("isValidInboxId rejects traversal and unsafe ids", () => {
    assert.strictEqual(isValidInboxId(""), false);
    assert.strictEqual(isValidInboxId(".."), false);
    assert.strictEqual(isValidInboxId("a/b"), false);
    assert.strictEqual(isValidInboxId("a\\b"), false);
    assert.strictEqual(isValidInboxId("a b"), false);
    assert.strictEqual(isValidInboxId("a.b"), false);
    assert.strictEqual(isValidInboxId("a".repeat(129)), false);
    assert.strictEqual(isValidInboxId("中文"), false);
    assert.strictEqual(isValidInboxId(null as unknown as string), false);
  });

  it("operations reject invalid ids instead of touching the fs", async (t) => {
    const root = tmpRoot(t);
    await assert.rejects(createInbox("../evil", { root }), /inboxId/i);
    await assert.rejects(readInbox("", { root }), /inboxId/i);
    await assert.rejects(enqueueSupplement("x/y", "text", { root }), /inboxId/i);
    await assert.rejects(claimNextSupplement("..", { root }), /inboxId/i);
    await assert.rejects(withdrawSupplement("..", "e1", { root }), /inboxId/i);
    await assert.rejects(releaseSupplement("..", "e1", { root }), /inboxId/i);
    await assert.rejects(mergePendingSupplements("a b", { root }), /inboxId/i);
  });
});

describe("supplement wire message (encode/decode)", () => {
  it("encode → decode round trips entry id and text", () => {
    const encoded = encodeSupplementMessage("e-42", "补充内容 abc");
    assert.ok(encoded.startsWith(SUPPLEMENT_MESSAGE_PREFIX));
    const decoded = decodeSupplementMessage(encoded);
    assert.deepStrictEqual(decoded, { id: "e-42", text: "补充内容 abc" });
  });

  it("decode returns null for ordinary user input (no prefix)", () => {
    assert.strictEqual(decodeSupplementMessage("任务：普通提示词"), null);
    assert.strictEqual(decodeSupplementMessage(""), null);
    assert.strictEqual(decodeSupplementMessage(null as unknown as string), null);
  });

  it("decode tolerates malformed prefix payload and returns null", () => {
    assert.strictEqual(decodeSupplementMessage(SUPPLEMENT_MESSAGE_PREFIX + "not json"), null);
    assert.strictEqual(decodeSupplementMessage(SUPPLEMENT_MESSAGE_PREFIX + '{"id":"e1"}'), null); // 缺 text
    assert.strictEqual(decodeSupplementMessage(SUPPLEMENT_MESSAGE_PREFIX + '{"text":"x"}'), null); // 缺 id
    assert.strictEqual(decodeSupplementMessage(SUPPLEMENT_MESSAGE_PREFIX + '{"id":1,"text":"x"}'), null); // id 类型错
    assert.strictEqual(decodeSupplementMessage(SUPPLEMENT_MESSAGE_PREFIX + '{"id":"e1","text":5}'), null); // text 类型错
    assert.strictEqual(decodeSupplementMessage(SUPPLEMENT_MESSAGE_PREFIX + "[1,2]"), null); // 数组
    assert.strictEqual(decodeSupplementMessage(SUPPLEMENT_MESSAGE_PREFIX), null); // 只有前缀
  });

  it("decode never exposes malformed content", () => {
    const bad = SUPPLEMENT_MESSAGE_PREFIX + "garbage{{{";
    assert.strictEqual(decodeSupplementMessage(bad), null);
    // 前缀加合法 JSON 但多余字符仍算 malformed（整体必须是单对象）
    assert.strictEqual(
      decodeSupplementMessage(SUPPLEMENT_MESSAGE_PREFIX + '{"id":"e1","text":"x"} trailing'),
      null,
    );
  });
});

describe("createInbox", () => {
  it("creates an empty inbox file with owner-only mode and no leftover lock", async (t) => {
    const root = tmpRoot(t);
    const inbox = await createInbox("worker-1", { root, now: () => "T0" });
    assert.strictEqual(inbox.inboxId, "worker-1");
    assert.deepStrictEqual(inbox.entries, []);
    const file = path.join(root, "worker-1.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      inboxId: string;
      entries: unknown[];
    };
    assert.strictEqual(raw.inboxId, "worker-1");
    assert.deepStrictEqual(raw.entries, []);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(`${file}.lock`));
  });

  it("rejects an already-existing inbox", async (t) => {
    const root = tmpRoot(t);
    await createInbox("dup", { root });
    await assert.rejects(createInbox("dup", { root }), /exists/i);
  });

  it("readInbox throws for a missing inbox", async (t) => {
    const root = tmpRoot(t);
    await assert.rejects(readInbox("missing", { root }), /not found/i);
  });

  it("createInbox tightens a umask-loosened root dir to 0o700", async (t) => {
    if (process.platform === "win32") {
      t.skip("mode bits are not reliably honored on Windows");
      return;
    }
    // 根目录由 createInbox 自建：mkdir 默认 mode 会受 umask 放宽（如 0o755）
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "supp-root-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = path.join(parent, "inbox-root");
    const oldUmask = process.umask(0o022);
    t.after(() => process.umask(oldUmask));
    await createInbox("worker-1", { root });
    assert.strictEqual(fs.statSync(root).mode & 0o777, 0o700);
    // 队列文件本身仍为 owner-only
    assert.strictEqual(
      fs.statSync(path.join(root, "worker-1.json")).mode & 0o777,
      0o600,
    );
  });

  it("createInbox keeps an already-tight root at 0o700 (never widens)", async (t) => {
    if (process.platform === "win32") {
      t.skip("mode bits are not reliably honored on Windows");
      return;
    }
    // 根目录已收紧为 0o700（0o700 是可用的最严目录权限）：createInbox 不得放宽
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "supp-root-"));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = path.join(parent, "inbox-root");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    await createInbox("worker-2", { root });
    assert.strictEqual(fs.statSync(root).mode & 0o777, 0o700);
  });
});

describe("FIFO enqueue / claim", () => {
  it("keeps entries FIFO and claims the earliest pending first", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "first", o);
    await enqueueSupplement("q", "second", o);
    const snap = await enqueueSupplement("q", "third", o);
    assert.deepStrictEqual(
      snap.entries.map((e) => e.text),
      ["first", "second", "third"],
    );
    assert.deepStrictEqual(
      snap.entries.map((e) => e.state),
      ["pending", "pending", "pending"],
    );

    const c1 = await claimNextSupplement("q", o);
    assert.strictEqual(c1.claimed?.text, "first");
    assert.strictEqual(c1.claimed?.state, "handoff");
    assert.ok(typeof c1.claimed?.handedOffAt === "string");
    assert.deepStrictEqual(
      c1.inbox.entries.map((e) => [e.text, e.state]),
      [
        ["first", "handoff"],
        ["second", "pending"],
        ["third", "pending"],
      ],
    );

    const c2 = await claimNextSupplement("q", o);
    assert.strictEqual(c2.claimed?.text, "second");
    const c3 = await claimNextSupplement("q", o);
    assert.strictEqual(c3.claimed?.text, "third");
  });

  it("claim takes only (inboxId, options) — no tool result parameter", () => {
    // success/error 无关：claim 本身不接受工具结果，签名只有两个参数
    assert.strictEqual(claimNextSupplement.length, 2);
  });

  it("repeated claim with no pending returns claimed null and leaves the file unchanged", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "only", o);
    const c1 = await claimNextSupplement("q", o);
    assert.strictEqual(c1.claimed?.text, "only");
    const c2 = await claimNextSupplement("q", o);
    assert.strictEqual(c2.claimed, null);
    const after = await readInbox("q", o);
    assert.strictEqual(after.entries.length, 1);
    assert.strictEqual(after.entries[0].text, "only");
    assert.strictEqual(after.entries[0].state, "handoff");
  });

  it("claim marks exactly one pending entry per call, one at a time", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    for (let i = 0; i < 5; i++) await enqueueSupplement("q", `m${i}`, o);
    for (let i = 0; i < 3; i++) {
      const res = await claimNextSupplement("q", o);
      assert.strictEqual(res.claimed?.text, `m${i}`);
      const handoffs = res.inbox.entries.filter((e) => e.state === "handoff");
      assert.strictEqual(handoffs.length, i + 1);
    }
  });
});

describe("enqueue bounds", () => {
  it("rejects blank and whitespace-only text", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await assert.rejects(enqueueSupplement("q", "", o), /blank/i);
    await assert.rejects(enqueueSupplement("q", "   \n\t ", o), /blank/i);
  });

  it("rejects non-string text", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await assert.rejects(
      enqueueSupplement("q", 42 as unknown as string, o),
      /string/i,
    );
    await assert.rejects(
      enqueueSupplement("q", null as unknown as string, o),
      /string/i,
    );
  });

  it("accepts exactly MAX_SUPPLEMENT_TEXT chars and rejects one more", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "x".repeat(MAX_SUPPLEMENT_TEXT), o);
    await assert.rejects(
      enqueueSupplement("q", "y".repeat(MAX_SUPPLEMENT_TEXT + 1), o),
      /4000/i,
    );
  });

  it("rejects when total capacity (pending + handoff) is full", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    for (let i = 0; i < MAX_SUPPLEMENT_ENTRIES; i++) {
      await enqueueSupplement("q", `m${i}`, o);
    }
    await assert.rejects(enqueueSupplement("q", "overflow", o), /30/i);
    // handoff 也计入容量：claim 3 条后总量仍为 30，依然拒绝
    for (let i = 0; i < 3; i++) await claimNextSupplement("q", o);
    await assert.rejects(enqueueSupplement("q", "overflow-2", o), /30/i);
    // withdraw 腾出容量后可再入队
    const target = await readInbox("q", o);
    const pendingId = target.entries.find((e) => e.state === "pending")!.id;
    const w = await withdrawSupplement("q", pendingId, o);
    assert.strictEqual(w.withdrawn, true);
    await enqueueSupplement("q", "fits-now", o);
  });
});

describe("withdrawSupplement", () => {
  it("removes a pending entry, keeps order, returns withdrawn true", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    await enqueueSupplement("q", "b", o);
    await enqueueSupplement("q", "c", o);
    const res = await withdrawSupplement("q", "e2", o);
    assert.strictEqual(res.withdrawn, true);
    assert.deepStrictEqual(
      res.inbox.entries.map((e) => e.text),
      ["a", "c"],
    );
    // 后续 claim 从最早剩余 pending 开始
    const c = await claimNextSupplement("q", o);
    assert.strictEqual(c.claimed?.text, "a");
  });

  it("refuses to withdraw handoff entries", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    await enqueueSupplement("q", "b", o);
    const c = await claimNextSupplement("q", o);
    const handoffId = c.claimed!.id;
    const w = await withdrawSupplement("q", handoffId, o);
    assert.strictEqual(w.withdrawn, false);
    const after = await readInbox("q", o);
    assert.deepStrictEqual(
      after.entries.map((e) => e.text),
      ["a", "b"],
    );
    assert.strictEqual(after.entries[0].state, "handoff");
  });

  it("returns withdrawn false for an unknown entry id", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    const w = await withdrawSupplement("q", "does-not-exist", o);
    assert.strictEqual(w.withdrawn, false);
    assert.strictEqual((await readInbox("q", o)).entries.length, 1);
  });
});

describe("releaseSupplement", () => {
  it("restores a handoff entry to pending in place, clears handedOffAt, bumps updatedAt", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    await enqueueSupplement("q", "b", o);
    await enqueueSupplement("q", "c", o);
    const c = await claimNextSupplement("q", o); // a -> handoff
    assert.strictEqual(c.claimed?.text, "a");
    const before = await readInbox("q", o);

    const res = await releaseSupplement("q", c.claimed!.id, o);
    assert.strictEqual(res.released, true);
    // 原位恢复：位置不变、状态 pending、handedOffAt 删除
    assert.deepStrictEqual(
      res.inbox.entries.map((e) => [e.text, e.state, e.handedOffAt]),
      [
        ["a", "pending", undefined],
        ["b", "pending", undefined],
        ["c", "pending", undefined],
      ],
    );
    // updatedAt 前进
    assert.notStrictEqual(res.inbox.updatedAt, before.updatedAt);
    // 落盘可见
    const disk = await readInbox("q", o);
    assert.strictEqual(disk.entries[0].state, "pending");
    assert.strictEqual(disk.entries[0].handedOffAt, undefined);
    // FIFO 语义恢复：claim 又可以拿到它
    const c2 = await claimNextSupplement("q", o);
    assert.strictEqual(c2.claimed?.text, "a");
  });

  it("refuses to release a pending entry and does not write", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    await enqueueSupplement("q", "b", o);
    await claimNextSupplement("q", o); // a -> handoff；e2(b) 仍是 pending
    const before = await readInbox("q", o);
    const rawBefore = fs.readFileSync(path.join(root, "q.json"), "utf8");

    const res = await releaseSupplement("q", "e2", o);
    assert.strictEqual(res.released, false);
    const after = await readInbox("q", o);
    assert.deepStrictEqual(after, before); // 完全不变
    assert.strictEqual(fs.readFileSync(path.join(root, "q.json"), "utf8"), rawBefore); // 未写盘
  });

  it("returns released false for an unknown entry id and does not write", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    await claimNextSupplement("q", o); // a -> handoff
    const rawBefore = fs.readFileSync(path.join(root, "q.json"), "utf8");

    const res = await releaseSupplement("q", "does-not-exist", o);
    assert.strictEqual(res.released, false);
    assert.strictEqual(fs.readFileSync(path.join(root, "q.json"), "utf8"), rawBefore);
    assert.strictEqual((await readInbox("q", o)).entries[0].state, "handoff");
  });

  it("releases in place: entry keeps its index, surrounding entries untouched", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    for (const text of ["a", "b", "c", "d", "e"]) {
      await enqueueSupplement("q", text, o);
    }
    for (let i = 0; i < 5; i++) await claimNextSupplement("q", o); // 全部 handoff
    const relB = await releaseSupplement("q", "e2", o); // b 原位恢复
    const relD = await releaseSupplement("q", "e4", o); // d 原位恢复
    assert.strictEqual(relB.released, true);
    assert.strictEqual(relD.released, true);
    assert.deepStrictEqual(
      relD.inbox.entries.map((e) => [e.text, e.state]),
      [
        ["a", "handoff"],
        ["b", "pending"],
        ["c", "handoff"],
        ["d", "pending"],
        ["e", "handoff"],
      ],
    );
  });

  it("release returns a frozen snapshot not mutated by later operations", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    const c = await claimNextSupplement("q", o);
    const res = await releaseSupplement("q", c.claimed!.id, o);
    assert.ok(Object.isFrozen(res.inbox));
    assert.ok(Object.isFrozen(res.inbox.entries));
    assert.ok(Object.isFrozen(res.inbox.entries[0]));
    const before = JSON.stringify(res.inbox);
    await claimNextSupplement("q", o); // 之后的操作不得变异已返回的 snapshot
    assert.strictEqual(JSON.stringify(res.inbox), before);
  });
});

describe("mergePendingSupplements", () => {
  it("merges all pending in order with the deterministic delimiter; handoff entries stay put", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "alpha", o);
    await enqueueSupplement("q", "beta", o);
    await enqueueSupplement("q", "gamma", o);
    await enqueueSupplement("q", "delta", o);
    const c = await claimNextSupplement("q", o); // alpha -> handoff
    assert.strictEqual(c.claimed?.text, "alpha");
    await enqueueSupplement("q", "epsilon", o);
    // entries: [alpha handoff, beta, gamma, delta, epsilon]

    const m = await mergePendingSupplements("q", o);
    assert.strictEqual(m.merged, true);
    const entries = m.inbox.entries;
    assert.strictEqual(entries.length, 2);
    // handoff 原样保留在最前
    assert.strictEqual(entries[0].text, "alpha");
    assert.strictEqual(entries[0].state, "handoff");
    assert.strictEqual(entries[0].handedOffAt, c.claimed?.handedOffAt);
    // 合并条目位于第一个 pending 的位置，正文按 --- Supplement N --- 顺序连接
    assert.strictEqual(entries[1].state, "pending");
    assert.strictEqual(
      entries[1].text,
      [
        "beta",
        "--- Supplement 2 ---",
        "gamma",
        "--- Supplement 3 ---",
        "delta",
        "--- Supplement 4 ---",
        "epsilon",
      ].join("\n\n"),
    );
  });

  it("keeps multiple handoff entries stable in front of the merged entry", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "h1", o);
    await enqueueSupplement("q", "h2", o);
    await enqueueSupplement("q", "p1", o);
    await enqueueSupplement("q", "p2", o);
    await enqueueSupplement("q", "p3", o);
    await claimNextSupplement("q", o); // h1 -> handoff
    await claimNextSupplement("q", o); // h2 -> handoff
    const m = await mergePendingSupplements("q", o);
    assert.strictEqual(m.merged, true);
    const entries = m.inbox.entries;
    assert.strictEqual(entries.length, 3);
    assert.deepStrictEqual(
      entries.map((e) => [e.text, e.state]),
      [
        ["h1", "handoff"],
        ["h2", "handoff"],
        ["p1\n\n--- Supplement 2 ---\n\np2\n\n--- Supplement 3 ---\n\np3", "pending"],
      ],
    );
  });

  it("merges interleaved pending/handoff created via claim+release into the earliest pending slot", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    for (const text of ["a", "b", "c", "d", "e"]) {
      await enqueueSupplement("q", text, o);
    }
    // [P a, P b, P c, P d, P e] -> claim 4 条 -> [H a, H b, H c, H d, P e]
    for (let i = 0; i < 4; i++) await claimNextSupplement("q", o);
    // 原位 release a 与 c -> [P a, H b, P c, H d, P e]（claim/release 造出的交错状态）
    assert.strictEqual((await releaseSupplement("q", "e1", o)).released, true);
    assert.strictEqual((await releaseSupplement("q", "e3", o)).released, true);
    const interleaved = await readInbox("q", o);
    assert.deepStrictEqual(
      interleaved.entries.map((e) => [e.text, e.state]),
      [
        ["a", "pending"],
        ["b", "handoff"],
        ["c", "pending"],
        ["d", "handoff"],
        ["e", "pending"],
      ],
    );

    const m = await mergePendingSupplements("q", o);
    assert.strictEqual(m.merged, true);
    // merged 位于最早 pending（a）的原全局位置；handoff b/d 保持原相对顺序
    assert.deepStrictEqual(
      m.inbox.entries.map((e) => [e.text, e.state]),
      [
        [
          "a\n\n--- Supplement 2 ---\n\nc\n\n--- Supplement 3 ---\n\ne",
          "pending",
        ],
        ["b", "handoff"],
        ["d", "handoff"],
      ],
    );
  });

  it("returns merged false with fewer than two pending and changes nothing", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    await enqueueSupplement("q", "b", o);
    await claimNextSupplement("q", o); // a -> handoff，只剩 1 条 pending
    const m1 = await mergePendingSupplements("q", o);
    assert.strictEqual(m1.merged, false);
    assert.deepStrictEqual(
      m1.inbox.entries.map((e) => [e.text, e.state]),
      [
        ["a", "handoff"],
        ["b", "pending"],
      ],
    );
    await claimNextSupplement("q", o); // b -> handoff，0 条 pending
    const m2 = await mergePendingSupplements("q", o);
    assert.strictEqual(m2.merged, false);
    assert.strictEqual(m2.inbox.entries.length, 2);
  });
});

describe("snapshot immutability", () => {
  it("later operations do not mutate a previously returned snapshot", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    const snap = await enqueueSupplement("q", "a", o);
    const before = JSON.stringify(snap);

    await enqueueSupplement("q", "b", o);
    await claimNextSupplement("q", o);
    await mergePendingSupplements("q", o);

    assert.strictEqual(JSON.stringify(snap), before);
    assert.deepStrictEqual(snap.entries.map((e) => e.text), ["a"]);
    assert.strictEqual(snap.entries[0].state, "pending");
    // 返回的 snapshot 与条目均被冻结
    assert.ok(Object.isFrozen(snap));
    assert.ok(Object.isFrozen(snap.entries));
    assert.ok(Object.isFrozen(snap.entries[0]));
  });

  it("each claim result carries a fresh inbox not shared with earlier snapshots", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    await enqueueSupplement("q", "b", o);
    const s1 = await readInbox("q", o);
    const c = await claimNextSupplement("q", o);
    assert.strictEqual(s1.entries[0].state, "pending");
    assert.strictEqual(c.inbox.entries[0].state, "handoff");
    assert.notStrictEqual(s1, c.inbox);
    assert.notStrictEqual(s1.entries, c.inbox.entries);
  });
});

describe("lock directory", () => {
  it("releases the lock after every operation", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    await enqueueSupplement("q", "a", o);
    await claimNextSupplement("q", o);
    await readInbox("q", o);
    assert.ok(!fs.existsSync(path.join(root, "q.json.lock")));
    assert.deepStrictEqual(fs.readdirSync(root), ["q.json"]);
  });

  it("recovers a stale lock (old mtime) and proceeds", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root, { lockStaleMs: 50 });
    await createInbox("q", o);
    const lockDir = path.join(root, "q.json.lock");
    fs.mkdirSync(lockDir);
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lockDir, old, old);
    // 陈旧锁不应阻塞操作
    await enqueueSupplement("q", "a", o);
    assert.ok(!fs.existsSync(lockDir));
    assert.strictEqual((await readInbox("q", o)).entries.length, 1);
  });

  it("times out on a live (fresh) lock without removing it", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root, { lockTimeoutMs: 60 });
    await createInbox("q", o);
    const lockDir = path.join(root, "q.json.lock");
    fs.mkdirSync(lockDir); // 新鲜锁：模拟另一个进程正在持有
    await assert.rejects(enqueueSupplement("q", "a", o), /lock/i);
    // 别人的锁不被我们删掉
    assert.ok(fs.existsSync(lockDir));
  });

  it("queue file is written atomically: no tmp files left behind", async (t) => {
    const root = tmpRoot(t);
    const o = opts(root);
    await createInbox("q", o);
    for (let i = 0; i < 10; i++) await enqueueSupplement("q", `m${i}`, o);
    const leftovers = fs.readdirSync(root).filter((f) => f.includes(".tmp-"));
    assert.deepStrictEqual(leftovers, []);
  });
});
