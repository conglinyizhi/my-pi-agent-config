import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promptWithPreview, type PromptWithPreviewOptions } from "./prompt-with-preview.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

interface Harness {
  render(): string;
  input(data: string): void;
  result(): string | undefined;
}

async function mount(options: PromptWithPreviewOptions): Promise<Harness> {
  let component: { handleInput(data: string): void; render(width: number): string[] } | undefined;
  let result: string | undefined;
  const ctx = {
    mode: "tui",
    ui: {
      input: async () => "native",
      custom: async (
        factory: (
          tui: { requestRender(): void },
          factoryTheme: typeof theme,
          kb: object,
          done: (value: string | undefined) => void,
        ) => { handleInput(data: string): void; render(width: number): string[] },
      ) => {
        component = factory({ requestRender() {} }, theme, {}, value => {
          result = value;
        });
        return new Promise<string | undefined>(() => {});
      },
    },
  } as never;

  void promptWithPreview(ctx, options);
  assert.ok(component);
  return {
    render: () => component!.render(80).join("\n"),
    input: (data: string) => component!.handleInput(data),
    result: () => result,
  };
}

describe("promptWithPreview", () => {
  it("预填值光标在末尾，可以接着改", async () => {
    const ui = await mount({ title: "最大输出", initial: "4096" });
    ui.input("1");
    ui.input("\r");
    assert.strictEqual(ui.result(), "40961");
  });

  it("实时显示换算结果", async () => {
    const ui = await mount({
      title: "最大输出",
      initial: "4096",
      preview: value => (value === "1M" ? "1,000,000（1.0M）" : null),
    });
    assert.doesNotMatch(ui.render(), /1,000,000/);

    for (let i = 0; i < 4; i++) ui.input("\u007f");
    ui.input("1");
    ui.input("M");

    assert.match(ui.render(), /= 1,000,000（1\.0M）/);
    ui.input("\r");
    assert.strictEqual(ui.result(), "1M");
  });

  it("Esc 取消返回 undefined", async () => {
    const ui = await mount({ title: "最大输出", initial: "4096" });
    ui.input("\u001b");
    assert.strictEqual(ui.result(), undefined);
  });

  it("非 TUI 模式回退内置输入框", async () => {
    let called = 0;
    const ctx = {
      mode: "print",
      ui: {
        input: async () => {
          called++;
          return "native-value";
        },
      },
    } as never;
    assert.strictEqual(await promptWithPreview(ctx, { title: "x" }), "native-value");
    assert.strictEqual(called, 1);
  });
});
