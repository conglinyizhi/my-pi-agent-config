// sandbox-params.ts — 派工时的沙箱参数校验（纯函数，可注入存在性判断）
//
// 为什么要在派工前硬校验：这批参数过去的失败模式全是「静默降级」——
//   - sandbox_dir 指向不存在的目录：landlock 包装器（scripts/sandbox-shell.mjs
//     的 filterExisting）把它丢掉，worker 悄悄退化成只有 /tmp 可写，
//     跑到一半才发现写不了；
//   - sandbox_dir 与 readonly 同时给：只读档位赢，调用方以为自己指定了可写目录，
//     实际一点也用不上；
//   - sandbox_profile=worktree 却没有 sandbox_dir：worker 整批按 readonly 跑。
// 代价都落在「worker 已经烧掉一个预算」之后。这些全部是派工那一刻就能判断的，
// 所以在这里一次性拒绝，报错文本直接给出修法。

import { statSync } from "node:fs";
import { resolve } from "node:path";

/** worker 沙箱档位：readonly=只有 /tmp 可写；worktree=只能写 sandbox_dir。 */
export type SandboxProfile = "readonly" | "worktree";

export interface SandboxPlan {
  profile: SandboxProfile;
  /** worktree 档位的可写根（原样透传给 worker 的 PI_SANDBOX_RW，不做规范化） */
  sandboxDir?: string;
  /** 生效后的只读标志（worker 的 PI_SANDBOX_READONLY） */
  readonly: boolean;
}

export type SandboxPlanResult =
  | { ok: true; plan: SandboxPlan }
  | { ok: false; error: string; text: string };

export interface SandboxParams {
  sandbox_dir?: string;
  sandbox_profile?: SandboxProfile;
  readonly?: boolean;
}

export interface SandboxPlanDeps {
  /** 目录存在性判断（测试注入）；缺省用 statSync */
  isDirectory?: (path: string) => boolean;
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析并校验本批 worker 的沙箱档位。
 *
 * 只有全部合法才返回 plan；任一项不合法就整批拒绝（不 spawn 任何 worker）。
 */
export function planSubagentSandbox(
  params: SandboxParams,
  deps: SandboxPlanDeps = {},
): SandboxPlanResult {
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const dir = typeof params.sandbox_dir === "string" && params.sandbox_dir.trim()
    ? params.sandbox_dir.trim()
    : undefined;
  const profile: SandboxProfile = params.sandbox_profile ?? (dir ? "worktree" : "readonly");
  const readonly = profile === "readonly" || params.readonly === true;

  if (profile === "worktree" && !dir) {
    return {
      ok: false,
      error: "missing_sandbox_dir",
      text: "错误：sandbox_profile=worktree 必须同时提供 sandbox_dir。",
    };
  }

  if (dir && readonly) {
    return {
      ok: false,
      error: "conflicting_sandbox_scope",
      text: [
        `错误：沙箱参数互相矛盾——sandbox_dir=${dir}，只读档位已生效（sandbox_profile=${params.sandbox_profile ?? "（未给，按 sandbox_dir 推导）"}，readonly=${params.readonly === true}）。`,
        "只读档位让 worker 只能写 /tmp，你指定的目录用不上。二选一：要写那个目录就别开只读，要只读就别传 sandbox_dir。",
      ].join("\n"),
    };
  }

  if (dir && !isDirectory(resolve(dir))) {
    return {
      ok: false,
      error: "sandbox_dir_not_found",
      text: [
        `错误：sandbox_dir 不是已存在的目录：${dir}`,
        "这个目录不存在的授权路径会被沙箱包装器丢掉，worker 会静默退化成只有 /tmp 可写，跑到一半才发现写不了，所以这里直接拒绝。",
        "先建好目录（worker 拿不到创建它的授权），再重新派工。",
      ].join("\n"),
    };
  }

  return { ok: true, plan: { profile, sandboxDir: dir, readonly } };
}
