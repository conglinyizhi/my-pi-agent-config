# GUI 前端（Vue 3 + Vite）

pi 图形界面的前端。宿主是 `gui/electron/`（Electron 主进程 + preload），这份前端只通过
`src/platform/` 的适配层跟宿主说话——视图不认识引擎，引擎也不认识视图。

## 跟宿主怎么接

- 启动：`bin/gui.sh <windowName> <requestFile> <responseFile>`（宿主解析 A/B 槽，见下）
- 数据进来：宿主把请求 JSON 铺成 initData，前端从 `window.piGui.initData` 读
- 结论回去：写 responseFile；前端不直接碰 pi 的任何 API
- 窗口表与能力清单在 `gui/electron/init-data.js`：`WINDOW_CONFIGS` / `SUPPORTED_FEATURES` / `PROTOCOL_VERSION`。
  加了窗口就进 `WINDOW_CONFIGS`，加了会被渲染的字段就进 `SUPPORTED_FEATURES`，
  否则 pi 侧探测不到会走降级路径（细节见 skill `gui-standards`）

## 目录

```
src/
  views/       GateView（审批）/ EditorView（提示词）/ SubagentsView（worker 看板）
               / RoutingView（调度）/ ReviewView（审核设置）
  components/  gate/、subagent/，以及未接入的 flows/（见文件头注释）
  domain/      纯函数层：gate/ review/ routing/ subagent/ editor/，node --test 直测
  platform/    宿主适配：electron / browser / wails（已归档宿主的桩）/ detect
  fixtures/    浏览器演示模式的假数据
```

## 构建

```sh
node_modules/.bin/vite build          # 出 dist/；宿主用 file:// 加载，base 必须是 "./"
node_modules/.bin/vite               # dev server（对着浏览器演示模式调版面时用）
```

产物怎么进 A/B 槽、怎么生效见 skill `ab-update`。开发态想直接跑仓库这份：
删掉 `~/.pi/runtime/gui/tag`，下次起窗就用仓库目录。

## 浏览器演示模式

不起 Electron、不要后端，用 `fixtures/` 的假数据把同一套视图渲出来，用来查版面与域逻辑：

```sh
pnpm build:browser                    # 单独打 browser.html 那个入口
pnpm dev
```

```text
/browser.html?view=gate
/browser.html?view=subagents
/browser.html?view=routing
/browser.html?view=editor
```

## Wails（已归档）

旧宿主是 Wails，源码归档在 `archive/wails-gui/`，不再参与运行、也不再是候选位。
`src/platform/wails.js` 与 `wailsjs/` 留作兼容边界：检测到 `window.go` / `window.runtime` 时
给出同形但明说不支持的桩（报错文案指向 Electron 宿主）。

## 测试

```sh
node --test src/domain/**/*.test.js   # 纯逻辑
node --test src/platform/electron.test.js
make test-gui                          # 上面这些加 Electron 侧模块的分组跑法
```
