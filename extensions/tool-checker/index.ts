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
 * - `tools.toml`   —— 声明式配置，新增工具只需编辑此文件
 * - `types.ts`     —— 公共类型定义（Detector / DetectorResult）
 * - `index.ts`     —— 主入口，读取 TOML 动态生成检测器
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Detector, DetectorResult } from "./types.js";
import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// 定位 TOML 配置文件
// ---------------------------------------------------------------------------

const __dirname = (() => {
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return resolve("."); }
})();

const TOML_PATH = resolve(__dirname, "tools.toml");

// ---------------------------------------------------------------------------
// TOML 配置类型
// ---------------------------------------------------------------------------

interface ToolConfig {
  name: string;
  display: string;
  check: string;
  auth?: string;
  verify?: string;
  version?: string;
  hint: string;
}

// ---------------------------------------------------------------------------
// 从 TOML 配置生成 Detector 对象
// ---------------------------------------------------------------------------

function createDetector(cfg: ToolConfig): Detector {
  return {
    name: cfg.name,
    displayName: cfg.display,
    description: `检测 ${cfg.display} 是否安装`,

    async check(): Promise<DetectorResult> {
      // 1. 执行 check 命令
      let output = "";
      try {
        const { stdout } = await execAsync(cfg.check, {
          encoding: "utf-8",
          timeout: 10000,
        });
        output = stdout.trim();
      } catch {
        return { installed: false };
      }

      if (!output) return { installed: false };

      // 2. 可选：verify 正则确认输出确实来自目标工具
      if (cfg.verify) {
        if (!new RegExp(cfg.verify, "m").test(output)) {
          return { installed: false };
        }
      }

      // 3. 可选：提取版本号
      let version: string | undefined;
      if (cfg.version) {
        const m = output.match(new RegExp(cfg.version, "m"));
        version = m ? m[1] : undefined;
      }

      // 4. 可选：鉴权检测
      let authenticated: boolean | undefined;
      if (cfg.auth) {
        try {
          await execAsync(cfg.auth, { encoding: "utf-8", timeout: 10000 });
          authenticated = true;
        } catch {
          authenticated = false;
        }
      } else {
        // 无 auth 配置 → 不需要鉴权，直接绿色 ✓
        authenticated = true;
      }

      return {
        installed: true,
        authenticated,
        version,
        promptHint: cfg.hint,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 加载 TOML 并构建检测器列表
// ---------------------------------------------------------------------------

function loadDetectors(): Detector[] {
  try {
    const raw = readFileSync(TOML_PATH, "utf-8");
    const data = parseToml(raw) as { tools?: ToolConfig[] };
    return (data.tools || []).map(createDetector);
  } catch {
    return [];
  }
}

const DETECTORS: Detector[] = loadDetectors();

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
