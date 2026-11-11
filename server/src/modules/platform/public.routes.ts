// Public (unauthenticated) endpoints: pricing and self-service trial signup.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { withAnonymous, withPlatform, withPlatformInTenant } from "../../db/pool.js";
import { parse } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { provisionTenant } from "./platform.service.js";
import { seedChartOfAccounts, createFiscalYear } from "../accounting/accounting.service.js";
import { loadUserCtx } from "../../core/auth.js";
import { newOpaqueToken, sha256, signAccess } from "../../core/security.js";
import { config } from "../../config.js";

const T = { tags: ["Public"] };

export async function publicRoutes(app: FastifyInstance) {
  app.get("/plans", { schema: { ...T, security: [], summary: "Public plans and prices" } }, async () =>
    withAnonymous(async (db) => (await db.query("SELECT * FROM public_plans()")).rows));

  app.get("/code-available", { schema: { ...T, security: [], summary: "Is a company code free?" } }, async (req) => {
    const q = parse(z.object({ code: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/) }), req.query);
    return withAnonymous(async (db) => ({ code: q.code, available: (await db.query("SELECT tenant_code_available($1) AS a", [q.code])).rows[0].a }));
  });

  app.post("/signup", {
    schema: { ...T, security: [], summary: "Self-service trial: creates the company on the default trial plan and signs the owner in" },
    config: { rateLimit: { max: Number(process.env.SIGNUP_RATE_LIMIT_PER_HOUR ?? 5), timeWindow: "1 hour" } },
  }, async (req, reply) => {
    const b = parse(z.object({
      companyName: z.string().min(3).max(120), code: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/), industry: z.string().max(60).optional(),
      ownerName: z.string().min(3).max(80), email: z.string().email(), phone: z.string().regex(/^\+?[0-9 ]{7,20}$/), password: z.string(),
      currency: z.string().length(3).default("LYD"), timezone: z.string().default("Africa/Tripoli"), acceptTerms: z.literal(true),
    }), req.body);
    const plan = await withPlatform(async (db) => (await db.query("SELECT code, trial_days FROM plans WHERE is_trial_default AND is_active")).rows[0]);
    if (!plan || plan.trial_days <= 0) throw E.rule("TRIALS_DISABLED", "التجربة المجانية غير متاحة حاليًا", "Free trials are not available right now");
    const id = randomUUID();
    const refresh = newOpaqueToken();
    const y = new Date().getUTCFullYear();
    // one transaction: company + owner + subscription + chart of accounts + fiscal year + session (all or nothing)
    const r = await withPlatformInTenant(id, async (db) => {
      const out = await provisionTenant(db, id, { code: b.code, legalName: b.companyName, industry: b.industry, baseCurrency: b.currency, timezone: b.timezone, defaultLocale: "ar", secondaryLocale: "en",
        planCode: plan.code, billingCycle: "monthly", company: { code: "MAIN", nameAr: b.companyName }, owner: { email: b.email, fullName: b.ownerName, password: b.password } }, null);
      await db.query("UPDATE tenants SET signup_source = 'self_signup', contact_phone = $2 WHERE id = $1", [id, b.phone]);
      await seedChartOfAccounts(db, id, out.companyId);
      await createFiscalYear(db, (await loadUserCtx(db, out.ownerUserId, id))!, { companyId: out.companyId, name: `FY${y}`, startDate: `${y}-01-01` });
      await db.query(`INSERT INTO refresh_tokens (tenant_id, user_id, token_hash, family_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), $6, $7)`,
        [id, out.ownerUserId, sha256(refresh), randomUUID(), config.refreshTokenTtlSec, req.ip, req.headers["user-agent"] ?? null]);
      return out;
    }).catch((e) => { if (e?.code === "23505" && String(e.constraint ?? "").includes("tenants_code")) throw E.conflict("رمز الشركة مستخدم — اختر رمزًا آخر", "Company code is taken"); throw e; });
    return reply.code(201).send({ tenantCode: b.code, trialDays: plan.trial_days, accessToken: signAccess(r.ownerUserId, id), refreshToken: `${id}.${refresh}` });
  });
}
