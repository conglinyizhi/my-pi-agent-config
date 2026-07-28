import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { readFileSync as _readFileSync } from "fs";

const requestFile = process.argv[2];
const responseFile = process.argv[3];
if (!requestFile || !responseFile) {
  console.error("Usage: electron app.js <request.json> <response.json>");
  process.exit(1);
}

const TIMEOUT_MS = 120_000;
const REASONS_FILE = join(homedir(), ".pi", "agent", "permission-gate-reasons.json");

/** 加载常用审核理由 */
function loadReasons(): string[] {
  try {
    if (existsSync(REASONS_FILE)) {
      return JSON.parse(readFileSync(REASONS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

/** 保存审核理由 */
function saveReason(reason: string) {
  const reasons = loadReasons().filter(r => r !== reason);
  reasons.unshift(reason);
  if (reasons.length > 20) reasons.length = 20;
  try {
    mkdirSync(dirname(REASONS_FILE), { recursive: true });
    writeFileSync(REASONS_FILE, JSON.stringify(reasons, null, 2));
  } catch {}
}

app.whenReady().then(() => {
  let request;
  try {
    request = JSON.parse(readFileSync(requestFile, "utf-8"));
  } catch {
    writeFileSync(responseFile, JSON.stringify({ action: "deny", reason: "bad-request" }));
    app.quit();
    return;
  }

  const { command, rules } = request;
  const reasons = loadReasons();

  // 高亮：收集所有正则匹配区间
  const highlights: [number, number, string][] = []; // [start, end, pattern]
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, "gi");
      let m;
      while ((m = re.exec(command)) !== null) {
        highlights.push([m.index, m.index + m[0].length, rule.pattern]);
        if (m[0].length === 0) break; // 防止零宽匹配死循环
      }
    } catch {}
  }
  // 合并重叠区间
  highlights.sort((a, b) => a[0] - b[0]);

  // 构建高亮 HTML
  let cmdHtml = "";
  let pos = 0;
  const merged: [number, number][] = [];
  for (const [s, e] of highlights) {
    let mergedEnd = e;
    // 合并重叠/相邻区间
    while (merged.length > 0 && merged[merged.length - 1][1] >= s) {
      const prev = merged.pop()!;
      mergedEnd = Math.max(mergedEnd, prev[1]);
    }
    merged.push([s, mergedEnd]);
  }

  for (const [s, e] of merged) {
    cmdHtml += escapeHtml(command.slice(pos, s));
    cmdHtml += `<mark>${escapeHtml(command.slice(s, e))}</mark>`;
    pos = e;
  }
  cmdHtml += escapeHtml(command.slice(pos));

  const ruleItems = rules
    .map(
      (r, i) => `
    <div class="rule" style="animation-delay: ${i * 0.05}s">
      <span class="rule-badge ${r.autoReject ? "auto" : "warn"}">${r.autoReject ? "自动拒绝" : "需确认"}</span>
      <span class="rule-pattern"><code>${escapeHtml(r.pattern)}</code></span>
      <span class="rule-tip">${escapeHtml(r.tip)}</span>
    </div>`
    )
    .join("");

  const reasonOptions = reasons
    .map(r => `<option value="${escapeAttr(r)}">${escapeHtml(r.slice(0, 80))}</option>`)
    .join("");

  // 窗口尺寸：宽 900-1200，高自适应
  const cmdLines = command.split("\n").length;
  const cmdHeight = Math.min(cmdLines * 24 + 32, 200);
  const winHeight = Math.min(200 + cmdHeight + rules.length * 50 + 80, 700);
  const winWidth = Math.min(Math.max(900, command.length * 0.6 + 100), 1200);

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "Microsoft YaHei", sans-serif;
    background: #1a1a2e; color: #e0e0e0;
    display: flex; flex-direction: column; height: 100vh;
    overflow: hidden;
  }
  .header {
    padding: 16px 20px 8px;
    border-bottom: 1px solid #2a2a4a;
  }
  .header h1 { font-size: 16px; color: #ff6b6b; }
  .header .sub { font-size: 12px; color: #888; margin-top: 4px; }

  .command-box {
    margin: 12px 20px; padding: 14px 16px;
    background: #0d0d1a; border: 1px solid #333;
    border-radius: 6px;
    font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 13px; line-height: 1.7;
    white-space: pre-wrap; word-break: break-all;
    overflow-y: auto;
    color: #4ec9b0;
  }
  .command-box mark {
    background: #ff6b6b44; color: #ff6b6b;
    padding: 1px 0; border-radius: 2px;
    font-weight: bold;
  }

  .rules {
    flex: 1; overflow-y: auto; margin: 0 20px;
  }
  .rules h2 { font-size: 13px; color: #aaa; margin: 8px 0 6px; }
  .rule {
    padding: 8px 12px; margin-bottom: 6px;
    background: #16213e; border-radius: 4px;
    border-left: 3px solid #ff6b6b;
    display: flex; gap: 10px; align-items: baseline;
    animation: fadeIn 0.2s ease-out both;
  }
  @keyframes fadeIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
  .rule-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 3px;
    white-space: nowrap; flex-shrink: 0;
  }
  .rule-badge.warn { background: #ff6b6b33; color: #ff6b6b; }
  .rule-badge.auto { background: #ff444455; color: #ff4444; }
  .rule-pattern { font-size: 12px; flex-shrink: 0; }
  .rule-pattern code { color: #ce9178; background: #1a1a2e; padding: 1px 4px; border-radius: 2px; }
  .rule-tip { font-size: 12px; color: #999; }

  .actions {
    padding: 12px 20px; border-top: 1px solid #2a2a4a;
    display: flex; gap: 10px; justify-content: flex-end;
  }
  button {
    padding: 10px 28px; border: none; border-radius: 4px;
    font-size: 14px; cursor: pointer; font-family: inherit;
  }
  .btn-allow { background: #2ecc71; color: #fff; }
  .btn-allow:hover { background: #27ae60; }
  .btn-deny { background: #e74c3c; color: #fff; }
  .btn-deny:hover { background: #c0392b; }
  .count { font-size: 12px; color: #777; margin-right: auto; align-self: center; }

  /* 审核意见弹层 */
  .overlay {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7);
    display: flex; justify-content: center; align-items: center;
    z-index: 100;
  }
  .overlay.hidden { display: none; }
  .dialog {
    background: #1a1a2e; border: 1px solid #333; border-radius: 8px;
    padding: 24px; width: 90%; max-width: 600px;
  }
  .dialog h2 { font-size: 15px; color: #ff6b6b; margin-bottom: 12px; }
  .dialog label { font-size: 12px; color: #888; display: block; margin: 10px 0 4px; }
  .dialog select, .dialog textarea {
    width: 100%; padding: 8px 10px;
    background: #0d0d1a; border: 1px solid #333; border-radius: 4px;
    color: #e0e0e0; font-family: inherit; font-size: 13px;
  }
  .dialog textarea { height: 80px; resize: vertical; }
  .dialog .btns { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
  .dialog .btns button { padding: 8px 20px; font-size: 13px; }
  .btn-cancel { background: #555; color: #ccc; }
  .btn-cancel:hover { background: #666; }
</style>
</head>
<body>
<div class="header">
  <h1>⚠️ 危险命令审计</h1>
  <div class="sub">以下命令触发了 ${rules.length} 条危险规则</div>
</div>
<pre class="command-box">${cmdHtml}</pre>
<div class="rules">
  <h2>命中规则</h2>
  ${ruleItems}
</div>
<div class="actions">
  <span class="count">${rules.length} 条规则匹配</span>
  <button class="btn-deny" onclick="showDenyDialog()">❌ 拒绝</button>
  <button class="btn-allow" onclick="respond('allow')">✅ 允许执行</button>
</div>

<!-- 拒绝原因弹层 -->
<div class="overlay hidden" id="denyOverlay">
  <div class="dialog">
    <h2>审核意见</h2>
    <label>常用理由：</label>
    <select id="reasonSelect" onchange="onReasonSelect()">
      <option value="">-- 手动输入 --</option>
      ${reasonOptions}
    </select>
    <label>审核意见（可选）：</label>
    <textarea id="reasonInput" placeholder="输入拒绝理由（可选）..."></textarea>
    <div class="btns">
      <button class="btn-cancel" onclick="hideDenyDialog()">取消</button>
      <button class="btn-deny" onclick="submitDeny()">确认拒绝</button>
    </div>
  </div>
</div>

<script>
  var responded = false;

  function respond(action, comment) {
    if (responded) return;
    responded = true;
    var payload = { action: action };
    if (comment) payload.comment = comment;
    var fs = require('fs');
    fs.writeFileSync(${JSON.stringify(responseFile)}, JSON.stringify(payload));
    window.close();
  }

  // 超时自动拒绝
  setTimeout(function() { respond('timeout'); }, ${TIMEOUT_MS});

  // 拒绝弹层
  function showDenyDialog() {
    document.getElementById('denyOverlay').classList.remove('hidden');
    document.getElementById('reasonInput').focus();
  }
  function hideDenyDialog() {
    document.getElementById('denyOverlay').classList.add('hidden');
  }
  function onReasonSelect() {
    var sel = document.getElementById('reasonSelect');
    if (sel.value) {
      document.getElementById('reasonInput').value = sel.value;
    }
  }
  function submitDeny() {
    var comment = document.getElementById('reasonInput').value.trim();
    respond('deny', comment || undefined);
  }

  // ESC 关闭弹层
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hideDenyDialog();
  });
</script>
</body>
</html>`;

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    title: "权限闸门 · 危险命令审计",
    resizable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  win.on("closed", () => {
    try {
      if (!existsSync(responseFile)) {
        writeFileSync(responseFile, JSON.stringify({ action: "deny", reason: "window-closed" }));
      }
    } catch {}
    app.quit();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
