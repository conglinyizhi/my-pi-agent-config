// tools-schema.test.ts — 验证 update_goal 各 action 的参数边界

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { UPDATE_PARAMETERS } from "./tools.ts";

describe("update_goal 参数 schema", () => {
	it("complete 只接受公共字段，不接受编辑字段", () => {
		assert.equal(Value.Check(UPDATE_PARAMETERS, { goal_id: "goal", revision: 1, action: "complete" }), true);
		assert.equal(Value.Check(UPDATE_PARAMETERS, {
			goal_id: "goal",
			revision: 1,
			action: "complete",
			objective: "不应出现",
		}), false);
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
			blocked_reason: "不应出现",
		}), false);
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
