import { createGuiApp } from "#lib/gui-kit";

createGuiApp({
  name: "三叉戟 · 模型路由配置",
  width: 960,
  height: 600,
  requestFile: process.argv[2],
  responseFile: process.argv[3],
  inject: (request, { responseFile }) => ({
    models: request.models,
    roles: request.roles,
    responseFile,
  }),
});
