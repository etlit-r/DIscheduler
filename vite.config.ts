import { defineConfig } from "vite";

// Web 画面（S1〜S5・S7）を public/app/ にビルドする（docs/design.md §11）
export default defineConfig({
  root: "web",
  base: "/app/",
  publicDir: false,
  build: {
    outDir: "../public/app",
    emptyOutDir: true,
    // CSP（script-src 'self'）を守るため、インラインのスクリプトを出さない
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
