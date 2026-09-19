import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  applyVimKey,
  filterOptions,
  normalizeOptions,
  parseVimKey,
  relativeLineGutter,
  relativeLineGutterWidth,
  vimSelect,
  type VimSelectOption,
  type VimState,
} from "./vim-select.ts";

const initial: VimState = { count: null, filterMode: false, query: "" };

function key(data: string) {
  return parseVimKey(data);
}

describe("parseVimKey", () => {
  it("区分方向键、j/k、数字和斜杠", () => {
    assert.deepStrictEqual(key("\u001b[A"), { type: "up" });
    assert.deepStrictEqual(key("\u001b[B"), { type: "down" });
    assert.deepStrictEqual(key("j"), { type: "char", value: "j" });
    assert.deepStrictEqual(key("k"), { type: "char", value: "k" });
    assert.deepStrictEqual(key("8"), { type: "char", value: "8" });
    assert.deepStrictEqual(key("/"), { type: "char", value: "/" });
  });

  it("识别确认、取消、删除和清空查询", () => {
    assert.deepStrictEqual(key("\r"), { type: "confirm" });
    assert.deepStrictEqual(key("\u001b"), { type: "cancel" });
    assert.deepStrictEqual(key("\u007f"), { type: "backspace" });
    assert.deepStrictEqual(key("\u0015"), { type: "clear-query" });
  });

  it("中文等非 ASCII 可打印字符也能当过滤词", () => {
    assert.deepStrictEqual(key("思"), { type: "char", value: "思" });
    assert.deepStrictEqual(key("（"), { type: "char", value: "（" });
    assert.deepStrictEqual(key("\u0000"), { type: "ignore" });
  });
});

describe("applyVimKey", () => {
  it("累积计数，忽略前导零，并在移动后清零", () => {
    let state = initial;
    let result = applyVimKey(state, key("0"));
    assert.deepStrictEqual(result.state, initial);
    result = applyVimKey(result.state, key("8"));
    result = applyVimKey(result.state, key("j"));
    assert.deepStrictEqual(result, {
      state: initial,
      effect: { type: "move", delta: 8 },
    });

    state = applyVimKey(initial, key("3")).state;
    result = applyVimKey(state, key("k"));
    assert.deepStrictEqual(result.effect, { type: "move", delta: -3 });
    assert.strictEqual(result.state.count, null);
  });

  it("支持过滤输入、退格、Ctrl-U、确认和取消", () => {
    let state = applyVimKey(initial, key("/")).state;
    assert.strictEqual(state.filterMode, true);
    state = applyVimKey(state, key("d")).state;
    state = applyVimKey(state, key("v")).state;
    assert.strictEqual(state.query, "dv");
    state = applyVimKey(state, key("\u007f")).state;
    assert.strictEqual(state.query, "d");
    state = applyVimKey(state, key("\u0015")).state;
    assert.strictEqual(state.query, "");
    state = { filterMode: true, query: "abc", count: null };
    const confirmed = applyVimKey(state, key("\r"));
    assert.deepStrictEqual(confirmed, {
      state: { filterMode: false, query: "abc", count: null },
      effect: { type: "none" },
    });
    const cancelled = applyVimKey(state, key("\u001b"));
    assert.deepStrictEqual(cancelled, {
      state: { filterMode: false, query: "", count: null },
      effect: { type: "refilter" },
    });
  });

  it("正常模式退格取消计数", () => {
    let state = applyVimKey(initial, key("8")).state;
    assert.strictEqual(state.count, 8);
    state = applyVimKey(state, key("\u007f")).state;
    assert.strictEqual(state.count, null);
    assert.deepStrictEqual(applyVimKey(state, key("j")).effect, { type: "move", delta: 1 });
  });

  it("正常模式下 Esc 取消、Enter 确认", () => {
    assert.deepStrictEqual(applyVimKey(initial, key("\u001b")).effect, { type: "cancel" });
    assert.deepStrictEqual(applyVimKey(initial, key("\r")).effect, { type: "confirm" });
  });

  it("正常模式 % 跳到当前项，过滤模式把 % 当普通字符", () => {
    const jumped = applyVimKey(initial, key("%"));
    assert.deepStrictEqual(jumped, {
      state: initial,
      effect: { type: "jump-current" },
    });
    const counted = applyVimKey(applyVimKey(initial, key("8")).state, key("%"));
    assert.strictEqual(counted.state.count, null);
    assert.deepStrictEqual(counted.effect, { type: "jump-current" });

    let state = applyVimKey(initial, key("/")).state;
    state = applyVimKey(state, key("%")).state;
    assert.strictEqual(state.filterMode, true);
    assert.strictEqual(state.query, "%");
  });
});

