/**
 * 计划模式扩展
 *
 * 用于安全代码分析的只读探索模式。
 * 启用后，只能使用只读工具。
 *
 * 特性：
 * - 可通过 /plan 命令或 Ctrl+Alt+P 切换
 * - Bash 仅允许白名单中的只读命令
 * - 从 "Plan:" 段落中提取带编号的计划步骤
 * - 在执行过程中用 [DONE:n] 标记完成步骤
 * - 执行期间显示进度跟踪组件
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.ts";

// 工具集合
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// assistant 消息的类型守卫
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

// 从 assistant 消息中提取文本内容
function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];

  pi.registerFlag("plan", {
    description: "以计划模式启动（只读探索）",
    type: "boolean",
    default: false,
  });

  function updateStatus(ctx: ExtensionContext): void {
    // 底部状态
    if (executionMode && todoItems.length > 0) {
      const completed = todoItems.filter((t) => t.completed).length;
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }

    // 展示待办列表的小组件
    if (executionMode && todoItems.length > 0) {
      const lines = todoItems.map((item) => {
        if (item.completed) {
          return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text));
        }
        return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
      });
      ctx.ui.setWidget("plan-todos", lines);
    } else {
      ctx.ui.setWidget("plan-todos", undefined);
    }
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled;
    executionMode = false;
    todoItems = [];

    if (planModeEnabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
      ctx.ui.notify(`计划模式已启用。工具：${PLAN_MODE_TOOLS.join(", ")}`);
    } else {
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      ctx.ui.notify("计划模式已关闭。已恢复完整访问。");
    }
    updateStatus(ctx);
  }

  function persistState(): void {
    pi.appendEntry("plan-mode", {
      enabled: planModeEnabled,
      todos: todoItems,
      executing: executionMode,
    });
  }

  pi.registerCommand("plan", {
    description: "切换计划模式（只读探索）",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("todos", {
    description: "显示当前计划待办列表",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("当前没有待办。先用 /plan 制定计划。", "info");
        return;
      }
      const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
      ctx.ui.notify(`计划进度：\n${list}`, "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "切换计划模式",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // 在计划模式中阻止破坏性 bash 命令
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return;

    const command = event.input.command as string;
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `计划模式：命令已阻止（不在白名单中）。请先用 /plan 关闭计划模式。\n命令：${command}`,
      };
    }
  });

  // 不在计划模式时，过滤过期的计划模式上下文
  pi.on("context", async (event) => {
    if (planModeEnabled) return;

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType === "plan-mode-context") return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (typeof content === "string") {
          return !content.includes("[PLAN MODE ACTIVE]");
        }
        if (Array.isArray(content)) {
          return !content.some((c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"));
        }
        return true;
      }),
    };
  });

  // 在 agent 启动前注入计划/执行上下文
  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[PLAN MODE ACTIVE]
你当前处于计划模式，这是一种用于安全代码分析的只读探索模式。

限制：
- 你只能使用：read、bash、grep、find、ls、questionnaire
- 你不能使用：edit、write（文件修改已禁用）
- Bash 仅允许白名单中的只读命令

使用 questionnaire 工具提出澄清问题。
如需网页检索，可通过 bash 使用 brave-search skill。

请在 "Plan:" 标题下创建一份详细的编号计划：

Plan:
1. 第一步描述
2. 第二步描述
...

不要尝试做出修改，只描述你将会怎么做。`,
          display: false,
        },
      };
    }

    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((t) => !t.completed);
      const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN - Full tool access enabled]

剩余步骤：
${todoList}

请按顺序执行每一步。
每完成一步，都在回复中包含一个 [DONE:n] 标记。`,
          display: false,
        },
      };
    }
  });

  // 在每一轮结束后跟踪进度
  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, todoItems) > 0) {
      updateStatus(ctx);
    }
    persistState();
  });

  // 处理计划完成和计划模式 UI
  pi.on("agent_end", async (event, ctx) => {
    // 检查执行是否完成
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((t) => t.completed)) {
        const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
        pi.sendMessage(
          {
            customType: "plan-complete",
            content: `**计划已完成！** ✓\n\n${completedList}`,
            display: true,
          },
          { triggerTurn: false },
        );
        executionMode = false;
        todoItems = [];
        pi.setActiveTools(NORMAL_MODE_TOOLS);
        updateStatus(ctx);
        persistState(); // 保存已清空状态，避免恢复时带回旧的执行模式
      }
      return;
    }

    if (!planModeEnabled || !ctx.hasUI) return;

    // 从最后一条 assistant 消息中提取待办
    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractTodoItems(getTextContent(lastAssistant));
      if (extracted.length > 0) {
        todoItems = extracted;
      }
    }

    // 展示计划步骤并询问下一步操作
    if (todoItems.length > 0) {
      const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
      pi.sendMessage(
        {
          customType: "plan-todo-list",
          content: `**计划步骤（${todoItems.length}）：**\n\n${todoListText}`,
          display: true,
        },
        { triggerTurn: false },
      );
    }

    const choice = await ctx.ui.select("计划模式：下一步做什么？", [
      todoItems.length > 0 ? "执行计划（跟踪进度）" : "执行计划",
      "继续停留在计划模式",
      "细化计划",
    ]);

    if (choice?.startsWith("执行计划")) {
      planModeEnabled = false;
      executionMode = todoItems.length > 0;
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      updateStatus(ctx);

      const execMessage = todoItems.length > 0 ? `执行计划。先从这里开始：${todoItems[0].text}` : "执行你刚刚创建的计划。";
      pi.sendMessage(
        {
          customType: "plan-mode-execute",
          content: execMessage,
          display: true,
        },
        { triggerTurn: true },
      );
    } else if (choice === "细化计划") {
      const refinement = await ctx.ui.editor("细化计划：", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim());
      }
    }
  });

  // 在会话开始/恢复时恢复状态
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries();

    // 恢复持久化状态
    const planModeEntry = entries.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode").pop() as
      | { data?: { enabled: boolean; todos?: TodoItem[]; executing?: boolean } }
      | undefined;

    if (planModeEntry?.data) {
      planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
      todoItems = planModeEntry.data.todos ?? todoItems;
      executionMode = planModeEntry.data.executing ?? executionMode;
    }

    // 恢复时：重新扫描消息以重建完成状态
    // 只扫描最后一次 "plan-mode-execute" 之后的消息，避免捡到旧计划中的 [DONE:n]
    const isResume = planModeEntry !== undefined;
    if (isResume && executionMode && todoItems.length > 0) {
      // 找到最后一个 plan-mode-execute 条目的索引（表示当前执行开始的位置）
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; customType?: string };
        if (entry.customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }

      // 只扫描执行标记之后的消息
      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
          messages.push(entry.message as AssistantMessage);
        }
      }
      const allText = messages.map(getTextContent).join("\n");
      markCompletedSteps(allText, todoItems);
    }

    if (planModeEnabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
    }
    updateStatus(ctx);
  });
}
