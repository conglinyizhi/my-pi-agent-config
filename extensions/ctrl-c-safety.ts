/**
 * Ctrl+C 安全拦截插件
 *
 * 防止误操作：在输入/粘贴内容后的 3 秒内，按下 Ctrl+C 不会清空编辑器，
 * 而是提示用户等待冷却时间结束。3 秒后 Ctrl+C 正常清空。
 *
 * 实现原理：
 * 1. 修改 keybindings.json，将 app.clear 从 ctrl+c 移到 shift+ctrl+c
 *    将 tui.input.copy 从 ctrl+c 移到 ctrl+insert
 * 2. 注册 ctrl+c 为扩展快捷键，在冷却期内拦截清空操作
 * 3. 首次安装需要 /reload 使快捷键绑定生效
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const COOLDOWN_MS = 3000; // 冷却时间 3 秒
const TICK_MS = 100; // tick 间隔 0.1 秒
const SAFE_CLEAR_KEY = "shift+ctrl+c"; // app.clear 的备用快捷键
const SAFE_COPY_KEY = "ctrl+insert"; // tui.input.copy 的备用快捷键

export default function (pi: ExtensionAPI) {
    // ---- 持久状态 ----
    let lastInputTime = 0; // 最后一次检测到编辑器内容变化的时间戳
    let blockedAt = 0; // 最近一次拦截发生的时间戳（0 = 无拦截）
    let lastEditorText = ""; // 编辑器内容快照
    let tickTimer: ReturnType<typeof setInterval> | null = null; // 唯一的持续 tick timer
    let ctxCache: any = undefined; // 缓存的 ctx，供 tick 回调使用

    // ========== 步骤 1：确保 keybindings.json 中 ctrl+c 已被释放 ==========

    function ensureKeybindings(): boolean {
        const keybindingsPath = join(getAgentDir(), "keybindings.json");
        let config: Record<string, string | string[]> = {};

        if (existsSync(keybindingsPath)) {
            try {
                const raw = readFileSync(keybindingsPath, "utf-8").trim();
                if (raw) {
                    config = JSON.parse(raw);
                }
            } catch {
                // 解析失败，使用空配置
            }
        }

        let modified = false;

        const clearKeys = config["app.clear"];
        if (clearKeys === undefined || clearKeys === "ctrl+c" ||
            (Array.isArray(clearKeys) && clearKeys.length === 1 && clearKeys[0] === "ctrl+c")) {
            config["app.clear"] = SAFE_CLEAR_KEY;
            modified = true;
        } else if (Array.isArray(clearKeys) && clearKeys.includes("ctrl+c")) {
            const filtered = clearKeys.filter((k: string) => k !== "ctrl+c");
            if (!filtered.includes(SAFE_CLEAR_KEY)) {
                filtered.push(SAFE_CLEAR_KEY);
            }
            config["app.clear"] = filtered;
            modified = true;
        }

        const copyKeys = config["tui.input.copy"];
        if (copyKeys === undefined || copyKeys === "ctrl+c" ||
            (Array.isArray(copyKeys) && copyKeys.length === 1 && copyKeys[0] === "ctrl+c")) {
            config["tui.input.copy"] = SAFE_COPY_KEY;
            modified = true;
        } else if (Array.isArray(copyKeys) && copyKeys.includes("ctrl+c")) {
            const filtered = copyKeys.filter((k: string) => k !== "ctrl+c");
            if (!filtered.includes(SAFE_COPY_KEY)) {
                filtered.push(SAFE_COPY_KEY);
            }
            config["tui.input.copy"] = filtered;
            modified = true;
        }

        if (modified) {
            writeFileSync(keybindingsPath, JSON.stringify(config, null, 2) + "\n");
        }

        return modified;
    }

    const keybindingsChanged = ensureKeybindings();

    // ========== 步骤 2：唯一的持续 tick ==========

    function startTick(ctx: any) {
        if (tickTimer) return; // 防止重复启动
        ctxCache = ctx;

        tickTimer = setInterval(() => {
            // --- 检测编辑器内容变化 ---
            try {
                const currentText = ctxCache?.ui?.getEditorText?.() ?? "";
                if (currentText !== lastEditorText) {
                    lastEditorText = currentText;
                    if (currentText.length > 0) {
                        lastInputTime = Date.now();
                    }
                }
            } catch { /* RPC 模式下可能不可用 */ }

            // --- 更新倒计时 ---
            if (blockedAt > 0) {
                const elapsed = Date.now() - blockedAt;
                if (elapsed >= COOLDOWN_MS) {
                    // 冷却结束
                    blockedAt = 0;
                    ctxCache?.ui?.setStatus?.("ctrl-c-safety", undefined);
                    ctxCache?.ui?.notify?.("冷却结束，现在可以按 Ctrl+C 清空输入了。也可用 Ctrl+G 打开外部编辑器", "info");
                } else {
                    const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
                    ctxCache?.ui?.setStatus?.("ctrl-c-safety", `⏳ ${remaining} 秒后可清空`);
                }
            }
        }, TICK_MS);
    }

    function stopTick() {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
        ctxCache = undefined as any;
        blockedAt = 0;
    }

    // ========== 步骤 3：注册 ctrl+c 快捷键 ==========

    pi.registerShortcut("ctrl+c", {
        description: "清空编辑器（3 秒冷却保护）",
        handler: async (ctx) => {
            const now = Date.now();
            const elapsed = now - lastInputTime;

            // 冷却期内：拦截，仅设置状态，tick 会自动更新倒计时
            if (elapsed < COOLDOWN_MS) {
                blockedAt = now;
                const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
                ctx.ui.notify(
                    `Ctrl+C 已拦截：请等待 ${remaining} 秒后再试。如需编辑大量内容，建议用 Ctrl+G 打开外部编辑器`,
                    "warning",
                );
                ctx.ui.setStatus("ctrl-c-safety", `⏳ ${remaining} 秒后可清空`);
                return true;
            }

            // 冷却期已过，正常清空
            blockedAt = 0;
            ctx.ui.setStatus("ctrl-c-safety", undefined);
            ctx.ui.setEditorText("");
            return true;
        },
    });

    // ========== 步骤 4：生命周期 ==========

    // 通过 input 事件追踪（用户按 Enter 提交时）
    pi.on("input", async () => {
        lastInputTime = Date.now();
    });

    pi.on("session_start", async (_event, ctx) => {
        if (!ctx.hasUI) return;

        // 启动时设置初始冷却
        lastInputTime = Date.now();

        // 初始化编辑器快照
        try {
            lastEditorText = ctx.ui.getEditorText?.() ?? "";
        } catch {
            lastEditorText = "";
        }

        // 启动唯一的持续 tick
        startTick(ctx);
    });

    pi.on("session_shutdown", async () => {
        stopTick();
    });

    // ========== 步骤 5：首次安装提示 ==========

    if (keybindingsChanged) {
        pi.on("session_start", async (_event, ctx) => {
            if (ctx.hasUI) {
                ctx.ui.notify(
                    "🛡 Ctrl+C 安全拦截已配置。请执行 /reload 以激活快捷键绑定。",
                    "info",
                );
            }
        });
    }
}
