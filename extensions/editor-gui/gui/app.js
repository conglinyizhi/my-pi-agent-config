import { app, BrowserWindow } from "electron";
import { loadRequest } from "../../../lib/electron-gui.mjs";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const requestFile = process.argv[2];
const responseFile = process.argv[3];
if (!requestFile || !responseFile) {
  console.error("Usage: electron app.js <request.json> <response.json>");
  process.exit(1);
}

app.whenReady().then(() => {
  const request = loadRequest(requestFile, responseFile);
  if (!request) { app.quit(); return; }

  const { clipHistory, file } = request;

  // 构建历史条目 HTML
  const historyItems = (clipHistory || []).map((text, i) => {
    const preview = text.slice(0, 120).replace(/\n/g, "↵ ");
    const previewHtml = escapeHtml(preview);
    const fullHtml = escapeHtml(text);
    return `<div class="hist-item" data-index="${i}" onclick="selectHist(${i})">
      <div class="hist-preview">${previewHtml}</div>
      <div class="hist-meta">#${i + 1}  ${text.length} 字符</div>
    </div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "Microsoft YaHei", monospace;
    background: #1a1a2e; color: #e0e0e0;
    display: flex; height: 100vh; overflow: hidden;
  }
  .sidebar {
    width: 280px; border-right: 1px solid #2a2a4a;
    display: flex; flex-direction: column;
  }
  .sidebar-tabs {
    display: flex; border-bottom: 1px solid #2a2a4a;
  }
  .sidebar-tabs button {
    flex: 1; padding: 10px; background: transparent;
    border: none; color: #888; font-size: 13px; cursor: pointer;
    font-family: inherit;
  }
  .sidebar-tabs button.active { color: #4ec9b0; border-bottom: 2px solid #4ec9b0; }
  .sidebar-list { flex: 1; overflow-y: auto; }
  .tab-content { display: none; height: 100%; }
  .tab-content.active { display: flex; flex-direction: column; }

  .hist-item {
    padding: 10px 12px; border-bottom: 1px solid #1f1f3a;
    cursor: pointer;
  }
  .hist-item:hover { background: #16213e; }
  .hist-item.selected { background: #1a3a5c; border-left: 3px solid #4ec9b0; }
  .hist-preview {
    font-size: 12px; color: #ccc; line-height: 1.5;
    white-space: pre-wrap; word-break: break-all;
    max-height: 3.6em; overflow: hidden;
  }
  .hist-meta { font-size: 10px; color: #666; margin-top: 4px; }

  .file-row {
    padding: 8px 12px; border-bottom: 1px solid #1f1f3a;
    cursor: pointer; font-size: 12px; color: #ccc;
  }
  .file-row:hover { background: #16213e; }

  .main {
    flex: 1; display: flex; flex-direction: column;
  }
  .main-header {
    padding: 8px 16px; border-bottom: 1px solid #2a2a4a;
    font-size: 12px; color: #888;
  }
  .editor {
    flex: 1; padding: 0;
  }
  .editor textarea {
    width: 100%; height: 100%; padding: 16px;
    background: #0d0d1a; border: none; color: #e0e0e0;
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 14px; line-height: 1.7;
    resize: none; outline: none;
  }
  .actions {
    padding: 8px 16px; border-top: 1px solid #2a2a4a;
    display: flex; gap: 8px; justify-content: flex-end;
  }
  button {
    padding: 8px 20px; border: none; border-radius: 4px;
    font-size: 13px; cursor: pointer; font-family: inherit;
  }
  .btn-save { background: #2ecc71; color: #fff; }
  .btn-save:hover { background: #27ae60; }
  .btn-restore { background: #3498db; color: #fff; }
  .btn-restore:hover { background: #2980b9; }
  .btn-cancel { background: #555; color: #ccc; }
  .btn-cancel:hover { background: #666; }
</style>
</head>
<body>
<div class="sidebar">
  <div class="sidebar-tabs">
    <button class="active" onclick="switchTab('history', this)">📋 历史</button>
    <button onclick="switchTab('file', this)">📁 文件</button>
  </div>
  <div class="sidebar-list">
    <div id="tab-history" class="tab-content active">
      ${historyItems || '<div style="padding:16px;color:#666;font-size:13px">暂无 Ctrl+C 历史</div>'}
    </div>
    <div id="tab-file" class="tab-content">
      <div style="padding:16px">
        <input id="filePath" style="width:100%;padding:8px;background:#0d0d1a;border:1px solid #333;border-radius:4px;color:#e0e0e0;font-size:13px;font-family:inherit" placeholder="输入文件路径...">
        <button onclick="openFile()" style="margin-top:8px;padding:6px 16px;background:#3498db;color:#fff;border:none;border-radius:4px;cursor:pointer">打开</button>
      </div>
    </div>
  </div>
</div>
<div class="main">
  <div class="main-header" id="mainHeader">Ctrl+C 历史 — 点击恢复</div>
  <div class="editor">
    <textarea id="editor" spellcheck="false"></textarea>
  </div>
  <div class="actions">
    <span id="fileInfo" style="font-size:11px;color:#666;margin-right:auto;align-self:center"></span>
    <button class="btn-restore" onclick="restoreToPi()">↩ 恢复到 pi</button>
    <button class="btn-save" onclick="saveFile()">💾 保存</button>
    <button class="btn-cancel" onclick="respond({cancelled:true})">取消</button>
  </div>
</div>

<script>
  var _responded = false;
  var _currentFile = ${JSON.stringify(file || null)};
  var _allHistory = ${JSON.stringify(clipHistory || [])};

  function respond(payload) {
    if (_responded) return;
    _responded = true;
    require('fs').writeFileSync(${JSON.stringify(responseFile)}, JSON.stringify(payload));
    window.close();
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 切换侧边栏标签
  function switchTab(tab, btn) {
    document.querySelectorAll('.sidebar-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
  }

  // 选择历史条目
  var _selectedHistIndex = -1;
  function selectHist(index) {
    document.querySelectorAll('.hist-item').forEach(el => el.classList.remove('selected'));
    document.querySelector('.hist-item[data-index="' + index + '"]')?.classList.add('selected');
    _selectedHistIndex = index;
    _currentFile = null;
    document.getElementById('editor').value = _allHistory[index] || '';
    document.getElementById('mainHeader').textContent = 'Ctrl+C 历史 #' + (index + 1);
    document.getElementById('fileInfo').textContent = '';
  }

  // 打开文件
  function openFile() {
    var p = document.getElementById('filePath').value.trim();
    if (!p) return;
    try {
      var content = require('fs').readFileSync(p, 'utf-8');
      document.getElementById('editor').value = content;
      _currentFile = p;
      _selectedHistIndex = -1;
      document.querySelectorAll('.hist-item').forEach(el => el.classList.remove('selected'));
      document.getElementById('mainHeader').textContent = p;
      document.getElementById('fileInfo').textContent = '已加载 ' + content.length + ' 字符';
    } catch(e) {
      document.getElementById('fileInfo').textContent = '错误: ' + e.message;
    }
  }

  // 保存文件
  function saveFile() {
    if (!_currentFile) {
      document.getElementById('fileInfo').textContent = '请先打开一个文件';
      return;
    }
    try {
      require('fs').writeFileSync(_currentFile, document.getElementById('editor').value, 'utf-8');
      document.getElementById('fileInfo').textContent = '已保存';
    } catch(e) {
      document.getElementById('fileInfo').textContent = '保存失败: ' + e.message;
    }
  }

  // 恢复到 pi 编辑器
  function restoreToPi() {
    var text = document.getElementById('editor').value;
    if (!text.trim()) return;
    respond({ action: 'restore', text: text });
  }

  // 初始：如果有文件，打开它；否则显示最新一条历史
  if (_currentFile) {
    openFile();
  } else if (_allHistory.length > 0) {
    selectHist(0);
  }

  // Ctrl+S 保存
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveFile();
    }
    if (e.key === 'Escape') respond({cancelled:true});
  });
</script>
</body>
</html>`;

  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    title: "编辑 · pi",
    resizable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  win.on("closed", () => {
    try {
      if (!require("fs").existsSync(responseFile)) {
        writeFileSync(responseFile, JSON.stringify({ cancelled: true }));
      }
    } catch {}
    app.quit();
  });
});

app.on("window-all-closed", () => app.quit());

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
