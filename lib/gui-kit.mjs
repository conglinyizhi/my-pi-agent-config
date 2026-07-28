// gui-kit.mjs — Electron GUI 骨架
//
// 每个 GUI 只需要写 inject() 回调，返回要注入到 window.__INIT_DATA__ 的数据
//
// 用法：
//   import { createGuiApp } from "#lib/gui-kit";
//   createGuiApp({
//     name: "my-gui",
//     inject: (request) => ({ data: request.data }),
//   });

import { app, BrowserWindow, Menu } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createGuiApp(opts) {
  const { name, width = 1000, height = 700, requestFile, responseFile, inject } = opts;

  if (!requestFile || !responseFile) {
    console.error("Usage: electron app.js <request.json> <response.json>");
    process.exit(1);
  }

  app.whenReady().then(() => {
    const distPath = path.join(__dirname, "dist");
    if (!existsSync(distPath)) {
      console.error(`${name}: dist/ not found. Run the build step first.`);
      app.quit();
      return;
    }

    let request = {};
    try {
      request = JSON.parse(readFileSync(requestFile, "utf-8"));
    } catch {
      writeFileSync(responseFile, JSON.stringify({ cancelled: true }));
      app.quit();
      return;
    }

    const tmpDir = mkdtempSync(path.join(tmpdir(), `${name}-`));
    cpSync(distPath, tmpDir, { recursive: true });
    const tmpHtml = path.join(tmpDir, "index.html");
    let html = readFileSync(tmpHtml, "utf-8");

    // 注入初始化数据 + 调试工具
    const initData = inject(request, { requestFile, responseFile });
    const patch = `<script>window.__INIT_DATA__ = ${JSON.stringify(initData)};</script>
<script>
(function(){
var _on=false;
window.__toggleInspector=function(){_on=!_on;document.body.classList.toggle('__insp',_on);var b=document.getElementById('__insp_badge');if(_on){if(!b){b=document.createElement('div');b.id='__insp_badge';b.style.cssText='position:fixed;top:8px;right:8px;background:#e67e22;color:#fff;padding:4px 12px;border-radius:4px;font-size:12px;z-index:9999;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.5);pointer-events:none';document.body.appendChild(b)}b.textContent='🔍 探测中 — 悬停显示data-name, 点击/C复制, Esc退出'}else{if(b)b.remove()}};
document.addEventListener('mouseover',function(e){if(!_on)return;var t=e.target.closest('[data-name]');if(!t)return;t.style.outline='2px solid #e67e22';t.title='data-name: '+t.getAttribute('data-name')+'\\n点击复制 | C键复制'},true);
document.addEventListener('mouseout',function(e){if(!_on)return;var t=e.target.closest('[data-name]');if(!t)return;t.style.outline=''},true);
document.addEventListener('click',function(e){if(!_on)return;var t=e.target.closest('[data-name]');if(!t)return;e.preventDefault();e.stopPropagation();copyDn(t.getAttribute('data-name'))},true);
document.addEventListener('keydown',function(e){if(!_on)return;if(e.key==='c'||e.key==='C'){var s=document.querySelector('.__insp [data-name]:hover');if(s)copyDn(s.getAttribute('data-name'))}if(e.key==='Escape')window.__toggleInspector()});
function copyDn(n){try{navigator.clipboard.writeText(n);console.log('📋 '+n)}catch(e){console.log(n)}}
})();
</script>`;
    html = html.replace("</head>", `${patch}</head>`);
    writeFileSync(tmpHtml, html, "utf-8");

    const win = new BrowserWindow({
      width, height, title: name,
      autoHideMenuBar: true, resizable: true,
      center: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });

    // 菜单
    const template = [
      {
        label: "调试",
        submenu: [
          {
            label: "🔍 元素探测",
            accelerator: "CmdOrCtrl+Shift+I",
            click: () => win.webContents.executeJavaScript("window.__toggleInspector ? window.__toggleInspector() : console.warn('no insp')"),
          },
          { type: "separator" },
          { role: "toggleDevTools", label: "开发者工具" },
          { role: "reload", label: "重新加载" },
        ],
      },
    ];
    if (process.platform === "darwin") {
      template.unshift({ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));

    win.loadFile(tmpHtml);

    win.once("ready-to-show", () => { const [x, y] = win.getPosition(); win.setPosition(x, y + 60); });

    win.on("closed", () => {
      try {
        if (!existsSync(responseFile)) {
          writeFileSync(responseFile, JSON.stringify({ cancelled: true }));
        }
      } catch {}
      try { rmSync(tmpDir, { recursive: true }); } catch {}
      app.quit();
    });
  });

  app.on("window-all-closed", () => app.quit());
}
