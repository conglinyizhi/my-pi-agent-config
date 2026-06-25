/**
 * 带边框和 margin 的输入编辑器
 *
 * 效果：
 *   左边距   ╭───────────────╮   右边距
 *   空白区域  │  输入内容...  │  空白区域
 *   空白区域  ╰───────────────╯  空白区域
 *
 * 通过调整 marginSize 控制边框到终端边缘的距离
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

class BorderedEditor extends CustomEditor {
  private marginSize: number;
  private fullTheme: any;

  constructor(tui: any, theme: any, keybindings: any, fullTheme: any, marginSize = 2) {
    super(tui, theme, keybindings);
    this.marginSize = marginSize;
    this.fullTheme = fullTheme;
  }

  render(width: number): string[] {
    const m = this.marginSize;

    // 内部可用宽度（减去左右 margin）
    const innerWidth = width - m * 2;
    if (innerWidth <= 0) {
      return super.render(width);
    }

    // 获取编辑器原始内容行（含父类自带的边框）
    const lines = super.render(innerWidth);

    // 用主题色给 margin 区域上背景色
    const marginBg = (s: string) => this.fullTheme.bg("selectedBg", s);

    // 给每一行加上左右 margin 背景（不添加额外边框，父类已有）
    return lines.map((line: string) => {
      return marginBg(" ".repeat(m)) + line + marginBg(" ".repeat(m));
    });
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      // 从设置中读取 marginSize，默认 2
      const marginSize = (ctx.settings as any)?.editorMargin ?? 2;
      return new BorderedEditor(tui, theme, keybindings, ctx.ui.theme, marginSize);
    });
  });
}
