import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tauriConfig from "./src-tauri/tauri.conf.json" with { type: "json" };

const developmentCsp = Object.entries(tauriConfig.app.security.devCsp)
  .map(([directive, sources]) => `${directive} ${sources.join(" ")}`)
  .join("; ");

// Tauri 开发时由 `tauri dev` 负责拉起本服务；端口需与 tauri.conf.json 的 devUrl 一致
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // 桌面端 tauri dev 直接加载 Vite URL，必须由 Vite 自己返回 CSP header。
    headers: { "Content-Security-Policy": developmentCsp },
  },
  build: {
    target: "es2022",
  },
  test: {
    // makepkg 的忽略构建目录可能包含一份源码副本，不能重复收集其中的测试。
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
