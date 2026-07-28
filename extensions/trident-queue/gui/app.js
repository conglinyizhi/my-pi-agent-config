import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "fs";

const requestFile = process.argv[2];
const responseFile = process.argv[3];
if (!requestFile || !responseFile) {
  console.error("Usage: electron app.js <request.json> <response.json>");
  process.exit(1);
}

app.whenReady().then(() => {
  let request;
  try {
    request = JSON.parse(readFileSync(requestFile, "utf-8"));
  } catch {
    writeFileSync(responseFile, JSON.stringify({ cancelled: true }));
    app.quit();
    return;
  }

  const { models, roles } = request;

  // 构建模型选项（带搜索）
  const modelOptions = models
    .map(m => `<option value="${escapeAttr(m.value)}">${escapeHtml(m.value)}  —  ${escapeHtml(m.name || m.id)}</option>`)
    .join("");

  const roleDescriptions = {
    oc: "OC Agent — 跟你聊天的入口，需要对话质感",
    translator: "翻译工具 — 与 OC 不同厂商，形成双视角",
    planner: "任务拆解 — 架构决策，需聪明模型",
    worker: "执行层 — 按计划干活，便宜即可",
    reviewer: "审查层 — diff 检查，便宜即可",
  };

  const roleSelects = ["oc", "translator", "planner", "worker", "reviewer"]
    .map(role => {
      const current = roles[role] || "";
      return `
    <div class="role-row">
      <div class="role-label">
        <strong>${role}</strong>
        <span class="role-desc">${roleDescriptions[role]}</span>
      </div>
      <select id="sel-${role}" data-role="${role}">
        ${modelOptions.replace(
          `value="${escapeAttr(current)}"`,
          `value="${escapeAttr(current)}" selected`
        )}
      </select>
    </div>`;
    })
    .join("");

  const modelCount = models.length;
  const winHeight = Math.min(200 + 5 * 70 + 80, 700);
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
  .header h1 { font-size: 16px; color: #4ec9b0; }
  .header .sub { font-size: 12px; color: #888; margin-top: 4px; }

  .search-box {
    margin: 8px 20px;
    padding: 8px 12px;
    background: #0d0d1a; border: 1px solid #333;
    border-radius: 4px; color: #e0e0e0; font-size: 13px;
    font-family: inherit;
  }
  .search-box:focus { outline: none; border-color: #4ec9b0; }

  .roles {
    flex: 1; overflow-y: auto; margin: 0 20px;
  }
  .role-row {
    padding: 10px 0; border-bottom: 1px solid #2a2a4a;
    display: flex; gap: 12px; align-items: center;
  }
  .role-label {
    display: flex; flex-direction: column; min-width: 100px;
  }
  .role-label strong { font-size: 14px; color: #4ec9b0; }
  .role-desc { font-size: 11px; color: #888; margin-top: 2px; }
  .role-row select {
    flex: 1; padding: 8px 10px;
    background: #0d0d1a; border: 1px solid #333; border-radius: 4px;
    color: #e0e0e0; font-size: 13px; font-family: inherit;
  }
  .role-row select:focus { outline: none; border-color: #4ec9b0; }

  .actions {
    padding: 12px 20px; border-top: 1px solid #2a2a4a;
    display: flex; gap: 10px; justify-content: flex-end;
  }
  button {
    padding: 10px 28px; border: none; border-radius: 4px;
    font-size: 14px; cursor: pointer; font-family: inherit;
  }
  .btn-save { background: #2ecc71; color: #fff; }
  .btn-save:hover { background: #27ae60; }
  .btn-cancel { background: #555; color: #ccc; }
  .btn-cancel:hover { background: #666; }
  .count { font-size: 12px; color: #777; margin-right: auto; align-self: center; }
</style>
</head>
<body>
<div class="header">
  <h1>⚓ 三叉戟 · 模型路由配置</h1>
  <div class="sub">${modelCount} 个可用模型 — 为每个角色选择模型</div>
</div>
<input class="search-box" id="search" placeholder="搜索模型..." oninput="onSearch()">
<div class="roles">
  ${roleSelects}
</div>
<div class="actions">
  <span class="count">${modelCount} 个模型</span>
  <button class="btn-cancel" onclick="respond({cancelled:true})">取消</button>
  <button class="btn-save" onclick="save()">保存配置</button>
</div>

<script>
  var responded = false;

  function respond(payload) {
    if (responded) return;
    responded = true;
    require('fs').writeFileSync(${JSON.stringify(responseFile)}, JSON.stringify(payload));
    window.close();
  }

  function save() {
    var roles = {};
    ['oc','translator','planner','worker','reviewer'].forEach(function(r) {
      roles[r] = document.getElementById('sel-'+r).value;
    });
    respond({ roles: roles });
  }

  // 搜索过滤
  function onSearch() {
    var q = document.getElementById('search').value.toLowerCase();
    document.querySelectorAll('.role-row select option').forEach(function(opt) {
      var text = (opt.textContent || '').toLowerCase();
      opt.style.display = !q || text.includes(q) ? '' : 'none';
    });
  }

  // 键盘快捷键
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') respond({cancelled:true});
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      document.getElementById('search').focus();
    }
  });
</script>
</body>
</html>`;

  const win = new BrowserWindow({
    width: 900,
    height: winHeight,
    title: "三叉戟 · 模型路由配置",
    resizable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  win.on("closed", () => {
    try {
      const fs = require("fs");
      if (!fs.existsSync(responseFile)) {
        writeFileSync(responseFile, JSON.stringify({ cancelled: true }));
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
