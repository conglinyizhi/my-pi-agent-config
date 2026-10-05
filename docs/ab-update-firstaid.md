# A/B 更新急救卡

> 一分钟版：判得不对就 `make ab-rollback COMPONENT=audit`，然后 `/reload`；
> 界面起不来就 `make ab-rollback COMPONENT=gui`。
> 忘了有哪些命令跑 `make help`。来龙去脉在 `docs/plans/2026-10-05-ab-update.md`。

## 现在跑的是哪一版

```sh
make ab-status                      # 两条产线各挂哪个 tag（带干净/失败计数）
make ab-tag COMPONENT=gui           # 只看一条
```

模型就一句话：**每条产品线一个 tag**。状态五样——`tag`（生效）/ `prev-tag`（回退目标）/
`candidate`（打好待验）/ `dir`（产物目录）/ `count`（干净往返计数），外加一份 `promote.log`
追加流水：切换、回退、崩溃都在里面（崩溃不再是单独的 md，见 `lib/ab-tag.ts` 的 appendLog）。

## 更新只有两条路

```sh
make ab-update COMPONENT=gui FORCE=1        # 强制：打完直接生效
make ab-update COMPONENT=gui                # 打完挂候选，一次干净授权就自动切
make ab-clean  COMPONENT=gui                # 每次干净授权往返记一笔（看门狗会调）
```

**什么叫"干净往返"**：窗口给出结论就算——**点允许、点拒绝都算**，审核链给出 verdict 也算。
与判断内容无关：拒绝说明你做了判断、机制跑通了。只有叉掉窗口、超时、起不来才算失败。

## 出事了，先止血

```sh
make ab-rollback COMPONENT=gui      # 退回 prev-tag
make ab-log COMPONENT=gui           # 看流水：为什么切、为什么退
```

**判得不对**：先回退，再看 `make ab-log COMPONENT=audit` 那一轮是 clean 还是 failure。
连续三次 failure，看门狗自己会退（阈值在 `lib/ab-tag.ts`）。

**改了仓库代码却没生效**：壳只在 `tag` 指向的产物里跑。要么 `make ab-update FORCE=1`
重打一版，要么删掉 `tag` 让它退回仓库那份——开发态就是这么来的（旧命令 `ab-detach` 已删）：

```sh
rm ~/.pi/runtime/gui/tag            # 下次起窗就用仓库那份；再想用槽就 make ab-update FORCE=1
```

## 硬约束

- 构建只落暂存目录 `dev`（`make ab-update` 干的就是这个）；生效的版本一律由 tag 决定
- 别手改 `~/.pi/runtime/*/tag`：那是 deploy 侧写的，手改会让"在跑哪一份"再次说不清
- 组件必须显式指名（`COMPONENT=gui|audit`）：两条线坏起来的样子不一样，一个看得见、一个静默
