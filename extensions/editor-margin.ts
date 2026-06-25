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

    // 获取父类渲染的全部行（含它自己的边框横线）
    const parentLines = super.render(innerWidth);

    // 用主题色给 margin 区域上背景色
    const marginBg = (s: string) => this.fullTheme.bg("selectedBg", s);
    // 边框颜色
    const borderFg = (s: string) => this.fullTheme.fg("border", s);

    // 去除 ANSI 转义序列，获取纯文本
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    // 查找父类底部边框行的位置（末行往前找，纯文本只含 ─ ↑ ↓ 数字和空格的行）
    let bottomBorderIdx = -1;
    for (let i = parentLines.length - 1; i >= 0; i--) {
      const plain = stripAnsi(parentLines[i]).trim();
      if (/^[─↑↓\d\smore]+$/.test(plain)) {
        bottomBorderIdx = i;
        break;
      }
    }

    const result: string[] = [];

    for (let i = 0; i < parentLines.length; i++) {
      const line = parentLines[i];

      if (i === 0) {
        // 替换父类顶部横线为自己的 ╭─╮
        result.push(
          marginBg(" ".repeat(m)) +
          borderFg("╭" + "─".repeat(innerWidth) + "╮") +
          marginBg(" ".repeat(m))
        );
      } else if (i === bottomBorderIdx) {
        // 替换父类底部横线为自己的 ╰─╯
        result.push(
          marginBg(" ".repeat(m)) +
          borderFg("╰" + "─".repeat(innerWidth) + "╯") +
          marginBg(" ".repeat(m))
        );
      } else {
        // 内容和自动补全行：加侧边 │ 和 margin
        const content = truncateToWidth(line, innerWidth);
        const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
        result.push(
          marginBg(" ".repeat(m)) +
          borderFg("│") +
          content +
          padding +
          borderFg("│") +
          marginBg(" ".repeat(m))
        );
      }
    }

    return result;
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
