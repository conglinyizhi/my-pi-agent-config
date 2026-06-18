/**
 * 跨平台通知发送模块
 * 支持 Linux、Windows、macOS 等操作系统
 */

import { exec, execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getOS, isWindows } from "./get-os";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** 执行异步指令，但最多等待指定毫秒数；超时即视为成功，不等命令结束 */
async function execNotifyAsync(
  command: string,
  argsOrOptions?: string[] | { shell?: boolean },
  options?: { shell?: boolean },
): Promise<void> {
  const execPromise = Array.isArray(argsOrOptions)
    ? execFileAsync(command, argsOrOptions, options)
    : execAsync(command, argsOrOptions);
  await Promise.race([
    execPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]);
}

/**
 * 默认通知自动消失等待时长（毫秒）
 */
const DEFAULT_TIMEOUT = 60_000; // 1 分钟

export interface NotifyOptions {
  title: string;
  message: string;
  urgency?: "low" | "normal" | "critical";
  timeout?: number; // 毫秒
  icon?: string;
  sound?: boolean;
  /** 自定义音频文件路径（优先于系统默认声音） */
  soundFile?: string;
}

/**
 * 通知可用性诊断结果
 */
export interface NotificationSupport {
  supported: boolean;
  /** 缺失的必需命令（用于提示用户安装） */
  missing: string[];
  /** 安装提示命令 */
  installHint: string;
  /** 当前操作系统 */
  os: string;
}

/**
 * 检查当前系统的通知能力
 * 返回是否支持、缺失的命令以及安装提示
 */
export async function checkNotificationSupport(): Promise<NotificationSupport> {
  const os = getOS();

  switch (os) {
    case "linux": {
      // 只使用 notify-send 发送桌面通知；对话框工具不作为降级方案
      const supported = await isCommandAvailable("notify-send");
      return {
        supported,
        missing: supported ? [] : ["notify-send"],
        installHint:
          "请安装 libnotify：\n  Debian/Ubuntu: sudo apt install libnotify-bin\n  Fedora/RHEL:  sudo dnf install libnotify\n  Arch:         sudo pacman -S libnotify",
        os,
      };
    }
    case "windows": {
      // Windows 内置 PowerShell，通常可用
      const hasPowershell = await isCommandAvailable("powershell");
      return {
        supported: hasPowershell,
        missing: hasPowershell ? [] : ["powershell"],
        installHint: "请确保 Windows PowerShell 可用（通常系统自带）。",
        os,
      };
    }
    case "macos": {
      const hasOsascript = await isCommandAvailable("osascript");
      return {
        supported: hasOsascript,
        missing: hasOsascript ? [] : ["osascript"],
        installHint: "macOS 通常自带 osascript。如缺失，请检查系统完整性。",
        os,
      };
    }
    default:
      return {
        supported: false,
        missing: [],
        installHint: `不支持的操作系统: ${os}，暂无通知支持。`,
        os,
      };
  }
}

/**
 * 检查某个命令是否可用（跨平台）
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    if (isWindows()) {
      await execAsync(`powershell -Command "Get-Command ${command} -ErrorAction SilentlyContinue"`, {
        windowsHide: true,
      });
    } else {
      await execAsync(`command -v ${command}`);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux 通知发送
 * 使用 notify-send 命令（需要 libnotify）
 */
async function sendLinuxNotification(options: NotifyOptions): Promise<void> {
  const { title, message, urgency = "normal", timeout = DEFAULT_TIMEOUT, icon, sound = false, soundFile } = options;

  const args: string[] = [];

  if (urgency) {
    args.push("-u", urgency);
  }

  if (icon) {
    args.push("-i", icon);
  }

  if (timeout) {
    args.push("-t", String(timeout));
  }

  args.push(title, message);

  // 超时 1000ms，超时即视为成功，不等 notify-send 结束
  await execNotifyAsync("notify-send", args);

  if (sound || soundFile) {
    await playLinuxSound(soundFile).catch(() => {
      // 声音播放失败不影响通知本身
    });
  }
}

/**
 * Linux 声音播放
 * 按优先级尝试：paplay -> ffplay -> canberra-gtk-play -> 系统提示音
 */
