import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 独立浏览器入口，避免 Wails production build 把 browser.html 打进嵌入资源。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: "dist-browser",
    emptyOutDir: true,
    rollupOptions: { input: "browser.html" },
  },
});
