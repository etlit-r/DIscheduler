/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env as AppEnv } from "../src/env";
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
    }
  }
}
