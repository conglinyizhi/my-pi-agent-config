# status-bus — 状态栏总线

在扩展与 pi 的状态栏之间注入一层**两侧抽象的总线**：把「状态栏的所有信息」收进一个
规范存储，再从输出侧扇出到多个目标。

- **对扩展零迁移**：扩展仍调用原生 `ctx.ui.setStatus / setWidget / setWorking*`，毫无差别。
- **当前目标**：只有 TUI（原生透传，行为不变）。
- **未来目标**：web / 文件 / 事件桥等，通过 `statusBus.subscribe()` 接入同一份变更流。

## 核心原则：数据 / 渲染分离

总线只承载**数据**，不承载**渲染**。渲染（着色、排版、顺序、是否显示）是前端
（TUI 主题 或 web CSS/组件）自己的职责：

- `statuses[*].text` 是**去 ANSI 的纯文本**。TUI 的颜色由 `theme.fg` 在透传那一刻完成，
  web 侧拿到的就是干净文本，自己决定样式。
- 总线不做语义反解（比如从颜色码猜 success/warning/accent）。将来若需要语义级着色，
  应由扩展提供结构化状态字段（`text + level`），而不是让总线猜。
- `widgets[*].content` 用 `kind` 判别（见下），组件工厂（函数）归一化为占位标记，
  不把不可序列化的函数塞进 JSON。

## 机制

`ctx.ui` 在整个会话里是**同一个单例对象**（pi 的 `ExtensionRunner.uiContext`，
`createContext()` 用 getter 惰性返回它）。所以只要在 `session_start` 时把它包一层，
之后所有扩展的所有状态栏写入都会自动经过总线：

```
扩展 ── setStatus/setWidget/setWorking* ──► 总线（归一化 + 记录 store + 发变更流）──► 原生 ui（TUI 目标）
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
| `StatusSnapshot` | 快照：`{ version, statuses, widgets, working }`（见下方 JSON 契约） |
| `WidgetPayload` | 挂件内容的 `kind` 判别联合（`lines` / `factory`） |
| `StatusChange` / `StatusListener` | 变更流类型：`(change) => void` |

接入一个未来目标的最小示例（无需改这里，也无需改任何扩展）：

```ts
import { statusBus } from "../../lib/status-bus.ts";

const off = statusBus.subscribe((change) => {
  // change.kind: "status" | "widget" | "working" | "reset"
  // change.snapshot: 完整 JSON 契约快照（见下）
});
// 不再需要时 off();
```

## JSON 契约（web / 外部消费方从这里开始读）

`statusBus.getSnapshot()` 的产物 **100% 可 `JSON.stringify`**，字段形态如下：

```json
{
  "version": 12,
  "statuses": {
    "sandbox-guard": { "text": "🔒 19 条黑名单", "updatedAt": 1730000000000 },
    "trident":        { "text": "林汐", "updatedAt": 1730000000001 }
  },
  "widgets": {
    "plan-todos": {
      "content": { "kind": "lines", "lines": ["☐ 步骤一", "☑ 步骤二"] },
      "options": { "placement": "aboveEditor" },
      "updatedAt": 1730000000002
    },
    "some-tui-gui": {
      "content": {
        "kind": "factory",
        "serialized": false,
        "note": "TUI 组件工厂，函数不可序列化；web 端无等效，应走声明式 openPanel"
      },
      "updatedAt": 1730000000003
    }
  },
  "working": {
    "message": "thinking…",
    "visible": true,
    "indicator": { "frames": ["●"], "intervalMs": 500 }
  }
}
```

要点：

- `statuses[*].text` 是去 ANSI 的纯文本（emoji 保留，颜色剥离）。
- `widgets[*].content` 用 `kind` 判别：
  - `"lines"` → `setWidget(key, string[])`，web 直接渲染文本行。
  - `"factory"` → `setWidget(key, 组件工厂)`，函数不可序列化，`serialized: false`
    是显式占位标记，`note` 说明原因；web 端应引导扩展走声明式 `openPanel`。
- `working.indicator` 只保留 `{ frames?: string[], intervalMs?: number }` 的可序列化子集。
- `version` 每次变更单调递增，供消费方做增量/去重。

## 已知边界

扩展加载顺序 = `readdirSync`（非字母序、不可控）。因此 `attach` 可能晚于少数扩展的
`session_start` 首轮写入（如 `🔒 N 条黑名单`、`林汐`），这些**初始状态**进不了 store
（TUI 显示不受影响，因为它们本就直连原生 ui）。后续若目标侧需要完整初始快照，可在
订阅侧做一次 reconcile：用 `ctx.ui.setFooter(factory)` 拿到 `footerData.getExtensionStatuses()`
读取原生状态后合并进 store。
