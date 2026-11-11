import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withAnonymous, withPlatform, withPlatformInTenant } from "../../db/pool.js";
import { authenticatePlatform } from "../../core/auth.js";
import { parse, zPage, pageSql, paged, zUuid } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { DUMMY_HASH, signPlatform, verifyPassword, verifyTotp } from "../../core/security.js";
import { config } from "../../config.js";
import { changePlan, newTenantId, provisionTenant, setTenantStatus, sweepSubscriptions } from "./platform.service.js";

const T = { tags: ["Platform"] };

const zPlan = z.object({
  code: z.string().regex(/^[a-z0-9_]+$/), nameAr: z.string().min(2), nameEn: z.string().min(2),
  currency: z.string().length(3), priceMonthly: z.coerce.number().min(0), priceYearly: z.coerce.number().min(0),
  trialDays: z.number().int().min(0).max(365).default(14), graceDays: z.number().int().min(0).max(90).default(7),
  maxUsers: z.number().int().positive(), maxCompanies: z.number().int().positive().default(1),
  maxBranches: z.number().int().positive(), maxWarehouses: z.number().int().positive(),
  storageMb: z.number().int().positive(), apiRpm: z.number().int().positive(),
  modules: z.array(z.string()).min(1), isPublic: z.boolean().default(true),
});

const zProvision = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/), legalName: z.string().min(2), nameEn: z.string().optional(), industry: z.string().optional(),
  baseCurrency: z.string().length(3).default("LYD"), timezone: z.string().default("Africa/Tripoli"),
  defaultLocale: z.enum(["ar", "en"]).default("ar"), secondaryLocale: z.enum(["ar", "en"]).optional(),
  planCode: z.string(), billingCycle: z.enum(["monthly", "yearly"]).default("monthly"), isDemo: z.boolean().default(false),
  company: z.object({ code: z.string().regex(/^[A-Z0-9_-]{1,20}$/), nameAr: z.string().min(2), nameEn: z.string().optional() }),
  owner: z.object({ email: z.string().email(), fullName: z.string().min(2), password: z.string() }),
});

