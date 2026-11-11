import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb, assertBranchAccess } from "../../core/auth.js";
import { parse, zUuid, zMoney, zDate, idempotent, send } from "../../core/http.js";
import * as s from "./assets.service.js";

const A = { tags: ["Assets & Maintenance"] };
const id$ = z.object({ id: zUuid });
const zCode = z.string().regex(/^[A-Z0-9_-]{1,30}$/);
const zQty = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((x) => /^\d{1,12}(\.\d{1,6})?$/.test(x) && Number(x) > 0, "positive quantity");
const zPct = z.union([z.string(), z.number()]).transform((v) => String(v)).refine((x) => /^\d{1,2}(\.\d{1,2})?$/.test(x), "0..99.99");
const zMethod = z.enum(["straight_line", "declining_balance"]);
const zParts = z.array(z.object({ itemId: zUuid, uomId: zUuid.nullable().optional(), qty: zQty })).max(100);

export async function assetRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- categories
  app.get("/assets/categories", { schema: { ...A, summary: "Asset categories (GL accounts, method, useful life)" }, preHandler: can("assets.register.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT c.*, aa.code AS asset_account_code, ac.code AS accum_account_code, ea.code AS expense_account_code, ma.code AS maintenance_account_code
         FROM asset_categories c JOIN accounts aa ON aa.id = c.asset_account_id JOIN accounts ac ON ac.id = c.accum_account_id JOIN accounts ea ON ea.id = c.expense_account_id
         LEFT JOIN accounts ma ON ma.id = c.maintenance_account_id WHERE c.company_id = $1 ORDER BY c.code`, [q.companyId])).rows);
  });
  app.post("/assets/categories", { schema: { ...A, summary: "Create asset category" }, preHandler: can("assets.register.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, code: zCode, nameAr: z.string().min(2), nameEn: z.string().optional(), method: zMethod.default("straight_line"),
      usefulLifeMonths: z.number().int().min(1).max(1200), residualPct: zPct.default("0"), assetAccountId: zUuid, accumAccountId: zUuid, expenseAccountId: zUuid,
      maintenanceAccountId: zUuid.nullable().optional() }), req.body);
    return reply.code(201).send(await tdb(req, (db) => s.createCategory(db, req.user!, b)));
  });

  // ---------------------------------------------------------------- register
  app.get("/assets", { schema: { ...A, summary: "Asset register with book values" }, preHandler: can("assets.register.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["draft", "active", "disposed"]).optional(), kind: z.string().optional(), q: z.string().optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT a.id, a.code, a.name_ar, a.kind, a.status, a.location, a.branch_id, a.serial_no, a.acquisition_date, a.in_service_date, a.cost, a.residual_value, a.method,
              a.useful_life_months, a.months_depreciated, a.accumulated_depreciation, (a.cost - a.accumulated_depreciation)::numeric(20,4)::text AS book_value,
              c.code AS category_code, c.name_ar AS category_name_ar,
              (SELECT min(p.next_due_date) FROM maintenance_plans p WHERE p.asset_id = a.id AND p.is_active) AS next_maintenance,
              (SELECT count(*) FROM maintenance_orders o WHERE o.asset_id = a.id AND o.status IN ('open', 'in_progress'))::int AS open_orders
         FROM fixed_assets a JOIN asset_categories c ON c.id = a.category_id
        WHERE a.company_id = $1 AND ($2::asset_status IS NULL OR a.status = $2) AND ($3::text IS NULL OR a.kind::text = $3)
          AND ($4::text IS NULL OR a.code ILIKE '%' || $4 || '%' OR a.name_ar ILIKE '%' || $4 || '%' OR a.serial_no ILIKE '%' || $4 || '%')
        ORDER BY a.code`, [q.companyId, q.status ?? null, q.kind ?? null, q.q ?? null])).rows);
  });
  app.post("/assets", { schema: { ...A, summary: "Create asset card (draft) — defaults from its category" }, preHandler: can("assets.register.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, categoryId: zUuid, code: zCode, nameAr: z.string().min(2), nameEn: z.string().optional(),
      kind: z.enum(["machine", "equipment", "vehicle", "building", "furniture", "it", "other"]).default("equipment"), branchId: zUuid.nullable().optional(),
      serialNo: z.string().max(100).optional(), manufacturer: z.string().max(100).optional(), model: z.string().max(100).optional(), location: z.string().max(200).optional(),
      workCenterId: zUuid.nullable().optional(), warehouseId: zUuid.nullable().optional(), acquisitionDate: zDate, inServiceDate: zDate.optional(), cost: zMoney,
      residualValue: zMoney.optional(), usefulLifeMonths: z.number().int().min(1).max(1200).optional(), method: zMethod.optional(),
      openingAccumulated: zMoney.optional(), openingMonthsUsed: z.number().int().min(0).optional(), fundingAccountId: zUuid.nullable().optional(), notes: z.string().max(2000).optional() }), req.body);
    assertBranchAccess(req.user!, b.branchId);
    return reply.code(201).send(await tdb(req, (db) => s.createAsset(db, req.user!, b)));
  });
  app.get("/assets/:id", { schema: { ...A, summary: "Asset card with life history (depreciation, maintenance, disposal)" }, preHandler: can("assets.register.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => s.assetHistory(db, id));
  });
  app.patch("/assets/:id", { schema: { ...A, summary: "Update location / notes / branch (financial fields freeze at capitalization)" }, preHandler: can("assets.register.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ location: z.string().max(200).nullable().optional(), notes: z.string().max(2000).nullable().optional(), branchId: zUuid.nullable().optional() }), req.body);
    if (b.branchId) assertBranchAccess(req.user!, b.branchId);
    return tdb(req, async (db) => {
      await db.query(`UPDATE fixed_assets SET location = CASE WHEN $2 THEN $3 ELSE location END, notes = CASE WHEN $4 THEN $5 ELSE notes END,
          branch_id = CASE WHEN $6 THEN $7::uuid ELSE branch_id END WHERE id = $1`,
        [id, b.location !== undefined, b.location ?? null, b.notes !== undefined, b.notes ?? null, b.branchId !== undefined, b.branchId ?? null]);
      return s.getAsset(db, id);
    });
  });
  app.delete("/assets/:id", { schema: { ...A, summary: "Delete a draft asset card" }, preHandler: can("assets.register.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => ({ deleted: (await db.query("DELETE FROM fixed_assets WHERE id = $1 AND status = 'draft'", [id])).rowCount === 1 }));
  });
  app.post("/assets/:id/capitalize", { schema: { ...A, summary: "Capitalize (posts Dr asset / Cr accumulated b/f / Cr funding)" }, preHandler: can("assets.register.capitalize") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ fundingAccountId: zUuid.optional(), postingDate: zDate.optional() }), req.body ?? {});
    return send(reply, await tdb(req, (db) => idempotent(req, db, req.user!.tenantId, async () => ({ status: 200, body: await s.capitalize(db, req.user!, id, b) }))));
  });
  app.post("/assets/:id/dispose", { schema: { ...A, summary: "Dispose / sell an asset (gain or loss posted)" }, preHandler: can("assets.register.dispose") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ date: zDate, proceeds: zMoney.default("0"), proceedsAccountId: zUuid.nullable().optional(), gainLossAccountId: zUuid.nullable().optional(),
      reason: z.string().min(3).max(500) }), req.body);
    return send(reply, await tdb(req, (db) => idempotent(req, db, req.user!.tenantId, async () => ({ status: 200, body: await s.dispose(db, req.user!, id, b) }))));
  });

  // ---------------------------------------------------------------- depreciation
  app.get("/assets/depreciation-runs", { schema: { ...A, summary: "Depreciation runs" }, preHandler: can("assets.register.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query(
      "SELECT r.*, (SELECT count(*) FROM depreciation_lines l WHERE l.run_id = r.id)::int AS assets FROM depreciation_runs r WHERE r.company_id = $1 ORDER BY r.period DESC", [q.companyId])).rows);
  });
  app.get("/assets/depreciation-runs/:id", { schema: { ...A, summary: "Depreciation run with lines" }, preHandler: can("assets.register.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => s.getRun(db, id));
  });
  app.post("/assets/depreciation-runs", { schema: { ...A, summary: "Prepare (or re-prepare) the depreciation draft of a month" }, preHandler: can("assets.depreciation.prepare") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, period: zDate }), req.body);
    return reply.code(201).send(await tdb(req, (db) => s.prepareRun(db, req.user!, b)));
  });
  app.post("/assets/depreciation-runs/:id/post", { schema: { ...A, summary: "Post depreciation (Dr expense / Cr accumulated); preparer ≠ poster" }, preHandler: can("assets.depreciation.post") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    return send(reply, await tdb(req, (db) => idempotent(req, db, req.user!.tenantId, async () => ({ status: 200, body: await s.postRun(db, req.user!, id) }))));
  });
  app.delete("/assets/depreciation-runs/:id", { schema: { ...A, summary: "Delete a draft depreciation run" }, preHandler: can("assets.depreciation.prepare") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => ({ deleted: (await db.query("DELETE FROM depreciation_runs WHERE id = $1 AND status = 'draft'", [id])).rowCount === 1 }));
  });

  // ---------------------------------------------------------------- maintenance
  app.get("/maintenance/plans", { schema: { ...A, summary: "Preventive maintenance plans (filter: due by date)" }, preHandler: can("assets.maintenance.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, dueBy: zDate.optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT p.*, a.code AS asset_code, a.name_ar AS asset_name_ar FROM maintenance_plans p JOIN fixed_assets a ON a.id = p.asset_id
        WHERE p.company_id = $1 AND ($2::date IS NULL OR (p.is_active AND p.next_due_date <= $2)) ORDER BY p.next_due_date`, [q.companyId, q.dueBy ?? null])).rows);
  });
  app.post("/maintenance/plans", { schema: { ...A, summary: "Create preventive plan (every N days)" }, preHandler: can("assets.maintenance.manage") }, async (req, reply) => {
    const b = parse(z.object({ assetId: zUuid, nameAr: z.string().min(2), intervalDays: z.number().int().min(1).max(3650), firstDueDate: zDate, checklist: z.string().max(4000).optional() }), req.body);
    return reply.code(201).send(await tdb(req, (db) => s.createPlan(db, req.user!, b)));
  });
  app.post("/maintenance/plans/generate", { schema: { ...A, summary: "Generate work orders for due plans (idempotent)" }, preHandler: can("assets.maintenance.manage") }, async (req) => {
    const b = parse(z.object({ companyId: zUuid, asOf: zDate }), req.body);
    return tdb(req, (db) => s.generateDueOrders(db, req.user!, b));
  });
  app.get("/maintenance/orders", { schema: { ...A, summary: "Maintenance work orders" }, preHandler: can("assets.maintenance.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional(), assetId: zUuid.optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT o.*, a.code AS asset_code, a.name_ar AS asset_name_ar FROM maintenance_orders o JOIN fixed_assets a ON a.id = o.asset_id
        WHERE o.company_id = $1 AND ($2::wo_status IS NULL OR o.status = $2) AND ($3::uuid IS NULL OR o.asset_id = $3)
        ORDER BY (o.status IN ('open', 'in_progress')) DESC, array_position(ARRAY['critical','high','normal','low']::wo_priority[], o.priority), o.reported_at DESC LIMIT 500`,
      [q.companyId, q.status ?? null, q.assetId ?? null])).rows);
  });
  app.get("/maintenance/orders/:id", { schema: { ...A, summary: "Work order with parts" }, preHandler: can("assets.maintenance.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => s.getOrder(db, id));
  });
  app.post("/maintenance/orders", { schema: { ...A, summary: "Report a breakdown (corrective work order)" }, preHandler: can("assets.maintenance.manage") }, async (req, reply) => {
    const b = parse(z.object({ assetId: zUuid, kind: z.literal("corrective").default("corrective"), priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
      description: z.string().min(3).max(2000), failureCode: z.string().max(50).optional(), warehouseId: zUuid.nullable().optional(), parts: zParts.optional() }), req.body);
    return reply.code(201).send(await tdb(req, (db) => s.createOrder(db, req.user!, b)));
  });
  app.put("/maintenance/orders/:id/parts", { schema: { ...A, summary: "Set planned spare parts and the issuing warehouse" }, preHandler: can("assets.maintenance.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ warehouseId: zUuid.nullable(), parts: zParts }), req.body);
    return tdb(req, (db) => s.setParts(db, req.user!, id, b));
  });
  app.post("/maintenance/orders/:id/start", { schema: { ...A, summary: "Start work" }, preHandler: can("assets.maintenance.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => s.startOrder(db, req.user!, id));
  });
  app.post("/maintenance/orders/:id/complete", { schema: { ...A, summary: "Complete: issue parts from stock and post maintenance cost" }, preHandler: can("assets.maintenance.complete") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ completionDate: zDate, downtimeMinutes: z.number().int().min(0).max(525600).default(0), externalCost: zMoney.default("0"),
      externalAccountId: zUuid.nullable().optional(), expenseAccountId: zUuid.nullable().optional(), resolution: z.string().min(3).max(2000) }), req.body);
    return send(reply, await tdb(req, (db) => idempotent(req, db, req.user!.tenantId, async () => ({ status: 200, body: await s.completeOrder(db, req.user!, id, b) }))));
  });
  app.post("/maintenance/orders/:id/cancel", { schema: { ...A, summary: "Cancel an open work order" }, preHandler: can("assets.maintenance.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    return tdb(req, (db) => s.cancelOrder(db, req.user!, id, b.reason));
  });
  app.get("/maintenance/summary", { schema: { ...A, summary: "Reliability & cost per asset: breakdowns, downtime, MTBF, maintenance cost, depreciation" }, preHandler: can("assets.maintenance.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, from: zDate, to: zDate }), req.query);
    return tdb(req, (db) => s.maintenanceSummary(db, q));
  });
}
