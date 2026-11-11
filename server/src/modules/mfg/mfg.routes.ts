import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zPage, pageSql, paged, zUuid, zMoney, zDate, idempotent } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import * as mfg from "./mfg.service.js";
import * as qa from "./quality.service.js";

const M = { tags: ["Manufacturing"] };
const Q = { tags: ["Quality"] };
const zQty = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((s) => /^\d{1,12}(\.\d{1,6})?$/.test(s) && Number(s) > 0, "positive quantity");
const zPct = z.union([z.string(), z.number()]).transform((v) => String(v)).refine((s) => /^\d{1,3}(\.\d{1,4})?$/.test(s) && Number(s) <= 100, "0..100");
const zNum = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((s) => /^-?\d{1,12}(\.\d{1,6})?$/.test(s), "number");
const id$ = z.object({ id: zUuid });

export async function mfgRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- work centers
  app.get("/manufacturing/work-centers", { schema: { ...M, summary: "Production lines / work centers" }, preHandler: can("manufacturing.orders.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT * FROM work_centers WHERE company_id = $1 ORDER BY code", [q.companyId])).rows);
  });
  app.post("/manufacturing/work-centers", { schema: { ...M, summary: "Create work center (capacity, conversion rate per hour)" }, preHandler: can("manufacturing.orders.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, branchId: zUuid.nullable().optional(), code: z.string().regex(/^[A-Z0-9_-]{1,20}$/), nameAr: z.string().min(2), nameEn: z.string().optional(),
      capacityPerHour: zMoney.optional(), ratePerHour: zMoney.default("0") }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => {
      const r = (await db.query(`INSERT INTO work_centers (tenant_id, company_id, branch_id, code, name_ar, name_en, capacity_per_hour, rate_per_hour) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user!.tenantId, b.companyId, b.branchId ?? null, b.code, b.nameAr, b.nameEn ?? null, b.capacityPerHour ?? null, b.ratePerHour])).rows[0];
      await audit(db, { tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId, action: "work_center.created", entityType: "work_center", entityId: r.id, after: r });
      return r;
    }));
  });

  // ---------------------------------------------------------------- formulas
  app.get("/manufacturing/boms", { schema: { ...M, summary: "Formulas / BOMs (all versions)" }, preHandler: can("manufacturing.boms.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, itemId: zUuid.optional() }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT b.*, i.code AS item_code, i.name_ar AS item_name_ar, (SELECT count(*) FROM bom_lines l WHERE l.bom_id = b.id) AS components
       FROM boms b JOIN items i ON i.id = b.item_id WHERE b.company_id = $1 AND ($2::uuid IS NULL OR b.item_id = $2) ORDER BY i.code, b.version DESC`, [q.companyId, q.itemId ?? null])).rows);
  });
  app.get("/manufacturing/boms/:id", { schema: { ...M, summary: "Formula with components and standard cost roll-up" }, preHandler: can("manufacturing.boms.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    const q = parse(z.object({ workCenterId: zUuid.optional() }), req.query);
    return tdb(req, async (db) => ({ ...(await mfg.getBom(db, id)), standardCost: await mfg.standardCost(db, id, q.workCenterId) }));
  });
  app.post("/manufacturing/boms", { schema: { ...M, summary: "Create a new formula version (draft)" }, preHandler: can("manufacturing.boms.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, itemId: zUuid, batchQty: zQty, stdScrapPct: zPct.optional(), stdHours: zMoney.optional(), notes: z.string().max(2000).optional(),
      lines: z.array(z.object({ itemId: zUuid, qty: zQty, scrapPct: zPct.optional(), substituteItemId: zUuid.nullable().optional() })).min(1).max(200) }), req.body);
    return reply.code(201).send(await tdb(req, (db) => mfg.createBom(db, req.user!, b)));
  });
  app.post("/manufacturing/boms/:id/approve", { schema: { ...M, summary: "Approve version (archives the previous approved one; SoD)" }, preHandler: can("manufacturing.boms.approve") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => mfg.approveBom(db, req.user!, id));
  });

  // ---------------------------------------------------------------- planning
  app.get("/manufacturing/requirements", { schema: { ...M, summary: "Material availability for a planned quantity" }, preHandler: can("manufacturing.planning.view") }, async (req) => {
    const q = parse(z.object({ bomId: zUuid, qty: zQty, warehouseId: zUuid }), req.query);
    return tdb(req, (db) => mfg.requirements(db, q.bomId, q.qty, q.warehouseId));
  });
  app.get("/manufacturing/mrp", { schema: { ...M, summary: "MRP: net requirements of open orders vs stock, with purchase suggestions" }, preHandler: can("manufacturing.planning.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, (db) => mfg.mrp(db, q.companyId));
  });

  // ---------------------------------------------------------------- production orders
  app.get("/manufacturing/orders", { schema: { ...M, summary: "Production orders" }, preHandler: can("manufacturing.orders.view") }, async (req) => {
    const q = parse(zPage.extend({ companyId: zUuid, status: z.enum(["draft", "released", "in_progress", "completed", "cancelled"]).optional() }), req.query);
    const { limit, offset } = pageSql(q);
    return tdb(req, async (db) => {
      const args = [q.companyId, q.status ?? null];
      const total = Number((await db.query("SELECT count(*) FROM production_orders WHERE company_id = $1 AND ($2::mo_status IS NULL OR status = $2)", args)).rows[0].count);
      const rows = (await db.query(`SELECT o.*, i.code AS item_code, i.name_ar AS item_name_ar, l.lot_no AS output_lot_no FROM production_orders o JOIN items i ON i.id = o.item_id
         LEFT JOIN lots l ON l.id = o.output_lot_id WHERE o.company_id = $1 AND ($2::mo_status IS NULL OR o.status = $2) ORDER BY o.planned_date DESC, o.created_at DESC LIMIT $3 OFFSET $4`, [...args, limit, offset])).rows;
      return paged(rows, total, q);
    });
  });
  app.get("/manufacturing/orders/:id", { schema: { ...M, summary: "Order with entries and material availability" }, preHandler: can("manufacturing.orders.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => {
      const o = await mfg.getOrder(db, id);
      return { ...o, requirements: await mfg.requirements(db, o.bom_id, o.produced_qty ?? o.planned_qty, o.material_warehouse_id, o.id) };
    });
  });
  app.get("/manufacturing/orders/:id/cost", { schema: { ...M, summary: "Actual vs standard cost, yield, material variances" }, preHandler: can("manufacturing.orders.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => mfg.costReport(db, id));
  });
  app.post("/manufacturing/orders", { schema: { ...M, summary: "Create production order (approved formula; output to quarantine)" }, preHandler: can("manufacturing.orders.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, itemId: zUuid, bomId: zUuid.optional(), workCenterId: zUuid.nullable().optional(), plannedQty: zQty, materialWarehouseId: zUuid,
      outputWarehouseId: zUuid, plannedDate: zDate, notes: z.string().max(2000).optional() }), req.body);
    return tdb(req, (db) => idempotent(req, reply, db, req.user!.tenantId, async () => ({ status: 201, body: await mfg.createOrder(db, req.user!, b) })));
  });
  app.delete("/manufacturing/orders/:id", { schema: { ...M, summary: "Delete a draft order" }, preHandler: can("manufacturing.orders.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    await tdb(req, async (db) => { const r = await db.query("DELETE FROM production_orders WHERE id = $1", [id]); if (!r.rowCount) throw E.notFound("production order"); });
    return { ok: true };
  });
  app.post("/manufacturing/orders/:id/release", { schema: { ...M, summary: "Release (freezes standard unit cost, assigns number)" }, preHandler: can("manufacturing.orders.release") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => mfg.releaseOrder(db, req.user!, id));
  });
  app.post("/manufacturing/orders/:id/issue", { schema: { ...M, summary: "Issue (or return) material — FEFO, no expired/held lots" }, preHandler: can("manufacturing.execution.issue") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ itemId: zUuid, qty: zQty, lotId: zUuid.nullable().optional(), entryDate: zDate, kind: z.enum(["issue", "return"]).default("issue") }), req.body);
    return tdb(req, (db) => idempotent(req, reply, db, req.user!.tenantId, async () => ({ status: 201, body: await mfg.issueMaterial(db, req.user!, id, b) })));
  });
  app.post("/manufacturing/orders/:id/time", { schema: { ...M, summary: "Record line hours (conversion cost absorbed to WIP)" }, preHandler: can("manufacturing.execution.time") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ hours: zQty, entryDate: zDate, notes: z.string().max(500).optional() }), req.body);
    return tdb(req, (db) => idempotent(req, reply, db, req.user!.tenantId, async () => ({ status: 201, body: await mfg.recordTime(db, req.user!, id, b) })));
  });
  app.post("/manufacturing/orders/:id/complete", { schema: { ...M, summary: "Complete: output lot into quarantine at actual cost; WIP cleared" }, preHandler: can("manufacturing.orders.complete") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ producedQty: zQty, scrapQty: z.union([z.string(), z.number()]).transform(String).optional(), lotNo: z.string().min(1).max(60),
      productionDate: zDate, expiryDate: zDate.optional(), entryDate: zDate }), req.body);
    return tdb(req, (db) => idempotent(req, reply, db, req.user!.tenantId, async () => ({ status: 200, body: await mfg.completeOrder(db, req.user!, id, b) })));
  });

  // ---------------------------------------------------------------- quality
  app.get("/quality/specs", { schema: { ...Q, summary: "Quality specs of an item" }, preHandler: can("quality.view") }, async (req) => {
    const q = parse(z.object({ itemId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT * FROM quality_specs WHERE item_id = $1 ORDER BY stage, parameter", [q.itemId])).rows);
  });
  app.put("/quality/specs", { schema: { ...Q, summary: "Replace specs of (item, stage); mark HACCP critical control points" }, preHandler: can("quality.specs.manage") }, async (req) => {
    const b = parse(z.object({ itemId: zUuid, stage: z.enum(["receiving", "in_process", "final", "return"]),
      specs: z.array(z.object({ parameter: z.string().min(1).max(100), unit: z.string().max(20).optional(), min: zNum.nullable().optional(), max: zNum.nullable().optional(), isCcp: z.boolean().optional() })).max(100) }), req.body);
    return tdb(req, (db) => qa.replaceSpecs(db, req.user!, b.itemId, b.stage, b.specs));
  });
  app.get("/quality/checks", { schema: { ...Q, summary: "Quality checks (by lot or latest)" }, preHandler: can("quality.view") }, async (req) => {
    const q = parse(zPage.extend({ companyId: zUuid, lotId: zUuid.optional(), result: z.enum(["pass", "fail"]).optional() }), req.query);
    const { limit, offset } = pageSql(q);
    return tdb(req, async (db) => {
      const args = [q.companyId, q.lotId ?? null, q.result ?? null];
      const where = "WHERE c.company_id = $1 AND ($2::uuid IS NULL OR c.lot_id = $2) AND ($3::qc_result IS NULL OR c.result = $3)";
      const total = Number((await db.query(`SELECT count(*) FROM quality_checks c ${where}`, args)).rows[0].count);
      const rows = (await db.query(`SELECT c.*, l.lot_no, i.code AS item_code, i.name_ar AS item_name_ar, u.full_name AS checked_by_name,
          coalesce((SELECT json_agg(r ORDER BY r.parameter) FROM quality_check_results r WHERE r.check_id = c.id), '[]') AS results
        FROM quality_checks c JOIN lots l ON l.id = c.lot_id JOIN items i ON i.id = l.item_id JOIN users u ON u.id = c.checked_by ${where} ORDER BY c.checked_at DESC LIMIT $4 OFFSET $5`, [...args, limit, offset])).rows;
      return paged(rows, total, q);
    });
  });
  app.post("/quality/checks", { schema: { ...Q, summary: "Record a check — judged by the system against specs; failure holds the lot and opens an NCR" }, preHandler: can("quality.checks.create") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, lotId: zUuid, stage: z.enum(["receiving", "in_process", "final", "return"]), productionOrderId: zUuid.nullable().optional(),
      sampleSize: z.string().max(50).optional(), notes: z.string().max(2000).optional(),
      results: z.array(z.object({ parameter: z.string().min(1), value: zNum.nullable().optional(), textValue: z.string().max(500).nullable().optional(), passed: z.boolean().optional() })).max(100) }), req.body);
    return reply.code(201).send(await tdb(req, (db) => qa.recordCheck(db, req.user!, b)));
  });
  app.get("/quality/ncrs", { schema: { ...Q, summary: "Non-conformance reports" }, preHandler: can("quality.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["open", "closed"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT n.*, l.lot_no, i.code AS item_code FROM nonconformances n LEFT JOIN lots l ON l.id = n.lot_id LEFT JOIN items i ON i.id = l.item_id
       WHERE n.company_id = $1 AND ($2::ncr_status IS NULL OR n.status = $2) ORDER BY n.created_at DESC LIMIT 500`, [q.companyId, q.status ?? null])).rows);
  });
  app.post("/quality/ncrs/:id/close", { schema: { ...Q, summary: "Close NCR with disposition and CAPA" }, preHandler: can("quality.ncr.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ disposition: z.enum(["rework", "scrap", "return_to_supplier", "use_as_is"]), rootCause: z.string().min(3), correctiveAction: z.string().min(3), preventiveAction: z.string().optional() }), req.body);
    return tdb(req, (db) => qa.closeNcr(db, req.user!, id, b));
  });
  app.get("/quality/trace/:id", { schema: { ...Q, summary: "Full genealogy of a lot: backward to suppliers, forward through production to customers" }, preHandler: can("quality.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => ({ backward: await qa.traceBackward(db, id), forward: await qa.traceForward(db, id) }));
  });
  app.get("/quality/recalls", { schema: { ...Q, summary: "Recalls" }, preHandler: can("quality.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT r.id, r.number, r.reason, r.status, r.created_at, l.lot_no, jsonb_array_length(r.snapshot->'forward'->'customers') AS customer_lines,
       jsonb_array_length(r.snapshot->'forward'->'lots') AS lots FROM recalls r JOIN lots l ON l.id = r.lot_id WHERE r.company_id = $1 ORDER BY r.created_at DESC`, [q.companyId])).rows);
  });
  app.post("/quality/recalls", { schema: { ...Q, summary: "Start a recall: holds every affected lot and freezes the trace as evidence" }, preHandler: can("quality.recall.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, lotId: zUuid, reason: z.string().min(5).max(2000) }), req.body);
    return reply.code(201).send(await tdb(req, (db) => qa.createRecall(db, req.user!, b)));
  });
}
