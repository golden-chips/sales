// Test environment — synthetic secrets only, never production values.
export const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_ADMIN_URL: process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://golden_owner:devpass@localhost:5432/golden_test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://golden_app:test_app_pw@localhost:5432/golden_test",
  APP_DB_PASSWORD: process.env.TEST_APP_DB_PASSWORD ?? "test_app_pw",
  JWT_SECRET: "test-jwt-secret-0123456789abcdef0123456789",
  PLATFORM_JWT_SECRET: "test-platform-secret-0123456789abcdef01234",
  LOG_LEVEL: "silent",
  RATE_LIMIT_PER_MIN: "100000",
  LOGIN_RATE_LIMIT_PER_MIN: "100000",
};
