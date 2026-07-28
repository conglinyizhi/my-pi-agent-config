import { createGuiApp } from "#lib/gui-kit";

createGuiApp({
  name: "权限闸门 · 危险命令审计",
  width: 800,
  height: 520,
  requestFile: process.argv[2],
  responseFile: process.argv[3],
  inject: (request, { responseFile }) => ({
    command: request.command,
    rules: request.rules,
    responseFile,
  }),
});
