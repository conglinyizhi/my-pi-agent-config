import { defineConfig } from "@rsbuild/core";
import { pluginVue } from "@rsbuild/plugin-vue";

export default defineConfig({
  plugins: [pluginVue()],
  source: {
    entry: { index: "./renderer/index.ts" },
  },
  output: {
    distPath: { root: "dist" },
    filenameHash: false,
    cleanDistPath: true,
    assetPrefix: "./",
  },
  html: {
    template: "./renderer/index.html",
    title: "提示词编辑 · pi",
  },
});
