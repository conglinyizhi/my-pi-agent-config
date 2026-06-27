/**
 * 工具检测器插件 —— 主入口
 *
 * ## 功能
 * 在每次会话启动 / reload 时检测宿主机上是否安装并配置了常用的外部 CLI 工具。
 * 若已可用，则在系统提示词中注入指引，让大模型优先使用 CLI 而不是直接调 API。
 *
 * TUI 状态栏实时颜色标识：
 *   - 绿色 ✓  → 已安装且鉴权完成
 *   - 橙色 ⚠  → 已安装但未鉴权
 *   - 灰色 ✗  → 未安装
 *
 * ## 架构
 * - `types.ts`     —— 公共类型定义（Detector / DetectorResult）
 * - `detectors/`   —— 各工具的检测器实现，每个文件导出一个 Detector 对象
 * - `index.ts`     —— 本文件，汇总所有检测器、订阅生命周期事件
 *
 * ## 如何新增一个检测器
 * 1. 在 `detectors/` 目录下新建一个 `.ts` 文件
 * 2. 实现 `Detector` 接口（参考 `detectors/gh-cli.ts`）
 * 3. 在下方 `DETECTORS` 数组中追加一行
 *
 * ```ts
 * // detectors/my-tool.ts
 * import type { Detector, DetectorResult } from "../types.js";
 *
 * export const myToolDetector: Detector = {
 *   name: "my-tool",
 *   displayName: "mt",   // TUI 状态栏短名（可选）
 *   description: "检测 xxx 工具是否可用",
 *   async check() { ... },
 * };
 * ```
 *
 * ```ts
 * // index.ts —— 在 DETECTORS 数组中追加
 * import { myToolDetector } from "./detectors/my-tool.js";
 * const DETECTORS: Detector[] = [
 *   ghCliDetector,
 *   myToolDetector,  // ← 新增这一行即可
 * ];
 * ```
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Detector, DetectorResult } from "./types.js";
import { ghCliDetector } from "./detectors/gh-cli.js";

// ---------------------------------------------------------------------------
// 注册所有检测器（新增检测器时只需在这里追加一行）
// ---------------------------------------------------------------------------

const DETECTORS: Detector[] = [
  ghCliDetector,
  // TODO: 在此处追加你自定义的检测器，例如 glab、doctl、aws-cli 等
];

// ===========================================================================
// 以下为插件主体逻辑，一般无需修改
// ===========================================================================

/**
 * 检测结果缓存条目。
 * 同时保存检测器元信息和检测结果，方便 TUI 渲染和提示词生成。
 */
interface CacheEntry {
  detector: Detector;
  result: DetectorResult;
}

/**
 * 检测结果缓存（会话级别，key = detector.name）。
 * 每次 session_start 重新检测，before_agent_start 只读取缓存。
 */
let cachedResults = new Map<string, CacheEntry>();

/**
 * 遍历所有检测器，逐个执行 check() 并写入缓存。
 * 单个检测器失败不会影响其他检测器。
 */
async function runAllChecks(): Promise<Map<string, CacheEntry>> {
  const results = new Map<string, CacheEntry>();

  for (const detector of DETECTORS) {
    try {
      const result = await detector.check();
      results.set(detector.name, { detector, result });
    } catch (_err) {
      // 单个检测器失败不阻塞整体流程
      results.set(detector.name, {
        detector,
        result: { installed: false },
      });
    }
  }

  cachedResults = results;
  return results;
}

/**
 * 根据缓存的检测结果生成追加到系统提示词中的文本。
 * 只提取那些有 promptHint 且 installed 的检测结果。
 */
function buildPromptAppend(): string {
  const hints: string[] = [];

  for (const { result } of cachedResults.values()) {
    if (result.promptHint && result.installed) {
      hints.push(result.promptHint);
    }
  }

  if (hints.length === 0) return "";

  return [
    "",
    "## 外部工具可用性 (自动检测)",
    "",
    ...hints.map((h) => `- ${h}`),
    "",
  ].join("\n");
}

/**
 * 根据单个检测结果决定 TUI 状态栏中该工具的颜色和符号。
 *
 * | 状态              | 颜色     | 符号 |
 * |-------------------|----------|------|
 * | 已安装 + 已鉴权   | success  | ✓    |
 * | 已安装 + 未鉴权   | accent   | ⚠    |
 * | 未安装            | dim      | ✗    |
 */
function renderToolStatus(
  entry: CacheEntry,
  theme: ExtensionAPI["ui"]["theme"],
): string {
  const label = entry.detector.displayName ?? entry.detector.name;
  const { installed, authenticated } = entry.result;

  if (installed && authenticated !== false) {
    return theme.fg("success", `${label} ✓`);
  }
  if (installed) {
    return theme.fg("accent", `${label} ⚠`);
  }
  return theme.fg("dim", `${label} ✗`);
}

// ===========================================================================
// 插件入口
// ===========================================================================

export default function toolChecker(pi: ExtensionAPI): void {
  /**
   * 会话启动 / reload 时：
   * 1. 运行所有检测器
   * 2. 在 TUI 状态栏中渲染每个工具的状态
   */
  pi.on("session_start", async (_event, ctx) => {
    const results = await runAllChecks();
    const { theme } = ctx.ui;

    for (const entry of results.values()) {
      ctx.ui.setStatus(
        `tool-${entry.detector.name}`,
        renderToolStatus(entry, theme),
      );
    }
  });

  /**
   * 会话关闭时清理状态栏中的工具标识。
   */
  pi.on("session_shutdown", (_event, ctx) => {
    for (const { detector } of cachedResults.values()) {
      ctx.ui.setStatus(`tool-${detector.name}`, undefined);
    }
  });

  /**
   * 每次 agent 启动前，将可用工具的提示注入系统提示词。
   */
  pi.on("before_agent_start", async (event, _ctx) => {
    const append = buildPromptAppend();
    if (!append) return; // 无可用的外部工具，不修改提示词

    return {
      systemPrompt: event.systemPrompt + append,
    };
  });
}
