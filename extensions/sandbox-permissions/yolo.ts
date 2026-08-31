// sandbox-yolo — 会话级沙箱墙开关（/yolo）
//
// /yolo = "you only live once"：把整面沙箱防护墙降到零（仅当前 session，默认关闭）。
// 开启时关闭三层墙：
//   - bash 审批链（bash-guard）：跳过 checkCommand / LLM 预审 / 人工确认
//   - Landlock 写保护（sandbox-shell）：spawnHook 注入 PI_SANDBOX_DISABLE=1
//   - read/write 黑名单（guard.ts）：跳过敏感路径拦截
//
// 状态只存内存：不开新 session、不写盘；通过 status bar（key=sandbox-yolo）
// 显示在 session 中——开启显示 🚀 YOLO，关闭则清除，断开即消散。
//
// 仅主进程加载：bash-guard / guard / allow / index 导入同一模块实例，共享同一份
// enabled。subagent 子进程经 --extension 单独加载 guard.ts，yolo.ts 默认 false，
// 子进程保持防护（subagent 无权给自己降墙）。

/** status bar 显示的 key（与 guard 的 "sandbox-guard" 区分，互不覆盖） */
export const YOLO_STATUS_KEY = "sandbox-yolo";

/** 当前 yolo 是否开启（默认 false = 防护开启） */
export function yoloEnabled(): boolean {
	return enabled;
}

export function setYolo(value: boolean): void {
	enabled = value;
}

/** 翻转，返回切换后的状态 */
export function toggleYolo(): boolean {
	enabled = !enabled;
	return enabled;
}

/** status bar 文案；关闭时返回 undefined（调用方 setStatus(key, undefined) 清除） */
export function yoloStatusText(): string | undefined {
	return enabled ? "🚀 YOLO" : undefined;
}

let enabled = false;
