import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发时由 `tauri dev` 负责拉起本服务；端口需与 tauri.conf.json 的 devUrl 一致
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
