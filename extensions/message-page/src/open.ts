import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 用系统默认浏览器打开一个本地 HTML 文件。
 * 尽量不抛出，失败时返回 false，调用方决定如何兜底。
 */
export async function openInBrowser(pi: ExtensionAPI, filePath: string): Promise<boolean> {
  const platform = process.platform;

  // 必须先等待文件存在；生成 HTML 是本插件的顺序执行，此处仅负责打开。
  try {
    if (platform === "darwin") {
      await pi.exec("open", ["-a", "Safari", filePath]);
    } else if (platform === "win32") {
      await pi.exec("cmd", ["/c", "start", "", filePath]);
    } else {
      await pi.exec("xdg-open", [filePath]);
    }
    return true;
  } catch {
    return false;
  }
}
