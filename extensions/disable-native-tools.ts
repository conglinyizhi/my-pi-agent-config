/**
 * 禁用原生工具扩展
 *
 * 当 MCP 提供 better-edit-tools 系列工具时，禁用原生的读写工具（read、edit、write）。
 * 保留 bash 工具以及其他工具（如 grep、find、ls）以及通过 MCP 适配器注册的工具。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 在会话启动时禁用原生工具
  pi.on("session_start", async (_event, ctx) => {
    // 获取所有工具
    const allTools = pi.getAllTools();
    
    // 检查 be-* 系列工具是否存在
    const beTools = allTools.filter(tool => tool.name.startsWith("be-"));
    const hasBeTools = beTools.length > 0;
    
    // 检查基本文件操作工具是否存在（be-read, be-write, be-replace, be-delete）
    const requiredBeTools = ["be-read", "be-write", "be-replace", "be-delete"];
    const hasRequiredBeTools = requiredBeTools.every(toolName => 
      allTools.some(tool => tool.name === toolName)
    );
    
    // 当检测到 be-* 系列工具存在并且至少存在基本文件操作工具时
    if (hasBeTools && hasRequiredBeTools) {
      // 定义要禁用的原生工具名称（保留 bash）
      const nativeToolsToDisable = ["read", "edit", "write"];
      
      // 过滤掉要禁用的原生工具
      const activeTools = allTools
        .filter(tool => !nativeToolsToDisable.includes(tool.name))
        .map(tool => tool.name);
      
      // 设置活动工具
      pi.setActiveTools(activeTools);
      
      // 通知用户
      if (ctx.hasUI) {
        ctx.ui.notify(
          `检测到 BetterEditTools 系列工具，已禁用原生工具：${nativeToolsToDisable.join(", ")}（保留 bash）`,
          "info"
        );
      }
    }
  });
}