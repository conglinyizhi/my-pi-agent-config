// 飞书卡片生成器（审批卡 + 提问卡，schema 2.0）。
//
// 审批卡：sandbox-allow / audit / capability 的待决断与决断后版式，见下。
// 提问卡：ask_question 扇出到飞书，一题一张，回调契约见文件内的 question 段与
//         hub/adapters/feishu/card-design/README.md。
//
// 本体放在 scripts/ 下，跟 loop-guard-calibrate.mjs 同理：这里的 console 输出
// 就是它的交付物，提交前检查器也只把 scripts/ 下的文件当脚本看。
//
// 跑法：node scripts/feishu-card-gen.mjs [输出目录]
//   默认写进 hub/adapters/feishu/card-design/，那边放生成的 JSON 与设计说明。
//
// 依据官方文档（副本不入库，索引见 open.feishu.cn/llms-docs 的 developer-guides）：
//   card-json-v2-structure.md      body.vertical_spacing 控制正文元素间距（4/8/12/16px 或 0-99px）。
//   form-container.md              表单子节点支持除 table/form 外的一切，必须含一个 submit 按钮；
//                                  提交回调一次带回 action.name（哪个按钮）与 action.form_value。
//   collapsible-panel.md           折叠面板不支持内嵌 form。
//   single-select-dropdown-menu.md options[].value 是字符串回调值，options[].icon 可加前缀图标。
//   input.md                       表单内输入框用 name 收进 form_value。
//   rich-text.md                   支持 <font color> / <text_tag color>。
//
// 三条排版纪律（都是为了压低纵向高度）：
//   1. 同一块信息合成「一个」富文本元素，多行用 \n 连。元素越少，元素间距的累加越少。
//   2. body.vertical_spacing 调小，且不再给每个元素写 margin。
//   3. 颜色：一个状态一个色。neutral 工作区、yellow 未标记、green 已长期信任、
//      blue 已本会话信任、red 已拉黑、orange 已取消授权。
//      <text_tag> 只用于目录/权限状态，审核结论与风险提示走不带底色的 <font color>。
//
// 路径只做显示缩写（$HOME / <工作区>），真实路径靠 sel_i 索引在适配器侧还原。

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.argv[2] ?? join(HERE, "..", "hub", "adapters", "feishu", "card-design");
const REQ = "ask-preview";
const HOME = "/home/dev";
const WORKSPACE = `${HOME}/.pi/agent`;

// 超出默认才值得标注：pi 内建 bash 默认 30s，内存默认 1024MB
const DEFAULT_TIMEOUT_S = 30;
const DEFAULT_MEMORY_MB = 1024;

const md = (content, extra = {}) => ({ tag: "markdown", content, text_size: "notation", ...extra });
const block = (lines) => lines.filter(Boolean).join("\n");

const tag = (color, text) => `<text_tag color='${color}'>${text}</text_tag>`;
const grey = (text) => `<font color='grey'>${text}</font>`;
const code = (text) => `\`${text}\``;
const fence = (text) => "```\n" + text + "\n```";

function shorten(path) {
  if (path === WORKSPACE) return "<工作区>";
  if (path.startsWith(`${WORKSPACE}/`)) return `<工作区>${path.slice(WORKSPACE.length)}`;
  if (path === HOME) return "$HOME";
  if (path.startsWith(`${HOME}/`)) return `$HOME${path.slice(HOME.length)}`;
  return path;
}

// 目录 / 权限状态：一状态一色，图标色与标签色一致
const STATE = {
  workspace: { color: "neutral", text: "工作区" },
  none: { color: "yellow", text: "未标记" },
  allow: { color: "green", text: "已长期信任" },
  "session-trust": { color: "blue", text: "已本会话信任" },
  block: { color: "red", text: "已拉黑" },
  revoke: { color: "orange", text: "已取消授权" },
};
const stateTag = (key) => tag(STATE[key].color, STATE[key].text);

// 下拉选项：图标同色系，让「选什么」在视觉上跟状态标签对齐
const SELECTABLE = [
  ["allow", "长期信任", "pin_filled"],
  ["session-trust", "本会话信任", "time_outlined"],
  ["block", "拉黑", "ban_outlined"],
  ["revoke", "取消授权", "undo_outlined"],
];

