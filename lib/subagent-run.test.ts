// subagent-run.test.ts — runSubagent 参数构造与最终输出提取行为测试
//
// 背景：worker 子进程需要显式加载 custom-providers 扩展（providers.toml 的动态模型），
// 同时保持隔离（--no-extensions 等）；反馈模式下 --tools 白名单只放 read/bash/be-*。
//
// 跑法：node --experimental-strip-types lib/subagent-run.test.ts

import assert from "node:assert";
import { describe, it } from "node:test";
import { buildSubagentArgs, extractAgentEndOutput } from "./subagent-run.ts";

describe("buildSubagentArgs", () => {
  const base = { task: "t", cwd: "/tmp", model: "m" };

  it("启用 custom-providers 扩展并禁用扩展发现", () => {
    const args = buildSubagentArgs(base);
    assert(args.includes("--no-extensions"));
    const extIdx = args.indexOf("--extension");
    assert(extIdx !== -1);
    assert(args[extIdx + 1].includes("custom-providers"));
    assert(args.includes("--no-session"));
    assert(args.includes("--no-skills"));
    assert(args.includes("--no-prompt-templates"));
    assert(args.includes("--no-context-files"));
    assert(args.includes("--mcp-config"));
  });

  it("tools 白名单拼成逗号分隔精确名单", () => {
    const args = buildSubagentArgs({ ...base, tools: ["read", "bash", "be-read", "be-replace"] });
    const idx = args.indexOf("--tools");
    assert(idx !== -1);
    assert.strictEqual(args[idx + 1], "read,bash,be-read,be-replace");
  });

  it("extraExtensions 逐个显式加载", () => {
    const args = buildSubagentArgs({ ...base, extraExtensions: ["/ext/be-error-recorder/index.ts"] });
    const extIdxs: number[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--extension") extIdxs.push(i + 1);
    assert(extIdxs.length >= 2);
    assert(extIdxs.some((i) => args[i].includes("be-error-recorder")));
  });

  it("无 tools 时不传 --tools", () => {
    const args = buildSubagentArgs(base);
    assert(!args.includes("--tools"));
  });

  it("保留提示词与任务注入参数", () => {
    const args = buildSubagentArgs({ ...base, promptPath: "/tmp/prompt.md" });
    assert(args.includes("--append-system-prompt"));
    const idx = args.indexOf("--append-system-prompt");
    assert.strictEqual(args[idx + 1], "/tmp/prompt.md");
    assert(args.some((a) => a === "任务：t"));
  });
});

describe("extractAgentEndOutput", () => {
  it("从 agent_end 的 messages 数组提取最终文本", () => {
    const out = extractAgentEndOutput(JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "完成。" }] },
      ],
    }));
    assert.strictEqual(out, "完成。");
  });

  it("无有效输出返回空串", () => {
    assert.strictEqual(extractAgentEndOutput(JSON.stringify({ type: "agent_end", messages: [] })), "");
    assert.strictEqual(extractAgentEndOutput("not json"), "");
  });
});
