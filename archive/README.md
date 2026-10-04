# archive —— 已退役的实现，保留不删

这里放**不再参与运行**的东西：不删是为了能翻、能对照、必要时能临时复活；但也**不该被自动选中**——
所以引用它们的代码要么已经删掉候选位，要么在注释里显式写明"要复活得先请回来"。

## 清单

| 目录 | 是什么 | 为什么退役 |
|---|---|---|
| `wails-gui/` | Wails 版 GUI 宿主（Go + WebKitGTK 4.1，Vue 前端） | 2026-10 切回 Electron：系统里有现成 electron，没有编译步骤，devtools 直接可用 |
| `gui-standards-wails/` | 当时的 GUI 开发规范（`SKILL.md`）+ skill-vault 里的旧副本 | 规范随宿主一起换；现行规范见 `skills/clyzhi/gui-standards/` |
| `wails-allowlist/` | 更早的一次前端实验遗留（单一 Vue 组件） | 未并入主线 |

## 复活 Wails 宿主的话

前端已搬到 `gui/frontend/`（两个引擎共用），归档里的 Go 工程指望 `frontend/dist` 在它自己目录下：

1. `ln -s ../../gui/frontend archive/wails-gui/frontend`（或在归档里重建一份产物）
2. `cd archive/wails-gui && wails build -tags webkit2_41`
3. 把二进制放回候选位，并在 `lib/gui-runner.ts` / `hub/gui.go` 的候选列表里显式加回

正常情况下不需要这么做——Electron 那条路是现在的主线。
