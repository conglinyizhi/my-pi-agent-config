import assert from "node:assert/strict";
import test from "node:test";
import { buildSubagentEnv, sanitizeWorkerEnv } from "./subagent-run.ts";

test("worker environment drops credentials and unrelated host variables", () => {
  const clean = sanitizeWorkerEnv({
    PATH: "/usr/bin",
    HOME: "/home/test",
    OPENAI_API_KEY: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    HTTP_PROXY: "http://proxy.invalid",
    PI_SUBAGENT: "host-value",
  });
  assert.deepStrictEqual(clean, { PATH: "/usr/bin", HOME: "/home/test" });
});

test("worker environment adds isolation markers after sanitization", () => {
  const env = buildSubagentEnv(
    { PATH: "/usr/bin", API_TOKEN: "secret" },
    { readonly: true, taskId: "task-1", capabilityRequestPath: "/tmp/request.json", capabilityResponsePath: "/tmp/response.json" },
  );
  assert.equal(env.PI_SUBAGENT, "1");
  assert.equal(env.PI_SANDBOX_READONLY, "1");
  assert.equal(env.PI_TASK_ID, "task-1");
  assert.equal(env.PI_SUBAGENT_CAPABILITY_REQUEST, "/tmp/request.json");
  assert.equal(env.PI_SUBAGENT_CAPABILITY_RESPONSE, "/tmp/response.json");
  assert.equal(env.API_TOKEN, undefined);
});
