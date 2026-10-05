---
name: ab-update
description: A/B 更新的操作手册：切换槽、回退、晋升、看门狗、打包与自举，以及"改了没生效"的排查。当任务涉及 A/B 更新、切槽切版本、回退回滚、晋升与金丝雀、ab-slot / ab-pack / ab-detach、审核侧或 GUI 换版时加载。
---

# A/B 更新

把「跑哪一版」和「写哪一版」分开：仓库是你写代码的地方，槽是跑的地方。

## 先说方向：正在从「四类槽」换成「一条产品线一个 tag」

新模型的命令（第 2 批已落地，旧的四槽还在并行、第 3 批删）：

```sh
make ab-tag COMPONENT=gui               # 这条产品线挂在哪个 tag
make ab-update COMPONENT=gui FORCE=1    # 强制：打完直接生效
make ab-update COMPONENT=gui            # 打完挂候选，攒满 5 次干净授权自动切
make ab-clean COMPONENT=gui             # 每次干净授权往返记一笔（看门狗会调）
```

状态就五样：`tag` / `prev-tag` / `candidate` / `dir` / `count`，外加 `promote.log` 流水。
一条产品线一个 tag——四槽（stable/previous/dev/head）+ `current` 软链是
「到底在跑哪一份、计数为什么总是 0」说不清的根源，正在退场。

下面这些是**旧模型的命令，第 3 批之后会消失**，现在还能用：

## 两个组件，四类槽

- **组件**：`audit`（审核侧：pi 的扩展与 lib）与 `gui`（窗口产物）。两者坏起来一个静默一个看得见，
  所以**命令必须显式指名组件**，谁也别给默认值
- **槽**：`stable`（基线）、`previous`（上一个基线，回退的落点）、`dev`（开发中那版）、`head`（未验证）
- **current**：软链，指向当前生效的槽；没有它就用仓库那份

```
~/.pi/runtime/<组件>/{stable,previous,dev,head}/  + current 软链 + manifest.json
                      + promote.log + streak.json + notice.txt + crash/<时间戳>/
```

## 日常命令（都在仓库根跑）

```
make ab-status                          # 两个组件在跑哪一版（不用给组件名）
make ab-pack COMPONENT=audit SLOT=dev   # 从仓库 HEAD 构建到槽
make ab-switch COMPONENT=audit SLOT=dev # current 指向某个槽
make ab-rollback COMPONENT=audit        # 应急回退到 previous
make ab-detach COMPONENT=audit          # 摘掉 current，回到仓库那份（开发态）
make ab-promote COMPONENT=audit         # 手工晋升（攒够五次干净会自动晋升）
make ab-note COMPONENT=audit OUTCOME=clean|failure   # 手工记一次往返
make ab-health COMPONENT=gui            # 自检：只清连续失败，不加连胜
make ab-bootstrap COMPONENT=gui         # 自举：把 HEAD 同时铺成 stable 与 previous
make ab-log COMPONENT=audit             # 晋升、回退、看门狗流水
make ab-firstaid                        # 打印急救卡
```

改动的生效时机不一样，这条最容易误判：

- `gui`：窗口创建时用 `file://` 加载产物 → **重开窗口**生效（开着的窗口握着旧 bundle）
- `audit`：pi 启动时装载扩展 → **`/reload`** 生效

## 开发态还是基线态

- 改代码时：`ab-detach`，跑的就是仓库那份，改完即时生效，不用每次打包
- 要验证切换、回退、看门狗时：`ab-switch` 回某个槽
- 槽不会自己更新：`ab-pack` 之后槽里那份才是新的，否则会"改了没生效"

## 晋升与看门狗

- 一次干净的审核往返记一次；**连续**攒够五次（阈值可调）才自动晋升 `dev → stable`，
  晋升时旧 `stable` 挪到 `previous`
- 失败清零：中间任何一次失败，连胜从头数
- **自检（`ab-health`）不进连胜**：成功只清连续失败，失败照样累进看门狗
- 连续失败三次自动回退；三条不退：没到门槛、已经在 `previous`、没有 `previous`
- `--force` 强推留痕，别把它当默认

## 回退

```
make ab-rollback COMPONENT=audit   # 回到 previous
make ab-detach COMPONENT=audit     # 连 previous 都没有时的兜底：摘掉 current，用仓库那份
```

## 硬约束

- **别手敲安装/构建命令**：走 `ab-pack`、`ab-switch` 这些入口，步骤里的门禁与校验都在里面
- **组件名必须显式给**：脚本与命令不给 gui / audit 设默认值
- **打包要带上 node_modules 软链**，槽内入口要摊平成 `export { default } from "./impl.ts";`，
  否则槽里起不来或壳加载壳无限递归（`ab-pack` 已经做掉这两件事）
- **换槽要带令牌**：同路径动态 import 会被 URL 缓存吃掉
- 脏产物不许晋升；`stable` 与 `previous` 只由晋升、回退、自举来动

## 出问题先看这几处

```
~/.pi/runtime/<组件>/notice.txt     # 槽加载失败时的提示（会自动退回仓库那份）
~/.pi/runtime/<组件>/crash/         # GUI 起不来时的现场：scene.json / request.json / stderr.txt
make ab-status                       # 计数与判定：keep / promote / rollback
```

症状与一步止血看 `docs/ab-update-firstaid.md`；设计取舍看 `docs/plans/2026-10-05-ab-update.md`。
