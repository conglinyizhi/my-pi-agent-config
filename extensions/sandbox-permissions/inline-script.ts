/**
 * Strict recovery for inline Python and Node programs.
 *
 * This deliberately recognizes only one simple command. It is not a shell
 * parser: ambiguity means no extraction and no side effect.
 */

import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type InlineRuntime = "python" | "node";

export interface InlineScript {
  runtime: InlineRuntime;
  executable: string;
  code: string;
  args: string[];
}

export interface SavedInlineScript extends InlineScript {
  path: string;
}

const RUNTIMES: Record<string, { runtime: InlineRuntime; flag: string; extension: string; directory: string }> = {
  python: { runtime: "python", flag: "-c", extension: ".py", directory: "py-script" },
  python3: { runtime: "python", flag: "-c", extension: ".py", directory: "py-script" },
  node: { runtime: "node", flag: "-e", extension: ".mjs", directory: "node-script" },
  nodejs: { runtime: "node", flag: "-e", extension: ".mjs", directory: "node-script" },
};

interface Word {
  value: string;
  quoted: boolean;
}

/**
 * Parse only shell words without expansions or shell operators. This accepts
 * enough syntax for the common `python3 -c '...'` / `node -e '...'` habit.
 */
function parseLiteralWords(command: string): Word[] | null {
  const words: Word[] = [];
  let i = 0;

  const skipSpace = () => {
    while (command[i] === " " || command[i] === "\t") i++;
  };

  skipSpace();
  while (i < command.length) {
    let value = "";
    let quoted = false;
    let hasContent = false;

    while (i < command.length && command[i] !== " " && command[i] !== "\t") {
      const ch = command[i];
      if (";|&<>`$()!\n\r".includes(ch) || (ch === "#" && !hasContent)) return null;

      if (ch === "'") {
        quoted = true;
        i++;
        const end = command.indexOf("'", i);
        if (end === -1) return null;
        value += command.slice(i, end);
        hasContent = true;
        i = end + 1;
        continue;
      }

      if (ch === '"') {
        quoted = true;
        i++;
        let closed = false;
        while (i < command.length) {
          const inner = command[i];
          if (inner === '"') {
            i++;
            closed = true;
            break;
          }
          if (inner === "$" || inner === "`") return null;
          if (inner === "\\") {
            const next = command[i + 1];
            if (next === undefined || next === "\n" || next === "\r") return null;
            // In double quotes, a backslash only consumes these four forms.
            if (next === '"' || next === "\\" || next === "$" || next === "`") {
              value += next;
              i += 2;
              hasContent = true;
              continue;
            }
          }
          value += inner;
          i++;
          hasContent = true;
        }
        if (!closed) return null;
        continue;
      }

      if (ch === "\\" || "*?[]{}~".includes(ch)) return null;
      value += ch;
      i++;
      hasContent = true;
    }

    if (!hasContent) return null;
    words.push({ value, quoted });
    skipSpace();
  }

  return words;
}

/** Return an inline script only when the whole command is unambiguous. */
export function extractInlineScript(command: string): InlineScript | null {
  const words = parseLiteralWords(command);
  if (!words || words.length < 3) return null;

  const config = RUNTIMES[words[0].value];
  if (!config || words[1].value !== config.flag || !words[2].quoted) return null;

  return {
    runtime: config.runtime,
    executable: words[0].value,
    code: words[2].value,
    args: words.slice(3).map((word) => word.value),
  };
}

/** Save code without executing it. The private directory is shared by runtime. */
export function saveInlineScript(script: InlineScript, tmpRoot = "/tmp"): SavedInlineScript {
  const config = RUNTIMES[script.executable];
  const directory = join(tmpRoot, config.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`临时脚本目录不可用：${directory}`);
  }
  chmodSync(directory, 0o700);

  const filePath = join(directory, `${randomUUID()}${config.extension}`);
  writeFileSync(filePath, script.code, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  chmodSync(filePath, 0o600);
  return { ...script, path: filePath };
}

function quoteForDisplay(arg: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function buildInlineScriptRejection(saved: SavedInlineScript): string {
  const runtimeLabel = saved.runtime === "python" ? "Python" : "Node.js";
  const nextCommand = [saved.executable, saved.path, ...saved.args].map(quoteForDisplay).join(" ");
  const semanticNote = saved.runtime === "python"
    ? "`python -c` 改为脚本文件后，`sys.argv[0]`、`__file__` 等运行时语义可能不同。"
    : "`node -e` 改为脚本文件后，`process.argv`、`__filename`、`__dirname` 等运行时语义可能不同。";

  return [
    `安全闸门拒绝了内联 ${runtimeLabel} 代码。请不要使用 ${saved.executable} ${saved.runtime === "python" ? "-c" : "-e"}。`,
    `代码已原样保存到：${saved.path}`,
    `请检查后改为运行：${nextCommand}`,
    semanticNote,
  ].join("\n");
}
