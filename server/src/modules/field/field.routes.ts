import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zMoney, zDate } from "../../core/http.js";
import { AppError, E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import * as f from "./field.service.js";

const F = { tags: ["Field sales (rep app)"] };
const D = { tags: ["Distribution"] };
const zQty = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((s) => /^\d{1,12}(\.\d{1,4})?$/.test(s) && Number(s) > 0, "positive quantity");
const zPct = z.union([z.string(), z.number()]).transform((v) => String(v)).refine((s) => /^\d{1,3}(\.\d{1,4})?$/.test(s) && Number(s) <= 100, "0..100");
const zPeriod = z.string().regex(/^\d{4}-\d{2}$/);
const id$ = z.object({ id: zUuid });

const zOp = z.discriminatedUnion("type", [
  z.object({ clientId: z.string().min(8).max(100), type: z.literal("invoice"), clientTime: z.string().datetime().optional(), payload: z.object({
    customerId: zUuid, paymentType: z.enum(["cash", "credit"]), invoiceDate: zDate,
    lines: z.array(z.object({ itemId: zUuid, uomId: zUuid.nullable().optional(), qty: zQty, discountPct: zPct.optional() }).strict()).min(1).max(100) }).strict() }),
  z.object({ clientId: z.string().min(8).max(100), type: z.literal("receipt"), clientTime: z.string().datetime().optional(), payload: z.object({
    customerId: zUuid, amount: zMoney.refine((s) => Number(s) > 0, "> 0"), paymentDate: zDate, salesInvoiceId: zUuid.nullable().optional() }).strict() }),
  z.object({ clientId: z.string().min(8).max(100), type: z.literal("visit"), clientTime: z.string().datetime().optional(), payload: z.object({
    customerId: zUuid, outcome: z.enum(["sale", "collection", "no_order", "closed", "refused", "other"]), visitedAt: z.string().datetime(),
    lat: z.number().min(-90).max(90).nullable().optional(), lng: z.number().min(-180).max(180).nullable().optional(), notes: z.string().max(1000).optional() }).strict() }),
]);

export async function fieldRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- rep app
  app.get("/field/my-day", { schema: { ...F, summary: "Today's route, van stock, today's totals and cash custody (own data only)" }, preHandler: can("distribution.field.app") }, async (req) => {
    const q = parse(z.object({ date: zDate.optional() }), req.query);
    return tdb(req, async (db) => f.myDay(db, await f.repOfUser(db, req.user!.userId), q.date ?? new Date().toISOString().slice(0, 10)));
  });

  app.post("/field/sync", { schema: { ...F, summary: "Offline sync: batch of field operations; each op is atomic and idempotent by clientId",
    description: "Every op runs in its own transaction. Re-sending an op with the same clientId returns the original result (`replayed: true`) and never duplicates an invoice or receipt. Failed ops are not recorded and can be retried after fixing." },
    preHandler: can("distribution.field.app") }, async (req) => {
    const b = parse(z.object({ ops: z.array(z.unknown()).min(1).max(200) }), req.body);
    const results = [];
    for (const raw of b.ops) {
      const parsed = zOp.safeParse(raw);
      const clientId = (raw as any)?.clientId ?? null;
      if (!parsed.success) { results.push({ clientId, ok: false, error: { code: "VALIDATION_FAILED", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }); continue; }
      try {
        results.push({ clientId, ok: true, result: await tdb(req, (db) => f.applyFieldOp(db, req.user!, parsed.data as f.FieldOp)) });
      } catch (e: any) {
        const appErr = e instanceof AppError;
        if (!appErr && !e?.code) throw e;
        results.push({ clientId, ok: false, error: appErr ? { code: e.code, message: e.message, message_ar: e.messageAr, details: e.details ?? null } : { code: "DB_RULE", message: e.message } });
      }
    }
    return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  });

  app.post("/field/load-requests", { schema: { ...F, summary: "Request a van load (draft transfer; the warehouse posts it)" }, preHandler: can("distribution.field.load") }, async (req, reply) => {
    const b = parse(z.object({ fromWarehouseId: zUuid, docDate: zDate, lines: z.array(z.object({ itemId: zUuid, qty: zQty })).min(1).max(200) }), req.body);
    return reply.code(201).send(await tdb(req, (db) => f.requestLoad(db, req.user!, b)));
  });
  app.post("/field/handovers", { schema: { ...F, summary: "Declare a cash handover from custody (a cashier confirms)" }, preHandler: can("distribution.field.load") }, async (req, reply) => {
    const b = parse(z.object({ amount: zMoney.refine((s) => Number(s) > 0, "> 0"), handoverDate: zDate, notes: z.string().max(500).optional() }), req.body);
    return reply.code(201).send(await tdb(req, (db) => f.submitHandover(db, req.user!, b)));
  });
  app.post("/field/settlements", { schema: { ...F, summary: "Submit end-of-day van count (a supervisor approves)" }, preHandler: can("distribution.field.load") }, async (req, reply) => {
    const b = parse(z.object({ settlementDate: zDate, notes: z.string().max(1000).optional(), counts: z.array(z.object({ itemId: zUuid, countedQty: z.union([z.string(), z.number()]).transform(String) })).max(500) }), req.body);
    return reply.code(201).send(await tdb(req, (db) => f.submitSettlement(db, req.user!, b)));
  });

  // ---------------------------------------------------------------- administration
  app.get("/distribution/reps", { schema: { ...D, summary: "Reps with van, territory, commission and custody" }, preHandler: can("distribution.reps.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => {
      const rows = (await db.query(`SELECT r.*, u.full_name, u.email, w.code AS van_code, t.name_ar AS territory_name FROM sales_reps r JOIN users u ON u.id = r.user_id
         JOIN warehouses w ON w.id = r.van_warehouse_id LEFT JOIN territories t ON t.id = r.territory_id WHERE r.company_id = $1 ORDER BY r.code`, [q.companyId])).rows;
      for (const r of rows) r.custody = await f.custodyBalance(db, r.id);
      return rows;
    });
  });
  app.post("/distribution/reps", { schema: { ...D, summary: "Register a rep (user with sales_rep role + van warehouse)" }, preHandler: can("distribution.reps.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, userId: zUuid, code: z.string().regex(/^[A-Z0-9_-]{1,20}$/), vanWarehouseId: zUuid, territoryId: zUuid.nullable().optional(),
      commissionType: z.enum(["none", "flat", "tiered"]).default("none"), commissionRate: zPct.optional(), maxDiscountPct: zPct.optional(),
      tiers: z.array(z.object({ upTo: zMoney.nullable(), rate: zPct })).max(10).optional() }), req.body);
    return reply.code(201).send(await tdb(req, (db) => f.createRep(db, req.user!, b)));
  });
  app.put("/distribution/reps/:id/routes", { schema: { ...D, summary: "Set the route of a weekday (ordered customers)" }, preHandler: can("distribution.reps.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ weekday: z.number().int().min(0).max(6), name: z.string().min(1).max(100), customerIds: z.array(zUuid).max(300) }), req.body);
    return tdb(req, (db) => f.setRoute(db, req.user!, id, b));
  });
  app.put("/distribution/reps/:id/targets", { schema: { ...D, summary: "Set monthly targets" }, preHandler: can("distribution.reps.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ period: zPeriod, salesTarget: zMoney.default("0"), collectionTarget: zMoney.default("0"), visitsTarget: z.number().int().min(0).default(0) }), req.body);
    return tdb(req, async (db) => {
      const r = (await db.query(`INSERT INTO rep_targets (tenant_id, rep_id, period, sales_target, collection_target, visits_target) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (rep_id, period) DO UPDATE SET sales_target = EXCLUDED.sales_target, collection_target = EXCLUDED.collection_target, visits_target = EXCLUDED.visits_target RETURNING *`,
        [req.user!.tenantId, id, b.period, b.salesTarget, b.collectionTarget, b.visitsTarget])).rows[0];
      await audit(db, { tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId, action: "rep.targets_set", entityType: "sales_rep", entityId: id, after: b });
      return r;
    });
  });
  app.get("/distribution/territories", { schema: { ...D, summary: "Territories" }, preHandler: can("distribution.reps.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT * FROM territories WHERE company_id = $1 ORDER BY code", [q.companyId])).rows);
  });
  app.post("/distribution/territories", { schema: { ...D, summary: "Create territory" }, preHandler: can("distribution.reps.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, code: z.string().regex(/^[A-Z0-9_-]{1,20}$/), nameAr: z.string().min(2) }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query("INSERT INTO territories (tenant_id, company_id, code, name_ar) VALUES ($1,$2,$3,$4) RETURNING *",
      [req.user!.tenantId, b.companyId, b.code, b.nameAr])).rows[0]));
  });
  app.put("/distribution/customers/:id/territory", { schema: { ...D, summary: "Assign a customer to a territory (and optional location)" }, preHandler: can("distribution.reps.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ territoryId: zUuid.nullable(), lat: z.number().min(-90).max(90).nullable().optional(), lng: z.number().min(-180).max(180).nullable().optional() }), req.body);
    return tdb(req, async (db) => {
      const r = (await db.query("UPDATE parties SET territory_id = $2, lat = coalesce($3, lat), lng = coalesce($4, lng) WHERE id = $1 RETURNING id, territory_id, lat, lng", [id, b.territoryId, b.lat ?? null, b.lng ?? null])).rows[0];
      if (!r) throw E.notFound("customer");
      return r;
    });
  });

  // ---------------------------------------------------------------- supervision & finance
  app.get("/distribution/settlements", { schema: { ...D, summary: "Day settlements" }, preHandler: can("distribution.reps.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["submitted", "approved", "rejected"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT s.*, r.code AS rep_code, u.full_name FROM van_settlements s JOIN sales_reps r ON r.id = s.rep_id JOIN users u ON u.id = r.user_id
       WHERE s.company_id = $1 AND ($2::settlement_status IS NULL OR s.status = $2) ORDER BY s.settlement_date DESC, s.created_at DESC LIMIT 300`, [q.companyId, q.status ?? null])).rows);
  });
  app.get("/distribution/settlements/:id", { schema: { ...D, summary: "Settlement with counted vs book quantities" }, preHandler: can("distribution.reps.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => f.getSettlement(db, id));
  });
  app.post("/distribution/settlements/:id/approve", { schema: { ...D, summary: "Approve: shortages charged to the rep, overages to inventory adjustment" }, preHandler: can("distribution.settlements.approve") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => f.approveSettlement(db, req.user!, id));
  });
  app.get("/distribution/handovers", { schema: { ...D, summary: "Cash handovers" }, preHandler: can("distribution.reps.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["submitted", "confirmed", "rejected"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT h.*, r.code AS rep_code, u.full_name FROM cash_handovers h JOIN sales_reps r ON r.id = h.rep_id JOIN users u ON u.id = r.user_id
       WHERE h.company_id = $1 AND ($2::handover_status IS NULL OR h.status = $2) ORDER BY h.created_at DESC LIMIT 300`, [q.companyId, q.status ?? null])).rows);
  });
  app.post("/distribution/handovers/:id/confirm", { schema: { ...D, summary: "Cashier confirms the counted cash (shortage charged to the rep)" }, preHandler: can("distribution.cash.confirm") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ countedAmount: zMoney, notes: z.string().max(500).optional() }), req.body);
    return tdb(req, (db) => f.confirmHandover(db, req.user!, id, b));
  });
  app.get("/distribution/performance", { schema: { ...D, summary: "Rep performance vs targets for a month" }, preHandler: can("distribution.reps.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, period: zPeriod }), req.query);
    return tdb(req, (db) => f.repPerformance(db, q.companyId, q.period));
  });
  app.get("/distribution/commission-runs", { schema: { ...D, summary: "Commission runs" }, preHandler: can("distribution.reps.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT * FROM commission_runs WHERE company_id = $1 ORDER BY period DESC", [q.companyId])).rows);
  });
  app.get("/distribution/commission-runs/:id", { schema: { ...D, summary: "Commission run detail" }, preHandler: can("distribution.reps.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => f.getCommissionRun(db, id));
  });
  app.post("/distribution/commission-runs", { schema: { ...D, summary: "Calculate commissions for a month (on collected money)" }, preHandler: can("distribution.commissions.run") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, period: zPeriod }), req.body);
    return reply.code(201).send(await tdb(req, (db) => f.createCommissionRun(db, req.user!, b)));
  });
  app.post("/distribution/commission-runs/:id/post", { schema: { ...D, summary: "Post commissions (Dr commission expense / Cr commissions payable; SoD)" }, preHandler: can("distribution.commissions.run") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => f.postCommissionRun(db, req.user!, id));
  });
  app.get("/distribution/notifications", { schema: { ...D, summary: "Outbound customer notifications (e.g. recall notices)" }, preHandler: can("distribution.notifications.view") }, async (req) => {
    const q = parse(z.object({ status: z.enum(["queued", "sent", "failed", "cancelled"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT n.*, p.code AS party_code, p.name_ar AS party_name FROM notification_outbox n LEFT JOIN parties p ON p.id = n.party_id
       WHERE ($1::notification_status IS NULL OR n.status = $1) ORDER BY n.created_at DESC LIMIT 500`, [q.status ?? null])).rows);
  });
}
