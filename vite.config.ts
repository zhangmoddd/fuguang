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
    // 调高警告阈值。前端整包 gzip 后不到 100 KB，
    // 默认 500 KB 的阈值对我们没有意义。
    // （注意：这里**不**产出单文件 —— 产物是 index.html + 一个 js + 一个 css，
    //   Tauri 会把整个 dist 内嵌进 exe，不需要为请求数做优化。）
    chunkSizeWarningLimit: 1200,
  },
});
