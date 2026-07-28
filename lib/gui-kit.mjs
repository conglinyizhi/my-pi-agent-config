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

import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 启动一个 Electron GUI 窗口。
 *
 * @param {object} opts
 * @param {string} opts.name - GUI 名称，用于 tmp 目录前缀和窗口标题
 * @param {number} [opts.width=1000] - 窗口宽度
 * @param {number} [opts.height=700] - 窗口高度
 * @param {string} opts.requestFile - argv[2]
 * @param {string} opts.responseFile - argv[3]
 * @param {(request: any) => object} opts.inject - 接收解析后的请求数据，返回注入到 HTML 的数据
 */
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

    // 读请求
    let request = {};
    try {
      request = JSON.parse(readFileSync(requestFile, "utf-8"));
    } catch {
      writeFileSync(responseFile, JSON.stringify({ cancelled: true }));
      app.quit();
      return;
    }

    // 复制 dist/ 到 temp 并注入数据
    const tmpDir = mkdtempSync(path.join(tmpdir(), `${name}-`));
    cpSync(distPath, tmpDir, { recursive: true });
    const tmpHtml = path.join(tmpDir, "index.html");
    let html = readFileSync(tmpHtml, "utf-8");

    const initData = inject(request, { requestFile, responseFile });
    const initScript = `<script>window.__INIT_DATA__ = ${JSON.stringify(initData)};</script>
<script>document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.shiftKey&&e.key==='I'){const a=document.body.classList.toggle('_inspect');console.log(a?'🔍 Inspect ON — hover to see data-name':'🔍 Inspect OFF')}});document.addEventListener('mouseover',e=>{if(!document.body.classList.contains('_inspect'))return;const t=e.target.closest('[data-name]');if(!t)return;const n=t.getAttribute('data-name');t.title=n;t.style.outline='2px solid #e67e22'},true);document.addEventListener('mouseout',e=>{if(!document.body.classList.contains('_inspect'))return;const t=e.target.closest('[data-name]');if(!t)return;t.style.outline=''},true);document.addEventListener('click',e=>{if(!document.body.classList.contains('_inspect'))return;e.preventDefault();e.stopPropagation();const t=e.target.closest('[data-name]');if(!t)return;const n=t.getAttribute('data-name');navigator.clipboard?.writeText(n);console.log('📋 Copied data-name:', n)},true);</script>`;
    html = html.replace("</head>", `${initScript}</head>`);
    writeFileSync(tmpHtml, html, "utf-8");

    const win = new BrowserWindow({
      width,
      height,
      title: name,
      autoHideMenuBar: true,
      resizable: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });

    win.loadFile(tmpHtml);

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
