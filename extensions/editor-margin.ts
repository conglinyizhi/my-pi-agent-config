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
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

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

    // 内部可用宽度（减去左右 margin 和左右边框字符 "│"）
    const innerWidth = width - m * 2 - 2;
    if (innerWidth <= 0) {
      return super.render(width);
    }

    // 获取编辑器原始内容行
    const lines = super.render(innerWidth);

    // 用主题色给 margin 区域上背景色
    const marginBg = (s: string) => this.fullTheme.bg("selectedBg", s);
    // 边框颜色
    const borderFg = (s: string) => this.fullTheme.fg("border", s);

    // 生成每一行：左边距 + 左边框 + 内容 + 右边框 + 右边距
    const contentLines = lines.map((line: string) => {
      const content = truncateToWidth(line, innerWidth);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
      return (
        marginBg(" ".repeat(m)) +
        borderFg("│") +
        content +
        padding +
        borderFg("│") +
        marginBg(" ".repeat(m))
      );
    });

    // 顶部边框行
    const topBorder =
      marginBg(" ".repeat(m)) +
      borderFg("╭" + "─".repeat(innerWidth) + "╮") +
      marginBg(" ".repeat(m));

    // 底部边框行
    const bottomBorder =
      marginBg(" ".repeat(m)) +
      borderFg("╰" + "─".repeat(innerWidth) + "╯") +
      marginBg(" ".repeat(m));

    return [topBorder, ...contentLines, bottomBorder];
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
