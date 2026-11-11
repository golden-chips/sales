import { defineConfig } from "vitest/config";
import { testEnv } from "./test/env.js";

// Tests run against a REAL PostgreSQL database (golden_test), connecting as the
// non-superuser golden_app role so RLS is genuinely exercised.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: testEnv,
  },
});
