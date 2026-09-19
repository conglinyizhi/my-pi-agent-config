# 归档：Wails IM 许可窗

许可窗已改成 hub 拉起的 yad 对话框。下面是未进主线的 Wails `allowlist` 窗口源码备份，不参与构建。

当时接线：

- windowName `allowlist`
- 前端 `AllowlistView.vue` + `domain/allowlist/pairs.js`
- Go `app.go` 注入 `pairs` / `asks`
- hub `gui.launchAllow` spawn `wails-gui allowlist`

现役入口仍是 `/remote:gui`，只是窗换成 yad。