const header = (title, subtitle, template) => ({
  title: { tag: "plain_text", content: title },
  subtitle: { tag: "plain_text", content: subtitle },
  template,
  padding: "12px 8px 12px 8px",
});

// body.vertical_spacing 压到 4px；各元素不再自己写 margin
const shell = (elements, hd) => ({
  schema: "2.0",
  config: {
    update_multi: true,
    style: { text_size: { normal_v2: { default: "normal", pc: "normal", mobile: "heading" } } },
  },
  header: hd,
  body: { direction: "vertical", vertical_spacing: "4px", elements },
});

const submitButton = (label, name, type) => ({
  tag: "button",
  text: { tag: "plain_text", content: label },
  type,
  width: "fill",
  form_action_type: "submit",
  name,
});

// 列：width 只在 flex_mode=none 时生效。之前写 stretch，width/weight 全被忽略，
// 列宽按内容自适应，剩余空间乱分 —— 值被推到最右边就是这么来的。
const column = (width, elements, extra = {}) => ({ tag: "column", width, vertical_align: "center", elements, ...extra });
const weighted = (weight, elements) => column("weighted", elements, { weight });

// 分栏统一 flex_mode none（= 默认），让 width/weight 真正生效
const cols = (columns, spacing = "8px") => ({ tag: "column_set", flex_mode: "none", horizontal_spacing: spacing, columns });

// 标签 / 值两列。权重固定成 2:7，同一张卡里所有这种行的值都从同一个 x 起，
// 别拿全角空格凑位置 —— 那是「看着差不多」，一换字号就散。
const labelRow = (label, value) => cols([column("60px", [md(grey(label))]), weighted(1, [md(value)])]);

// 附言输入框：整行铺满（历史附言按钮已按需求删掉）
const commentInput = () => ({
  tag: "input",
  name: "comment",
  required: false,
  placeholder: { tag: "plain_text", content: "附言（可选，随按钮一起提交）" },
  default_value: "",
  width: "fill",
  max_length: 200,
  margin: "8px 0px 0px 0px",
});
const actionBar = (allowLabel = "✅ 允许（仅此一次）") =>
  cols([
    weighted(1, [submitButton("🚫 拒绝", "btn_deny", "danger")]),
    weighted(1, [submitButton(allowLabel, "btn_approve", "primary_filled")]),
  ]);

// 表单名默认沿用审批卡的 gate_form；提问卡一题一个表单，名字带题号
const form = (elements, name = "gate_form") => ({ tag: "form", name, elements });

// 资源申请超出默认才标注，值得用户注意的事进 subtitle（plain_text，只能靠 ⚠ 提示）
function resourceNote({ timeout, memoryMb } = {}) {
  const notes = [];
  if (typeof timeout === "number" && timeout > DEFAULT_TIMEOUT_S) notes.push(`时限 ${timeout}s（默认 ${DEFAULT_TIMEOUT_S}s）`);
  if (typeof memoryMb === "number" && memoryMb > DEFAULT_MEMORY_MB) notes.push(`内存 ${memoryMb}MB（默认 ${DEFAULT_MEMORY_MB}MB）`);
  return notes.length ? `　⚠ ${notes.join(" · ")}` : "";
}

const metaLine = (extra = "") => md(grey(`${REQ} · sess-1 · 至 12:30${extra}`), { margin: "6px 0px 0px 0px" });

// ── sandbox-allow ──────────────────────────────────────────────────────

const PATHS = [
  { path: "/var/tmp/pi-build", zone: "out" },
  { path: `${HOME}/.cache/pi-build`, zone: "out" },
  { path: `${HOME}/.cache/secret`, zone: "out" },
  { path: `${HOME}/go/pkg/mod`, zone: "out", granted: "allow" },
  { path: `${HOME}/agent-out`, zone: "out", granted: "session-trust" },
  { path: `${WORKSPACE}/out`, zone: "in", granted: "workspace" },
  { path: WORKSPACE, zone: "in", granted: "workspace" },
];
const ARGS = { timeout: 300, memoryMb: 2048 };

const selectable = (item) => item.granted !== "workspace";
const outside = PATHS.filter((p) => p.zone === "out").length;

