// 计划模式：只读探索 + 步骤追踪，安全代码分析（详见 README.md）

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.ts";
import { notifyQuestion } from "../../lib/notify-send";

// 工具集合
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "ask_question"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// 计划模式持久化状态
type PlanModeState = {
  enabled: boolean;
  todos?: TodoItem[];
  executing?: boolean;
};

type PlanModeEntry = SessionEntry & { type: "custom"; customType: "plan-mode"; data?: PlanModeState };
type PlanModeExecuteEntry = SessionEntry & { type: "custom"; customType: "plan-mode-execute" };

function isPlanModeEntry(entry: SessionEntry): entry is PlanModeEntry {
  return entry.type === "custom" && entry.customType === "plan-mode";
}

function isPlanModeExecuteEntry(entry: SessionEntry): entry is PlanModeExecuteEntry {
  return entry.type === "custom" && entry.customType === "plan-mode-execute";
}

function isPlanModeContextMessage(m: AgentMessage): m is AgentMessage & { customType: "plan-mode-context" } {
  return (m as AgentMessage & { customType?: string }).customType === "plan-mode-context";
}

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
        if (isPlanModeContextMessage(m)) return false;
        if (m.role !== "user") return true;

        const content = m.content;
        if (typeof content === "string") {
          return !content.includes("[PLAN MODE ACTIVE]");
        }
        if (Array.isArray(content)) {
          return !content.some((c) => c.type === "text" && c.text.includes("[PLAN MODE ACTIVE]"));
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
- 你只能使用：read、bash、grep、find、ls、ask_question
- 你不能使用：edit、write（文件修改已禁用）
- Bash 仅允许白名单中的只读命令

使用 ask_question 工具提出澄清问题。
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

    // 发送桌面通知提醒用户确认计划（复用 notifyQuestion，带默认完成音）
    notifyQuestion("计划已生成，请确认下一步操作。").catch(() => {});

    const choice = await ctx.ui.select("计划已生成。请选择下一步（退出后可手动输入后面指令继续操作）：", [
      todoItems.length > 0 ? "(执行计划) 跟踪进度 /plan:start" : "(执行计划) /plan:start",
      "(继续) 停留在计划模式 /plan:continue",
      "(细化) 计划 /plan:refine",
      "不做任何行动，我亲自掌舵",
    ]);

    if (choice?.includes("执行计划")) {
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
    } else if (choice?.includes("细化")) {
      const refinement = await ctx.ui.editor("细化计划：", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
    } else if (choice?.includes("亲自掌舵")) {
      // 用户选择亲自掌舵：安全退出计划模式，不触发任何后续行动
      planModeEnabled = false;
      executionMode = false;
      todoItems = [];
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      updateStatus(ctx);
      ctx.ui.notify("已退出计划模式，您现在完全掌控。", "success");
      persistState();
    }
  });

  // 在会话开始/恢复时恢复状态
  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries();

    // 恢复持久化状态
    const planModeEntry = entries.find(isPlanModeEntry);

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
        if (isPlanModeExecuteEntry(entries[i])) {
          executeIndex = i;
          break;
        }
      }

      // 只扫描执行标记之后的消息
      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type === "message" && isAssistantMessage(entry.message)) {
          messages.push(entry.message);
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