async function playLinuxSound(soundFile?: string): Promise<void> {
  // 播放自定义音频文件
  if (soundFile) {
    try {
      await execNotifyAsync(`paplay "${soundFile}"`);
      return;
    } catch {
      // paplay 失败，尝试 ffplay
    }

    try {
      // -nodisp 禁止显示窗口，-autoexit 播放完自动退出
      await execNotifyAsync(`ffplay -nodisp -autoexit "${soundFile}"`);
      return;
    } catch {
      throw new Error(`Linux 声音播放失败：无法播放自定义音频 ${soundFile}`);
    }
  }

  try {
    await execNotifyAsync("canberra-gtk-play -i message");
    return;
  } catch {
    // canberra 不可用或主题音缺失，继续尝试 paplay
  }

  const candidateSounds = [
    "/usr/share/sounds/freedesktop/stereo/message.oga",
    "/usr/share/sounds/deepin/stereo/message.ogg",
    "/usr/share/sounds/gnome/default/alerts/glass.ogg",
    "/usr/share/sounds/ubuntu/notifications/Positive.ogg",
  ];

  for (const soundPath of candidateSounds) {
    if (!(await fileExists(soundPath))) {
      continue;
    }

    try {
      await execNotifyAsync(`paplay "${soundPath}"`);
      return;
    } catch {
      // paplay 失败，尝试 ffplay
    }

    try {
      // -nodisp 禁止显示窗口，-autoexit 播放完自动退出
      await execNotifyAsync(`ffplay -nodisp -autoexit "${soundPath}"`);
      return;
    } catch {
      // ffplay 也失败，尝试下一个候选文件
    }
  }

  throw new Error("Linux 声音播放失败：未找到可用的声音工具或系统提示音");
}

/**
 * 检查文件是否存在
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await execAsync(`test -f "${filePath}"`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows 通知发送
 * 使用 PowerShell 的 BurntToast 模块或系统通知
 */
async function sendWindowsNotification(options: NotifyOptions): Promise<void> {
  const { title, message, sound = false, soundFile } = options;

  // 使用 PowerShell 发送 Toast 通知
  const audioXml = sound && !soundFile ? '<audio src="ms-winsoundevent:Notification.Default" />' : "";
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
      ${audioXml}
    </toast>
"@
    
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($template)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Pi Agent").Show($toast)
  `;

  // 超时 1000ms，超时即视为成功，不等 PowerShell 结束
  await execNotifyAsync(`powershell -Command "${psScript.replace(/\"/g, '\\"')}"`, {
    windowsHide: true,
  });

  if (soundFile) {
    await playWindowsSound(soundFile).catch(() => {
      // 声音播放失败不影响通知本身
    });
  }
}

/**
 * Windows 声音播放
 * 使用 PowerShell 的 SoundPlayer 播放自定义音频文件
 */
async function playWindowsSound(soundFile: string): Promise<void> {
  const playScript = `
    $player = New-Object System.Media.SoundPlayer "${soundFile.replace(/"/g, '\"')}"
    $player.PlaySync()
  `;

  await execNotifyAsync(`powershell -Command "${playScript.replace(/"/g, '\\"')}"`, {
    windowsHide: true,
  });
}

/**
 * macOS 通知发送
 * 使用 osascript 或 terminal-notifier
 */
async function sendMacNotification(options: NotifyOptions): Promise<void> {
  const { title, message, sound = true, soundFile } = options;

  // 使用 osascript 发送通知
  const soundParam = sound && !soundFile ? 'sound name "default"' : "";
  const script = `display notification "${message}" with title "${title}" ${soundParam}`;

  // 超时 1000ms，超时即视为成功，不等 osascript 结束
  await execNotifyAsync(`osascript -e '${script}'`);
  // 备用方案不再需要——超时已覆盖各种情况

  if (soundFile) {
    await playMacSound(soundFile).catch(() => {
      // 声音播放失败不影响通知本身
    });
  }
}

/**
 * macOS 声音播放
 * 使用 afplay 播放自定义音频文件
 */
async function playMacSound(soundFile: string): Promise<void> {
  await execNotifyAsync(`afplay "${soundFile}"`);
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
    timeout: DEFAULT_TIMEOUT,
  });
}

/**
 * 默认任务完成音效路径
 */
const DEFAULT_TASK_COMPLETE_SOUND = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "sounds", "task-complete.wav");

/**
 * 发送任务完成通知
 */
export async function notifyTaskComplete(taskDescription: string): Promise<boolean> {
  return notify("Pi Agent", `任务完成: ${taskDescription}`, {
    urgency: "normal",
    timeout: DEFAULT_TIMEOUT,
    sound: true,
    soundFile: DEFAULT_TASK_COMPLETE_SOUND,
  });
}

/**
 * 发送问题询问通知
 */
export async function notifyQuestion(question: string): Promise<boolean> {
  return notify("Pi Agent", `需要您的输入: ${question}`, {
    urgency: "normal",
    timeout: DEFAULT_TIMEOUT,
    sound: true,
    soundFile: DEFAULT_TASK_COMPLETE_SOUND,
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
        await execAsync("which notify-send");
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
      return { os, supported: true, method: "notify-send" };
    case "windows":
      return { os, supported: true, method: "PowerShell Toast" };
    case "macos":
      return { os, supported: true, method: "osascript/terminal-notifier" };
    default:
      return { os, supported: false, method: "none" };
  }
}
