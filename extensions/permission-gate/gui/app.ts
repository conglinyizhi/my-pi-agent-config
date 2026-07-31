import { createGuiApp } from "#lib/gui-kit";

createGuiApp({
  name: "权限闸门 · 危险命令审计",
  width: 800,
  height: 520,
  inject: (request, { responseFile }) => ({
    command: request.command,
    taskId: request.taskId || null,
    rules: request.rules,
    responseFile,
  }),
});