describe("relativeLineGutter", () => {
  it("光标行写绝对序号，其余行写距离，并按宽度右对齐", () => {
    assert.strictEqual(relativeLineGutter(0, 0), "1");
    assert.strictEqual(relativeLineGutter(1, 0), "1");
    assert.strictEqual(relativeLineGutter(2, 0), "2");
    assert.strictEqual(relativeLineGutter(4, 4), "5");
    assert.strictEqual(relativeLineGutter(0, 4), "4");
    assert.strictEqual(relativeLineGutter(3, 4), "1");
    assert.strictEqual(relativeLineGutter(5, 4), "1");
    assert.strictEqual(relativeLineGutter(0, 9, 2), " 9");
    assert.strictEqual(relativeLineGutter(9, 9, 2), "10");
    assert.strictEqual(relativeLineGutterWidth(9), 1);
    assert.strictEqual(relativeLineGutterWidth(10), 2);
  });
});

describe("filterOptions", () => {
  it("空查询保序，模糊结果按匹配度排序，无匹配为空", () => {
    const options = ["gpt-5.6", "deepseek-v4-flash", "claude-4"];
    assert.deepStrictEqual(filterOptions(options, ""), options);
    assert.strictEqual(filterOptions(options, "dv4")[0], "deepseek-v4-flash");
    assert.deepStrictEqual(filterOptions(options, "zzzz"), []);
  });
});

describe("英文别名", () => {
  it("字符串与对象两种写法都能归一化", () => {
    const items = normalizeOptions([
      "纯字符串",
      { label: "思考返回格式 — 未设置", alias: "thinking" },
      { label: "展示名", value: "返回值", alias: "alias" },
    ]);
    assert.deepStrictEqual(items[0], { label: "纯字符串", value: "纯字符串", searchText: "纯字符串" });
    assert.strictEqual(items[1].value, "思考返回格式 — 未设置");
    assert.strictEqual(items[1].searchText, "思考返回格式 — 未设置 thinking");
    assert.strictEqual(items[2].value, "返回值");
    assert.strictEqual(items[2].searchText, "展示名 返回值 alias");
  });

  it("可以敲英文别名过滤，返回值仍是选项本身", async () => {
    const ui = await mount([
      { label: "上下文窗口 — 1000000", alias: "context" },
      { label: "思考返回格式 — 未设置", alias: "thinking" },
      { label: "历史消息需带思考 — 未设置", alias: "reasoning-content" },
      { label: "工具参数流式下发 — 未设置", alias: "stream" },
      { label: "最大输出 — 384000", alias: "max" },
      { label: "名称 — 未设置", alias: "name" },
    ]);

    assert.match(ui.render(), /thinking/); // 别名显示在行尾，用户能看见
    ui.input("/");
    for (const ch of "thinking") ui.input(ch);
    ui.input("\r");
    assert.match(ui.render(), /\/ thinking/);
    ui.input("\r");
    assert.strictEqual(ui.selected(), "思考返回格式 — 未设置");
  });
});

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

interface Harness {
  render(): string;
  input(data: string): void;
  selected: () => string | undefined;
}

