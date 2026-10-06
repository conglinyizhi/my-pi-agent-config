---
name: ab-update
description: A/B 更新的操作手册：一条产线一个 tag、切 tag、回退、攒够干净往返自动切、金丝雀与看门狗、"改了没生效"的排查。当任务涉及 A/B 更新、换版本、回退回滚、自动晋升、ab-tag / ab-update / ab-clean / ab-rollback 时加载。
---

# A/B 更新

把「跑哪一版」和「写哪一版」分开：仓库是你写代码的地方，槽是跑的地方。

## 一条产品线一个 tag

四槽模型（stable/previous/dev/head + `current` 软链）**已经删掉了**——它才是
「到底在跑哪一份、计数为什么总是 0」说不清的根源。现在只有：

```sh
make ab-status                          # 这条产线挂哪个 tag，带干净/失败计数
make ab-tag COMPONENT=gui               # 只看一条
make ab-update COMPONENT=gui FORCE=1    # 强制：打完直接生效
make ab-update COMPONENT=gui            # 打完先起一次金丝雀，过了才挂候选（FORCE=1 越过）
make ab-clean COMPONENT=gui             # 每次干净授权往返记一笔（看门狗会调）
make ab-rollback COMPONENT=gui          # 退回 prev-tag
make ab-log COMPONENT=gui               # 看流水
```

状态就五样：`tag` / `prev-tag` / `candidate` / `dir` / `count`，外加 `promote.log` 流水
与 `notice.txt`（槽加载失败时留给下个会话的提示）。壳只在 `tag` 指向的产物里跑；
**要回仓库那份就删掉 `tag`**（`rm ~/.pi/runtime/gui/tag`，下次起窗生效）。

**"干净往返"的定义**：窗口给出结论就算——允许、拒绝都算。与判断内容无关，
只有叉掉窗口、超时、起不来才算失败。

## 历史：四类槽（已删，留作对照）

- **组件**：`audit`（审核侧：pi 的扩展与 lib）与 `gui`（窗口产物）。两者坏起来一个静默一个看得见，
  所以**命令必须显式指名组件**，谁也别给默认值
- **槽**：`stable`（基线）、`previous`（上一个基线，回退的落点）、`dev`（开发中那版）、`head`（未验证）
- **current**：软链，指向当前生效的槽；没有它就用仓库那份

```
~/.pi/runtime/<组件>/{stable,previous,dev,head}/  + current 软链 + manifest.json
                      + promote.log + streak.json + notice.txt + crash/<时间戳>/
```

## 只有 gui 一条产线

`AB_COMPONENTS` 现在只有 `gui`。审核侧（pi 的扩展与 lib）**不走 A/B**：
改仓库里那份，`/reload` 即生效，不用打包也不用切 tag。
但命令仍要求显式给 `COMPONENT`——默认值被刻意去掉，不给就是不给。

改动的生效时机不一样，这条最容易误判：

- `gui`：窗口创建时用 `file://` 加载产物 → **重开窗口**生效（开着的窗口握着旧 bundle）
- 审核侧：pi 装载扩展 → **`/reload`** 生效

## 开发态还是基线态

- 改代码时：删掉 `tag`，跑的就是仓库那份，改完即时生效，不用每次打包
- 要验证切换、回退、看门狗时：`make ab-update COMPONENT=gui FORCE=1` 重新挂一版
- 槽不会自己更新：没重打之前槽里那份还是旧的，否则会"改了没生效"

## 晋升与看门狗

- 一次干净的往返记一次；**连续**攒够 `PROMOTE_THRESHOLD`（现在 1 次）就自动把候选切为生效，
  旧的生效版本落进 `prev-tag`
- 失败清零：中间任何一次失败，连胜从头数
- 连续 `FAIL_THRESHOLD`（3 次）自动回退到 `prev-tag`；三条不退：没到门槛、已经在 `prev-tag`、
  没有 `prev-tag`
- 脏工作区构建的产物不许晋升；`FORCE=1` 越过金丝雀会留痕

## 硬约束

- **别手敲安装/构建命令**：走 Makefile 与 `bin/ab.sh` 的入口，门禁与校验都在里面
- **组件名必须显式给**：脚本与命令不给默认值
- **打包要带上 node_modules 软链**，槽内入口要摊平成 `export { default } from "./impl.ts";`，
  否则槽里起不来或壳加载壳无限递归（`scripts/ab-pack.ts` 已经做掉这两件事）
- **别手改 `~/.pi/runtime/*/tag`**：那是 deploy 侧写的，手改会让"在跑哪一份"再次说不清

## 出问题先看这几处

```
~/.pi/runtime/<组件>/notice.txt     # 槽加载失败时的提示（会自动退回仓库那份）
~/.pi/runtime/<组件>/crash/         # GUI 起不来时的现场：scene.json / request.json / stderr.txt
make ab-status                       # 计数与判定：keep / promote / rollback
```

症状与一步止血看 `docs/ab-update-firstaid.md`；设计取舍看 `docs/plans/2026-10-05-ab-update.md`。
