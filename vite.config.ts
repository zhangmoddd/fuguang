import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 浮光前端构建配置。
// 固定端口 + strictPort：Tauri 的 devUrl 依赖固定地址，端口漂移会导致开发模式白屏。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 4173,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // src-tauri 由 cargo 自己监听，前端 watcher 不必扫它，能明显降低 CPU 占用
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri 内置 WebView2 支持现代语法，不需要为老浏览器降级
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
    // 单文件产物更容易被 Tauri 打包命中，减少碎片请求
    chunkSizeWarningLimit: 1200,
  },
});
