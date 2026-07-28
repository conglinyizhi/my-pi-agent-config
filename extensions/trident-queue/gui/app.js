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

  // 按 provider 分组
  const byProvider = new Map();
  for (const m of models) {
    const [provider, ...rest] = m.value.split(":");
    const modelPart = rest.join(":");
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push({ value: m.value, name: m.name, model: modelPart });
  }

  const providers = [...byProvider.keys()].sort();
  const providerOptions = providers.map(p => `<option value="${escapeAttr(p)}">${escapeHtml(p)} (${byProvider.get(p).length})</option>`).join("");

  // 把所有模型序列化为 JSON 供 JS 使用
  const modelsJson = JSON.stringify(models);
  const rolesJson = JSON.stringify(roles || {});

  const roleDescriptions = {
    oc: "OC Agent — 跟你聊天的入口，需对话质感",
    translator: "翻译工具 — 与 OC 不同厂商",
    planner: "任务拆解 — 架构决策，需聪明",
    worker: "执行层 — 便宜即可",
    reviewer: "审查层 — 便宜即可",
  };

  const roleSelects = ["oc", "translator", "planner", "worker", "reviewer"]
    .map(role => `
    <div class="role-row">
      <div class="role-label">
        <strong>${role}</strong>
        <span class="role-desc">${roleDescriptions[role]}</span>
      </div>
      <select id="sel-${role}" data-role="${role}">
      </select>
    </div>`)
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
  .header h1 { font-size: 16px; color: #4ec9b0; }
  .header .sub { font-size: 12px; color: #888; margin-top: 4px; }

  .filters {
    margin: 8px 20px; display: flex; gap: 10px; align-items: center;
  }
  .filters input, .filters select {
    padding: 8px 12px; height: 36px;
    background: #0d0d1a; border: 1px solid #333;
    border-radius: 4px; color: #e0e0e0; font-size: 13px;
    font-family: inherit;
  }
  .filters input { flex: 1; }
  .filters input:focus, .filters select:focus {
    outline: none; border-color: #4ec9b0;
  }
  .filters .hint { font-size: 11px; color: #666; align-self: center; }

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
    max-width: 100%;
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
  <div class="sub">共 ${models.length} 个可用模型</div>
</div>
<div class="filters">
  <input id="search" placeholder="grep 搜索模型...（支持正则，如 claude|gemini）" oninput="applyFilters()">
  <select id="providerFilter" onchange="applyFilters()">
    <option value="">所有供应商</option>
    ${providerOptions}
  </select>
  <span class="hint">Ctrl+F 聚焦搜索</span>
</div>
<div class="roles">
  ${roleSelects}
</div>
<div class="actions">
  <span class="count" id="matchCount"></span>
  <button class="btn-cancel" onclick="respond({cancelled:true})">取消</button>
  <button class="btn-save" onclick="save()">保存配置</button>
</div>

<script>
  var responded = false;
  var MODELS = ${modelsJson};
  var ROLES = ${rolesJson};

  function respond(payload) {
    if (responded) return;
    responded = true;
    require('fs').writeFileSync(${JSON.stringify(responseFile)}, JSON.stringify(payload));
    window.close();
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 过滤模型
  function getFilteredModels() {
    var q = document.getElementById('search').value.trim();
    var provider = document.getElementById('providerFilter').value;
    var regex = null;
    if (q) {
      try { regex = new RegExp(q, 'i'); } catch(e) { regex = new RegExp(q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'i'); }
    }

    return MODELS.filter(function(m) {
      if (provider && !m.value.startsWith(provider + ':')) return false;
      if (regex && !regex.test(m.value) && !regex.test(m.name)) return false;
      return true;
    });
  }

  // 重建所有 role select 的选项
  function rebuildSelects() {
    // 保存当前选中值
    var savedSelections = {};
    ['oc','translator','planner','worker','reviewer'].forEach(function(role) {
      savedSelections[role] = document.getElementById('sel-' + role).value;
    });

    var filtered = getFilteredModels();
    document.getElementById('matchCount').textContent = filtered.length + ' 个匹配';

    ['oc','translator','planner','worker','reviewer'].forEach(function(role) {
      var sel = document.getElementById('sel-' + role);
      var prevValue = savedSelections[role];

      // 按 provider 分组
      var groups = {};
      filtered.forEach(function(m) {
        var parts = m.value.split(':');
        var provider = parts[0];
        if (!groups[provider]) groups[provider] = [];
        groups[provider].push(m);
      });

      sel.innerHTML = '';

      // 如果之前选了模型且不在过滤结果中，加一条"已选"选项保留它
      if (prevValue && !filtered.find(function(m) { return m.value === prevValue; })) {
        var keepOpt = document.createElement('option');
        keepOpt.value = prevValue;
        keepOpt.textContent = prevValue + '（已选）';
        keepOpt.style.color = '#4ec9b0';
        sel.appendChild(keepOpt);
        if (filtered.length === 0) {
          sel.innerHTML = keepOpt.outerHTML;
          return;
        }
      }

      if (filtered.length === 0) {
        sel.innerHTML = '<option value="">无匹配模型</option>';
        return;
      }

      Object.keys(groups).sort().forEach(function(provider) {
        var optgroup = document.createElement('optgroup');
        optgroup.label = provider;
        groups[provider].forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m.value;
          opt.textContent = m.value + '  —  ' + m.name;
          optgroup.appendChild(opt);
        });
        sel.appendChild(optgroup);
      });

      // 恢复选中值
      if (prevValue && filtered.find(function(m) { return m.value === prevValue; })) {
        sel.value = prevValue;
      }
    });
  }

  function applyFilters() {
    rebuildSelects();
  }

  // 初始状态：为每个 role 预设 ROLES 中的值
  function initSelections() {
    ['oc','translator','planner','worker','reviewer'].forEach(function(role) {
      var sel = document.getElementById('sel-' + role);
      sel.value = ROLES[role] || '';
    });
  }

  function save() {
    var roles = {};
    ['oc','translator','planner','worker','reviewer'].forEach(function(r) {
      roles[r] = document.getElementById('sel-'+r).value;
    });
    respond({ roles: roles });
  }

  // 初始化
  rebuildSelects();
  initSelections();

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
    width: 960,
    height: 600,
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
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
