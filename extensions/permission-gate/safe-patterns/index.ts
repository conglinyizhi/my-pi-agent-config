/**
 * 安全模式白名单聚合
 *
 * 每个模式独立实现在单独文件中（如 tmp-recreate.ts），
 * 在此导入并聚合为 safePatternHandlers 数组。
 *
 * 新增模式：创建 xxx.ts → 在此 import → push 到数组中。
 */

export type SafePatternHandler = (slices: string[]) => Set<number>;

// DeepSeek V4 Pro 行为
import { tmpRecreate } from "./tmp-recreate";
// Qwen 3.x 行为
import { mktempCleanup } from "./mktemp-cleanup";
// GLM 5.2 行为
import { sudoReadonly } from "./sudo-readonly";
// venv 激活后的 pip install 放行
import { pipAfterVenv } from "./pip-after-venv";

export const safePatternHandlers: SafePatternHandler[] = [tmpRecreate, mktempCleanup, sudoReadonly, pipAfterVenv];
