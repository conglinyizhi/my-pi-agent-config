import { createGuiApp } from "#lib/gui-kit";

createGuiApp({
  name: "提示词编辑 · pi",
  width: 1100,
  height: 700,
  requestFile: process.argv[2],
  responseFile: process.argv[3],
  inject: (request, { responseFile }) => ({
    clipHistory: request.clipHistory || [],
    file: request.file || null,
    responseFile,
  }),
});
