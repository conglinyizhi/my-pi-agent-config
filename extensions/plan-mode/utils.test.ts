// utils.test.ts — plan-mode 步骤提取/完成标记（统一 Step 形状后）
// 跑法：node --experimental-strip-types extensions/plan-mode/utils.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractTodoItems, markCompletedSteps } from "./utils.ts";
import type { Step } from "../../lib/todo-store.ts";

describe("extractTodoItems（→ 统一 Step 形状）", () => {
  it("解析 Plan: 编号列表 → content + pending", () => {
    const items = extractTodoItems("Plan:\n1. 读取相关源代码\n2. 修改目标配置文件\n");
    assert.deepEqual(items, [
      { content: "读取相关源代码", status: "pending" },
      { content: "修改目标配置文件", status: "pending" },
    ]);
  });

  it("无 Plan: 头返回空列表", () => {
    assert.deepEqual(extractTodoItems("随便说点什么"), []);
  });
});

describe("markCompletedSteps（[DONE:n] → 下标 n-1）", () => {
  it("按编号标记对应下标", () => {
    const steps: Step[] = [
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
      { content: "c", status: "pending" },
    ];
    const n = markCompletedSteps("第 2 步完成 [DONE:2]", steps);
    assert.equal(n, 1);
    assert.deepEqual(steps.map((s) => s.status), ["pending", "completed", "pending"]);
  });

  it("越界编号忽略且不误标", () => {
    const steps: Step[] = [{ content: "a", status: "pending" }];
    const n = markCompletedSteps("[DONE:9]", steps);
    assert.equal(n, 1);
    assert.equal(steps[0].status, "pending");
  });
});
