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

// 解析 electron 启动参数中的 request/response 文件路径。
// 不能假设固定在 process.argv[2]/[3]：/usr/bin/electron* 可能是 wrapper 脚本，
// 会把 ~/.config/electron-flags.conf 里的开关参数（如 --ozone-platform-hint=auto）
// 插到参数最前面，脚本路径因此被挤到 argv[4] 之后。
// 做法：按脚本自身路径定位，跳过所有开关参数；取脚本之后的两个位置参数。
function resolveCliArgs(argv) {
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptIdx = argv.findIndex((a) => a === scriptPath);
  if (scriptIdx >= 0) {
    return { requestFile: argv[scriptIdx + 1], responseFile: argv[scriptIdx + 2] };
  }
  // fallback：跳过 electron 二进制与所有开关参数，剩下的前两个是 request/response
  const rest = argv.slice(1).filter((a) => !a.startsWith("-"));
  return { requestFile: rest[1], responseFile: rest[2] };
}

export function createGuiApp(opts) {
  const { name, width = 1000, height = 700, inject, setupWindow } = opts;
  const { requestFile, responseFile } = resolveCliArgs(process.argv);

  if (!requestFile || !responseFile) {
    console.error("Usage: electron app.js <request.json> <response.json>");
    process.exit(1);
  }

  // 主进程异常上报：console.error 输出 + 写 <responseFile>.error sidecar。
  // Electron 的 uncaughtException 默认只弹原生对话框不打日志，自动化（fasttest）
  // 抓不到；sidecar 让异常可被检测，同时避免模态框阻断窗口关闭流程。
  const errorFile = `${responseFile}.error`;
  const reportError = (err) => {
    const msg = err instanceof Error ? (err.stack || err.message) : String(err);
    console.error(`[gui-kit:${name}] ${msg}`);
    try {
      writeFileSync(errorFile, msg, "utf-8");
    } catch {}
  };
  process.on("uncaughtException", reportError);
  process.on("unhandledRejection", reportError);

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

    // 渲染就绪上报：轮询 #app 是否挂载（Vue mount 完成），结果写 <responseFile>.ready
    // ok = 已挂载；empty = 页面加载但 #app 无内容（renderer JS 报错时会出现）
    // 供 fasttest 等自动化检测，正常使用时无人读取、随 tmpDir 清理，无副作用
    win.webContents.on("did-finish-load", () => {
      let tries = 0;
      const check = setInterval(async () => {
        try {
          const mounted = await win.webContents.executeJavaScript(
            `(() => { const el = document.getElementById('app'); return !!(el && el.children.length > 0); })()`
          );
          if (mounted) {
            clearInterval(check);
            writeFileSync(`${responseFile}.ready`, "ok", "utf-8");
          } else if (++tries >= 50) {
            clearInterval(check);
            writeFileSync(`${responseFile}.ready`, "empty", "utf-8");
          }
        } catch {
          clearInterval(check);
        }
      }, 200);
    });

    win.once("ready-to-show", () => {
      if (setupWindow) {
        setupWindow(win);
      } else {
        const [x, y] = win.getPosition();
        win.setPosition(x, y + 60);
      }
    });

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
