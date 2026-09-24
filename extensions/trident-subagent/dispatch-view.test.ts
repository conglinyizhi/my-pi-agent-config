// dispatch-view.test.ts — 派发展示层单测（投影 / 仪表盘 / 回报预算 / 投递合并）
//
// 全部纯计算，不 spawn、不碰网络、不写盘：
//   - projectWorker/projectFleet：吞吐折算（含自校准与缺省回退）、活性判定
//     （在途工具 / 思考 / 静默 / 等审批 / 终态）、重试计数、截断标记
//   - FleetView：多行渲染、宽度截断、瞬时速率采样与 sparkline、宽度缓存
//   - createCoalescer：限频合并、末次必达、注入时钟下的确定性行为
//   - workerOutputBudget / formatWorkerOutput：整批预算切分与截断提示
//
// 跑法：node --experimental-strip-types extensions/trident-subagent/dispatch-view.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  DEFAULT_CHARS_PER_TOKEN,
  FleetView,
  IDLE_AFTER_MS,
  MAX_CHARS_PER_TOKEN,
  MIN_CHARS_PER_TOKEN,
  createCoalescer,
  formatCount,
  formatDuration,
  formatClock,
  formatSeconds,
  formatRate,
  formatRatePadded,
  formatToolArgs,
  formatWorkerOutput,
  projectFleet,
  projectWorker,
  sparkline,
  workerOutputBudget,
  type FleetTheme,
} from "./dispatch-view.ts";
import type { WorkerRun } from "./status.ts";

/** 无着色主题：断言输出文本时可读（theme.fg 原样返回） */
const plainTheme: FleetTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function run(overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id: "w1",
    inboxId: "batch-x-w1",
    task: "任务",
    model: "test/model",
    status: "running",
    startedAt: at(0),
    lastActivityAt: at(10_000),
    ...overrides,
  };
}

describe("projectWorker：吞吐折算", () => {
  it("无 stream/usage 时给零值且不产生 NaN", () => {
    const v = projectWorker(run(), 0, T0 + 10_000);
    assert.strictEqual(v.throughput.chars, 0);
    assert.strictEqual(v.throughput.outputTokens, 0);
    assert.strictEqual(v.throughput.charsPerToken, DEFAULT_CHARS_PER_TOKEN);
    assert.strictEqual(v.throughput.avgCharsPerSec, 0);
    assert.strictEqual(v.cost, 0);
    assert.strictEqual(v.finished, false);
  });

  it("字符数是三桶之和，平均速率按起算时长计算", () => {
    const v = projectWorker(
      run({
        stream: { textChars: 300, thinkingChars: 1200, toolcallChars: 100, deltas: 40, messages: 2 },
      }),
      0,
      T0 + 16_000, // 16s
    );
    assert.strictEqual(v.throughput.chars, 1600);
    assert.strictEqual(v.throughput.avgCharsPerSec, 100);
  });

  it("outputTokens = 已终结 usage.output + 在途 liveOutputTokens", () => {
    const v = projectWorker(
      run({ usage: usageOf({ output: 800 }), liveOutputTokens: 250 }),
      0,
      T0 + 5_000,
    );
    assert.strictEqual(v.throughput.outputTokens, 1050);
  });

  it("有已终结消息时用实测比值自校准（思考也计 token，故比值可用）", () => {
    // 4000 字符 / 1000 已终结 token → 4 字符每 token
    const v = projectWorker(
      run({
        usage: usageOf({ output: 1000 }),
        stream: { textChars: 1000, thinkingChars: 3000, toolcallChars: 0, deltas: 10, messages: 3 },
      }),
      0,
      T0 + 10_000,
    );
    assert.strictEqual(v.throughput.charsPerToken, 4);
    // 4000 字 / 10s = 400 字/s → 每 token 4 字 → 100 tok/s
    assert.strictEqual(v.throughput.estTokensPerSec, 100);
  });

  it("自校准比值（每 token 字符数）被夹在合理区间", () => {
    // 5000 token 只对应 10 字符（荒谬）→ 夹到下限
    const tiny = projectWorker(
      run({
        usage: usageOf({ output: 5000 }),
        stream: { textChars: 10, thinkingChars: 0, toolcallChars: 0, deltas: 1, messages: 1 },
      }),
      0,
      T0 + 1000,
    );
    assert.strictEqual(tiny.throughput.charsPerToken, MIN_CHARS_PER_TOKEN);
    // 10000 字符只对应 1 token → 夹到上限
    const huge = projectWorker(
      run({
        usage: usageOf({ output: 1 }),
        stream: { textChars: 10_000, thinkingChars: 0, toolcallChars: 0, deltas: 1, messages: 1 },
      }),
      0,
      T0 + 1000,
    );
    assert.strictEqual(huge.throughput.charsPerToken, MAX_CHARS_PER_TOKEN);
  });

  it("未终结消息不参与自校准（避免在途数字污染系数）", () => {
    const v = projectWorker(
      run({
        usage: usageOf({ output: 0 }),
        stream: { textChars: 500, thinkingChars: 0, toolcallChars: 0, deltas: 5, messages: 0 },
      }),
      0,
      T0 + 10_000,
    );
    assert.strictEqual(v.throughput.charsPerToken, DEFAULT_CHARS_PER_TOKEN);
  });

  it("已终态：elapsed 到 finishedAt，静默时长归零", () => {
    const v = projectWorker(
      run({ status: "success", finishedAt: at(30_000), lastActivityAt: at(29_000) }),
      0,
      T0 + 900_000, // 观测时刻远晚于结束
    );
    assert.strictEqual(v.elapsedMs, 30_000);
    assert.strictEqual(v.silentMs, 0);
    assert.strictEqual(v.finished, true);
  });
});

