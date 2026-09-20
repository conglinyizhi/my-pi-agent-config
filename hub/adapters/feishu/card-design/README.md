# 飞书审批卡设计（schema 2.0）

生成器本体在 `scripts/feishu-card-gen.mjs`（放那儿是因为 console 输出就是它的交付物，检查器只把 `scripts/` 下的文件当脚本）。

```
node scripts/feishu-card-gen.mjs              # 重新生成下面这几份 JSON
node scripts/feishu-card-gen.mjs <输出目录>    # 写到别处
```

生成的 JSON：

| 文件 | 用途 | header |
|---|---|---|
| `pending.json` | sandbox-allow 待决断，**这一类预览只发这一张** | `blue` |
| `audit.json` | 危险命令审计（云端审核结论 + 风险规则） | `orange` |
| `capability.json` | subagent 能力请求 | `indigo` |
| `allowed.json` | 决断为允许后 patch 上去 | `green` |
| `denied.json` | 决断为拒绝后 patch 上去 | `purple` |
| `question-<i>of<N>.json` | `ask_question` 扇出到飞书，一题一张（示例 3 题，见 `question-1of3.json`） | `turquoise` |

## 版式（待决断）

```
┌ header：审批 · sandbox-allow / agent 申请工作区外的目录可写 ──┐
│ ```                                                   │
│ pnpm install && node scripts/build.mjs --out …        │   ← 无「命令」字样
│ ```                                                   │
│ 工作区外才算提权。下拉留空 = 不动该目录。共 7 项，其中工作区外 5 项。 │   ← notation 灰字
│ ┌ form ─────────────────────────────────────────────┐ │
│ │ [未标记]       `/var/tmp/pi-build`        [标记 ▾] │ │
│ │ [已长期信任]    `$HOME/.cache/pi-build`    [改为… ▾] │ │
│ │ [已本会话信任]  `$HOME/agent-out`          [改为… ▾] │ │
│ │ [工作区]       `<工作区>/out`          ← 无控件，铺满 │ │
│ │ [工作区]       `<工作区>`                           │ │
│ │ [ 附言（可选，随按钮一起提交）                    ] │ │
│ │ [🚫 拒绝]              [✅ 允许（仅此一次）]         │ │
│ └───────────────────────────────────────────────────┘ │
│ ask-preview · sess-1 · 至 12:30                       │   ← notation 灰字
└───────────────────────────────────────────────────────┘
```

列宽：标签列固定像素（目录行 104px、标签行 60px），其余按 weight 分。**必须 `flex_mode: "none"`**，否则 width/weight 全失效（见下方硬约束）。

## 设计决定

1. **不折叠目录区**：折叠面板不支持内嵌表单容器（`collapsible-panel.md`），而目录下拉必须在表单里才能一次提交，所以目录区直接铺在表单里。
2. **没有图例，一个状态一个颜色**：标签自带文字（「已长期信任」）就是图例。颜色不重复 —— neutral 工作区默认可写、yellow 未标记、green 已长期信任、blue 已本会话信任、red 已拉黑、orange 已取消授权。两套视觉语言分开：`<text_tag>` 只用于目录/权限状态，审核结论与风险提示走不带底色的 `<font color>`。
3. **路径缩写**：用户家目录 → `$HOME`，工作区根 → `<工作区>`，所以工作区下的目录显示成 `<工作区>/out`。缩写只影响显示，适配器按 `sel_i` 索引拿真实路径。
4. **不可编辑的行不分栏**：工作区 / 内建根覆盖的目录是单条 markdown 铺满整行，省掉一列控件的高度。
5. **决断后隐藏按钮、header 换色**：`allowed` 绿、`denied` 紫；正文顶加「已决断」并带决断人、时间、附言；决断后卡上没有任何可点元素。
6. **用不到的信息压成灰字**：requestId、会话、过期、时限、内存放在底部一行 notation。
7. **下拉四个动作**：`session-write` 在当前权限模型里与 `session-trust` 行为等价（见 `session-access.ts` 注释与 `applyPathActions`），不单列。已有授权的目录给「取消授权 / 拉黑」—— 灰色标签不等于不可操作。
8. **audit 卡的信息密度**：审核结论排成「结论行 + 短列表」而不是一整段散文（列表由提示词要求、`normalizeBullets` 兑底）；风险规则只留规则名与命中片段，去掉 tip —— tip 与模型那几条语义重叠，去掉能把这块砍一半，超过 3 项只报数量。

