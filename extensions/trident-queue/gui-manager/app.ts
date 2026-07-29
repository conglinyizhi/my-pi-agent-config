import { createGuiApp } from "#lib/gui-kit";

createGuiApp({
  name: "舰队事项 · 三叉戟",
  width: 800,
  height: 600,
  requestFile: process.argv[2],
  responseFile: process.argv[3],
  inject: (request, { responseFile }) => ({
    tasks: request.tasks,
    responseFile,
  }),
});
