import { createGuiApp } from "#lib/gui-kit";

createGuiApp({
  name: "TODO 调度 · 三叉戟",
  width: 900,
  height: 640,
  inject: (request, { responseFile }) => ({
    todos: request.todos,
    responseFile,
  }),
});