export async function platformRoutes(app: FastifyInstance) {
  app.post("/auth/login", {
    schema: { ...T, security: [], summary: "Platform super-admin login", body: { type: "object", properties: { email: { type: "string" }, password: { type: "string" }, otp: { type: "string" } }, required: ["email", "password"] } },
    config: { rateLimit: { max: config.loginRateLimitPerMin, timeWindow: "1 minute" } },
  }, async (req) => {
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200), otp: z.string().optional() }), req.body);
    const u = await withAnonymous(async (db) => (await db.query("SELECT * FROM platform_user_for_login($1)", [b.email])).rows[0]);
    const ok = await verifyPassword(b.password, u?.password_hash ?? DUMMY_HASH);
    const success = !!u && ok && u.is_active;
    if (success && u.mfa_enabled && !(b.otp && verifyTotp(u.mfa_secret, b.otp))) {
      await withPlatform((db) => db.query("INSERT INTO login_attempts (scope, identifier, success, reason, ip) VALUES ('platform',$1,false,'mfa',$2)", [b.email, req.ip]));
      throw E.mfaRequired();
    }
    await withPlatform(async (db) => {
      await db.query("INSERT INTO login_attempts (scope, identifier, success, reason, ip, user_agent) VALUES ('platform',$1,$2,$3,$4,$5)",
        [b.email, success, success ? null : "bad_credentials", req.ip, req.headers["user-agent"] ?? null]);
      if (success) {
        await db.query("UPDATE platform_users SET last_login_at = now() WHERE id = $1", [u.id]);
        await audit(db, { tenantId: null, actorType: "platform", actorId: u.id, action: "platform.login", entityType: "platform_user", entityId: u.id, ip: req.ip, requestId: req.id });
      }
    });
    if (!success) throw E.invalidCredentials();
    return { accessToken: signPlatform(u.id), user: { id: u.id, fullName: u.full_name } };
  });

  // everything below requires a platform token
  await app.register(async (p) => {
    p.addHook("preHandler", authenticatePlatform);

    p.get("/plans", { schema: { ...T, summary: "List plans" } }, async () => withPlatform(async (db) =>
      (await db.query(`SELECT p.*, ARRAY(SELECT module_code FROM plan_modules m WHERE m.plan_id = p.id ORDER BY module_code) AS modules FROM plans p ORDER BY price_monthly`)).rows));

    p.post("/plans", { schema: { ...T, summary: "Create plan" } }, async (req, reply) => {
      const b = parse(zPlan, req.body);
      const plan = await withPlatform(async (db) => {
        const r = (await db.query(
          `INSERT INTO plans (code,name_ar,name_en,currency,price_monthly,price_yearly,trial_days,grace_days,max_users,max_companies,max_branches,max_warehouses,storage_mb,api_rpm,is_public)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [b.code, b.nameAr, b.nameEn, b.currency, b.priceMonthly, b.priceYearly, b.trialDays, b.graceDays, b.maxUsers, b.maxCompanies, b.maxBranches, b.maxWarehouses, b.storageMb, b.apiRpm, b.isPublic])).rows[0];
        await db.query("INSERT INTO plan_modules (plan_id, module_code) SELECT $1, unnest($2::text[])", [r.id, [...new Set(["core", ...b.modules])]]);
        await audit(db, { tenantId: null, actorType: "platform", actorId: req.platformUserId!, action: "plan.created", entityType: "plan", entityId: r.id, after: b });
        return r;
      });
      return reply.code(201).send(plan);
    });

    p.get("/tenants", { schema: { ...T, summary: "List tenants (metadata only)" } }, async (req) => {
      const q = parse(zPage.extend({ status: z.string().optional(), q: z.string().optional() }), req.query);
      const { limit, offset } = pageSql(q);
      return withPlatform(async (db) => {
        const where = `WHERE ($1::text IS NULL OR t.status::text = $1) AND ($2::text IS NULL OR t.code ILIKE '%'||$2||'%' OR t.legal_name ILIKE '%'||$2||'%')`;
        const total = Number((await db.query(`SELECT count(*) FROM tenants t ${where}`, [q.status ?? null, q.q ?? null])).rows[0].count);
        const rows = (await db.query(
          `SELECT t.id, t.code, t.legal_name, t.name_en, t.industry, t.status, t.status_reason, t.base_currency, t.is_demo, t.created_at,
                  p.code AS plan_code, s.status AS subscription_status, s.current_period_end
             FROM tenants t
             LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status IN ('trialing','active','past_due','suspended')
             LEFT JOIN plans p ON p.id = s.plan_id
            ${where} ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`, [q.status ?? null, q.q ?? null, limit, offset])).rows;
        return paged(rows, total, q);
      });
    });

    p.post("/tenants", { schema: { ...T, summary: "Provision a new tenant (company, HQ branch, roles, owner, subscription)" } }, async (req, reply) => {
      const b = parse(zProvision, req.body);
      const id = newTenantId();
      const r = await withPlatformInTenant(id, (db) => provisionTenant(db, id, b, req.platformUserId!));
      return reply.code(201).send(r);
    });

    p.get("/tenants/:id", { schema: { ...T, summary: "Tenant detail + usage + subscription history" } }, async (req) => {
      const { id } = parse(z.object({ id: zUuid }), req.params);
      return withPlatform(async (db) => {
        const t = (await db.query("SELECT * FROM tenants WHERE id = $1", [id])).rows[0];
        if (!t) throw E.notFound("tenant");
        const usage = (await db.query("SELECT * FROM platform_tenant_usage($1)", [id])).rows[0];
        const subscriptions = (await db.query("SELECT s.*, p.code AS plan_code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $1 ORDER BY s.created_at DESC", [id])).rows;
        const events = (await db.query("SELECT * FROM subscription_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT 50", [id])).rows;
        const invoices = (await db.query("SELECT * FROM platform_invoices WHERE tenant_id = $1 ORDER BY issued_at DESC LIMIT 50", [id])).rows;
        return { tenant: t, usage, subscriptions, events, invoices };
      });
    });

    for (const [path, status] of [["suspend", "suspended"], ["reactivate", "active"], ["cancel", "cancelled"]] as const) {
      p.post(`/tenants/:id/${path}`, { schema: { ...T, summary: `Set tenant ${status}` } }, async (req) => {
        const { id } = parse(z.object({ id: zUuid }), req.params);
        const b = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
        await withPlatform((db) => setTenantStatus(db, id, status, b.reason, req.platformUserId!));
        return { ok: true, status };
      });
    }

    p.post("/tenants/:id/change-plan", { schema: { ...T, summary: "Upgrade / downgrade (blocked if usage exceeds target limits)" } }, async (req) => {
      const { id } = parse(z.object({ id: zUuid }), req.params);
      const b = parse(z.object({ planCode: z.string(), billingCycle: z.enum(["monthly", "yearly"]).default("monthly") }), req.body);
      return withPlatform((db) => changePlan(db, id, b.planCode, b.billingCycle, req.platformUserId!));
    });

    p.post("/invoices/:id/mark-paid", { schema: { ...T, summary: "Record payment of a subscription invoice" } }, async (req) => {
      const { id } = parse(z.object({ id: zUuid }), req.params);
      return withPlatform(async (db) => {
        const r = (await db.query("UPDATE platform_invoices SET status = 'paid', paid_at = now() WHERE id = $1 AND status IN ('issued','overdue') RETURNING *", [id])).rows[0];
        if (!r) throw E.notFound("open invoice");
        await audit(db, { tenantId: null, actorType: "platform", actorId: req.platformUserId!, action: "platform_invoice.paid", entityType: "platform_invoice", entityId: id });
        return r;
      });
    });

    p.get("/upgrade-requests", { schema: { ...T, summary: "Upgrade / activation requests from tenants" } }, async (req) => {
      const q = parse(z.object({ status: z.enum(["open", "done", "rejected"]).optional() }), req.query);
      return withPlatform(async (db) => (await db.query(`SELECT r.*, t.code AS tenant_code, t.legal_name, t.status AS tenant_status, t.contact_phone AS tenant_phone, t.signup_source
         FROM upgrade_requests r JOIN tenants t ON t.id = r.tenant_id WHERE ($1::upgrade_status IS NULL OR r.status = $1) ORDER BY r.created_at DESC LIMIT 300`, [q.status ?? null])).rows);
    });
    p.post("/upgrade-requests/:id/complete", { schema: { ...T, summary: "Activate the requested plan (issues the invoice) and close the request" } }, async (req) => {
      const { id } = parse(z.object({ id: zUuid }), req.params);
      return withPlatform(async (db) => {
        const r = (await db.query("SELECT * FROM upgrade_requests WHERE id = $1 AND status = 'open' FOR UPDATE", [id])).rows[0];
        if (!r) throw E.notFound("open upgrade request");
        const out = await changePlan(db, r.tenant_id, r.plan_code, r.billing_cycle, req.platformUserId!);
        await db.query("UPDATE upgrade_requests SET status = 'done', handled_by = $2, handled_at = now() WHERE id = $1", [id, req.platformUserId]);
        return out;
      });
    });
    p.post("/upgrade-requests/:id/reject", { schema: { ...T, summary: "Reject an upgrade request" } }, async (req) => {
      const { id } = parse(z.object({ id: zUuid }), req.params);
      return withPlatform(async (db) => {
        const r = (await db.query("UPDATE upgrade_requests SET status = 'rejected', handled_by = $2, handled_at = now() WHERE id = $1 AND status = 'open' RETURNING *", [id, req.platformUserId])).rows[0];
        if (!r) throw E.notFound("open upgrade request");
        return r;
      });
    });
    p.post("/plans/:code/trial-default", { schema: { ...T, summary: "Make this plan the one self-service trials start on" } }, async (req) => {
      const { code } = parse(z.object({ code: z.string() }), req.params);
      return withPlatform(async (db) => {
        await db.query("UPDATE plans SET is_trial_default = false WHERE is_trial_default");
        const r = (await db.query("UPDATE plans SET is_trial_default = true WHERE code = $1 RETURNING code, trial_days", [code])).rows[0];
        if (!r) throw E.notFound("plan");
        await audit(db, { tenantId: null, actorType: "platform", actorId: req.platformUserId!, action: "plan.trial_default", entityType: "plan", entityId: code });
        return r;
      });
    });

    p.post("/subscriptions/sweep", { schema: { ...T, summary: "Run subscription lifecycle sweep now" } }, async () => withPlatform((db) => sweepSubscriptions(db)));

    p.get("/audit", { schema: { ...T, summary: "Platform-level audit events (no tenant business data)" } }, async (req) => {
      const q = parse(zPage, req.query);
      const { limit, offset } = pageSql(q);
      return withPlatform(async (db) => {
        const total = Number((await db.query("SELECT count(*) FROM audit_log WHERE tenant_id IS NULL")).rows[0].count);
        const rows = (await db.query("SELECT * FROM audit_log WHERE tenant_id IS NULL ORDER BY id DESC LIMIT $1 OFFSET $2", [limit, offset])).rows;
        return paged(rows, total, q);
      });
    });
  });
}
