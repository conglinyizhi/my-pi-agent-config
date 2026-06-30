/**
 * uv 检测器
 *
 * 检测逻辑：
 * 1. 确认 uv 命令是否在 PATH 中
 * 2. 运行 `uv --version` 验证输出来自 Rust 版 uv（而非其他同名程序）
 * 3. 若确认是 uv，推测安装路径
 *
 * uv 是 Astral 团队用 Rust 实现的 Python 包管理器，
 * 可替代 pip / pip-tools / poetry / pyenv 等传统工具。
 *
 * 检测到后，在系统提示词中告知大模型严格使用 uv 处理 Python 包管理。
 */

import type { Detector, DetectorResult } from "../types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/** 异步执行命令，忽略 stderr，返回 stdout 并去除首尾空白 */
async function execTrim(cmd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, {
      encoding: "utf-8",
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** 检测命令是否存在于 PATH 中 */
async function commandExists(cmd: string): Promise<boolean> {
  const result = await execTrim(`command -v ${cmd}`);
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// 检测器实现
// ---------------------------------------------------------------------------

export const uvDetector: Detector = {
  name: "uv",

  displayName: "uv",

  description: "检测 uv (Rust 实现的 Python 包管理器) 是否安装",

  async check(): Promise<DetectorResult> {
    // 第一步：是否安装
    if (!(await commandExists("uv"))) {
      return { installed: false };
    }

    // 第二步：运行 uv --version，确认输出确实是 Rust 版 uv
    // uv 的版本输出形如：uv 0.6.x (xxxxxxxx)
    const versionOutput = await execTrim("uv --version 2>/dev/null");

    if (!versionOutput) {
      // 命令存在但没有任何输出 → 可能是其他同名程序
      return { installed: false };
    }

    // 解析版本号，取第一行
    const firstLine = versionOutput.split("\n")[0].trim();

    // 确认输出是 uv 的版本信息（以 "uv " 开头或以 "uv-" 开头）
    if (!/^uv[\s-]/.test(firstLine)) {
      // 不像是 uv 的版本输出，谨慎起见当作未安装
      return { installed: false };
    }

    // 提取干净版本号：去掉前缀 "uv " 和后面的 commit hash 括号
    const versionMatch = firstLine.match(/^uv\s+(\S+)/);
    const version = versionMatch ? versionMatch[1] : firstLine;

    return {
      installed: true,
      // uv 不需要登录鉴权，标记为已鉴权以显示绿色 ✓
      authenticated: true,
      version,
      promptHint:
        "用户已经配置好 uv（Rust 实现的 Python 包管理器）。" +
        "严格使用 uv 处理所有 Python 包管理操作，包括但不限于：" +
        "uv pip install（安装包）、uv pip uninstall（卸载）、" +
        "uv venv（创建虚拟环境）、uv pip list（列出已安装包）、" +
        "uv pip compile（锁定依赖）。禁止使用 pip 或 python -m pip。",
    };
  },
};
