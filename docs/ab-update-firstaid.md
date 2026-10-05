# A/B 更新急救卡

> 一分钟版：图形界面起不来就 `make ab-rollback COMPONENT=gui`；
> 审核判定不对劲就 `make ab-rollback COMPONENT=audit` 再 `/reload`。
> 忘了有哪些命令就跑 `make help`（那是稳定入口，命令名不会漂）。
> 来龙去脉在 `docs/plans/2026-10-05-ab-update.md`，这里只讲怎么止血。

## 现在在跑哪一版

```sh
make ab-status
```

打印两个组件（gui / audit）、四个槽（stable / previous / dev / head）、current 指向谁、
连续干净与连续失败的计数、以及"够不够晋升"的判定。

## 出事了，先止血

| 症状 | 一步 |
|---|---|
| 图形界面起不来、反复崩 | `make ab-rollback COMPONENT=gui` |
| 审核判定明显不对劲（全拒、全放、老是超时） | `make ab-rollback COMPONENT=audit`，然后 `/reload` |
| 不知道坏在哪一步 | `make ab-log COMPONENT=audit` 看流水 |

回退最终落到 `bin/ab-rollback`：一段**纯 shell**，不依赖 node、不依赖 Electron、不依赖任何扩展。
Electron 完全起不来时它也能用（这就是它为什么故意写得这么笨）；`make ab-rollback` 只是给它套了个名字。

## 图形界面全废时的兜底通道

1. **TUI**：闸门有 TUI 面板（不依赖 GUI 进程）
2. **IM**：飞书适配器接审批，本机窗答不了时它会接手

## 现场在哪

```
~/.pi/runtime/<组件>/crash/<时间戳>/   scene.json + request.json + stderr.txt（最近十份）
~/.pi/runtime/<组件>/notice.txt        晋升/回退/协议不匹配的提示（会话启动时读走并清空）
~/.pi/runtime/<组件>/promote.log       晋升、回退、看门狗、每次计数的流水
~/.pi/runtime/<组件>/streak.json       连续干净与连续失败的计数
```

## 两个组件，别混

`gui` 与 `audit` 是两套独立的两槽，**命令必须显式说动哪一个**。这是故意的：

- `gui` 坏了你立刻看得见（窗口打不开）
- `audit` 坏了是**静默的**（每次审计都超时、都拒绝，或者悄悄放行，界面看着还正常）

所以最危险的误操作是：看到窗口不对，顺手退了一把 `audit` ——窗口一点没变，还悄悄换掉了一个
你以为没动的版本。Makefile 因此**不给 COMPONENT 默认值**，缺了就报错并列出两个名字
（`make ab-status` 是读类命令，例外：它两个都列）。别"顺手"把默认值加回去。

## 三个容易误判的点

1. **引擎是"运行时目录存在才生效"**：`~/.pi/runtime/audit` 不在，等于整套没启用，一切照旧走仓库那份
2. **`current` 没设置或指不到，不是故障**：壳会老老实实用仓库实现，这是设计好的退路
3. **`notice.txt` 看起来空的，多半已经被读走了**：会话启动读一次并清空（`--print` 模式下那行提示在 TUI 里）

## 回到开发态

```sh
make ab-switch SLOT=dev          # 指向 dev 槽
rm ~/.pi/runtime/audit/current   # 或者干脆删掉 current：等于用仓库那份
```

## 别做

- **别删 previous**：它是唯一的回退目标，`bin/ab-rollback` 靠它救命
- **别手工把 current 指向不存在的目录**：壳会退回仓库（不至于坏），但状态会变得难读
- **别往仓库提交构建产物**：槽里的东西是从 git ref 算出来的，不进 git

## 常用动作

```sh
make ab-pack                    # 从 HEAD 构建到 dev（改完先提交再打包，否则槽里是上一版）
make ab-switch                  # 指到 dev
make ab-note OUTCOME=clean      # 手工记一次干净往返（平时闸门会自动记）
make ab-promote                 # 手工晋升；攒够五次干净会自动晋升
make smoke                      # 壳的三条路径灰盒验收（会起真 pi）
```

## 想改动这一套本身

- 设计稿：`docs/plans/2026-10-05-ab-update.md`（含前置检查、入口清单、灰盒验收 recipe）
- 壳的实现在 `lib/ab-shell.ts`；槽位规则 `lib/ab-slots.ts`；动盘 `lib/ab-store.ts`（CLI 与 pi 侧共用）
- 改完跑：`node --test --experimental-strip-types lib/ab-*.test.ts scripts/ab-*.test.ts`（分批跑，别一次全上）
