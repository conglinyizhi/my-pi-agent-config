// ../../../lib/gui-kit.mjs
import { app, BrowserWindow, Menu } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
var __dirname = path.dirname(fileURLToPath(import.meta.url));
function createGuiApp(opts) {
  const { name, width = 1e3, height = 700, requestFile, responseFile, inject } = opts;
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
    const initData = inject(request, { requestFile, responseFile });
    const patch = `<script>window.__INIT_DATA__ = ${JSON.stringify(initData)};</script>
<script>
(function(){
var _on=false;
window.__toggleInspector=function(){_on=!_on;document.body.classList.toggle('__insp',_on);var b=document.getElementById('__insp_badge');if(_on){if(!b){b=document.createElement('div');b.id='__insp_badge';b.style.cssText='position:fixed;top:8px;right:8px;background:#e67e22;color:#fff;padding:4px 12px;border-radius:4px;font-size:12px;z-index:9999;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.5);pointer-events:none';document.body.appendChild(b)}b.textContent='\u{1F50D} \u63A2\u6D4B\u4E2D \u2014 \u60AC\u505C\u663E\u793Adata-name, \u70B9\u51FB/C\u590D\u5236, Esc\u9000\u51FA'}else{if(b)b.remove()}};
document.addEventListener('mouseover',function(e){if(!_on)return;var t=e.target.closest('[data-name]');if(!t)return;t.style.outline='2px solid #e67e22';t.title='data-name: '+t.getAttribute('data-name')+'\\n\u70B9\u51FB\u590D\u5236 | C\u952E\u590D\u5236'},true);
document.addEventListener('mouseout',function(e){if(!_on)return;var t=e.target.closest('[data-name]');if(!t)return;t.style.outline=''},true);
document.addEventListener('click',function(e){if(!_on)return;var t=e.target.closest('[data-name]');if(!t)return;e.preventDefault();e.stopPropagation();copyDn(t.getAttribute('data-name'))},true);
document.addEventListener('keydown',function(e){if(!_on)return;if(e.key==='c'||e.key==='C'){var s=document.querySelector('.__insp [data-name]:hover');if(s)copyDn(s.getAttribute('data-name'))}if(e.key==='Escape')window.__toggleInspector()});
function copyDn(n){try{navigator.clipboard.writeText(n);console.log('\u{1F4CB} '+n)}catch(e){console.log(n)}}
})();
</script>`;
    html = html.replace("</head>", `${patch}</head>`);
    writeFileSync(tmpHtml, html, "utf-8");
    const win = new BrowserWindow({
      width,
      height,
      title: name,
      autoHideMenuBar: true,
      resizable: true,
      center: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    const template = [
      {
        label: "\u8C03\u8BD5",
        submenu: [
          {
            label: "\u{1F50D} \u5143\u7D20\u63A2\u6D4B",
            accelerator: "CmdOrCtrl+Shift+I",
            click: () => win.webContents.executeJavaScript("window.__toggleInspector ? window.__toggleInspector() : console.warn('no insp')")
          },
          { type: "separator" },
          { role: "toggleDevTools", label: "\u5F00\u53D1\u8005\u5DE5\u5177" },
          { role: "reload", label: "\u91CD\u65B0\u52A0\u8F7D" }
        ]
      }
    ];
    if (process.platform === "darwin") {
      template.unshift({ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    win.loadFile(tmpHtml);
    win.once("ready-to-show", () => {
      const [x, y] = win.getPosition();
      win.setPosition(x, y + 60);
    });
    win.on("closed", () => {
      try {
        if (!existsSync(responseFile)) {
          writeFileSync(responseFile, JSON.stringify({ cancelled: true }));
        }
      } catch {
      }
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
      }
      app.quit();
    });
  });
  app.on("window-all-closed", () => app.quit());
}

// app.ts
createGuiApp({
  name: "\u4EFB\u52A1\u786E\u8BA4 \xB7 \u4E09\u53C9\u621F",
  width: 600,
  height: 680,
  requestFile: process.argv[2],
  responseFile: process.argv[3],
  inject: (request, { responseFile }) => ({
    texts: request.texts || [],
    responseFile
  })
});
