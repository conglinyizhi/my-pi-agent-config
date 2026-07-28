import { createGuiApp } from "#lib/gui-kit";

createGuiApp({
  name: "TODO 调度 · 三叉戟",
  width: 900,
  height: 640,
  requestFile: process.argv[2],
  responseFile: process.argv[3],
  inject: (request, { responseFile }) => ({
    todos: request.todos,
    responseFile,
  }),
});
