import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb, assertBranchAccess } from "../../core/auth.js";
import { parse, zUuid } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { assertWithinLimit } from "../../core/limits.js";

const T = { tags: ["Organization"] };
const zCode = z.string().regex(/^[A-Z0-9_-]{1,20}$/);

export async function orgRoutes(app: FastifyInstance) {
  app.get("/companies", { schema: { ...T, summary: "Companies" }, preHandler: can("core.org.view") }, async (req) =>
    tdb(req, async (db) => (await db.query("SELECT * FROM companies ORDER BY code")).rows));

  app.post("/companies", { schema: { ...T, summary: "Create company (plan limit)" }, preHandler: can("core.org.manage") }, async (req, reply) => {
    const b = parse(z.object({ code: zCode, nameAr: z.string().min(2), nameEn: z.string().optional(), baseCurrency: z.string().length(3), taxNumber: z.string().optional() }), req.body);
    const u = req.user!;
    const r = await tdb(req, async (db) => {
      await assertWithinLimit(db, u.tenantId, "companies");
      const c = (await db.query("INSERT INTO companies (tenant_id, code, name_ar, name_en, base_currency, tax_number) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        [u.tenantId, b.code, b.nameAr, b.nameEn ?? null, b.baseCurrency, b.taxNumber ?? null])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "company.created", entityType: "company", entityId: c.id, after: c, ip: req.ip, requestId: req.id });
      return c;
    });
    return reply.code(201).send(r);
  });

  app.get("/branches", { schema: { ...T, summary: "Branches visible to the user (branch scope applied)" }, preHandler: can("core.org.view") }, async (req) => {
    const u = req.user!;
    return tdb(req, async (db) => (await db.query("SELECT * FROM branches WHERE ($1::uuid[] IS NULL OR id = ANY($1)) ORDER BY code", [u.branchIds])).rows);
  });

  app.post("/branches", { schema: { ...T, summary: "Create branch / factory / site (plan limit)" }, preHandler: can("core.org.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, code: zCode, nameAr: z.string().min(2), nameEn: z.string().optional(),
      kind: z.enum(["head_office", "factory", "branch", "warehouse_site", "sales_office"]).default("branch"), city: z.string().optional(), address: z.string().optional(), phone: z.string().optional() }), req.body);
    const u = req.user!;
    const r = await tdb(req, async (db) => {
      await assertWithinLimit(db, u.tenantId, "branches");
      const x = (await db.query("INSERT INTO branches (tenant_id, company_id, code, name_ar, name_en, kind, city, address, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [u.tenantId, b.companyId, b.code, b.nameAr, b.nameEn ?? null, b.kind, b.city ?? null, b.address ?? null, b.phone ?? null])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "branch.created", entityType: "branch", entityId: x.id, after: x, ip: req.ip, requestId: req.id });
      return x;
    });
    return reply.code(201).send(r);
  });

  app.patch("/branches/:id", { schema: { ...T, summary: "Update branch" }, preHandler: can("core.org.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ nameAr: z.string().min(2).optional(), nameEn: z.string().nullable().optional(), city: z.string().nullable().optional(), isActive: z.boolean().optional() }), req.body);
    const u = req.user!;
    assertBranchAccess(u, id);
    return tdb(req, async (db) => {
      const before = (await db.query("SELECT * FROM branches WHERE id = $1", [id])).rows[0];
      if (!before) throw E.notFound("branch");
      const r = (await db.query("UPDATE branches SET name_ar = coalesce($2, name_ar), name_en = coalesce($3, name_en), city = coalesce($4, city), is_active = coalesce($5, is_active) WHERE id = $1 RETURNING *",
        [id, b.nameAr ?? null, b.nameEn ?? null, b.city ?? null, b.isActive ?? null])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "branch.updated", entityType: "branch", entityId: id, before, after: r, ip: req.ip, requestId: req.id });
      return r;
    });
  });

  app.get("/warehouses", { schema: { ...T, summary: "Warehouses (branch scope applied)" }, preHandler: can("core.org.view") }, async (req) => {
    const u = req.user!;
    return tdb(req, async (db) => (await db.query("SELECT w.*, b.code AS branch_code, b.name_ar AS branch_name_ar FROM warehouses w JOIN branches b ON b.id = w.branch_id WHERE ($1::uuid[] IS NULL OR w.branch_id = ANY($1)) ORDER BY w.code", [u.branchIds])).rows);
  });

  app.post("/warehouses", { schema: { ...T, summary: "Create warehouse (plan limit)" }, preHandler: can("core.org.manage") }, async (req, reply) => {
    const b = parse(z.object({ branchId: zUuid, code: zCode, nameAr: z.string().min(2), nameEn: z.string().optional(),
      kind: z.enum(["main", "raw_materials", "packaging", "finished_goods", "wip", "quarantine", "damaged", "van", "transit"]).default("main"), isSellable: z.boolean().optional() }), req.body);
    const u = req.user!;
    assertBranchAccess(u, b.branchId);
    const sellable = b.isSellable ?? !["quarantine", "damaged", "raw_materials", "packaging", "wip"].includes(b.kind);
    const r = await tdb(req, async (db) => {
      await assertWithinLimit(db, u.tenantId, "warehouses");
      const x = (await db.query("INSERT INTO warehouses (tenant_id, branch_id, code, name_ar, name_en, kind, is_sellable) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [u.tenantId, b.branchId, b.code, b.nameAr, b.nameEn ?? null, b.kind, sellable])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "warehouse.created", entityType: "warehouse", entityId: x.id, after: x, ip: req.ip, requestId: req.id });
      return x;
    });
    return reply.code(201).send(r);
  });

  app.get("/settings", { schema: { ...T, summary: "Tenant settings" }, preHandler: can(null) }, async (req) =>
    tdb(req, async (db) => (await db.query("SELECT * FROM tenant_settings")).rows[0]));

  app.patch("/settings", { schema: { ...T, summary: "Update tenant settings (security, SoD, formats)" }, preHandler: can("core.settings.manage") }, async (req) => {
    const b = parse(z.object({
      dateFormat: z.enum(["DD/MM/YYYY", "YYYY-MM-DD", "MM/DD/YYYY"]).optional(), numberLocale: z.enum(["ar-LY", "en-US", "ar-EG", "fr-FR"]).optional(),
      fiscalYearStartMonth: z.number().int().min(1).max(12).optional(), enforceSod: z.boolean().optional(), mfaRequired: z.boolean().optional(),
      passwordMinLength: z.number().int().min(8).max(128).optional(), sessionTtlMinutes: z.number().int().min(5).max(1440).optional(), maxFailedLogins: z.number().int().min(3).max(20).optional(),
      fieldGpsRequired: z.boolean().optional(),
    }), req.body);
    const u = req.user!;
    return tdb(req, async (db) => {
      const before = (await db.query("SELECT * FROM tenant_settings")).rows[0];
      const r = (await db.query(
        `UPDATE tenant_settings SET date_format = coalesce($1, date_format), number_locale = coalesce($2, number_locale), fiscal_year_start_month = coalesce($3, fiscal_year_start_month),
           enforce_sod = coalesce($4, enforce_sod), mfa_required = coalesce($5, mfa_required), password_min_length = coalesce($6, password_min_length),
           session_ttl_minutes = coalesce($7, session_ttl_minutes), max_failed_logins = coalesce($8, max_failed_logins), field_gps_required = coalesce($9, field_gps_required) RETURNING *`,
        [b.dateFormat ?? null, b.numberLocale ?? null, b.fiscalYearStartMonth ?? null, b.enforceSod ?? null, b.mfaRequired ?? null, b.passwordMinLength ?? null, b.sessionTtlMinutes ?? null, b.maxFailedLogins ?? null, b.fieldGpsRequired ?? null])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "settings.updated", entityType: "tenant_settings", entityId: u.tenantId, before, after: r, ip: req.ip, requestId: req.id });
      return r;
    });
  });

  app.get("/subscription", { schema: { ...T, summary: "Own subscription, plan limits, usage and invoices" }, preHandler: can("core.subscription.view") }, async (req) =>
    tdb(req, async (db) => {
      const sub = (await db.query(
        `SELECT s.*, p.code AS plan_code, p.name_ar AS plan_name_ar, p.name_en AS plan_name_en, p.max_users, p.max_companies, p.max_branches, p.max_warehouses, p.storage_mb, p.api_rpm,
                ARRAY(SELECT module_code FROM plan_modules m WHERE m.plan_id = p.id ORDER BY 1) AS modules
           FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('trialing','active','past_due') LIMIT 1`)).rows[0] ?? null;
      const usage = (await db.query("SELECT * FROM platform_tenant_usage($1)", [req.user!.tenantId])).rows[0];
      const invoices = (await db.query("SELECT number, period_start, period_end, amount, discount, currency, status, issued_at, due_at, paid_at FROM platform_invoices ORDER BY issued_at DESC LIMIT 24")).rows;
      return { subscription: sub, usage, invoices };
    }));

  app.post("/subscription/upgrade-request", { schema: { ...T, summary: "Ask the platform to activate / change the subscription (one open request at a time)" }, preHandler: can("core.subscription.view") }, async (req, reply) => {
    const b = parse(z.object({ planCode: z.string().min(2), billingCycle: z.enum(["monthly", "yearly"]).default("monthly"), note: z.string().max(1000).optional(), contactPhone: z.string().max(30).optional() }), req.body);
    const u = req.user!;
    return reply.code(201).send(await tdb(req, async (db) => {
      const plan = (await db.query("SELECT code FROM public_plans() WHERE code = $1", [b.planCode])).rows[0];
      if (!plan) throw E.validation([{ path: "planCode", message: "unknown plan" }]);
      const r = (await db.query(`INSERT INTO upgrade_requests (tenant_id, plan_code, billing_cycle, note, contact_phone, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [u.tenantId, b.planCode, b.billingCycle, b.note ?? null, b.contactPhone ?? null, u.userId]).catch((e) => {
          if (e?.code === "23505") throw E.conflict("لديك طلب مفتوح بالفعل — سيتواصل معك فريقنا", "You already have an open request"); throw e; })).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "subscription.upgrade_requested", entityType: "upgrade_request", entityId: r.id, after: b });
      return r;
    }));
  });
  app.get("/subscription/upgrade-requests", { schema: { ...T, summary: "Own upgrade requests" }, preHandler: can("core.subscription.view") }, async (req) =>
    tdb(req, async (db) => (await db.query("SELECT * FROM upgrade_requests ORDER BY created_at DESC LIMIT 20")).rows));
}
