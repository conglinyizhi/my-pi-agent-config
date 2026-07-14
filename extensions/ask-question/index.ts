// ask_question：LLM 向用户发起结构化提问（对齐 HF 社区 ASK_QUESTION 动作命名）

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { notifyQuestion } from "../../lib/notify-send";

interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
  id: string;
  label: string;
  /** 完整问题文本（对齐 HF 数据集 question_text 语义） */
  question_text: string;
  options: QuestionOption[];
  allowOther: boolean;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface AskQuestionResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// 数据结构定义
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "Value returned when this option is selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below the label" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    }),
  ),
  question_text: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, {
    minItems: 1,
    description: "Selectable options (at least one). Prefer 2–6 concise choices.",
  }),
  allowOther: Type.Optional(
    Type.Boolean({
      description: "Allow free-form 'Type something' option (default: true)",
    }),
  ),
});

const AskQuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    description: "One or more questions to ask the user",
  }),
});

type AskQuestionInput = Static<typeof AskQuestionParams>;
type AskQuestionToolResult = AgentToolResult<AskQuestionResult>;

function errorResult(message: string, questions: Question[] = []): AskQuestionToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

/**
 * 处理提问交互逻辑
 */
async function handleAskQuestion(ctx: ExtensionContext, params: AskQuestionInput): Promise<AskQuestionToolResult> {
  if (ctx.mode !== "tui") {
    return errorResult("Error: UI not available (running in non-interactive mode)");
  }
  if (params.questions.length === 0) {
    return errorResult("Error: No questions provided");
  }

  // 发送通知：有问题需要用户回答（异步，不阻塞主程序）
  const questionSummary =
    params.questions.length === 1 ? params.questions[0].question_text : `${params.questions.length} 个问题需要回答`;
  notifyQuestion(questionSummary).catch(() => {
    ctx.ui.notify("通知发送失败，请检查系统通知工具是否安装", "warning");
  });

  // 规范化问题并设置默认值
  const questions: Question[] = params.questions.map((q, i) => ({
    id: q.id,
    label: q.label || `Q${i + 1}`,
    question_text: q.question_text,
    options: q.options,
    allowOther: q.allowOther !== false,
  }));

  const isMulti = questions.length > 1;
  const totalTabs = questions.length + 1; // 问题数量 + 提交按钮

  const result = await ctx.ui.custom<AskQuestionResult>((tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (result: AskQuestionResult) => void) => {
    // 状态变量
    let currentTab = 0;
    let optionIndex = 0;
    let inputMode = false;
    let inputQuestionId: string | null = null;
    let cachedLines: string[] | undefined;
    const answers = new Map<string, Answer>();

    // 用于“输入自定义内容”选项的编辑器
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);

    // 辅助函数
    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function submit(cancelled: boolean) {
      done({ questions, answers: Array.from(answers.values()), cancelled });
    }

    function currentQuestion(): Question | undefined {
      return questions[currentTab];
    }

    function currentOptions(): RenderOption[] {
      const q = currentQuestion();
      if (!q) return [];
      const opts: RenderOption[] = [...q.options];
      if (q.allowOther) {
        opts.push({
          value: "__other__",
          label: "Type something.",
          isOther: true,
        });
      }
      return opts;
    }

    function allAnswered(): boolean {
      return questions.every((q) => answers.has(q.id));
    }

    function advanceAfterAnswer() {
      if (!isMulti) {
        submit(false);
        return;
      }
      if (currentTab < questions.length - 1) {
        currentTab++;
      } else {
        currentTab = questions.length; // 提交标签页
      }
      optionIndex = 0;
      refresh();
    }

    function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
      answers.set(questionId, {
        id: questionId,
        value,
        label,
        wasCustom,
        index,
      });
    }

    // 编辑器提交回调
    editor.onSubmit = (value) => {
      if (!inputQuestionId) return;
      const trimmed = value.trim() || "(no response)";
      saveAnswer(inputQuestionId, trimmed, trimmed, true);
      inputMode = false;
      inputQuestionId = null;
      editor.setText("");
      advanceAfterAnswer();
    };

    function handleInput(data: string) {
      // 输入模式：路由到编辑器
      if (inputMode) {
        if (matchesKey(data, Key.escape)) {
          inputMode = false;
          inputQuestionId = null;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      const q = currentQuestion();
      const opts = currentOptions();

      // 标签页导航（仅多问题模式）
      if (isMulti) {
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          currentTab = (currentTab + 1) % totalTabs;
          optionIndex = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          currentTab = (currentTab - 1 + totalTabs) % totalTabs;
          optionIndex = 0;
          refresh();
          return;
        }
      }

      // 提交标签页
      if (currentTab === questions.length) {
        if (matchesKey(data, Key.enter) && allAnswered()) {
          submit(false);
        } else if (matchesKey(data, Key.escape)) {
          submit(true);
        }
        return;
      }

      // 选项导航
      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(opts.length - 1, optionIndex + 1);
        refresh();
        return;
      }

      // 选择选项
      if (matchesKey(data, Key.enter) && q) {
        const opt = opts[optionIndex];
        if (opt.isOther) {
          inputMode = true;
          inputQuestionId = q.id;
          editor.setText("");
          refresh();
          return;
        }
        saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
        advanceAfterAnswer();
        return;
      }

      // 取消
      if (matchesKey(data, Key.escape)) {
        submit(true);
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      // 终端宽度至少为 1，避免 0 宽导致 wrap 异常
      const renderWidth = Math.max(1, width);
      const q = currentQuestion();
      const opts = currentOptions();

      // 按可见列宽折行，正确处理 ANSI 颜色码与宽字符（中文等）
      function addWrapped(text: string) {
        lines.push(...wrapTextWithAnsi(text, renderWidth));
      }

      // 带前缀折行：首行保留前缀，续行用等宽空白对齐
      function addWrappedWithPrefix(prefix: string, text: string) {
        const prefixWidth = visibleWidth(prefix);
        if (prefixWidth >= renderWidth) {
          addWrapped(prefix + text);
          return;
        }
        const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
        const continuationPrefix = " ".repeat(prefixWidth);
        for (let i = 0; i < wrapped.length; i++) {
          lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
        }
      }

      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      // 标签页栏（仅多问题模式）
      if (isMulti) {
        const tabs: string[] = ["← "];
        for (let i = 0; i < questions.length; i++) {
          const isActive = i === currentTab;
          const isAnswered = answers.has(questions[i].id);
          const lbl = questions[i].label;
          const box = isAnswered ? "■" : "□";
          const color = isAnswered ? "success" : "muted";
          const text = ` ${box} ${lbl} `;
          const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
          tabs.push(`${styled} `);
        }
        const canSubmit = allAnswered();
        const isSubmitTab = currentTab === questions.length;
        const submitText = " ✓ Submit ";
        const submitStyled = isSubmitTab ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(canSubmit ? "success" : "dim", submitText);
        tabs.push(`${submitStyled} →`);
        addWrappedWithPrefix(" ", tabs.join(""));
        lines.push("");
      }

      // 渲染选项列表的辅助函数
      function renderOptions() {
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const selected = i === optionIndex;
          const isOther = opt.isOther === true;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
          const color = selected || (isOther && inputMode) ? "accent" : "text";

          addWrappedWithPrefix(prefix, theme.fg(color, label));
          if (opt.description) {
            addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
          }
        }
      }

      // 内容
      if (inputMode && q) {
        addWrappedWithPrefix(" ", theme.fg("text", q.question_text));
        lines.push("");
        // 显示选项作为参考
        renderOptions();
        lines.push("");
        addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
        for (const line of editor.render(Math.max(1, renderWidth - 2))) {
          // 编辑器行本身已按宽度渲染，这里只加左缩进并做兜底截断
          lines.push(truncateToWidth(` ${line}`, renderWidth));
        }
        lines.push("");
        addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
      } else if (currentTab === questions.length) {
        addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
        lines.push("");
        for (const question of questions) {
          const answer = answers.get(question.id);
          if (answer) {
            const prefix = answer.wasCustom ? "(wrote) " : "";
            const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
            addWrappedWithPrefix(" ", summary);
          }
        }
        lines.push("");
        if (allAnswered()) {
          addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
        } else {
          const missing = questions
            .filter((q) => !answers.has(q.id))
            .map((q) => q.label)
            .join(", ");
          addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
        }
      } else if (q) {
        addWrappedWithPrefix(" ", theme.fg("text", q.question_text));
        lines.push("");
        renderOptions();
      }

      lines.push("");
      if (!inputMode) {
        const help = isMulti ? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" : "↑↓ navigate • Enter select • Esc cancel";
        addWrappedWithPrefix(" ", theme.fg("dim", help));
      }
      lines.push(theme.fg("accent", "─".repeat(renderWidth)));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });

  if (result.cancelled) {
    return {
      content: [{ type: "text", text: "User cancelled the question" }],
      details: result,
    };
  }

  // 结果带回完整问题文本，便于事后在对话流中回看
  const answerLines = result.answers.map((a: Answer) => {
    const q = questions.find((qq) => qq.id === a.id);
    const qLabel = q?.label || a.id;
    const qText = q?.question_text ? ` — ${q.question_text}` : "";
    if (a.wasCustom) {
      return `${qLabel}${qText}\n  → user wrote: ${a.label}`;
    }
    return `${qLabel}${qText}\n  → user selected: ${a.index}. ${a.label}`;
  });
  return {
    content: [{ type: "text", text: answerLines.join("\n") }],
    details: result,
  };
}

export default function askQuestion(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_question",
    label: "Ask Question",
    description:
      "Ask the user one or more structured questions with selectable options. Use for clarifying requirements, getting preferences, or confirming decisions. Single question: simple option list. Multiple questions: tab-based interface. Prefer concise options; set allowOther when free-form input may be needed.",
    parameters: AskQuestionParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return handleAskQuestion(ctx, params);
    },

    renderCall(args, theme, _context) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const first = qs[0];
      const preview = first ? truncateToWidth(first.question_text, 60) : "";
      let text = theme.fg("toolTitle", theme.bold("ask_question "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (preview) {
        text += theme.fg("dim", `: "${preview}"`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskQuestionResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        if (a.wasCustom) {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
