import { defineConfig } from "@playwright/test";

// Runs against a running stack (API + web) whose database holds the DEMO tenant
// seeded by server/scripts/seed.ts + seed-demo-extras.ts. Tests run in order on
// one worker because later flows build on the shared DEMO data.
export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    locale: "ar-LY",
    timezoneId: "Africa/Tripoli",
    viewport: { width: 1366, height: 900 },
    trace: "off",
    screenshot: "only-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
});
