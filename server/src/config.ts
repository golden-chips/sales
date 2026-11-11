// All configuration comes from the environment. No secrets in source code.
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see docs/ENVIRONMENT_VARIABLES.md)`);
  return v;
}
function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: num("PORT", 4000),
  host: process.env.HOST ?? "0.0.0.0",
  /** runtime connection — MUST be the non-superuser golden_app role so RLS applies */
  databaseUrl: req("DATABASE_URL"),
  jwtSecret: req("JWT_SECRET"),
  platformJwtSecret: req("PLATFORM_JWT_SECRET"),
  accessTokenTtlSec: num("ACCESS_TOKEN_TTL_SEC", 15 * 60),
  refreshTokenTtlSec: num("REFRESH_TOKEN_TTL_SEC", 7 * 24 * 3600),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
  globalRateLimitPerMin: num("RATE_LIMIT_PER_MIN", 300),
  loginRateLimitPerMin: num("LOGIN_RATE_LIMIT_PER_MIN", 10),
  logLevel: process.env.LOG_LEVEL ?? "info",
};

export function assertSecretsStrong() {
  for (const [k, v] of [["JWT_SECRET", config.jwtSecret], ["PLATFORM_JWT_SECRET", config.platformJwtSecret]] as const) {
    if (v.length < 32) throw new Error(`${k} must be at least 32 characters`);
  }
  if (config.jwtSecret === config.platformJwtSecret) throw new Error("JWT_SECRET and PLATFORM_JWT_SECRET must differ");
}
