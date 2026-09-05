/**
 * 独立渲染测试：不依赖真实会话 / 真实模型调用。
 * 运行：node --import tsx test-render.mts   (在 ~/.pi/agent 下，tsx 可解析 node_modules)
 */
import { markdownToHtml, loadHighlightCss } from "./src/markdown.ts";
import { renderPage, templateNames, type PageData } from "./src/templates.ts";
import { parseCardJson, parseDecisionCheck } from "./src/cards.ts";

const SAMPLE_MD = [
  "# 重构方案讨论",
  "",
  "这次我们要决定怎么处理 **认证模块**。",
  "",
  "有两个方向：",
  "",
  "1. 继续用 JWT，但加上 refresh token",
  "2. 换成 session + cookie",
  "",
  "> 我倾向 JWT + refresh，改动最小。",
  "",
  "```ts",
  "const config = { jwt: true, refresh: true };",
  "console.log(config);",
  "```",
  "",
  "- 需要你拍板是否保留第三方登录",
  "- 数据库是否要平滑迁移",
  "",
  "| 方案 | 成本 | 风险 |",
  "|-----|------|------|",
  "| JWT | 低 | 中 |",
  "| Session | 高 | 低 |",
  "",
].join("\n");

const SAMPLE_CARDS_JSON = `\`\`\`json
{
  "title": "认证模块重构",
  "summary": "讨论认证方案，需要拍板方向与第三方登录去留。",
  "decisions": [
    {
      "priority": "high",
      "question": "认证方案选 JWT+refresh 还是 session+cookie？",
      "options": ["JWT + refresh token", "session + cookie"],
      "recommendation": "JWT + refresh token",
      "reasoning": "改动最小，现有前端兼容。"
    },
    {
      "priority": "medium",
      "question": "是否保留第三方登录？",
      "options": ["保留", "下线"],
      "recommendation": "保留",
      "reasoning": "短期迁移成本高。"
    }
  ]
}
\`\`\``;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}  ${detail ?? ""}`);
  }
}

console.log("== markdown → HTML ==");
const bodyHtml = await markdownToHtml(SAMPLE_MD);
console.log("len:", bodyHtml.length);
check("含 <h1>", bodyHtml.includes("<h1>"));
check("含代码块高亮 pre>code.hljs", bodyHtml.includes('<pre><code class="hljs language-'));
check("含表格", bodyHtml.includes("<table>"));
check("含引用", bodyHtml.includes("<blockquote>"));

console.log("\n== highlight CSS 可加载 ==");
const css = loadHighlightCss("github-dark");
check("CSS 长度>500", css.length > 500, `got ${css.length}`);
check("CSS 含 .hljs", css.includes(".hljs"));

console.log("\n== 三套模板渲染 ==");
for (const tpl of templateNames()) {
  const data: PageData = {
    title: "认证模块重构",
    summary: "需要拍板认证方案。",
    decisions: parseCardJson(SAMPLE_CARDS_JSON).decisions,
    bodyHtml,
    modelLabel: "openai/gpt-5.2",
    timestamp: Date.now(),
    template: tpl,
  };
  const html = renderPage(data);
  check(`[${tpl}] 含标题`, html.includes("认证模块重构"));
  check(`[${tpl}] 含决策卡片`, html.includes("dcard"));
  check(`[${tpl}] 含优先级徽章`, html.includes("pr-badge"));
  check(`[${tpl}] 含原文`, html.includes("markdown-body"));
  check(`[${tpl}] 含代码高亮 CSS`, html.includes("hljs"));
  check(`[${tpl}] 含 meta`, html.includes("openai/gpt-5.2"));
}

console.log("\n== parseCardJson 边界 ==");
check("带 fence 的 JSON", parseCardJson(SAMPLE_CARDS_JSON).decisions.length === 2);
check("空 decisions", parseCardJson('{"decisions": []}').decisions.length === 0);
const bad = parseCardJson("这不是 json");
check("坏 JSON 不抛且归类空", bad.decisions.length === 0);
check("坏 JSON 不抛", true);
const open = parseCardJson('{"decisions":[{"priority":"high","question":"q","options":["a","b"],"recommendation":"r","reasoning":"w"}]}');
check("正常单卡", open.decisions.length === 1 && open.decisions[0].priority === "high");
check("缺 question 被过滤", parseCardJson('{"decisions":[{"priority":"high"},{"question":"ok","priority":"low"}]}').decisions.length === 1);

console.log("\n== parseDecisionCheck 判定 ==");
const dc = parseDecisionCheck('{"tool":"no_decision","args":{"reason":"这只是一条完成通知"}}');
check("工具报告无决策", dc.hasDecision === false && dc.reason === "这只是一条完成通知");
const dc2 = parseDecisionCheck('{"hasDecision":false,"reason":"无关紧要"}');
check("严格JSON无决策", dc2.hasDecision === false && dc2.reason === "无关紧要");
const dc3 = parseDecisionCheck('{"hasDecision":true,"decisions":[{"question":"q","priority":"high"}]}');
check("有决策解析卡片", dc3.hasDecision === true && dc3.cards.decisions.length === 1);
const dc4 = parseDecisionCheck('{"title":"t","decisions":[{"question":"q"}]}');
check("旧格式视为有决策", dc4.hasDecision === true && dc4.cards.decisions.length === 1);
const dc5 = parseDecisionCheck('```json\n{"hasDecision":false,"reason":"x"}\n```');
check("fence内无决策", dc5.hasDecision === false);
const dc6 = parseDecisionCheck("不是 json 的文本");
check("坏JSON保守作为有决策", dc6.hasDecision === true && dc6.cards.decisions.length === 0);

console.log(`\n${failures === 0 ? "全部通过 ✅" : `存在 ${failures} 处失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
