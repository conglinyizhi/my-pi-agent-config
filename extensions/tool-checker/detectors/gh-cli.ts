/**
 * GitHub CLI (gh) 检测器
 *
 * 检测逻辑：
 * 1. 确认 gh 命令是否在 PATH 中
 * 2. 若已安装，运行 `gh auth status` 判断是否已完成鉴权
 * 3. 若鉴权成功，尝试获取版本号
 *
 * 当以上全部通过时，在系统提示词中告知大模型：
 * "系统已安装 gh CLI 并且完成密钥配置，有需要应使用该工具而不是直接访问 API"
 */

import type { Detector, DetectorResult } from "../types.js";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// 内部工具函数
// ---------------------------------------------------------------------------

/** 同步执行命令，忽略 stderr，返回 stdout 并去除首尾空白 */
function execTrim(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** 检测命令是否存在于 PATH 中 */
function commandExists(cmd: string): boolean {
  return execTrim(`command -v ${cmd}`).length > 0;
}

// ---------------------------------------------------------------------------
// 检测器实现
// ---------------------------------------------------------------------------

export const ghCliDetector: Detector = {
  name: "gh-cli",

  displayName: "gh",

  description: "检测 GitHub CLI (gh) 是否安装并完成鉴权",

  async check(): Promise<DetectorResult> {
    // 第一步：是否安装
    if (!commandExists("gh")) {
      return { installed: false };
    }

    // 第二步：是否完成鉴权
    // gh auth status 在未登录时 exit code != 0
    let authenticated = false;
    try {
      execSync("gh auth status", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      authenticated = true;
    } catch {
      // gh auth status 失败 → 未鉴权
    }

    if (!authenticated) {
      return {
        installed: true,
        authenticated: false,
      };
    }

    // 第三步：获取版本
    const version = execTrim("gh --version 2>/dev/null | head -1") || undefined;

    return {
      installed: true,
      authenticated: true,
      version,
      promptHint:
        "系统已安装 gh CLI 并且完成密钥配置，有需要应使用该工具（gh 命令）而不是直接调用 GitHub API。",
    };
  },
};
