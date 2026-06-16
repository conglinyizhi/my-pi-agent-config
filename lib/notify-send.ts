/**
 * 跨平台通知发送模块
 * 支持 Linux、Windows、macOS 等操作系统
 */

import { exec } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface NotifyOptions {
  title: string;
  message: string;
  urgency?: "low" | "normal" | "critical";
  timeout?: number; // 毫秒
  icon?: string;
  sound?: boolean;
}

/**
 * 检测当前操作系统类型
 */
function getOS(): "linux" | "windows" | "macos" | "unknown" {
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

/**
 * Linux 通知发送
 * 使用 notify-send 命令（需要 libnotify）
 */
async function sendLinuxNotification(options: NotifyOptions): Promise<void> {
  const { title, message, urgency = "normal", timeout, icon } = options;

  const args: string[] = [];

  if (urgency) {
    args.push(`-u ${urgency}`);
  }

  if (icon) {
    args.push(`-i "${icon}"`);
  }

  if (timeout) {
    args.push(`-t ${timeout}`);
  }

  const command = `notify-send ${args.join(" ")} "${title}" "${message}"`;

  try {
    await execAsync(command);
  } catch {
    // 如果 notify-send 不可用，尝试使用 zenity
    try {
      const zenityCommand = `zenity --info --title="${title}" --text="${message}" --timeout=${Math.floor((timeout || 5000) / 1000)}`;
      await execAsync(zenityCommand);
    } catch {
      throw new Error("Linux 通知发送失败：请安装 notify-send 或 zenity");
    }
  }
}

/**
 * Windows 通知发送
 * 使用 PowerShell 的 BurntToast 模块或系统通知
 */
async function sendWindowsNotification(options: NotifyOptions): Promise<void> {
  const { title, message } = options;

  // 使用 PowerShell 发送 Toast 通知
  const psScript = `
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    
    $template = @"
    <toast>
      <visual>
        <binding template="ToastGeneric">
          <text>${title}</text>
          <text>${message}</text>
        </binding>
      </visual>
    </toast>
"@
    
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($template)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Pi Agent").Show($toast)
  `;

  try {
    await execAsync(`powershell -Command "${psScript.replace(/"/g, '\\"')}"`, {
      windowsHide: true,
    });
  } catch {
    // 备用方案：使用 msg 命令
    try {
      await execAsync(`msg * /time:5 "${title}: ${message}"`);
    } catch {
      throw new Error("Windows 通知发送失败：请确保 PowerShell 可用");
    }
  }
}

/**
 * macOS 通知发送
 * 使用 osascript 或 terminal-notifier
 */
async function sendMacNotification(options: NotifyOptions): Promise<void> {
  const { title, message, sound = true } = options;

  // 使用 osascript 发送通知
  const soundParam = sound ? 'sound name "default"' : "";
  const script = `display notification "${message}" with title "${title}" ${soundParam}`;

  try {
    await execAsync(`osascript -e '${script}'`);
  } catch {
    // 备用方案：使用 terminal-notifier（如果安装了的话）
    try {
      await execAsync(`terminal-notifier -title "${title}" -message "${message}"`);
    } catch {
      throw new Error("macOS 通知发送失败：请确保 osascript 可用");
    }
  }
}

/**
 * 发送跨平台通知
 * 自动检测操作系统并使用相应的通知机制
 */
export async function sendNotification(options: NotifyOptions): Promise<boolean> {
  const os = getOS();

  try {
    switch (os) {
      case "linux":
        await sendLinuxNotification(options);
        break;
      case "windows":
        await sendWindowsNotification(options);
        break;
      case "macos":
        await sendMacNotification(options);
        break;
      default:
        console.warn(`不支持的操作系统: ${os}，无法发送通知`);
        return false;
    }
    return true;
  } catch (error) {
    console.error("发送通知失败:", error);
    return false;
  }
}

/**
 * 发送简单通知的便捷函数
 */
export async function notify(title: string, message: string, options?: Partial<NotifyOptions>): Promise<boolean> {
  return sendNotification({
    title,
    message,
    ...options,
  });
}

/**
 * 发送任务开始通知
 */
export async function notifyTaskStart(taskDescription: string): Promise<boolean> {
  return notify("Pi Agent", `任务开始: ${taskDescription}`, {
    urgency: "low",
    timeout: 3000,
  });
}

/**
 * 发送任务完成通知
 */
export async function notifyTaskComplete(taskDescription: string): Promise<boolean> {
  return notify("Pi Agent", `任务完成: ${taskDescription}`, {
    urgency: "normal",
    timeout: 5000,
  });
}

/**
 * 发送问题询问通知
 */
export async function notifyQuestion(question: string): Promise<boolean> {
  return notify("Pi Agent", `需要您的输入: ${question}`, {
    urgency: "normal",
    timeout: 5000,
  });
}

/**
 * 发送错误通知
 */
export async function notifyError(errorMessage: string): Promise<boolean> {
  return notify("Pi Agent - 错误", errorMessage, {
    urgency: "critical",
    timeout: 10000,
  });
}

/**
 * 发送警告通知
 */
export async function notifyWarning(warningMessage: string): Promise<boolean> {
  return notify("Pi Agent - 警告", warningMessage, {
    urgency: "normal",
    timeout: 5000,
  });
}

/**
 * 检查通知功能是否可用
 */
export async function isNotificationAvailable(): Promise<boolean> {
  const os = getOS();

  try {
    switch (os) {
      case "linux":
        await execAsync("which notify-send || which zenity");
        return true;
      case "windows":
        await execAsync('powershell -Command "Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue"');
        return true;
      case "macos":
        await execAsync("which osascript || which terminal-notifier");
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * 获取通知系统信息
 */
export function getNotificationInfo(): { os: string; supported: boolean; method: string } {
  const os = getOS();

  switch (os) {
    case "linux":
      return { os, supported: true, method: "notify-send/zenity" };
    case "windows":
      return { os, supported: true, method: "PowerShell Toast" };
    case "macos":
      return { os, supported: true, method: "osascript/terminal-notifier" };
    default:
      return { os, supported: false, method: "none" };
  }
}