/** 用假 tui/theme 驱动 ctx.ui.custom 的 factory，拿到组件本体做按键与渲染断言。 */
async function mount(options: VimSelectOption[], selectOpts?: { currentValue?: string }): Promise<Harness> {
  let component: { handleInput(data: string): void; render(width: number): string[] } | undefined;
  let selected: string | undefined;
  const ctx = {
    mode: "tui",
    ui: {
      select: async () => "native",
      custom: async (
        factory: (
          tui: { requestRender(): void },
          factoryTheme: typeof theme,
          kb: object,
          done: (value: string | undefined) => void,
        ) => { handleInput(data: string): void; render(width: number): string[] },
      ) => {
        component = factory({ requestRender() {} }, theme, {}, value => {
          selected = value;
        });
        return new Promise<string | undefined>(() => {});
      },
    },
  } as never;

  void vimSelect(ctx, "选择", options, selectOpts);
  assert.ok(component);
  return {
    render: () => component!.render(80).join("\n"),
    input: (data: string) => component!.handleInput(data),
    selected: () => selected,
  };
}

describe("vimSelect", () => {
  // SelectList 的渲染依赖全局主题，测试里先初始化一次
  initTheme("dark");

  it("在 TUI 中支持计数跳转并把选择结果交给 done", async () => {
    const ui = await mount(["a", "b", "c", "d", "e", "f"]);
    ui.input("8");
    ui.input("j");
    ui.input("\r");
    assert.strictEqual(ui.selected(), "f");
  });

  it("行头相对行号跟光标走，提示行文案不变", async () => {
    const ui = await mount(["a", "b", "c", "d", "e", "f"]);
    const initial = ui.render();
    assert.match(initial, /8j\/8k 计数跳转/);
    assert.match(initial, /→\s+1 a/);
    assert.match(initial, /\s+1 b/);
    assert.match(initial, /\s+2 c/);
    ui.input("j");
    const moved = ui.render();
    assert.match(moved, /\s+1 a/);
    assert.match(moved, /→\s+2 b/);
    assert.match(moved, /\s+1 c/);
    assert.match(moved, /8j\/8k 计数跳转/);
  });

  it("过滤模式输入后 Enter 保留过滤结果并刷新界面", async () => {
    const ui = await mount(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]);
    ui.input("/");
    ui.input("d");
    assert.match(ui.render(), /\/ d▌/);
    ui.input("\r");
    assert.match(ui.render(), /\/ d/);
    assert.doesNotMatch(ui.render(), /▌/);
    ui.input("\r");
    assert.strictEqual(ui.selected(), "delta");
  });

  it("正常模式 % 跳到当前项，行尾标 %，过滤后不在列表里则提示", async () => {
    const ui = await mount(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"], {
      currentValue: "epsilon",
    });
    assert.match(ui.render(), /epsilon\s+%/);
    assert.match(ui.render(), /% 定位当前/);
    ui.input("%");
    ui.input("\r");
    assert.strictEqual(ui.selected(), "epsilon");

    const missing = await mount(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"], {
      currentValue: "epsilon",
    });
    missing.input("/");
    for (const ch of "alp") missing.input(ch);
    missing.input("\r");
    missing.input("%");
    assert.match(missing.render(), /当前项不在列表里/);
  });

  it("短列表或非 TUI 原样委托内置选择器", async () => {
    let calls = 0;
    const ctx = {
      mode: "tui",
      ui: {
        select: async () => {
          calls++;
          return "native-result";
        },
      },
    } as never;
    assert.strictEqual(await vimSelect(ctx, "短", ["a", "b", "c"]), "native-result");
    assert.strictEqual(calls, 1);

    const printCtx = {
      mode: "print",
      ui: {
        select: async () => "print-result",
      },
    } as never;
    assert.strictEqual(await vimSelect(printCtx, "长", ["a", "b", "c", "d", "e", "f"]), "print-result");
  });
});
