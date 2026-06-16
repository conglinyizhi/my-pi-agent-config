import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Regression test for task-notification extension.
 *
 * Bug: the extension originally hooked `turn_end`, which fires after every
 * assistant reply turn. Multi-turn tasks therefore produced one desktop
 * notification per turn, spamming the user with identical "任务完成" toasts.
 *
 * Expected behavior: task-completion notification is sent exactly once, when
 * the agent loop finishes (`agent_end`).
 */
describe("task-notification extension", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./task-notification.ts", import.meta.url)),
    "utf-8",
  );

  // Extract each `pi.on("...", ...)` handler body by splitting on the event
  // registration calls. This is intentionally simple: the file is small and
  // the bug is structural (wrong event used for completion notification).
  const handlers = source
    .split(/pi\.on\("/)
    .slice(1)
    .map((block) => {
      const eventName = block.slice(0, block.indexOf("\""));
      const body = block.slice(block.indexOf("\""));
      return { eventName, body };
    });

  it("does not send task-complete notifications on turn_end", () => {
    const turnEnd = handlers.find((h) => h.eventName === "turn_end");
    if (turnEnd) {
      assert.strictEqual(
        turnEnd.body.includes("notifyTaskComplete"),
        false,
        "turn_end handler must not send task-complete notifications",
      );
    }
  });

  it("sends a completion notification on agent_end", () => {
    const agentEnd = handlers.find((h) => h.eventName === "agent_end");
    assert(agentEnd, "expected an agent_end handler");
    assert(
      agentEnd.body.includes("notifyTaskComplete") || agentEnd.body.includes("notify("),
      "agent_end handler should send a notification",
    );
  });
});
