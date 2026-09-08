// vim-select：长列表的 Vim 式 TUI 选择器
//
// 用法：
//   vimSelect(ctx, "选择模型", options)
//
// TUI 模式下支持计数前缀（如 8j / 3k）、j/k 或方向键移动、/ 进入模糊过滤。
// 过滤模式中可直接输入文字，Enter 保留过滤结果并退出过滤，Esc 清空过滤并退出。
// 短列表和非 TUI 模式继续使用内置选择器。

import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  decodeKittyPrintable,
  fuzzyFilter,
  matchesKey,
  SelectList,
  Text,
  type Component,
} from "@earendil-works/pi-tui";

export interface VimSelectOptions {
  /** 每屏显示的选项行数。 */
  maxVisible?: number;
  /** 覆盖默认按键提示行。 */
  hint?: string;
  /** 不超过该数量时退回内置选择器。 */
  nativeThreshold?: number;
  /** 模糊搜索使用的文本，默认使用选项本身。 */
  searchText?: (option: string) => string;
}

export type VimKey =
  | { type: "char"; value: string }
  | { type: "down" }
  | { type: "up" }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "backspace" }
  | { type: "clear-query" }
  | { type: "ignore" };

export interface VimState {
  count: number | null;
  filterMode: boolean;
  query: string;
}

export type VimEffect =
  | { type: "move"; delta: number }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "refilter" }
  | { type: "none" };

/** 将终端输入归一化为选择器需要的最小按键集合。 */
export function parseVimKey(data: string): VimKey {
  if (matchesKey(data, "up")) return { type: "up" };
  if (matchesKey(data, "down")) return { type: "down" };
  if (matchesKey(data, "enter")) return { type: "confirm" };
  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return { type: "cancel" };
  if (matchesKey(data, "backspace")) return { type: "backspace" };
  if (matchesKey(data, "ctrl+u")) return { type: "clear-query" };

  // Kitty 键盘协议会把普通字符编码成 CSI-u；普通终端则直接给单字符。
  const printable = data.length === 1 ? data : decodeKittyPrintable(data);
  if (printable && printable.length === 1) {
    const code = printable.codePointAt(0) ?? 0;
    if (code >= 32 && code <= 126) return { type: "char", value: printable };
  }
  return { type: "ignore" };
}

/** 应用一个按键，组件外也可复用这段无状态的选择器逻辑。 */
export function applyVimKey(state: VimState, key: VimKey): { state: VimState; effect: VimEffect } {
  if (state.filterMode) {
    if (key.type === "char") {
      return {
        state: { ...state, query: state.query + key.value },
        effect: { type: "refilter" },
      };
    }
    if (key.type === "backspace") {
      return {
        state: { ...state, query: state.query.slice(0, -1) },
        effect: { type: "refilter" },
      };
    }
    if (key.type === "clear-query") {
      return { state: { ...state, query: "" }, effect: { type: "refilter" } };
    }
    if (key.type === "confirm") {
      return { state: { ...state, filterMode: false }, effect: { type: "none" } };
    }
    if (key.type === "cancel") {
      return { state: { ...state, filterMode: false, query: "" }, effect: { type: "refilter" } };
    }
    if (key.type === "up") return { state, effect: { type: "move", delta: -1 } };
    if (key.type === "down") return { state, effect: { type: "move", delta: 1 } };
    return { state, effect: { type: "none" } };
  }

  if (key.type === "char") {
    if (/^[0-9]$/.test(key.value)) {
      const digit = Number(key.value);
      if (state.count === null) {
        return digit === 0
          ? { state, effect: { type: "none" } }
          : { state: { ...state, count: digit }, effect: { type: "none" } };
      }
      const next = state.count * 10 + digit;
      return {
        state: { ...state, count: Math.min(9999, next) },
        effect: { type: "none" },
      };
    }
    if (key.value === "j") {
      return { state: { ...state, count: null }, effect: { type: "move", delta: state.count ?? 1 } };
    }
    if (key.value === "k") {
      return { state: { ...state, count: null }, effect: { type: "move", delta: -(state.count ?? 1) } };
    }
    if (key.value === "/") {
      return { state: { ...state, filterMode: true, count: null }, effect: { type: "none" } };
    }
    return { state, effect: { type: "none" } };
  }
  if (key.type === "down") {
    return { state: { ...state, count: null }, effect: { type: "move", delta: state.count ?? 1 } };
  }
  if (key.type === "up") {
    return { state: { ...state, count: null }, effect: { type: "move", delta: -(state.count ?? 1) } };
  }
  if (key.type === "confirm") return { state, effect: { type: "confirm" } };
  if (key.type === "cancel") return { state, effect: { type: "cancel" } };
  // 正常模式下退格取消计数，避免 "8" 退格后按 j 仍按 8 行跳
  if (key.type === "backspace") return { state: { ...state, count: null }, effect: { type: "none" } };
  return { state, effect: { type: "none" } };
}