describe("projectWorker：当前动向", () => {
  it("在途工具（未写 ok）显示工具名与参数头", () => {
    const v = projectWorker(
      run({
        timeline: [
          { id: "t1", type: "tool", ts: at(1000), tool: "bash", args: '{"command":"rg -n   subagent lib/"}' },
        ],
      }),
      0,
      T0 + 3000,
    );
    assert.strictEqual(v.activity.kind, "tool");
    assert.match(v.activity.label, /^bash/);
    assert.match(v.activity.label, /rg -n subagent lib\//); // 空白折叠为单行
  });

  it("已结束的工具不再算「在途」（回落为流式/静默判定）", () => {
    const v = projectWorker(
      run({
        timeline: [{ id: "t1", type: "tool", ts: at(1000), tool: "bash", ok: true, result: "ok" }],
        stream: { textChars: 10, thinkingChars: 0, toolcallChars: 0, deltas: 1, messages: 0, lastDeltaKind: "thinking" },
      }),
      0,
      T0 + 3000,
    );
    assert.strictEqual(v.activity.kind, "thinking");
  });

  it("纯思考期显示「思考中」——这是「能看到还在动」的核心", () => {
    const v = projectWorker(
      run({
        stream: {
          textChars: 0,
          thinkingChars: 5000,
          toolcallChars: 0,
          deltas: 80,
          messages: 0,
          lastDeltaAt: at(2900),
          lastDeltaKind: "thinking",
        },
      }),
      0,
      T0 + 3000,
    );
    assert.strictEqual(v.activity.kind, "thinking");
    assert.strictEqual(v.activity.label, "思考中");
  });

  it("增量停滞后显示静默时长，而不是拿旧状态冒充当前", () => {
    const v = projectWorker(
      run({
        lastActivityAt: at(1000),
        stream: {
          textChars: 0,
          thinkingChars: 9,
          toolcallChars: 0,
          deltas: 1,
          messages: 0,
          lastDeltaKind: "thinking",
        },
      }),
      0,
      T0 + IDLE_AFTER_MS + 7000,
    );
    assert.strictEqual(v.activity.kind, "idle");
    assert.match(v.activity.label, /静默 8s（00:00:08）/);
  });

  it("等审批优先于一切运行态", () => {
    const v = projectWorker(
      run({
        status: "needs_approval",
        capabilityRequest: {
          version: 1,
          requestId: "r1",
          capability: "network",
          command: "pip install x",
          commandDigest: "d",
          reason: "需要联网",
          cwd: "/tmp",
          createdAt: at(1000),
        } as WorkerRun["capabilityRequest"],
      }),
      0,
      T0 + 2000,
    );
    assert.strictEqual(v.activity.kind, "waiting");
    assert.match(v.activity.label, /network/);
    assert.ok(v.capability);
    assert.strictEqual(v.capability?.command, "pip install x");
  });

  it("终态映射：success/timeout/aborted/failed", () => {
    const cases: Array<[WorkerRun["status"], string]> = [
      ["success", "done"],
      ["timeout", "failed"],
      ["aborted", "failed"],
      ["failed", "failed"],
    ];
    for (const [status, kind] of cases) {
      const v = projectWorker(run({ status, finishedAt: at(5000) }), 0, T0 + 6000);
      assert.strictEqual(v.activity.kind, kind, `status=${status}`);
    }
  });
});

describe("projectWorker：重试与截断元信息", () => {
  it("重试轮次取 timeline 里「第 N 次尝试」的最大值", () => {
    const v = projectWorker(
      run({
        timeline: [
          { id: "l1", type: "lifecycle", ts: at(1), state: "starting", message: "worker 启动" },
          { id: "l2", type: "lifecycle", ts: at(2), state: "starting", message: "worker 重试（第 6 次尝试）" },
        ],
      }),
      0,
      T0 + 1000,
    );
    assert.strictEqual(v.retries, 6);
  });

  it("note 取失败/审批类 lifecycle 说明，truncated 标记被识别", () => {
    const v = projectWorker(
      run({
        timeline: [
          { id: "l1", type: "lifecycle", ts: at(1), state: "truncated", truncated: true, message: "已截断：丢弃 3 条最旧记录" },
          { id: "l2", type: "lifecycle", ts: at(2), state: "failed", message: "Concurrency limit exceeded" },
        ],
      }),
      0,
      T0 + 1000,
    );
    assert.strictEqual(v.note, "Concurrency limit exceeded");
    assert.strictEqual(v.timelineTruncated, true);
  });

  it("projectFleet 保持输入顺序并带 index", () => {
    const views = projectFleet(
      [run({ id: "w1" }), run({ id: "w2" }), run({ id: "w3" })],
      T0 + 1000,
    );
    assert.deepStrictEqual(views.map((v) => v.id), ["w1", "w2", "w3"]);
    assert.deepStrictEqual(views.map((v) => v.index), [0, 1, 2]);
  });
});

describe("格式化小工具", () => {
  it("formatDuration 双格式：秒数 + 时分秒", () => {
    assert.strictEqual(formatDuration(0), "0s（00:00:00）");
    assert.strictEqual(formatDuration(59_000), "59s（00:00:59）");
    assert.strictEqual(formatDuration(61_000), "61s（00:01:01）");
    assert.strictEqual(formatDuration(238_000), "238s（00:03:58）");
    assert.strictEqual(formatDuration(3_600_000 + 120_000), "3720s（01:02:00）");
    // 负数/非法值一律归零，不当成负耗时展示
    assert.strictEqual(formatDuration(-1), "0s（00:00:00）");
  });

  it("formatSeconds / formatClock 是双格式的两个分量", () => {
    assert.strictEqual(formatSeconds(238_000), "238s");
    assert.strictEqual(formatClock(238_000), "00:03:58");
    assert.strictEqual(formatClock(8_000), "00:00:08");
    assert.strictEqual(formatClock(3_600_000 + 120_000), "01:02:00");
    assert.strictEqual(formatClock(99 * 3600_000 + 59 * 60_000 + 59_000), "99:59:59");
  });

  it("formatCount/formatRate 压缩大数", () => {
    assert.strictEqual(formatCount(0), "0");
    assert.strictEqual(formatCount(999), "999");
    assert.strictEqual(formatCount(8_400), "8.4k");
    assert.strictEqual(formatCount(12_000), "12k");
    assert.strictEqual(formatCount(1_200_000), "1.2M");
    assert.strictEqual(formatRate(0), "0");
    assert.strictEqual(formatRate(86.4), "86");
    assert.strictEqual(formatRate(3_140), "3.1k");
  });

  it("formatRatePadded 恒 3 字符（零填充，防右侧列跳动）", () => {
    // 无速度也要有占位，否则整段消失同样会让右侧文本移位
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.strictEqual(formatRatePadded(v), "000", `${v} 该给占位`);
    }
    assert.strictEqual(formatRatePadded(8), "008");
    assert.strictEqual(formatRatePadded(86.4), "086");
    assert.strictEqual(formatRatePadded(134), "134");
    for (const v of [0, 1, 9, 86.4, 134, 999]) {
      assert.strictEqual(formatRatePadded(v).length, 3, `${v} → ${formatRatePadded(v)}`);
    }
    // ≥1000 沿用 k 记法（罕见区间，宽度会多一位）
    assert.strictEqual(formatRatePadded(3_140), "3.1k");
  });

  it("sparkline 按峰值归一且长度对齐", () => {
    assert.strictEqual(sparkline([]), "");
    const s = sparkline([0, 1, 2, 4]);
    assert.strictEqual(s.length, 4);
    assert.strictEqual(s[3], "█"); // 峰值满格
    assert.strictEqual(s[0], "▁"); // 零值最低格
    assert.strictEqual(sparkline([0, 0]), "▁▁"); // 全零不炸（max 兜底）
  });

  it("formatToolArgs：单键只给值，多键带 key=，非 JSON 退回单行化", () => {
    assert.strictEqual(formatToolArgs('{"command":"rg -n subagent lib/"}', 70), "rg -n subagent lib/");
    assert.strictEqual(formatToolArgs('{"path":"/a/b.ts","limit":20}', 70), "path=/a/b.ts limit=20");
    assert.strictEqual(formatToolArgs('"plain string"', 70), "plain string");
    assert.strictEqual(formatToolArgs("not json", 70), "not json");
    assert.strictEqual(formatToolArgs("{truncated...", 70), "{truncated..."); // 截断串不抛
    assert.strictEqual(formatToolArgs("", 70), "");
    // 空白折叠 + 超长截断
    assert.match(formatToolArgs('{"command":"a   b"}', 70), /^a b$/); // 空白折叠
    assert.ok(formatToolArgs(JSON.stringify({ command: "y".repeat(200) }), 10).length <= 11);
  });
});

