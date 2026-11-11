import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zMoney, zDate, idempotent, send } from "../../core/http.js";
import { E } from "../../core/errors.js";
import * as pos from "./pos.service.js";

const P = { tags: ["Point of Sale"] };
const id$ = z.object({ id: zUuid });
const zQty = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((x) => /^\d{1,12}(\.\d{1,6})?$/.test(x) && Number(x) > 0, "positive quantity");
const zPct = z.union([z.string(), z.number()]).transform((v) => String(v)).refine((x) => /^\d{1,3}(\.\d{1,2})?$/.test(x) && Number(x) <= 100, "0..100");
const today = () => new Date().toISOString().slice(0, 10);

export async function posRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- registers
  app.get("/pos/registers", { schema: { ...P, summary: "POS registers (with the open shift, if any)" }, preHandler: can("pos.shifts.operate") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT r.*, w.code AS warehouse_code, s.id AS open_shift_id, s.number AS open_shift_number, s.cashier_id AS open_shift_cashier_id, u.full_name AS open_shift_cashier
         FROM pos_registers r JOIN warehouses w ON w.id = r.warehouse_id LEFT JOIN pos_shifts s ON s.register_id = r.id AND s.status = 'open' LEFT JOIN users u ON u.id = s.cashier_id
        WHERE r.company_id = $1 ORDER BY r.code`, [q.companyId])).rows);
  });
  app.post("/pos/registers", { schema: { ...P, summary: "Create register: sellable warehouse, quarantine returns, drawer/safe/card/over-short accounts, discount limit" }, preHandler: can("pos.registers.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, branchId: zUuid, code: z.string().regex(/^[A-Z0-9_-]{1,20}$/), nameAr: z.string().min(2), warehouseId: zUuid, returnWarehouseId: zUuid,
      walkInCustomerId: zUuid, cashAccountId: zUuid, safeAccountId: zUuid, cardAccountId: zUuid.nullable().optional(), varianceAccountId: zUuid.nullable().optional(),
      maxDiscountPct: zPct.optional(), receiptHeader: z.string().max(500).optional(), receiptFooter: z.string().max(500).optional() }), req.body);
    return reply.code(201).send(await tdb(req, (db) => pos.createRegister(db, req.user!, b)));
  });

  // ---------------------------------------------------------------- catalogue for the counter
  app.get("/pos/registers/:id/catalog", { schema: { ...P, summary: "Sellable items with price, barcodes and sellable quantity in the register's warehouse" }, preHandler: can("pos.shifts.operate") }, async (req) => {
    const { id } = parse(id$, req.params);
    const q = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `WITH r AS (SELECT * FROM pos_registers WHERE id = $1)
       SELECT i.id, i.code, i.name_ar, i.name_en, i.barcode, i.sales_price, i.track_lots, u.code AS uom_code,
              (SELECT coalesce(json_agg(json_build_object('uomId', iu.uom_id, 'code', uu.code, 'factor', iu.factor, 'barcode', iu.barcode)), '[]') FROM item_uoms iu JOIN uoms uu ON uu.id = iu.uom_id WHERE iu.item_id = i.id) AS units,
              CASE WHEN i.track_lots THEN (SELECT coalesce(sum(lb.qty), 0) FROM lot_balances lb JOIN lots l ON l.id = lb.lot_id
                                            WHERE lb.warehouse_id = r.warehouse_id AND l.item_id = i.id AND NOT l.on_hold AND (l.expiry_date IS NULL OR l.expiry_date >= current_date))
                   ELSE (SELECT coalesce(sum(qty), 0) FROM stock_balances sb WHERE sb.warehouse_id = r.warehouse_id AND sb.item_id = i.id) END::numeric(20,4)::text AS available
         FROM items i JOIN r ON r.company_id = i.company_id JOIN uoms u ON u.id = i.base_uom_id
        WHERE i.is_active AND i.kind IN ('finished', 'service') AND i.sales_price IS NOT NULL
          AND ($2::text IS NULL OR i.code ILIKE '%' || $2 || '%' OR i.name_ar ILIKE '%' || $2 || '%' OR i.barcode = $2)
        ORDER BY i.code LIMIT 500`, [id, q.q ?? null])).rows);
  });

  // ---------------------------------------------------------------- shifts
  app.get("/pos/shifts", { schema: { ...P, summary: "Shifts (cashiers see their own; supervisors all)" }, preHandler: can("pos.shifts.operate") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["open", "closed"]).optional() }), req.query);
    const all = req.user!.permissions.has("pos.shifts.supervise");
    return tdb(req, async (db) => (await db.query(
      `SELECT s.*, r.code AS register_code, u.full_name AS cashier,
              (SELECT count(*) FROM sales_invoices i WHERE i.pos_shift_id = s.id AND i.status = 'posted')::int AS invoices,
              (SELECT coalesce(sum(total), 0) FROM sales_invoices i WHERE i.pos_shift_id = s.id AND i.status = 'posted')::numeric(20,4)::text AS net
         FROM pos_shifts s JOIN pos_registers r ON r.id = s.register_id JOIN users u ON u.id = s.cashier_id
        WHERE s.company_id = $1 AND ($2::pos_shift_status IS NULL OR s.status = $2) AND ($3 OR s.cashier_id = $4)
        ORDER BY s.opened_at DESC LIMIT 200`, [q.companyId, q.status ?? null, all, req.user!.userId])).rows);
  });
  app.get("/pos/shifts/current", { schema: { ...P, summary: "My open shift (or null)" }, preHandler: can("pos.shifts.operate") }, async (req) => {
    return tdb(req, async (db) => {
      const s = (await db.query("SELECT id FROM pos_shifts WHERE cashier_id = $1 AND status = 'open'", [req.user!.userId])).rows[0];
      return s ? pos.shiftReport(db, s.id) : null;
    });
  });
  app.post("/pos/shifts", { schema: { ...P, summary: "Open my shift (opening float moved from the safe to the drawer)" }, preHandler: can("pos.shifts.operate") }, async (req, reply) => {
    const b = parse(z.object({ registerId: zUuid, openingFloat: zMoney.default("0"), businessDate: zDate.optional() }), req.body);
    return reply.code(201).send(await tdb(req, (db) => pos.openShift(db, req.user!, { ...b, businessDate: b.businessDate ?? today() })));
  });
  app.get("/pos/shifts/:id", { schema: { ...P, summary: "X/Z report of a shift" }, preHandler: can("pos.shifts.operate") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => {
      const r = await pos.shiftReport(db, id);
      if (r.shift.cashier_id !== req.user!.userId && !req.user!.permissions.has("pos.shifts.supervise") && !req.user!.permissions.has("pos.reports.view")) throw E.forbidden("pos.shifts.supervise");
      return r;
    });
  });
  app.post("/pos/shifts/:id/sales", { schema: { ...P, summary: "Sell (posted immediately). clientId makes retries safe." }, preHandler: can("pos.shifts.operate") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ clientId: z.string().min(8).max(100), customerId: zUuid.nullable().optional(), notes: z.string().max(500).optional(),
      lines: z.array(z.object({ itemId: zUuid.optional(), barcode: z.string().min(1).max(64).optional(), uomId: zUuid.nullable().optional(), qty: zQty, discountPct: zPct.optional() })
        .refine((l) => !!l.itemId !== !!l.barcode, "itemId or barcode")).min(1).max(200),
      cash: zMoney.default("0"), card: zMoney.default("0"), credit: zMoney.default("0"), tendered: zMoney.optional() }), req.body);
    const r = await tdb(req, (db) => pos.sell(db, req.user!, id, b));
    return reply.code(r.replayed ? 200 : 201).send(r);
  });
  app.get("/pos/sales/:id/receipt", { schema: { ...P, summary: "Receipt data for printing" }, preHandler: can("pos.shifts.operate") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => pos.receipt(db, id));
  });
  app.post("/pos/shifts/:id/returns", { schema: { ...P, summary: "Return & refund (goods go to quarantine)" }, preHandler: can("pos.sales.return") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ invoiceId: zUuid, lines: z.array(z.object({ invoiceLineId: zUuid, qty: zQty })).min(1), refundTender: z.enum(["cash", "card"]).default("cash"),
      reason: z.string().min(3).max(500) }), req.body);
    return send(reply, await tdb(req, (db) => idempotent(req, db, req.user!.tenantId, async () => ({ status: 201, body: await pos.returnSale(db, req.user!, id, b) }))));
  });
  app.post("/pos/shifts/:id/drops", { schema: { ...P, summary: "Cash drop to the main safe" }, preHandler: can("pos.shifts.supervise") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ amount: zMoney.refine((x) => Number(x) > 0, "positive"), note: z.string().max(300).optional() }), req.body);
    return send(reply, await tdb(req, (db) => idempotent(req, db, req.user!.tenantId, async () => ({ status: 201, body: await pos.cashDrop(db, req.user!, id, b) }))));
  });
  app.post("/pos/shifts/:id/close", { schema: { ...P, summary: "Close (Z): counted cash to the safe, over/short posted" }, preHandler: can("pos.shifts.operate") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ countedCash: zMoney, notes: z.string().max(500).optional() }), req.body);
    return send(reply, await tdb(req, (db) => idempotent(req, db, req.user!.tenantId, async () => ({ status: 200, body: await pos.closeShift(db, req.user!, id, b) }))));
  });
}
