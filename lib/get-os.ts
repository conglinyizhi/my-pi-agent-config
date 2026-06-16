import { platform } from "node:os";

/*** 检测当前操作系统类型 */
export function getOS(): "linux" | "windows" | "macos" | "unknown" {
  const os = platform();
  switch (os) {
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "unknown";
  }
}

export function isWindows(): boolean {
  return getOS() === "windows";
}

export function isMacOS(): boolean {
  return getOS() === "macos";
}

export function isLinux(): boolean {
  return getOS() === "linux";
}

export default {
  getOS,
  isLinux,
  isWindows,
  isMacOS,
};