## 交互：一次点击带走全部选择，含附言

目录下拉、附言输入框、两个按钮放在**同一个表单容器**里：

| 元素 | `name` | 回调里的位置 |
|---|---|---|
| 每个目录的下拉 | `sel_0` … `sel_N`（索引对应卡片里目录顺序） | `action.form_value.sel_i` |
| 附言输入框 | `comment` | `action.form_value.comment` |
| 拒绝按钮 | `btn_deny` | `action.name` |
| 允许按钮 | `btn_approve` | `action.name` |

两个按钮都是 `form_action_type: "submit"`。用户挑完下拉、写好附言，点允许 → 回调**一次**带回全部内容。中间零次卡片重画，只在决断后 patch 一次换成绿灯/紫灯形态。

下拉留空 = 不动该目录。

**附言在输入框里**（`name=comment`），也是表单项，点按钮时跟着一起回传。输入框右边是**折叠按钮组**（`overflow`，官方就叫这个名）：默认收起成一个「⋯」按钮，点开列出历史附言。选项文本是 `时间　内容`，`value` 存正文；数据源是 `~/.pi/agent/permission-gate-reasons.csv`（GUI 那个「▾ 历史」读的同一份，最多 20 条）。

注意 `overflow`（折叠按钮组）与 `collapsible_panel`（折叠面板）是两个不同组件，别混：前者是「⋯ 展开一组按钮」，后者是「一块可折叠的内容区」，而且两者都不支持内嵌 form。

历史目前只做展示。点条目已经会回传 `{action: "use-history"}` 加条目正文，回填到输入框也能做，但那需要为每次点击重画一次卡片，而且会把用户已经打的半截字冲掉，所以没接。

## 提问卡（`ask_question` 扇出到飞书）

一题一张卡，第 i 张 header 写「提问 [i/N]」，subtitle 是该题的 `label`（没有 label 就写「共 N 个问题」）。三题示例：`question-1of3.json` / `question-2of3.json` / `question-3of3.json`。

```
┌ header：提问 [1/3] / 隔离方式 ────────────────────────┐
│ 这次改造会动共享的构建脚本。改之前先定怎么隔离工作区？   │
│ 选一个，或在下面自己写；自己写的优先                    │   ← notation 灰字
│ ┌ form q_form_1 ───────────────────────────────────┐ │
│ │ sel_1   用 git worktree 隔离 / 直接开分支 / … ▾   │ │
│ │ [ custom_1  或者自己写…                         ] │ │
│ │ [🚫 取消]              [✅ 提交本题]              │ │
│ └─────────────────────────────────────────────────┘ │
│ ask-preview · sess-1 · 至 12:30                      │   ← notation 灰字
└──────────────────────────────────────────────────────┘
```

### 回调契约

表单名与控件名都带题号（i 从 1 开始），适配器靠它把回调认回具体哪一题：

| 元素 | `name` | 回调里的位置 | 说明 |
|---|---|---|---|
| 表单 | `q_form_<i>` | 不出现在回调里 | 一题一个表单，互不干扰 |
| 下拉 | `sel_<i>` | `action.form_value.sel_i` | 值就是该题 `options[].value`（字符串）；`placeholder` 是「选择」 |
| 自由输入 | `custom_<i>` | `action.form_value.custom_i` | 只在 `allowOther` 为 true 时存在，`max_length` 200，非必填 |
| 取消 | `btn_deny` | `action.name` | 文案 `🚫 取消`，`danger` |
| 提交本题 | `btn_answer` | `action.name` | 文案 `✅ 提交本题`，`primary_filled` |

两个按钮都是 `form_action_type: submit`，点哪个都会带回整张表单的 `form_value`。**只有 `action.name === "btn_answer"` 的那次才算答案**：点取消同样会带 `form_value`，适配器不能看见 `form_value` 就当成回答。`custom_i` 非空时优先于 `sel_i`（卡上的灰字也是这么提示的），两个都空就是没作答。

按钮名不带题号：适配器要判断的是「提交还是取消」，是哪一题由表单名与 `sel_i` / `custom_i` 认。

