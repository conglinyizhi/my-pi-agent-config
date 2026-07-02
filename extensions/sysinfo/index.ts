// /sysinfo —— 一键收集系统信息发送给 LLM（类似 neofetch）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const TIMEOUT = 8000; // 单个命令超时（ms）

// ---------------------------------------------------------------------------
// 收集脚本：一条 shell 搞定所有信息收集
// ---------------------------------------------------------------------------
const COLLECT_SCRIPT = `
echo "===== 操作系统 ====="
cat /etc/os-release 2>/dev/null || cat /etc/lsb-release 2>/dev/null || echo "无法读取"

echo ""
echo "===== 内核 ====="
uname -a

echo ""
echo "===== 运行时间 ====="
uptime 2>/dev/null || cat /proc/uptime 2>/dev/null

echo ""
echo "===== 主机名 ====="
hostname

echo ""
echo "===== 当前用户 / Shell / 终端 ====="
echo "USER=\${USER:-unknown}"
echo "SHELL=\${SHELL:-unknown}"
echo "TERM=\${TERM:-unknown}"
echo "HOME=\${HOME}"

echo ""
echo "===== 桌面环境 ====="
echo "XDG_CURRENT_DESKTOP=\${XDG_CURRENT_DESKTOP:-未设置}"
echo "XDG_SESSION_TYPE=\${XDG_SESSION_TYPE:-未设置}"
echo "DESKTOP_SESSION=\${DESKTOP_SESSION:-未设置}"
echo "WAYLAND_DISPLAY=\${WAYLAND_DISPLAY:-未设置}"
echo "DISPLAY=\${DISPLAY:-未设置}"

echo ""
echo "===== CPU ====="
grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs
echo "核心数: \$(nproc 2>/dev/null || grep -c processor /proc/cpuinfo 2>/dev/null)"

echo ""
echo "===== GPU ====="
lspci 2>/dev/null | grep -i -E 'vga|3d|display' || echo "无 lspci 或未检测到 GPU"

echo ""
echo "===== 内存 ====="
free -h 2>/dev/null || cat /proc/meminfo 2>/dev/null | head -5

echo ""
echo "===== 磁盘 ====="
df -h / 2>/dev/null | tail -1
echo ""
df -h /home 2>/dev/null | tail -1

echo ""
echo "===== 架构 ====="
uname -m

echo ""
echo "===== 核心工具版本 ====="
echo -n "node: "; node --version 2>/dev/null || echo "未安装"
echo -n "npm:  "; npm --version 2>/dev/null || echo "未安装"
echo -n "python3: "; python3 --version 2>/dev/null || echo "未安装"
echo -n "python: "; python --version 2>/dev/null || echo "未安装"
echo -n "git: "; git --version 2>/dev/null || echo "未安装"
echo -n "docker: "; docker --version 2>/dev/null || echo "未安装"
echo -n "pip: "; pip3 --version 2>/dev/null || pip --version 2>/dev/null || echo "未安装"
echo -n "rustc: "; rustc --version 2>/dev/null || echo "未安装"
echo -n "cargo: "; cargo --version 2>/dev/null || echo "未安装"
echo -n "gcc: "; gcc --version 2>/dev/null | head -1 || echo "未安装"
echo -n "make: "; make --version 2>/dev/null | head -1 || echo "未安装"


echo ""
echo "===== 环境变量 (关键) ====="
echo "LANG=\${LANG:-未设置}"
echo "PATH=\${PATH}"
echo "EDITOR=\${EDITOR:-未设置}"
echo "PAGER=\${PAGER:-未设置}"
echo "SSH_AUTH_SOCK=\${SSH_AUTH_SOCK:-未设置}"
`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sysinfo", {
    description: "收集系统信息并发送给 LLM（类似 neofetch）",
    handler: async (_args, ctx) => {
      ctx.ui.notify("正在收集系统信息…", "info");
      ctx.ui.setStatus("sysinfo", "收集中…");

      let output: string;
      try {
        const result = await execAsync(COLLECT_SCRIPT, {
          timeout: TIMEOUT,
          maxBuffer: 512 * 1024,
          shell: "/bin/bash",
        });
        output = result.stdout || "(无输出)";
        if (result.stderr) {
          output += "\n\n[stderr]\n" + result.stderr;
        }
      } catch (e: any) {
        output = `收集系统信息时出错: ${e.message}\n`;
        if (e.stdout) output += `\n--- 已收集的部分 ---\n${e.stdout}`;
      } finally {
        ctx.ui.setStatus("sysinfo", undefined);
      }

      const message = `以下是当前系统的信息（由 /sysinfo 收集）：\n\n\`\`\`\n${output}\n\`\`\``;

      pi.sendUserMessage(message);

      ctx.ui.notify("系统信息已发送给 LLM ✓", "info");
    },
  });
}
