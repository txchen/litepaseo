import { defineConfig } from "vite-plus";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { outDir: "dist/web" },
  pack: {
    entry: ["src/server/cli.ts"],
    outDir: "dist/server",
    format: "esm",
    platform: "node",
    dts: false,
    outExtensions: () => ({ js: ".mjs" }),
  },
});
