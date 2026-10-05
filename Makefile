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

# A/B 更新的可配项：make ab-pack COMPONENT=audit SLOT=head REF=v1.2.0
#
# COMPONENT **刻意不给默认值**：gui 与 audit 是一对最容易混的东西
# （一个坏了看得见，一个坏了是静默的），省一次敲键盘换来的可能是退错对象。
# 读类命令（ab-status）不需要它，会两个都列。
SLOT ?= dev
REF ?= HEAD
RT ?= $(HOME)/.pi/runtime

.DEFAULT_GOAL := help
.PHONY: help check test test-ab test-ptc test-sandbox test-gui test-lib \
        require-component ab-status ab-pack ab-bootstrap ab-switch ab-rollback ab-detach ab-promote ab-log ab-note ab-health ab-firstaid \
        gui-canary smoke

help: ## 列出所有目标
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN { FS = ":.*?## " } { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }'

# ── A/B 更新（症状与止血见 docs/ab-update-firstaid.md） ──

require-component:
	@test -n "$(COMPONENT)" || { \
		printf '要动哪个组件？二选一（不给默认是故意的，这两个最容易混）：\n'; \
		printf '  COMPONENT=gui    图形界面：坏了你立刻看得见\n'; \
		printf '  COMPONENT=audit  审核链：坏了是静默的\n'; \
		exit 2; \
	}

ab-status: ## 两条产线各挂哪个 tag，带干净/失败计数（读类，不用给组件名）
	@for c in gui audit; do \
		printf '[%s] ' "$$c"; \
		bin/ab.sh status --component $$c --runtime-root $(RT) | tr '\n' ' '; \
		echo; \
	done

ab-tag: require-component ## 看这条产线挂在哪个 tag（必给 COMPONENT）
	bin/ab.sh status --component $(COMPONENT) --runtime-root $(RT)

ab-update: require-component ## 打一版：FORCE=1 直接生效，否则挂候选等 5 次干净往返
	@bin/ab.sh update --component $(COMPONENT) --ref $(REF) --runtime-root $(RT) $(if $(FORCE),--force,)

ab-clean: require-component ## 记一次干净授权往返；攒满 5 次自动切到候选
	@bin/ab.sh clean --component $(COMPONENT) --runtime-root $(RT)

ab-rollback: require-component ## 退回 prev-tag（应急止血）
	@bin/ab.sh rollback --component $(COMPONENT) --runtime-root $(RT)

ab-log: require-component ## 看流水：切换、回退、干净与失败计数（必给 COMPONENT）
	@tail -n 30 "$(RT)/$(COMPONENT)/promote.log"

ab-firstaid: ## 打印急救卡
	@cat docs/ab-update-firstaid.md

# ── 检查 ──

check: ## 类型检查（tsc --noEmit）
	node_modules/.bin/tsc --noEmit -p tsconfig.json

# 测试分组跑：一次塞太多会撞沙箱 1 GiB 内存墙（这是实测过的教训，别合并）

test-ab: ## A/B 引擎、槽位、壳、能力探测
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

smoke: ## 壳的三条路径真验（会起真 pi、会花一次极小的模型调用）
	scripts/ab-smoke.sh
