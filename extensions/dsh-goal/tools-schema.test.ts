// tools-schema.test.ts — 验证 update_goal 各 action 的参数边界

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { UPDATE_PARAMETERS } from "./tools.ts";

describe("update_goal 参数 schema", () => {
	it("根节点保持 object，且 complete 的推荐最小形状可通过", () => {
		assert.equal(UPDATE_PARAMETERS.type, "object");
		assert.equal(Value.Check(UPDATE_PARAMETERS, { goal_id: "goal", revision: 1, action: "complete" }), true);
		// OpenAI function schema 只接受根 object；action 专属字段由 execute 运行时拒绝。
		assert.equal(Value.Check(UPDATE_PARAMETERS, {
			goal_id: "goal",
			revision: 1,
			action: "complete",
			objective: "运行时应拒绝",
		}), true);
	});

	it("edit、resume、blocked 各自只接受合法字段", () => {
		assert.equal(Value.Check(UPDATE_PARAMETERS, {
			goal_id: "goal",
			revision: 1,
			action: "edit",
			objective: "新目标",
			max_goal_rounds: 5,
		}), true);
		assert.equal(Value.Check(UPDATE_PARAMETERS, {
			goal_id: "goal",
			revision: 1,
			action: "resume",
		}), true);
		assert.equal(Value.Check(UPDATE_PARAMETERS, {
			goal_id: "goal",
			revision: 1,
			action: "resume",
			blocked_reason: "运行时应拒绝",
		}), true);
		assert.equal(Value.Check(UPDATE_PARAMETERS, {
			goal_id: "goal",
			revision: 1,
			action: "blocked",
			blocked_reason: "持续阻塞",
		}), true);
		assert.equal(Value.Check(UPDATE_PARAMETERS, {
			goal_id: "goal",
			revision: 1,
			action: "blocked",
		}), false);
	});
});