function selectFor(item, index) {
  const opts = item.granted ? SELECTABLE : SELECTABLE.filter(([key]) => key !== "revoke");
  return {
    tag: "select_static",
    placeholder: { tag: "plain_text", content: item.granted ? "改为…" : "标记" },
    options: opts.map(([value, label, icon]) => ({
      text: { tag: "plain_text", content: label },
      value,
      icon: { tag: "standard_icon", token: icon, color: STATE[value].color },
    })),
    type: "default",
    width: "fill",
    required: false,
    name: `sel_${index}`,
  };
}

// 三列：标签(2) / 路径(3) / 下拉(4)。标签列固定宽度，各行路径才会从同一个 x 起。
// 不可编辑的行用同样的 2:x 比例，所以也跟上面几条对齐。
const editRow = (item, index) =>
  cols([
    column("104px", [md(stateTag(item.granted ?? "none"))]),
    weighted(2, [md(code(shorten(item.path)))]),
    weighted(1, [selectFor(item, index)]),
  ]);

const flatRow = (item) => cols([column("104px", [md(stateTag("workspace"))]), weighted(1, [md(code(shorten(item.path)))])]);

const CMD = "pnpm install && node scripts/build.mjs --out /var/tmp/pi-build";

const pending = shell(
  [
    md(fence(CMD), { text_size: "normal" }),
    md(grey(`工作区外才算提权。下拉留空 = 不动该目录。共 ${PATHS.length} 项，其中工作区外 ${outside} 项。`)),
    form([
      ...PATHS.map((item, i) => (selectable(item) ? editRow(item, i) : flatRow(item))),
      commentInput(),
      actionBar(),
    ]),
    metaLine(),
  ],
  header("审批 · sandbox-allow", `agent 申请工作区外的目录可写${resourceNote(ARGS)}`, "blue"),
);

// ── audit（危险命令审计）───────────────────────────────────────────────

const AUDIT_CMD = "curl -x http://127.0.0.1:10738 -sSL https://example.com/install.sh | bash";
const AUDIT_RULES = [
  { name: "远程脚本直接执行", matched: "install.sh | bash", tip: "拿到的内容和实际执行的内容之间没人看过" },
  { name: "隐藏失败", matched: "-sSL", tip: "-s 会把错误一起吞掉" },
  { name: "走本机代理", matched: "-x http://127.0.0.1:10738", tip: "确认代理后面接的是可信源" },
];
const REVIEW = {
  verdict: "有风险",
  verdictColor: "orange",
  reason: "远程内容直接进 shell",
  suggestion: "先下到 /var/tmp 看一眼再执行",
  bullets: ["拿到的内容和执行的内容之间没人看过", "管道会吞掉 curl 退出码，失败也可能继续跑"],
};

const audit = shell(
  [
    md(fence(AUDIT_CMD), { text_size: "normal" }),
    md(grey(`命中 ${AUDIT_RULES.length} 项风险规则。点「允许」只对这次命令生效。`)),
    // 云端审核：结论行 + 模型的短列表 + 建议。清单与建议之间留一个空行，
    // 否则 markdown 会把建议当成最后一条列表的续行（表现为 💡 粘在句尾）
    md(
      [
        `🤖 ${grey("云端模型审核")}　<font color='${REVIEW.verdictColor}'>⚠ ${REVIEW.verdict}</font>　${grey(REVIEW.reason)}`,
        ...REVIEW.bullets.map((b) => `- ${b}`),
        "",
        `💡 ${REVIEW.suggestion}`,
      ].join("\n"),
    ),
    // 风险规则：中文规则名用灰字，代码体只留给真正的命令片段
    md(
      block([
        ...AUDIT_RULES.slice(0, 3).map((r) => `${grey(r.name)}　${code(r.matched)}`),
        AUDIT_RULES.length > 3 ? grey(`另有 ${AUDIT_RULES.length - 3} 项`) : "",
      ]),
    ),
    form([commentInput(), actionBar("✅ 允许")]),
    metaLine(),
  ],
  header("审批 · audit", "agent 请求执行危险命令", "orange"),
);

// ── capability（subagent 能力请求）─────────────────────────────────────

const CAP = { command: "sudo pacman -S --noconfirm podman", capability: "sandbox-allow", scope: "仅本次命令", reason: "worker 要装一个容器运行时，才能跑完验收里的集成测试" };

