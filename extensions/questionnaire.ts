/**
 * 问卷工具 - 用于询问单个或多个问题的统一工具
 *
 * 单个问题：简单的选项列表
 * 多个问题：标签页导航在问题之间切换
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// 类型定义
interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
  id: string;
  label: string;
  prompt: string;
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

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// 数据结构定义
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    }),
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, {
    description: "Available options to choose from",
  }),
  allowOther: Type.Optional(
    Type.Boolean({
      description: "Allow 'Type something' option (default: true)",
    }),
  ),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "Questions to ask the user",
  }),
});

type QuestionnaireInput = Static<typeof QuestionnaireParams>;
type QuestionnaireToolResult = AgentToolResult<QuestionnaireResult>;

function errorResult(message: string, questions: Question[] = []): QuestionnaireToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

/**
 * 处理问卷交互逻辑
 */
async function handleQuestionnaire(ctx: ExtensionContext, params: QuestionnaireInput): Promise<QuestionnaireToolResult> {
  if (ctx.mode !== "tui") {
    return errorResult("Error: UI not available (running in non-interactive mode)");
  }
  if (params.questions.length === 0) {
    return errorResult("Error: No questions provided");
  }

  // 规范化问题并设置默认值
  const questions: Question[] = params.questions.map((q, i) => ({
    id: q.id,
    label: q.label || `Q${i + 1}`,
    prompt: q.prompt,
    options: q.options,
    allowOther: q.allowOther !== false,
  }));

  const isMulti = questions.length > 1;
  const totalTabs = questions.length + 1; // 问题数量 + 提交按钮

  const result = await ctx.ui.custom<QuestionnaireResult>((tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (result: QuestionnaireResult) => void) => {
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
      const q = currentQuestion();
      const opts = currentOptions();

      // 添加截断行的辅助函数
      const add = (s: string) => lines.push(truncateToWidth(s, width));

      add(theme.fg("accent", "─".repeat(width)));

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
        add(` ${tabs.join("")}`);
        lines.push("");
      }

      // 渲染选项列表的辅助函数
      function renderOptions() {
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const selected = i === optionIndex;
          const isOther = opt.isOther === true;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const color = selected ? "accent" : "text";
          // 在输入模式下标记“输入自定义内容”为不同样式
          if (isOther && inputMode) {
            add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
          } else {
            add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
          }
          if (opt.description) {
            add(`     ${theme.fg("muted", opt.description)}`);
          }
        }
      }

      // 内容
      if (inputMode && q) {
        add(theme.fg("text", ` ${q.prompt}`));
        lines.push("");
        // 显示选项作为参考
        renderOptions();
        lines.push("");
        add(theme.fg("muted", " Your answer:"));
        for (const line of editor.render(width - 2)) {
          add(` ${line}`);
        }
        lines.push("");
        add(theme.fg("dim", " Enter to submit • Esc to cancel"));
      } else if (currentTab === questions.length) {
        add(theme.fg("accent", theme.bold(" Ready to submit")));
        lines.push("");
        for (const question of questions) {
          const answer = answers.get(question.id);
          if (answer) {
            const prefix = answer.wasCustom ? "(wrote) " : "";
            add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`);
          }
        }
        lines.push("");
        if (allAnswered()) {
          add(theme.fg("success", " Press Enter to submit"));
        } else {
          const missing = questions
            .filter((q) => !answers.has(q.id))
            .map((q) => q.label)
            .join(", ");
          add(theme.fg("warning", ` Unanswered: ${missing}`));
        }
      } else if (q) {
        add(theme.fg("text", ` ${q.prompt}`));
        lines.push("");
        renderOptions();
      }

      lines.push("");
      if (!inputMode) {
        const help = isMulti ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" : " ↑↓ navigate • Enter select • Esc cancel";
        add(theme.fg("dim", help));
      }
      add(theme.fg("accent", "─".repeat(width)));

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
      content: [{ type: "text", text: "User cancelled the questionnaire" }],
      details: result,
    };
  }

  const answerLines = result.answers.map((a: Answer) => {
    const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
    if (a.wasCustom) {
      return `${qLabel}: user wrote: ${a.label}`;
    }
    return `${qLabel}: user selected: ${a.index}. ${a.label}`;
  });

  return {
    content: [{ type: "text", text: answerLines.join("\n") }],
    details: result,
  };
}

export default function questionnaire(pi: ExtensionAPI) {
  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return handleQuestionnaire(ctx, params);
    },

    renderCall(args, theme, _context) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("questionnaire "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionnaireResult | undefined;
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
