import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { AppError } from "./core/errors.js";
import { platformRoutes } from "./modules/platform/platform.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { iamRoutes } from "./modules/iam/iam.routes.js";
import { orgRoutes } from "./modules/org/org.routes.js";
import { auditRoutes } from "./modules/audit/audit.routes.js";
import { accountingRoutes } from "./modules/accounting/accounting.routes.js";
import { masterDataRoutes } from "./modules/erp/masterdata.routes.js";
import { documentRoutes } from "./modules/erp/documents.routes.js";
import { erpReportRoutes } from "./modules/erp/reports.routes.js";
import { mfgRoutes } from "./modules/mfg/mfg.routes.js";
import { fieldRoutes } from "./modules/field/field.routes.js";
import { importRoutes } from "./modules/import/import.routes.js";
import { hrRoutes, iclockRoutes } from "./modules/hr/hr.routes.js";
import { pool } from "./db/pool.js";

const PG_MAP: Record<string, [number, string, string, string]> = {
  P0001: [422, "BUSINESS_RULE", "", ""],
  "23505": [409, "DUPLICATE", "القيمة موجودة مسبقًا", "Duplicate value"],
  "23503": [422, "INVALID_REFERENCE", "مرجع غير صالح أو مستخدم في سجلات أخرى", "Invalid or in-use reference"],
  "23514": [422, "CONSTRAINT_VIOLATION", "البيانات تخالف قواعد النظام", "Data violates a system rule"],
  "23P01": [409, "OVERLAP", "تداخل مع سجل موجود", "Overlaps an existing record"],
  "42501": [403, "FORBIDDEN", "غير مسموح", "Not allowed"],
  "22P02": [422, "INVALID_INPUT", "قيمة غير صالحة", "Invalid input value"],
};

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel, redact: ["req.headers.authorization", "req.headers.cookie"] },
    genReqId: (req) => (typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].slice(0, 64) : randomUUID()),
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  // zod is the single source of validation (see core/http.ts::parse); route
  // JSON schemas exist only to document the API in OpenAPI.
  app.setValidatorCompiler(() => () => true);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.corsOrigins, credentials: false });
  await app.register(rateLimit, { max: config.globalRateLimitPerMin, timeWindow: "1 minute" });

  await app.register(swagger, {
    openapi: {
      info: { title: "GOLDEN ERP API", version: "1.0.0", description: "Multi-tenant SaaS ERP. All tenant endpoints require `Authorization: Bearer <access token>`; unsafe operations accept `Idempotency-Key`." },
      servers: [{ url: "/" }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
      security: [{ bearer: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/api/docs" });

  app.addHook("onSend", async (req, reply) => { reply.header("x-request-id", req.id); });

  app.setErrorHandler((err: FastifyError & { code?: string }, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, message_ar: err.messageAr, details: err.details ?? null, requestId: req.id } });
    }
    const pgCode = (err as any).code as string | undefined;
    if (pgCode && PG_MAP[pgCode]) {
      const [status, code, ar, en] = PG_MAP[pgCode];
      const msg = pgCode === "P0001" ? err.message : en;
      req.log.info({ pgCode, constraint: (err as any).constraint }, "db rule");
      return reply.code(status).send({ error: { code, message: msg, message_ar: ar || msg, details: (err as any).constraint ? { constraint: (err as any).constraint } : null, requestId: req.id } });
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests", message_ar: "طلبات كثيرة، حاول لاحقًا", requestId: req.id } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: "BAD_REQUEST", message: err.message, message_ar: "طلب غير صالح", requestId: req.id } });
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal server error", message_ar: "خطأ داخلي في الخادم", requestId: req.id } });
  });

  app.get("/health", { schema: { hide: true } }, async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  await app.register(async (v1) => {
    await v1.register(platformRoutes, { prefix: "/platform" });
    await v1.register(authRoutes, { prefix: "/auth" });
    await v1.register(iamRoutes);
    await v1.register(orgRoutes);
    await v1.register(auditRoutes);
    await v1.register(accountingRoutes, { prefix: "/accounting" });
    await v1.register(masterDataRoutes);
    await v1.register(documentRoutes);
    await v1.register(erpReportRoutes);
    await v1.register(mfgRoutes);
    await v1.register(fieldRoutes);
    await v1.register(importRoutes);
    await v1.register(hrRoutes);
  }, { prefix: "/api/v1" });
  // fingerprint devices (ZKTeco iclock/ADMS) post to a fixed path at the server root
  await app.register(iclockRoutes);

  return app;
}
