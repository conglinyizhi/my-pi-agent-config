import { createGuiApp } from "#lib/gui-kit";

createGuiApp({
  name: "任务确认 · 三叉戟",
  width: 600,
  height: 680,
  requestFile: process.argv[2],
  responseFile: process.argv[3],
  inject: (request, { responseFile }) => ({
    texts: request.texts || [],
    responseFile,
  }),
});
