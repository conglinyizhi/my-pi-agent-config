const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const requestFile = process.argv[2];
const responseFile = process.argv[3];
if (!requestFile || !responseFile) {
  console.error("Usage: electron42 app.js <request.json> <response.json>");
  process.exit(1);
}

function writeResponse(action) {
  fs.writeFileSync(responseFile, JSON.stringify({ action }));
  app.quit();
}

app.whenReady().then(() => {
  const request = JSON.parse(fs.readFileSync(requestFile, "utf-8"));
  const { command, rules } = request;

  const win = new BrowserWindow({
    width: 780,
    height: 480,
    title: "权限闸门 · 危险命令审计",
    resizable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  // Build rule annotations
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
    margin: 12px 20px;
    padding: 14px 16px;
    background: #0d0d1a; border: 1px solid #333;
    border-radius: 6px; font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 14px; line-height: 1.6;
    white-space: pre-wrap; word-break: break-all;
    max-height: 120px; overflow-y: auto;
    color: #4ec9b0;
  }

  .rules {
    flex: 1; overflow-y: auto;
    margin: 0 20px; padding: 0;
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
    transition: background 0.15s;
  }
  .btn-allow { background: #2ecc71; color: #fff; }
  .btn-allow:hover { background: #27ae60; }
  .btn-deny { background: #e74c3c; color: #fff; }
  .btn-deny:hover { background: #c0392b; }
  .btn-reject-all { background: #555; color: #ccc; font-size: 12px; }
  .btn-reject-all:hover { background: #666; }

  .count { font-size: 12px; color: #777; margin-right: auto; align-self: center; }
</style>
</head>
<body>
<div class="header">
  <h1>⚠️ 危险命令审计</h1>
  <div class="sub">以下命令触发了 ${rules.length} 条危险规则</div>
</div>

<pre class="command-box">${escapeHtml(command)}</pre>

<div class="rules">
  <h2>命中规则</h2>
  ${ruleItems}
</div>

<div class="actions">
  <span class="count">${rules.length} 条规则匹配</span>
  <button class="btn-reject-all" onclick="respond('reject-all')">全部拒绝</button>
  <button class="btn-deny" onclick="respond('deny')">拒绝</button>
  <button class="btn-allow" onclick="respond('allow')">✓ 允许执行</button>
</div>

<script>
  const { ipcRenderer } = require('electron');
  function respond(action) {
    require('fs').writeFileSync(${JSON.stringify(responseFile)}, JSON.stringify({ action }));
    ipcRenderer.send('respond', action);
  }
</script>
</body>
</html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  ipcMain.on("respond", (_e, action) => {
    writeResponse(action);
  });
});

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

app.on("window-all-closed", () => {
  // If user closes window without clicking button, write deny
  if (fs.existsSync(requestFile) && !fs.existsSync(responseFile)) {
    writeResponse("window-closed");
  }
  app.quit();
});