describe("FleetView：渲染与采样", () => {
  it("每个 worker 至少三行（折叠态），含吞吐与动向", () => {
    const view = new FleetView(plainTheme, false, () => T0 + 12_000);
    view.update(
      projectFleet(
        [
          run({
            id: "w1",
            lastActivityAt: at(11_500), // 采样时刻前 500ms 仍有增量：应显示「思考中」而非静默
            usage: usageOf({ output: 8400, input: 41_000, cost: 0.021, turns: 5 }),
            stream: {
              textChars: 20_000,
              thinkingChars: 4_000,
              toolcallChars: 700,
              deltas: 200,
              messages: 5,
              lastDeltaKind: "thinking",
            },
          }),
        ],
        T0 + 12_000,
      ),
      plainTheme,
      false,
    );
    const lines = view.render(100);
    // 表头 + 分隔 + w1 三行
    assert.ok(lines.length >= 5, `期望 >=5 行，实得 ${lines.length}`);
    const body = lines.join("\n");
    assert.match(body, /w1/);
    assert.match(body, /思考中/);
    assert.match(body, /tok\/s/);
    assert.match(body, /out 8\.4k/);
    assert.match(body, /¥0\.021/);
  });

  it("表头速率字段恒占位：无速度时给 000 tok/s，不整段消失", () => {
    const header = (stream?: WorkerRun["stream"]) => {
      const view = new FleetView(plainTheme, false, () => T0 + 12_000);
      view.update(
        projectFleet(
          [run({ usage: usageOf({ output: 100, cost: 0.01 }), ...(stream ? { stream } : {}) })],
          T0 + 12_000,
        ),
        plainTheme,
        false,
      );
      return view.render(100)[0];
    };

    const idle = header();
    assert.match(idle, /000 tok\/s/, "无速度时应有占位");

    // 字段位置与行长不随速度变化：后面的文本（时间/成本）不该左右跳
    const busy = header({ textChars: 3_000, thinkingChars: 0, toolcallChars: 0, deltas: 60, messages: 2 });
    assert.doesNotMatch(busy, /000 tok\/s/, "有速度时不该还是占位");
    assert.strictEqual(idle.indexOf("tok/s"), busy.indexOf("tok/s"), "速率字段位置应一致");
    assert.strictEqual(visibleWidth(idle), visibleWidth(busy));
  });

  it("展开态追加字符细分与 token/pid 明细分行", () => {
    const view = new FleetView(plainTheme, true, () => T0 + 5000);
    view.update(
      projectFleet([run({ pid: 4242, usage: usageOf({ output: 100, cacheRead: 900, turns: 2 }) })], T0 + 5000),
      plainTheme,
      true,
    );
    const body = view.render(120).join("\n");
    assert.match(body, /字符 /);
    assert.match(body, /思考 /);
    assert.match(body, /缓存读/);
    assert.match(body, /pid 4242/);
  });

  it("空 fleet 有占位而不是崩", () => {
    const view = new FleetView(plainTheme, false, () => T0);
    view.update([], plainTheme, false);
    const body = view.render(80).join("\n");
    assert.match(body, /无进行中的 worker/);
  });

  it("排队中的 worker 显示「排队」而不是假的运行/启动", () => {
    const view = new FleetView(plainTheme, false, () => T0 + 1000);
    view.update(projectFleet([run({ status: "queued" })], T0 + 1000), plainTheme, false);
    const body = view.render(90).join("\n");
    assert.match(body, /排队/);
    assert.match(body, /等并行额度/);
    assert.match(body, /1 排队/); // 表头 chip
    assert.doesNotMatch(body, /运行/);
  });

  it("排队时长标为「已排队」，不拿批次起点冒充运行耗时", () => {
    const view = new FleetView(plainTheme, false, () => T0 + 61_000);
    view.update(projectFleet([run({ status: "queued", startedAt: at(0) })], T0 + 61_000), plainTheme, false);
    const body = view.render(90).join("\n");
    assert.match(body, /已排队 61s（00:01:01）/);
  });

  it("时间推进后重渲染不吃缓存（耗时/静默继续走字）", () => {
    let clock = T0 + 10_000;
    const view = new FleetView(plainTheme, false, () => clock, undefined);
    view.update(projectFleet([run({ lastActivityAt: at(5_000) })], clock), plainTheme, false);
    const first = view.render(80).join("\n");
    assert.match(first, /10s（00:00:10）/);

    // 无新事件、只有时间流逝：仍然必须重绘（否则面板看起来假死）
    clock = T0 + 40_000;
    view.update(projectFleet([run({ lastActivityAt: at(5_000) })], clock), plainTheme, false);
    const second = view.render(80).join("\n");
    assert.match(second, /40s（00:00:40）/);
    assert.notStrictEqual(first, second);
  });

  it("长工具跑着时说「已执行」而不是「静默」（bash 等网络超时的场景）", () => {
    const clock = T0 + 60_000;
    const w = run({
      lastActivityAt: at(5_000),
      timeline: [{ id: "t1", type: "tool", ts: at(5_000), tool: "bash", args: "curl https://example.com", ok: undefined }],
    });
    const view = new FleetView(plainTheme, false, () => clock, undefined);
    view.update(projectFleet([w], clock), plainTheme, false);
    const body = view.render(90).join("\n");
    assert.match(body, /bash curl https:\/\/example\.com/);
    assert.match(body, /已执行 /);
    assert.doesNotMatch(body, /静默/);
  });

  it("展开提示随状态切换（折叠=展开明细 / 展开=收起明细）", () => {
    const hint = (expanded: boolean) => (expanded ? "ctrl+i 收起明细" : "ctrl+i 展开明细");

    const collapsed = new FleetView(plainTheme, false, () => T0, hint);
    collapsed.update(projectFleet([run()], T0), plainTheme, false);
    const collapsedBody = collapsed.render(80).join("\n");
    assert.match(collapsedBody, /展开明细/);
    assert.doesNotMatch(collapsedBody, /收起明细/);

    const expanded = new FleetView(plainTheme, true, () => T0, hint);
    expanded.update(projectFleet([run()], T0), plainTheme, true);
    const expandedBody = expanded.render(80).join("\n");
    assert.match(expandedBody, /收起明细/);
  });

  it("每行不超过给定宽度（含窄宽度）", () => {
    const view = new FleetView(plainTheme, true, () => T0 + 1000);
    view.update(projectFleet([run({ model: "a-very-long-provider/model-name-here" })], T0 + 1000), plainTheme, true);
    for (const width of [200, 60, 20, 8]) {
      for (const line of view.render(width)) {
        // 用可见宽度断言：主题/重置序列不计入终端列宽
        assert.ok(visibleWidth(line) <= Math.max(4, width), `width=${width} 行超宽（可见 ${visibleWidth(line)}）: ${JSON.stringify(line)}`);
      }
    }
  });

  it("瞬时速率按采样间隔累积，sparkline 反映真实流速", () => {
    let clock = T0;
    const view = new FleetView(plainTheme, false, () => clock);
    // 第一帧建立样本基线
    view.update(projectFleet([run({ stream: streamOf(0) })], clock), plainTheme, false);
    view.render(100);
    assert.deepStrictEqual(view.rateHistory("w1"), []);

    // 1s 后累计 1000 字 → 1000 字/s
    clock = T0 + 1000;
    view.update(projectFleet([run({ stream: streamOf(1000) })], clock), plainTheme, false);
    view.render(100);
    const hist = view.rateHistory("w1");
    assert.strictEqual(hist.length, 1);
    assert.strictEqual(hist[0], 1000);

    // 再过 1s 又 500 字 → 500 字/s
    clock = T0 + 2000;
    view.update(projectFleet([run({ stream: streamOf(1500) })], clock), plainTheme, false);
    view.render(100);
    assert.deepStrictEqual(view.rateHistory("w1"), [1000, 500]);
  });

  it("采样间隔不足时丢弃噪声样本", () => {
    let clock = T0;
    const view = new FleetView(plainTheme, false, () => clock);
    view.update(projectFleet([run({ stream: streamOf(0) })], clock), plainTheme, false);
    view.render(100);
    clock = T0 + 20; // 远小于 MIN_SAMPLE_INTERVAL_MS
    view.update(projectFleet([run({ stream: streamOf(9999) })], clock), plainTheme, false);
    view.render(100);
    assert.deepStrictEqual(view.rateHistory("w1"), []);
  });

  it("宽度与数据签名都没变时命中渲染缓存（同一数组引用）", () => {
    const view = new FleetView(plainTheme, false, () => T0 + 1000);
    view.update(projectFleet([run()], T0 + 1000), plainTheme, false);
    const first = view.render(90);
    const second = view.render(90);
    assert.strictEqual(first, second);
    // 数据签名变化 → 缓存作废
    view.update(projectFleet([run({ status: "needs_approval" })], T0 + 1000), plainTheme, false);
    assert.notStrictEqual(view.render(90), first);
  });

  it("invalidate 清缓存（主题切换场景）", () => {
    const view = new FleetView(plainTheme, false, () => T0 + 1000);
    view.update(projectFleet([run()], T0 + 1000), plainTheme, false);
    const first = view.render(70);
    view.invalidate();
    assert.notStrictEqual(view.render(70), first);
  });
});

