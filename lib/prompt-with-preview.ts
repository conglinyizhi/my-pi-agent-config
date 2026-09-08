// prompt-with-preview：带实时换算预览的文本输入框
//
// 用法：
//   await promptWithPreview(ctx, {
//     title: "最大输出（当前: 384000）\n单次回复最多生成多少 token。",
//     initial: "384000",
//     preview: value => numberPreview(value),
//   })
//
// 输入框下面会实时显示「当前输入换算成什么」，用来让用户看懂 1M / 512K / 100万
// 这类写法到底等于多少，不用自己数零。非 TUI 模式退回内置 ctx.ui.input。

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

export interface PromptWithPreviewOptions {
  /** 标题，可多行（说明、对应配置项、操作提示都放这里） */
  title: string;
  /** 预填值 */
  initial?: string;
  /** 把当前输入转成预览行；返回 null 表示这一行不显示 */
  preview?: (value: string) => string | null;
  /** 底部按键提示，默认「Enter 确认 · Esc 取消」 */
  hint?: string;
}

export async function promptWithPreview(
  ctx: ExtensionCommandContext,
  options: PromptWithPreviewOptions,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    return ctx.ui.input(options.title, options.initial);
  }

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const input = new Input();
    // setValue 会把光标留在行首（Input 的 cursor 初值就是 0），
    // 逐个字符喂进去才能把光标落在末尾，用户接着改就行，不用先按 End。
    if (options.initial) {
      for (const ch of options.initial) input.handleInput(ch);
    }

    const previewLine = new Text("", 1, 0);
    const updatePreview = () => {
      const raw = input.getValue();
      const text = options.preview?.(raw) ?? null;
      previewLine.setText(text ? theme.fg("accent", `  = ${text}`) : "");
    };

    container.addChild(new DynamicBorder(str => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(input);
    container.addChild(previewLine);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", options.hint ?? "Enter 确认 · Esc 取消"), 1, 0));
    container.addChild(new DynamicBorder(str => theme.fg("accent", str)));

    updatePreview();

    // 焦点透传给 Input，中文输入法的候选窗才会跟着光标走
    let focused = false;

    return {
      get focused() {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
        input.focused = value;
      },
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, "enter") || data === "\n") {
          done(input.getValue());
          return;
        }
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
          done(undefined);
          return;
        }
        input.handleInput(data);
        updatePreview();
        tui.requestRender();
      },
    };
  });
}