const capability = shell(
  [
    md(fence(CAP.command), { text_size: "normal" }),
    labelRow("能力", CAP.capability),
    labelRow("范围", CAP.scope),
    labelRow("理由", CAP.reason),
    md(grey("只批准当前这条命令；worker 会在批准后重新启动，不会获得持续权限。")),
    form([commentInput(), actionBar("✅ 允许本次命令")]),
    metaLine(),
  ],
  header("审批 · capability", "subagent 申请能力", "indigo"),
);

// ── question（ask_question 扇出到飞书）───────────────────────────────
//
// 契约（适配器按它解析，字段名不要改）：问题一题一张卡，第 i 张 header 写「提问 [i/N]」，
// subtitle 是该题的 label（没 label 就写「共 N 个问题」）。答题走 form 提交，
// 名字里的题号就是适配器把 form_value 认回哪一题的钥匙：q_form_i / sel_i / custom_i。
// 两个按钮都 form_action_type=submit，回调一次带回 action.name（按了哪个）与 action.form_value（选了什么）。
//
// allowOther 为 false 时才省掉自由输入框 —— 没有自由输入还留着输入框，
// 用户就会往一个不会被采纳的地方写字。

const QUESTIONS = [
  {
    label: "隔离方式",
    question_text: "这次改造会动共享的构建脚本。改之前先定怎么隔离工作区？",
    options: [
      { value: "worktree", label: "用 git worktree 隔离", description: "互不干扰，但依赖要重装一遍" },
      { value: "branch", label: "在当前工作区直接开分支", description: "最快，但构建产物会互相覆盖" },
      { value: "copy", label: "整个仓库复制到 /var/tmp 再改", description: "最干净，占地最大" },
    ],
    allowOther: true,
  },
  {
    label: "验收范围",
    question_text: "改完跑哪一层测试就算过？",
    options: [
      { value: "unit", label: "只跑改动目录的单测（约 2 分钟）" },
      { value: "integration", label: "单测 + 集成（约 8 分钟）" },
      { value: "all", label: "全量，含 e2e（约 20 分钟）" },
    ],
    allowOther: false,
  },
  {
    label: "回滚预案",
    question_text: "新脚本万一把 CI 挂了，先回滚还是先热修？",
    options: [
      { value: "revert", label: "直接回滚到上一版" },
      { value: "hotfix", label: "先热修，超过 30 分钟没头绪再回滚" },
      { value: "freeze", label: "停住流水线，等你看过再说" },
    ],
    allowOther: true,
  },
];

// 灰字提示跟着有没有自由输入走，别在没输入框的卡上写「在下面自己写」
const HINT_WITH_OTHER = "选一个，或在下面自己写；自己写的优先";
const HINT_ONLY_SELECT = "选一个，点「提交本题」回传";

const optionSelect = (index, options) => ({
  tag: "select_static",
  placeholder: { tag: "plain_text", content: "选择" },
  options: options.map((o) => ({ text: { tag: "plain_text", content: o.label }, value: o.value })),
  type: "default",
  width: "fill",
  required: false,
  name: `sel_${index}`,
});

const customInput = (index) => ({
  tag: "input",
  name: `custom_${index}`,
  placeholder: { tag: "plain_text", content: "或者自己写…" },
  default_value: "",
  width: "fill",
  max_length: 200,
  required: false,
});

// 按钮名不分题号：适配器要判断的是「提交还是取消」，哪一题由 q_form_i / sel_i 认
const questionActions = () => cols([
  weighted(1, [submitButton("🚫 取消", "btn_deny", "danger")]),
  weighted(1, [submitButton("✅ 提交本题", "btn_answer", "primary_filled")]),
]);

// 选项自带的说明放卡面：下拉选项文本会被截，取舍信息只能放这儿。
// 合成一个富文本元素，条数与元素间距都不会跟着涨
function optionNotes(options) {
  // 每行各自包 <font>：一个标签跨多行时闭合会丢，最后一行会把 </font> 当字面量显示出来
  const lines = (options ?? [])
    .filter((o) => o.description?.trim())
    .map((o) => grey(`- ${o.label}：${o.description}`));
  return lines.length ? [md(lines.join("\n"))] : [];
}

