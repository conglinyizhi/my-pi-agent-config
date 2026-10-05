# A/B 更新急救卡

> 一分钟版：图形界面起不来就 `bin/ab-rollback gui`；审核判定不对劲就 `bin/ab-rollback audit` 再 `/reload`。
> 来龙去脉在 `docs/plans/2026-10-05-ab-update.md`，这里只讲怎么止血。

## 现在在跑哪一版

```sh
bin/ab-slot status
```

打印两个组件（gui / audit）、四个槽（stable / previous / dev / head）、current 指向谁、
连续干净与连续失败的计数、以及"够不够晋升"的判定。

## 出事了，先止血

| 症状 | 一步 |
|---|---|
| 图形界面起不来、反复崩 | `bin/ab-rollback gui` |
| 审核判定明显不对劲（全拒、全放、老是超时） | `bin/ab-rollback audit`，然后 `/reload` |
| 不知道坏在哪一步 | `bin/ab-slot log audit` 看晋升、回退、看门狗与计数的流水 |

`bin/ab-rollback` 是一段**纯 shell**：不依赖 node、不依赖 Electron、不依赖任何扩展。
Electron 完全起不来时它也能用（这就是它为什么故意写得这么笨）。

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

## 三个容易误判的点

1. **引擎是"运行时目录存在才生效"**：`~/.pi/runtime/audit` 不在，等于整套没启用，一切照旧走仓库那份
2. **`current` 没设置或指不到，不是故障**：壳会老老实实用仓库实现，这是设计好的退路
3. **`notice.txt` 看起来空的，多半已经被读走了**：会话启动读一次并清空（`--print` 模式下那行提示在 TUI 里）

## 回到开发态

```sh
bin/ab-slot switch audit dev     # 指向 dev 槽
rm ~/.pi/runtime/audit/current   # 或者干脆删掉 current：等于用仓库那份
```

## 别做

- **别删 previous**：它是唯一的回退目标，`bin/ab-rollback` 靠它救命
- **别手工把 current 指向不存在的目录**：壳会退回仓库（不至于坏），但状态会变得难读
- **别往仓库提交构建产物**：槽里的东西是从 git ref 算出来的，不进 git

## 常用动作

```sh
bin/ab-pack audit --slot dev            # 从 HEAD 构建到 dev（改完先提交再打包，否则槽里是上一版）
bin/ab-slot switch audit dev            # 指到 dev
bin/ab-slot note audit clean            # 手工记一次干净往返（平时闸门会自动记）
bin/ab-slot promote audit               # 手工晋升；攒够五次干净会自动晋升
bin/ab-slot rollback audit --reason 说明  # 等价于 ab-rollback，但带一条理由进日志
```

## 想改动这一套本身

- 设计稿：`docs/plans/2026-10-05-ab-update.md`（含前置检查、入口清单、灰盒验收 recipe）
- 壳的实现在 `lib/ab-shell.ts`；槽位规则 `lib/ab-slots.ts`；动盘 `lib/ab-store.ts`（CLI 与 pi 侧共用）
- 改完跑：`node --test --experimental-strip-types lib/ab-*.test.ts scripts/ab-*.test.ts`（分批跑，别一次全上）
