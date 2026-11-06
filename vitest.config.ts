import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          DISCORD_APPLICATION_ID: "100000000000000001",
          DISCORD_BOT_TOKEN: "test-bot-token",
          DISCORD_PUBLIC_KEY: "0".repeat(64),
          DISCORD_API_BASE: "https://discord.test/api/v10",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
