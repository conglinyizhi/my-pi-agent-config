# pi-agent 的稳定入口
#
# 把常用动作固定成命令名，免得记一长串参数、也免得不同的人（或 agent）用不同姿势跑。
# 这里只做调度：逻辑都在 scripts/ 与 lib/ 里，那边才有测试。
#
#   make            （等于 make help，列出全部目标）
#   make check      类型检查
#   make test       全部测试（按组串行，别一次塞太多）
#
# A/B 更新相关的命令与症状处理见 docs/ab-update-firstaid.md。

SHELL := /bin/sh

# A/B 更新的可配项：make ab-update COMPONENT=gui FORCE=1
#
# 现在只有一条产线（gui）：窗口是"看得见的那一半"，换版要原子。
# 审核侧（扩展）不走 A/B——改的是仓库那份，/reload 就生效。
# COMPONENT 仍要显式给：省一次敲键盘换来的可能是退错对象。
SLOT ?= dev
REF ?= HEAD
RT ?= $(HOME)/.pi/runtime

.DEFAULT_GOAL := help
.PHONY: help check test test-ab test-ptc test-sandbox test-gui test-lib \
        require-component ab-status ab-pack ab-update ab-clean ab-rollback ab-log ab-firstaid refs-check

help: ## 列出所有目标
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN { FS = ":.*?## " } { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }'

# ── A/B 更新（症状与止血见 docs/ab-update-firstaid.md） ──

require-component:
	@test -n "$(COMPONENT)" || { \
		printf '要动哪个组件？现在只有 gui（不给默认是故意的）：\n'; \
		printf '  COMPONENT=gui  图形界面：坏了你立刻看得见\n'; \
		exit 2; \
	}

ab-status: ## 这条产线挂哪个 tag，带干净/失败计数（读类，不用给组件名）
	@bin/ab.sh status --component gui --runtime-root $(RT)

ab-tag: require-component ## 看这条产线挂在哪个 tag（必给 COMPONENT）
	bin/ab.sh status --component $(COMPONENT) --runtime-root $(RT)

ab-update: require-component ## 打一版：FORCE=1 直接生效，否则挂候选等 1 次干净往返
	@bin/ab.sh update --component $(COMPONENT) --ref $(REF) --runtime-root $(RT) $(if $(FORCE),--force,)

ab-clean: require-component ## 记一次干净授权往返；够数（现在 1 次）就自动切到候选
	@bin/ab.sh clean --component $(COMPONENT) --runtime-root $(RT)

ab-rollback: require-component ## 退回 prev-tag（应急止血）
	@bin/ab.sh rollback --component $(COMPONENT) --runtime-root $(RT)

ab-log: require-component ## 看流水：切换、回退、干净与失败计数（必给 COMPONENT）
	@tail -n 30 "$(RT)/$(COMPONENT)/promote.log"

ab-firstaid: ## 打印急救卡
	@cat docs/ab-update-firstaid.md

# ── 检查 ──

refs-check: ## 删了符号之后确认没有活引用：make refs-check SYM="flowsBridge FLOWS_CLI"
	@test -n "$(SYM)" || { printf '要给符号名：make refs-check SYM="flowsBridge"\n'; exit 2; }
	@node scripts/refs-check.mjs $(SYM)

check: ## 类型检查（tsc --noEmit）
	node_modules/.bin/tsc --noEmit -p tsconfig.json

# 测试分组跑：一次塞太多会撞沙箱 1 GiB 内存墙（这是实测过的教训，别合并）

test-ab: ## A/B 引擎、槽位与状态、能力探测
	node --test --experimental-strip-types lib/ab-*.test.ts lib/gui-spec.test.ts lib/ab-notice.test.ts scripts/ab-*.test.ts

test-ptc: ## PTC 扩展与脚本审核链
	node --test --experimental-strip-types extensions/ptc/*.test.ts lib/ptc-*.test.ts

test-sandbox: ## 沙箱扩展（23 个文件，分五批跑）
	node --test --experimental-strip-types extensions/sandbox-permissions/guard.test.ts extensions/sandbox-permissions/allow.test.ts extensions/sandbox-permissions/helpers.test.ts extensions/sandbox-permissions/session-access.test.ts extensions/sandbox-permissions/yolo.test.ts
	node --test --experimental-strip-types extensions/sandbox-permissions/rule-engine.test.ts extensions/sandbox-permissions/paths.test.ts extensions/sandbox-permissions/trusted.test.ts extensions/sandbox-permissions/render.test.ts
	node --test --experimental-strip-types extensions/sandbox-permissions/review-settings.test.ts extensions/sandbox-permissions/review-gui.test.ts extensions/sandbox-permissions/review-command.test.ts extensions/sandbox-permissions/review-dimensions.test.ts extensions/sandbox-permissions/review-classifier.test.ts
	node --test --experimental-strip-types extensions/sandbox-permissions/subagent-bash-guard.test.ts extensions/sandbox-permissions/network-policy.test.ts extensions/sandbox-permissions/network-command.test.ts extensions/sandbox-permissions/workspace-command.test.ts extensions/sandbox-permissions/paths-command.test.ts extensions/sandbox-permissions/inline-script.test.ts extensions/sandbox-permissions/classifier-client.test.ts extensions/sandbox-permissions/classifier-key.test.ts extensions/sandbox-permissions/paths-config.test.ts
	node --test --experimental-strip-types extensions/sandbox-permissions/llm-review.test.ts

test-gui: ## GUI 前端域逻辑与 Electron 侧模块
	cd gui/frontend && node --test src/domain/gate/*.test.js src/domain/review/*.test.js
	node --test gui/electron/*.test.mjs

test-lib: ## lib 下其余测试（文件多，撞内存墙就再拆一组）
	node --test --experimental-strip-types lib/subagent-*.test.ts lib/bash-approval.test.ts lib/review-settings.test.ts lib/text-diff.test.ts lib/script-changes.test.ts lib/script-format.test.ts

test: test-ab test-ptc test-sandbox test-gui test-lib ## 全部测试（按组串行）
