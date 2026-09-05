import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/common";

/**
 * Markdown → 自包含 HTML 的渲染。
 * 在 Node 端就把代码块高亮成带 span 的 HTML，页面无需额外 JS。
 */

type HighlightTheme = "github-dark" | "github" | "atom-one-dark";

const require = createRequire(import.meta.url);

// precompute: 各主题 CSS 路径（resolve 一次，避免每次都探）
const THEME_CSS: Record<HighlightTheme, string> = {
  "github-dark": "highlight.js/styles/github-dark.css",
  github: "highlight.js/styles/github.css",
  "atom-one-dark": "highlight.js/styles/atom-one-dark.css",
};

export type { HighlightTheme };

const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

/** 把 markdown 文本转成渲染后的 HTML 字符串。 */
export function markdownToHtml(md: string): string {
  const html = marked.parse(md);
  return typeof html === "string" ? html : String(html);
}

/** 读取某一个高亮主题的 CSS 文本。 */
export function loadHighlightCss(theme: HighlightTheme = "github-dark"): string {
  try {
    const cssPath = require.resolve(THEME_CSS[theme]);
    return readFileSync(cssPath, "utf8");
  } catch {
    // 解析失败则回退到最小可用样式（无颜色也能看）
    return `.hljs{color:#c9d1d9;background:#0d1117}.hljs-code{font-family:monospace}`;
  }
}
