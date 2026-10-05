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
        gui-canary smoke flows-check

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

ab-status: ## 看两个组件在跑哪一版（读类，不用给 COMPONENT）
	bin/ab-slot.sh status $(COMPONENT)

ab-pack: require-component ## 从 git ref 构建到槽（必给 COMPONENT，SLOT=dev|head）
	bin/ab-pack.sh $(COMPONENT) --ref $(REF) --slot $(SLOT) --runtime-root $(RT)

ab-bootstrap: require-component ## 自举：把当前 HEAD 同时铺成 stable 与 previous（从零开始的那条回退路）
	bin/ab-pack.sh $(COMPONENT) --ref $(REF) --slot stable --bootstrap --runtime-root $(RT)
	bin/ab-pack.sh $(COMPONENT) --ref $(REF) --slot previous --bootstrap --runtime-root $(RT)
	@printf '已自举 %s：stable 与 previous 都是 %s\n' "$(COMPONENT)" "$(REF)"

ab-switch: require-component ## 把 current 指向某个槽（必给 COMPONENT，SLOT=dev）
	bin/ab-slot.sh switch $(COMPONENT) $(SLOT) --runtime-root $(RT)

ab-rollback: require-component ## 应急回退到上一个稳定槽（必给 COMPONENT；纯 shell）
	bin/ab-rollback.sh $(COMPONENT)

ab-detach: require-component ## 摘掉 current：回到仓库版本（临时开发用，不删任何槽）
	@rm -f "$(RT)/$(COMPONENT)/current"
	@printf '已摘掉 %s 的 current：从现在起用仓库那份实现（下一次 reload 生效）\n' "$(COMPONENT)"

ab-promote: require-component ## 手工晋升 dev（必给 COMPONENT；攒够五次干净会自动晋升）
	bin/ab-slot.sh promote $(COMPONENT) --runtime-root $(RT)

flows-check: ## 检查自写的审核流程（review-flows/*.ts 的类型与形状）
	npx tsc -p review-flows

ab-health: require-component ## 自检槽：成功只清连续失败，不加晋升连胜（必给 COMPONENT）
	bin/ab-slot.sh health $(COMPONENT) --runtime-root $(RT)

ab-note: require-component ## 手工记一次往返（必给 COMPONENT，OUTCOME=clean|failure）
	bin/ab-slot.sh note $(COMPONENT) $(OUTCOME) --runtime-root $(RT)

ab-log: require-component ## 看晋升、回退、看门狗与计数的流水（必给 COMPONENT）
	bin/ab-slot.sh log $(COMPONENT) --runtime-root $(RT)

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

# ── 灰盒验收 ──

gui-canary: ## GUI 启动自检（会弹一个闸门窗，判定后自动关掉）
	scripts/gui-canary.sh

smoke: ## 壳的三条路径真验（会起真 pi、会花一次极小的模型调用）
	scripts/ab-smoke.sh