/** 按模糊匹配结果返回选项；空查询明确保持原数组顺序。 */
export function filterOptions(
  options: string[],
  query: string,
  searchText: (option: string) => string = option => option,
): string[] {
  if (!query.trim()) return options.slice();
  return fuzzyFilter(options, query, searchText);
}

function asItems(options: string[]) {
  return options.map(option => ({ value: option, label: option }));
}

/**
 * 长列表选择器。短列表和非 TUI 调用保持内置 select 的返回语义。
 */
export async function vimSelect(
  ctx: ExtensionCommandContext,
  title: string,
  options: string[],
  opts: VimSelectOptions = {},
): Promise<string | undefined> {
  const nativeThreshold = opts.nativeThreshold ?? 5;
  if (ctx.mode !== "tui" || options.length <= nativeThreshold) {
    return ctx.ui.select(title, options);
  }

  const maxVisible = Math.max(1, opts.maxVisible ?? 14);
  const searchText = opts.searchText ?? (option => option);
  const defaultHint = "8j/8k 计数跳转 · / 过滤 · Enter 选中 · Esc 取消";

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    let state: VimState = { count: null, filterMode: false, query: "" };
    let filtered = filterOptions(options, state.query, searchText);
    let selectedIndex = 0;
    let selectList = new SelectList(asItems(filtered), maxVisible, getSelectListTheme());

    selectList.onSelect = item => done(item.value);
    selectList.onCancel = () => done(undefined);

    const rebuildSelectList = () => {
      filtered = filterOptions(options, state.query, searchText);
      selectedIndex = 0;
      selectList = new SelectList(asItems(filtered), maxVisible, getSelectListTheme());
      selectList.onSelect = item => done(item.value);
      selectList.onCancel = () => done(undefined);
    };

    const renderChrome = () => {
      container.clear();
      container.addChild(new DynamicBorder(str => theme.fg("accent", str)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      const countPrefix = state.count === null ? "" : `计数 ${state.count} · `;
      container.addChild(new Text(theme.fg("dim", `${countPrefix}${opts.hint ?? defaultHint}`), 1, 0));
      if (state.filterMode || state.query) {
        const cursor = state.filterMode ? "▌" : "";
        container.addChild(new Text(theme.fg("dim", `/ ${state.query}${cursor}`), 1, 0));
      }
      if (filtered.length === 0) {
        container.addChild(new Text(theme.fg("dim", "（无匹配，退格或 Ctrl-U 修改过滤词）"), 1, 0));
      } else {
        selectList.setSelectedIndex(selectedIndex);
        container.addChild(selectList);
      }
      container.addChild(new DynamicBorder(str => theme.fg("accent", str)));
    };

    const refresh = (refilter: boolean) => {
      if (refilter) rebuildSelectList();
      renderChrome();
      tui.requestRender();
    };

    renderChrome();
    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        const key = parseVimKey(data);
        if (key.type === "ignore") return;

        const result = applyVimKey(state, key);
        state = result.state;

        if (result.effect.type === "cancel") {
          selectList.onCancel?.();
          return;
        }
        if (result.effect.type === "confirm") {
          const item = filtered[selectedIndex];
          if (item !== undefined) selectList.onSelect?.({ value: item, label: item });
          return;
        }
        if (result.effect.type === "move") {
          const max = Math.max(0, filtered.length - 1);
          selectedIndex = Math.max(0, Math.min(max, selectedIndex + result.effect.delta));
        }
        // refilter 需要重建列表；其余按键也可能改变计数提示或过滤模式，统一刷新一次。
        refresh(result.effect.type === "refilter");
      },
    } satisfies Component;
  });
}
