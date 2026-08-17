# status-bus — 状态栏总线

在扩展与 pi 的状态栏之间注入一层**两侧抽象的总线**：把「状态栏的所有信息」收进一个
规范存储，再从输出侧扇出到多个目标。

- **对扩展零迁移**：扩展仍调用原生 `ctx.ui.setStatus / setWidget / setWorking*`，毫无差别。
- **当前目标**：只有 TUI（原生透传，行为不变）。
- **未来目标**：web / 文件 / 事件桥等，通过 `statusBus.subscribe()` 接入同一份变更流。

## 机制

`ctx.ui` 在整个会话里是**同一个单例对象**（pi 的 `ExtensionRunner.uiContext`，
`createContext()` 用 getter 惰性返回它）。所以只要在 `session_start` 时把它包一层，
之后所有扩展的所有状态栏写入都会自动经过总线：

```
扩展 ── setStatus/setWidget/setWorking* ──► 总线（记录 store + 发变更流）──► 原生 ui（TUI 目标）
                                              │
                                              └──► subscribe 订阅者（未来 web/文件/事件桥）
```

`extensions/status-bus/index.ts` 只做两件事：

- `session_start`：`statusBus.attach(ctx.ui)`（幂等，包一层即拦截全部后续写入）
- `session_shutdown`：`statusBus.reset()`（清空当前会话状态）

## 核心 API（`lib/status-bus.ts`）

| 导出 | 说明 |
|------|------|
| `StatusBus` | 总线类（store + subscribe + attach + snapshot + reset） |
| `statusBus` | 进程级单例 |
| `StatusSnapshot` | 快照：`{ version, statuses, widgets, working }` |
| `StatusChange` / `StatusListener` | 变更流类型：`(change) => void` |

接入一个未来目标的最小示例（无需改这里，也无需改任何扩展）：

```ts
import { statusBus } from "../../lib/status-bus.ts";

const off = statusBus.subscribe((change) => {
  // change.kind: "status" | "widget" | "working" | "reset"
  // change.snapshot: 完整可序列化快照（widget 的组件工厂 content 除外，需自行处理）
});
// 不再需要时 off();
```

## 已知边界

扩展加载顺序 = `readdirSync`（非字母序、不可控）。因此 `attach` 可能晚于少数扩展的
`session_start` 首轮写入（如 `🔒 N 条黑名单`、`林汐`），这些**初始状态**进不了 store
（TUI 显示不受影响，因为它们本就直连原生 ui）。后续若目标侧需要完整初始快照，可在
订阅侧做一次 reconcile：用 `ctx.ui.setFooter(factory)` 拿到 `footerData.getExtensionStatuses()`
读取原生状态后合并进 store。
