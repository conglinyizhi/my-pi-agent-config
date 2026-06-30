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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ghCliDetector } from "./detectors/gh-cli.js";
import { uvDetector } from "./detectors/uv.js";
import type { Detector, DetectorResult } from "./types.js";

// ---------------------------------------------------------------------------
// 注册所有检测器（新增检测器时只需在这里追加一行）
// ---------------------------------------------------------------------------

const DETECTORS: Detector[] = [
  ghCliDetector,
  uvDetector,
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

/** 当前正在执行的检测 Promise，用于 before_agent_start 等场景按需等待 */
let checkPromise: Promise<Map<string, CacheEntry>> | null = null;

/**
 * 启动所有检测器（不阻塞调用方，返回 void）。
 *
 * 检测并行执行，完成后自动写入缓存并通过 .then() 异步更新 TUI 状态栏。
 * 单个检测器失败不会影响其他检测器。
 */
function startChecks(ui: ExtensionContext["ui"]): void {
  const total = DETECTORS.length;
  let done = 0;

  // 首次启动即显示 0/N
  ui.setStatus("tool-check-progress", `0/${total}`);

  /** 每个检测器完成时调用，更新进度条；全部完成时自动隐藏 */
  const tick = () => {
    done++;
    if (done < total) {
      ui.setStatus("tool-check-progress", `${done}/${total}`);
    } else {
      ui.setStatus("tool-check-progress", undefined);
    }
  };

  checkPromise = (async (): Promise<Map<string, CacheEntry>> => {
    const results = new Map<string, CacheEntry>();

    const tasks = DETECTORS.map(async (detector) => {
      try {
        const result = await detector.check();
        results.set(detector.name, { detector, result });
      } catch (_err) {
        results.set(detector.name, {
          detector,
          result: { installed: false },
        });
      } finally {
        tick();
      }
    });

    await Promise.all(tasks);
    cachedResults = results;
    return results;
  })();

  // 检测完成后异步更新 TUI 状态栏，不阻塞会话初始化
  checkPromise.then((results) => {
    const { theme } = ui;
    for (const entry of results.values()) {
      ui.setStatus(`tool-${entry.detector.name}`, renderToolStatus(entry, theme));
    }
  });
}

/**
 * 等待正在进行的检测完成（如有）。
 *
 * 用于 before_agent_start 和 /show-status 等需要确保结果就绪的场景。
 * 消费后置 null，避免后续重复等待。
 */
async function ensureChecksDone(): Promise<void> {
  if (checkPromise) {
    await checkPromise;
    checkPromise = null;
  }
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

  return ["", "## 外部工具可用性 (自动检测)", "", ...hints.map((h) => `- ${h}`), ""].join("\n");
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
function renderToolStatus(entry: CacheEntry, theme: ExtensionContext["ui"]["theme"]): string {
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
   * 启动检测但不等待，TUI 状态栏在检测完成后通过 .then() 异步更新。
   */
  pi.on("session_start", (_event, ctx) => {
    startChecks(ctx.ui);
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
   * 注册 /show-status 命令。
   *
   * 以 TUI notify 形式向用户展示所有检测器的详细结果。
   * 命令消息会被 Pi 拦截，不会流入 LLM 上下文。
   */
  pi.registerCommand("show-status", {
    description: "查看所有外部 CLI 工具的检测结果（不流入大模型上下文）",
    handler: async (_args, ctx) => {
      // 确保检测已完成再展示
      await ensureChecksDone();

      const entries = [...cachedResults.values()];

      if (entries.length === 0) {
        ctx.ui.notify("暂无已注册的工具检测器", "info");
        return;
      }

      const { theme } = ctx.ui;

      const lines: string[] = [];
      for (const entry of entries) {
        const label = entry.detector.displayName ?? entry.detector.name;
        const { installed, authenticated, version } = entry.result;

        /** 安装并且完成认证 */
        const isInstallAndAuthenticated = installed && authenticated !== false

        let line: string;
        if (isInstallAndAuthenticated) {
          line = theme.fg("success", `${label} ✓ 已安装并完成鉴权(${version||'不知道啥版本'})`);
        } else if (installed) {
          line = theme.fg("accent", `${label} ⚠ 已安装但未完成鉴权`);
        } else {
          line = theme.fg("dim", `${label} ✗ 未安装`);
        }
        lines.push(line);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  /**
   * 每次 agent 启动前，确保检测已完成后再注入系统提示词。
   * 此时检测通常在 session_start 就已启动，用户打字的时间足以跑完，
   * ensureChecksDone 多数情况下立即返回。
   */
  pi.on("before_agent_start", async (event, _ctx) => {
    await ensureChecksDone();

    const append = buildPromptAppend();
    if (!append) return; // 无可用的外部工具，不修改提示词

    return {
      systemPrompt: event.systemPrompt + append,
    };
  });
}