`allowOther` 为 false 时省掉 `custom_i`，灰字提示也跟着换成「选一个，点「提交本题」回传」——没有输入框就不该提示用户去写。三题示例里第 2 题就是这种。

### 设计决定

1. **一题一张卡**，不把 N 题堆进一张：飞书卡片没有标签页组件，塞进一张要么纵向很高，要么得自己实现翻页状态；一题一张天然对应「答完一题算一题」，每题的 `q_form_i` 也各自独立。
2. **header 用 `turquoise`**：审批卡的状态色已经占了 blue / orange / indigo / green / purple，提问是另一类卡，用一个没被占的颜色。
3. **选项只走 `label`**：官方 `select_static` 的选项文本是 `text`，题目自带的 `description` 不进选项（塞进去会把卡撑高，且回调里也用不上）；要补充说明就写进 `question_text`。

## 适配器要改的地方

1. `onCard` 现在只读 `action_value`，改成同时读 `action.name`（`btn_approve` / `btn_deny`）与 `action.form_value`
2. 按 `sel_i` 索引映射回真实路径（顺序由生成卡片时的 payload 决定），转成 `pathActions: [{path, list}]`
3. `form_value.comment` 作为 decide 的附言
4. 决断后 `patchCard` 换成 `allowed.json` / `denied.json` 版式（`patchCard` 已实现）

hub 侧 `pathActions` 协议现成（`applyPathActions`），不用动。

**待验证**：lark-cli 把 `card.action.trigger` 摊成扁平字段时，`form_value` 与 `name` 的键名。要钉死就在 `onCard` 里临时打一行原始事件，点一次表单看 journal。

## 从官方文档确认的硬约束

官方文档**副本不入库**（当时抓下来放在草稿目录 `.local-drafts/feishu-docs/`，约 850K），下表只留「文件名 + 行号」的引用，核对时按 `https://open.feishu.cn/llms-docs/zh-CN/llms-developer-guides.txt` 的索引重新拉对应页面：

| 结论 | 出处 |
|---|---|
| 折叠面板**不支持**内嵌表单容器；反过来 form 可内嵌除 table/form 外的一切 | `collapsible-panel.md` line 16 / `form-container.md` line 142 |
| 表单提交回调带 `action.name` 与 `action.form_value`；表单内按钮用 `form_action_type: submit` | `form-container.md` line 145-147 |
| 表单内输入框用 `name` 收进 `form_value` | `input.md` |
| 下拉 `options[].value` 是字符串回调值；`behaviors.value` 另走 `action.value` | `single-select-dropdown-menu.md` line 152-156 |
| `initial_option` 填**展示内容**不是 value | `single-select-dropdown-menu.md` line 96 |
| JSON 2.0 的交互与可更新有效期统一 **14 天** | `configuring-card-interactions.md` line 66 |
| `note` 标签在 2.0 被移除（实测 230099） | 发卡实测 |
| 富文本支持 `<font color>` / `<text_tag color>` | `rich-text.md` line 160-167 |
| `body.vertical_spacing` 控正文元素间距（4/8/12/16px 或 0-99px） | `card-json-v2-structure.md` line 116 |
| 折叠面板 `header.padding` 不认两值，`"4px 8px"` 报 `invalid panel header padding`，得写单值 | 发卡实测 |
| 「折叠按钮组」是 `overflow`（⋯ 按钮，点开展开一组选项），不是 `collapsible_panel` | `overflow.md`、`component-json-v2-overview.md` line 55 |
| **列的 `width` / `weight` 仅在 `flex_mode: "none"` 时生效**。写 `stretch` 会让两者全部失效，列宽改成按内容自适应、剩余空间乱分（表现为值被推到最右边，中间一大段空白） | `column-set-v2.md` line 125 |
| `column` 的 `width` 可以是 `auto` / `weighted` / 固定像素（[16,600]px，V7.4+） | `column-set-v2.md` line 125 |
| `column` / `column_set` 的 `horizontal_align` 默认就是 `left`；对齐不对时先查 `flex_mode`，不是查对齐 | `column-set-v2.md` line 104,128 |
| `overflow` 的 `options[].text.content` 上限 100 字符；它本身没有 icon / text / size 字段 | `overflow.md` |
| markdown 元素的 `content` 必须是字符串；把元素对象再包一层会报 `200621 parse card json err` | 发卡实测 |
