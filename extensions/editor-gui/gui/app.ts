import { createGuiApp } from "#lib/gui-kit";
import { screen } from "electron";

createGuiApp({
  name: "提示词输入 · pi",
  width: 800,
  height: 450,
  inject: (request, { responseFile }) => ({
    clipHistory: request.clipHistory || [],
    responseFile,
  }),
  setupWindow(win) {
    const display = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = display.workAreaSize;
    const [ww, wh] = win.getSize();
    const x = Math.round((sw - ww) / 2);
    const y = Math.round(sh * 0.55 - wh / 2);
    win.setPosition(x, Math.max(0, y));
  },
});
