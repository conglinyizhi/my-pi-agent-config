import {defineConfig} from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  // 相对路径：Electron 用 file:// 直接加载 dist，绝对路径（默认的 "/"）会取不到资源。
  // Wails 的资产服务在根路径下，相对路径同样成立，两边共用一份产物。
  base: "./",
  plugins: [vue()]
})