function questionCard(index, total, q) {
  const allowOther = q.allowOther !== false;
  return shell(
    [
      form(
        [
          md(q.question_text, { text_size: "normal" }),
          md(grey(allowOther ? HINT_WITH_OTHER : HINT_ONLY_SELECT)),
          ...optionNotes(q.options),
          optionSelect(index, q.options),
          ...(allowOther ? [customInput(index)] : []),
          questionActions(),
        ],
        `q_form_${index}`,
      ),
      metaLine(),
    ],
    header(`提问 [${index}/${total}]`, q.label ?? `共 ${total} 个问题`, "turquoise"),
  );
}

// ── 决断后（sandbox-allow）────────────────────────────────────────────

const APPLIED = new Map([
  [`${HOME}/.cache/pi-build`, "allow"],
  [`${HOME}/.cache/secret`, "block"],
]);

// 决断后全部平铺，且整块合成一个富文本元素
function settled({ template, title, subtitle, decision, color, comment }) {
  const rows = PATHS.map((item) => {
    const applied = APPLIED.get(item.path);
    if (applied) return `${stateTag(applied)}　${code(shorten(item.path))}　${grey("本次")}`;
    if (item.granted === "workspace") return `${stateTag("workspace")}　${code(shorten(item.path))}`;
    return `${stateTag(item.granted ?? "none")}　${code(shorten(item.path))}`;
  });
  return shell(
    [
      md(fence(CMD), { text_size: "normal" }),
      md(`<font color='${color}'>**${decision}**</font>`, { text_size: "normal" }),
      md(block([grey(`${APPLIED.size} 项有改动，其余 ${PATHS.length - APPLIED.size} 项未动`), ...rows])),
      metaLine(` · feishu / 丛林 决断${comment ? ` · 附言「${comment}」` : ""}`),
    ],
    header(title, subtitle, template),
  );
}

const allowed = settled({ template: "green", title: "已允许 · sandbox-allow", subtitle: "feishu / 丛林 · 12:45", decision: "✅ 已决断：允许（仅此一次）", color: "green", comment: "先别动 /var/tmp" });
const denied = settled({ template: "purple", title: "已拒绝 · sandbox-allow", subtitle: "feishu / 丛林 · 12:45", decision: "🚫 已决断：拒绝", color: "red" });

const cards = { "pending.json": pending, "audit.json": audit, "capability.json": capability, "allowed.json": allowed, "denied.json": denied };
// 提问卡按题号展开，文件名自带 i-of-N，跟 header 上的进度一致
QUESTIONS.forEach((q, i) => {
  cards[`question-${i + 1}of${QUESTIONS.length}.json`] = questionCard(i + 1, QUESTIONS.length, q);
});
for (const [name, card] of Object.entries(cards)) {
  writeFileSync(join(DIR, name), JSON.stringify(card, null, 2) + "\n");
  console.log("写好", name);
}

// ── 提问卡：决断后的形态 ──────────────────────────────────────────────
// 与适配器 questions.go 的 questionSettledCard 一致：按钮全撤，只留题面与答案。
// 答过的绿、取消/没答的灰——「没答」不能看起来像「答了」。
function questionSettledCard(index, total, q, answer, action) {
  const answered = action === "allow";
  const lines = [q.question_text];
  if (!answered) {
    lines.push(grey("未作答"));
  } else if (answer?.wasCustom) {
    lines.push(`✍️ 自己写：${answer.label}`);
  } else if (answer) {
    lines.push(`✅ 选择：${answer.label}`);
  } else {
    lines.push(grey("未作答"));
  }
  return shell(
    [md(block(lines), { text_size: "normal" })],
    header(
      answered ? `已答 [${index}/${total}]` : `已取消 [${index}/${total}]`,
      q.label ?? `共 ${total} 个问题`,
      answered ? "green" : "grey",
    ),
  );
}

// 这一段在写入循环之后，所以自己落盘（放进 cards 已经晚了）
const settledQuestion = questionSettledCard(1, QUESTIONS.length, QUESTIONS[0], { value: "worktree", label: "用 git worktree 隔离" }, "allow");
writeFileSync(join(DIR, "question-settled.json"), JSON.stringify(settledQuestion, null, 2) + "\n");
console.log("写好 question-settled.json");