describe("createCoalescer：限频合并", () => {
  function harness(minIntervalMs: number) {
    let clock = 0;
    const delivered: string[] = [];
    const timers: Array<{ at: number; fn: () => void; canceled: boolean }> = [];
    const c = createCoalescer<string>(minIntervalMs, (v) => delivered.push(v), {
      now: () => clock,
      schedule: (fn, ms) => {
        const t = { at: clock + ms, fn, canceled: false, unref: () => undefined };
        timers.push(t);
        return t;
      },
      cancel: (h) => {
        (h as { canceled: boolean }).canceled = true;
      },
    });
    const advance = (ms: number) => {
      clock += ms;
      for (const t of timers) {
        if (!t.canceled && t.at <= clock) {
          t.canceled = true;
          t.fn();
        }
      }
    };
    return { c, delivered, advance, timers };
  }

  it("首次 push 立即送达（无历史节流）", () => {
    const { c, delivered } = harness(150);
    c.push("a");
    assert.deepStrictEqual(delivered, ["a"]);
  });

  it("间隔内的多次 push 合并为一次，且带去最新值", () => {
    const { c, delivered, advance } = harness(150);
    c.push("a");
    c.push("b");
    c.push("c");
    assert.deepStrictEqual(delivered, ["a"]); // 只有首次立即
    assert.strictEqual(c.hasPending(), true);
    advance(150);
    assert.deepStrictEqual(delivered, ["a", "c"]); // 中间值被合并掉
  });

  it("flush 立即送达挂起值，且不重复送达", () => {
    const { c, delivered } = harness(150);
    c.push("a");
    c.push("b");
    c.flush();
    assert.deepStrictEqual(delivered, ["a", "b"]);
    assert.strictEqual(c.hasPending(), false);
    c.flush();
    assert.deepStrictEqual(delivered, ["a", "b"]);
  });

  it("超过间隔后再次 push 立即送达", () => {
    const { c, delivered, advance } = harness(150);
    c.push("a");
    advance(200);
    c.push("b");
    assert.deepStrictEqual(delivered, ["a", "b"]);
  });
});

describe("回报文本预算", () => {
  it("预算按 worker 数均分并保底", () => {
    assert.ok(workerOutputBudget(1) >= workerOutputBudget(4));
    assert.strictEqual(workerOutputBudget(0), workerOutputBudget(1)); // 0 视为 1
    assert.ok(workerOutputBudget(1000) >= 4 * 1024); // 保底，不会归零
  });

  it("预算内原样返回", () => {
    assert.strictEqual(formatWorkerOutput("short report", 4096), "short report");
  });

  it("超预算被截断并附可读提示（含完整内容位置）", () => {
    const out = formatWorkerOutput("x".repeat(20_000), 4096);
    assert.ok(out.length < 20_000);
    assert.match(out, /输出被截断/);
    assert.match(out, /subagent-diagnostics/);
  });
});

// ── 测试夹具 ──

function usageOf(patch: Partial<NonNullable<WorkerRun["usage"]>> = {}): NonNullable<WorkerRun["usage"]> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
    ...patch,
  };
}

function streamOf(textChars: number): NonNullable<WorkerRun["stream"]> {
  return { textChars, thinkingChars: 0, toolcallChars: 0, deltas: textChars, messages: 0 };
}
