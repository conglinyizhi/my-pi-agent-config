import { app, BrowserWindow } from "electron";
import { loadRequest } from "#lib/electron-gui";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, cpSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const distPath = path.join(__dirname, "dist");

  if (!existsSync(distPath)) {
    console.error("dist/ not found. Run: pnpm build:gui-editor");
    app.quit();
    return;
  }

  // 复制 dist/ 到 temp 目录并注入初始数据
  const tmpDir = mkdtempSync(path.join(tmpdir(), "edit-gui-vue-"));
  cpSync(distPath, tmpDir, { recursive: true });

  const tmpHtml = path.join(tmpDir, "index.html");
  let html = readFileSync(tmpHtml, "utf-8");
  const initScript = `<script>window.__INIT_DATA__ = ${JSON.stringify({
    clipHistory: clipHistory || [],
    file: file || null,
    responseFile,
  })};</script>`;
  html = html.replace("</head>", `${initScript}</head>`);
  writeFileSync(tmpHtml, html, "utf-8");

  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    title: "编辑 · pi",
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
