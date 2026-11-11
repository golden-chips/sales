// Field sales & distribution — the van-sales operating model on top of the ERP core.
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { createInvoice, postInvoice, createPayment, postPayment } from "../erp/sales.service.js";
import { createStockDoc } from "../erp/inventory.service.js";
import { stockIn, stockOut } from "../erp/stock.js";
import { docNumber, minorUnits, postJournal } from "../erp/common.js";

const one = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
const log = (db: Db, u: UserCtx, action: string, entityType: string, entityId: string, after?: unknown, before?: unknown) =>
  audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action, entityType, entityId, after, before });

/**
 * Field documents are posted by the field app itself (the rep cannot wait for a
 * second person at the shop). Segregation of duties is replaced by compensating
 * controls: price list only, discount ceiling per rep, assigned customers only,
 * credit limit, and the supervisor-approved day settlement + cashier-confirmed
 * cash handover.
 */
const fieldCtx = (u: UserCtx): UserCtx => ({ ...u, enforceSod: false });

export async function repOfUser(db: Db, userId: string) {
  const r = await one(db, "SELECT * FROM sales_reps WHERE user_id = $1", [userId]);
  if (!r) throw E.rule("NOT_A_REP", "هذا المستخدم غير مسجل كمندوب", "This user is not registered as a sales rep");
  if (!r.is_active) throw E.rule("REP_INACTIVE", "حساب المندوب موقوف", "Rep is inactive");
  return r;
}

// ------------------------------------------------------------------ administration
export async function createRep(db: Db, u: UserCtx, b: { companyId: string; userId: string; code: string; vanWarehouseId: string; territoryId?: string | null;
  commissionType?: "none" | "flat" | "tiered"; commissionRate?: string; maxDiscountPct?: string; tiers?: { upTo: string | null; rate: string }[] }) {
  const wh = await one(db, "SELECT w.kind, b.company_id FROM warehouses w JOIN branches b ON b.id = w.branch_id WHERE w.id = $1", [b.vanWarehouseId]);
  if (!wh || wh.company_id !== b.companyId) throw E.validation([{ path: "vanWarehouseId", message: "warehouse not found in this company" }]);
  if (wh.kind !== "van") throw E.rule("NOT_A_VAN", "مخزن المندوب يجب أن يكون من نوع «سيارة توزيع» (van)", "The rep's warehouse must be of kind 'van'");
  const isRep = await one(db, "SELECT 1 AS x FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.code = 'sales_rep'", [b.userId]);
  if (!isRep) throw E.rule("USER_NOT_SALES_REP", "يجب أن يحمل المستخدم دور «مندوب مبيعات»", "The user must hold the sales_rep role");
  const r = await one(db, `INSERT INTO sales_reps (tenant_id, company_id, user_id, code, van_warehouse_id, territory_id, commission_type, commission_rate, max_discount_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [u.tenantId, b.companyId, b.userId, b.code, b.vanWarehouseId, b.territoryId ?? null, b.commissionType ?? "none", b.commissionRate ?? "0", b.maxDiscountPct ?? "0"]);
  if (b.commissionType === "tiered") {
    if (!b.tiers?.length) throw E.validation([{ path: "tiers", message: "tiered commission needs tiers" }]);
    let i = 0;
    for (const t of b.tiers) await db.query("INSERT INTO commission_tiers (tenant_id, rep_id, tier_no, up_to, rate) VALUES ($1,$2,$3,$4,$5)", [u.tenantId, r.id, ++i, t.upTo, t.rate]);
  }
  await log(db, u, "rep.created", "sales_rep", r.id, b);
  return r;
}

export async function setRoute(db: Db, u: UserCtx, repId: string, b: { weekday: number; name: string; customerIds: string[] }) {
  const rep = await one(db, "SELECT * FROM sales_reps WHERE id = $1", [repId]);
  if (!rep) throw E.notFound("rep");
  const route = await one(db, `INSERT INTO routes (tenant_id, rep_id, weekday, name) VALUES ($1,$2,$3,$4)
     ON CONFLICT (rep_id, weekday) DO UPDATE SET name = EXCLUDED.name RETURNING *`, [u.tenantId, repId, b.weekday, b.name]);
  await db.query("DELETE FROM route_stops WHERE route_id = $1", [route.id]);
  let seq = 0;
  for (const c of b.customerIds) {
    const ok = await one(db, "SELECT 1 AS x FROM parties WHERE id = $1 AND company_id = $2 AND kind IN ('customer','both')", [c, rep.company_id]);
    if (!ok) throw E.validation([{ path: "customerIds", message: "customer not found in this company" }]);
    await db.query("INSERT INTO route_stops (tenant_id, route_id, seq, customer_id) VALUES ($1,$2,$3,$4)", [u.tenantId, route.id, ++seq, c]);
  }
  await log(db, u, "route.set", "route", route.id, b);
  return route;
}

/** a rep may only serve customers on one of their routes or in their territory */
async function assertAssigned(db: Db, rep: any, customerId: string) {
  const ok = await one(db, `SELECT 1 AS x FROM parties p WHERE p.id = $2 AND p.company_id = $3 AND p.is_active AND p.kind IN ('customer','both') AND (
      EXISTS (SELECT 1 FROM route_stops s JOIN routes r ON r.id = s.route_id WHERE r.rep_id = $1 AND s.customer_id = p.id)
      OR ($4::uuid IS NOT NULL AND p.territory_id = $4))`, [rep.id, customerId, rep.company_id, rep.territory_id]);
  if (!ok) throw E.rule("CUSTOMER_NOT_ASSIGNED", "العميل غير مسند لهذا المندوب (لا في مساراته ولا في منطقته)", "Customer is not assigned to this rep (route or territory)");
}

// ------------------------------------------------------------------ the rep's day
export async function myDay(db: Db, rep: any, date: string) {
  const weekday = (await one(db, "SELECT extract(dow FROM $1::date)::int AS d", [date])).d;
  const stops = (await db.query(
    `SELECT s.seq, p.id, p.code, p.name_ar, p.phone, p.city, p.lat, p.lng, p.credit_limit,
            (SELECT coalesce(sum(total - amount_paid - amount_returned),0) FROM sales_invoices si WHERE si.customer_id = p.id AND si.status = 'posted') AS balance,
            (SELECT max(visited_at) FROM visits v WHERE v.customer_id = p.id) AS last_visit,
            EXISTS (SELECT 1 FROM visits v WHERE v.customer_id = p.id AND v.rep_id = $2 AND v.visited_at::date = $3::date) AS visited_today
       FROM routes r JOIN route_stops s ON s.route_id = r.id JOIN parties p ON p.id = s.customer_id
      WHERE r.rep_id = $2 AND r.weekday = $1 ORDER BY s.seq`, [weekday, rep.id, date])).rows;
  const van = (await db.query(
    `SELECT i.id, i.code, i.name_ar, i.sales_price, u.code AS uom, b.qty,
            coalesce((SELECT json_agg(json_build_object('uomId', iu.uom_id, 'code', u2.code, 'factor', iu.factor)) FROM item_uoms iu JOIN uoms u2 ON u2.id = iu.uom_id WHERE iu.item_id = i.id), '[]') AS units
       FROM stock_balances b JOIN items i ON i.id = b.item_id JOIN uoms u ON u.id = i.base_uom_id WHERE b.warehouse_id = $1 AND b.qty > 0 ORDER BY i.code`, [rep.van_warehouse_id])).rows;
  const today = await one(db, `SELECT
       (SELECT coalesce(sum(total),0) FROM sales_invoices WHERE rep_id = $1 AND status = 'posted' AND invoice_date = $2) AS sales,
       (SELECT count(*) FROM sales_invoices WHERE rep_id = $1 AND status = 'posted' AND invoice_date = $2) AS invoices,
       (SELECT coalesce(sum(amount),0) FROM payments WHERE rep_id = $1 AND status = 'posted' AND payment_date = $2) AS collections,
       (SELECT count(*) FROM visits WHERE rep_id = $1 AND visited_at::date = $2) AS visits`, [rep.id, date]);
  return { rep: { id: rep.id, code: rep.code, maxDiscountPct: rep.max_discount_pct }, date, route: stops, van, today, custody: await custodyBalance(db, rep.id) };
}

export async function custodyBalance(db: Db, repId: string) {
  return (await one(db, `SELECT (
      (SELECT coalesce(sum(total),0) FROM sales_invoices WHERE rep_id = $1 AND status = 'posted' AND payment_type = 'cash')
    + (SELECT coalesce(sum(amount),0) FROM payments WHERE rep_id = $1 AND status = 'posted' AND direction = 'in' AND method = 'rep_custody')
    - (SELECT coalesce(sum(declared_amount),0) FROM cash_handovers WHERE rep_id = $1 AND status = 'confirmed'))::numeric(20,4)::text AS b`, [repId])).b as string;
}

// ------------------------------------------------------------------ offline sync
export type FieldOp =
  | { clientId: string; type: "invoice"; clientTime?: string; payload: { customerId: string; paymentType: "cash" | "credit"; invoiceDate: string; lines: { itemId: string; uomId?: string | null; qty: string; discountPct?: string }[] } }
  | { clientId: string; type: "receipt"; clientTime?: string; payload: { customerId: string; amount: string; paymentDate: string; salesInvoiceId?: string | null } }
  | { clientId: string; type: "visit"; clientTime?: string; payload: { customerId: string; outcome: string; visitedAt: string; lat?: number | null; lng?: number | null; notes?: string } };

/**
 * Applies ONE field operation. Called in its own transaction per op, so a bad
 * op never blocks the rest of the batch. Successful ops are recorded under
 * (rep, clientId): re-sending the same op returns the stored result instead of
 * creating a duplicate (the classic offline double-sync problem).
 */
export async function applyFieldOp(db: Db, u: UserCtx, op: FieldOp) {
  const rep = await repOfUser(db, u.userId);
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`field:${rep.id}:${op.clientId}`]);
  const prev = await one(db, "SELECT result FROM field_ops WHERE rep_id = $1 AND client_id = $2", [rep.id, op.clientId]);
  if (prev) return { ...prev.result, replayed: true };
  const ctx = fieldCtx(u);
  let result: Record<string, unknown>;
  if (op.type === "invoice") {
    const p = op.payload;
    await assertAssigned(db, rep, p.customerId);
    for (const l of p.lines) if (Number(l.discountPct ?? 0) > Number(rep.max_discount_pct))
      throw E.rule("DISCOUNT_NOT_ALLOWED", `الخصم ${l.discountPct}% يتجاوز الحد المسموح للمندوب (${Number(rep.max_discount_pct)}%)`, `Discount exceeds the rep's ceiling (${Number(rep.max_discount_pct)}%)`);
    // no unitPrice from the field: price list / customer special price only
    const draft = await createInvoice(db, ctx, { companyId: rep.company_id, warehouseId: rep.van_warehouse_id, customerId: p.customerId, invoiceDate: p.invoiceDate, paymentType: p.paymentType,
      notes: `field:${op.clientId}`, lines: p.lines.map((l) => ({ itemId: l.itemId, uomId: l.uomId ?? null, qty: l.qty, discountPct: l.discountPct })) });
    await db.query("UPDATE sales_invoices SET rep_id = $2 WHERE id = $1", [draft.id, rep.id]);
    const posted = await postInvoice(db, ctx, draft.id);
    result = { type: "invoice", id: posted.id, number: posted.number, total: posted.total, lines: posted.lines.map((l: any) => ({ item: l.item_code, qty: l.qty, lot: l.lot_no, total: l.line_total })) };
  } else if (op.type === "receipt") {
    const p = op.payload;
    await assertAssigned(db, rep, p.customerId);
    const draft = await createPayment(db, ctx, { companyId: rep.company_id, direction: "in", partyId: p.customerId, method: "rep_custody", paymentDate: p.paymentDate, amount: p.amount,
      reference: `field:${op.clientId}`, salesInvoiceId: p.salesInvoiceId ?? null });
    await db.query("UPDATE payments SET rep_id = $2 WHERE id = $1", [draft.id, rep.id]);
    const posted = await postPayment(db, ctx, draft.id);
    result = { type: "receipt", id: posted.id, number: posted.number, amount: posted.amount, allocations: posted.allocations.length };
  } else if (op.type === "visit") {
    const p = op.payload;
    await assertAssigned(db, rep, p.customerId);
    const gps = await one(db, "SELECT field_gps_required FROM tenant_settings", []);
    if (gps?.field_gps_required && (p.lat === undefined || p.lat === null || p.lng === undefined || p.lng === null))
      throw E.rule("GPS_REQUIRED", "سياسة الشركة تتطلب الموقع الجغرافي للزيارة", "Company policy requires GPS on visits");
    const v = await one(db, `INSERT INTO visits (tenant_id, rep_id, customer_id, visited_at, outcome, lat, lng, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [u.tenantId, rep.id, p.customerId, p.visitedAt, p.outcome, p.lat ?? null, p.lng ?? null, p.notes ?? null]);
    result = { type: "visit", id: v.id };
  } else throw E.validation([{ path: "type", message: "unknown operation type" }]);
  await db.query("INSERT INTO field_ops (tenant_id, rep_id, client_id, op_type, status, result, client_time) VALUES ($1,$2,$3,$4,'ok',$5,$6)",
    [u.tenantId, rep.id, op.clientId, op.type, JSON.stringify(result), op.clientTime ?? null]);
  return { ...result, replayed: false };
}

// ------------------------------------------------------------------ van load (approved by the warehouse)
export async function requestLoad(db: Db, u: UserCtx, b: { fromWarehouseId: string; docDate: string; lines: { itemId: string; qty: string }[] }) {
  const rep = await repOfUser(db, u.userId);
  const from = await one(db, "SELECT kind FROM warehouses WHERE id = $1", [b.fromWarehouseId]);
  if (!from || !["main", "finished_goods"].includes(from.kind)) throw E.rule("INVALID_SOURCE", "التحميل يكون من مخزن رئيسي أو مخزن منتج تام", "Loads come from a main / finished-goods warehouse");
  // a draft transfer: the warehouse posts it (different person → natural SoD)
  return createStockDoc(db, u, { companyId: rep.company_id, reason: "transfer", warehouseId: b.fromWarehouseId, toWarehouseId: rep.van_warehouse_id, docDate: b.docDate,
    notes: `طلب تحميل — المندوب ${rep.code}`, lines: b.lines.map((l) => ({ itemId: l.itemId, qtyDelta: l.qty })) });
}

// ------------------------------------------------------------------ cash handover
export async function submitHandover(db: Db, u: UserCtx, b: { amount: string; handoverDate: string; notes?: string }) {
  const rep = await repOfUser(db, u.userId);
  const pending = await one(db, "SELECT coalesce(sum(declared_amount),0)::text AS p FROM cash_handovers WHERE rep_id = $1 AND status = 'submitted'", [rep.id]);
  const bal = await custodyBalance(db, rep.id);
  if ((await one(db, "SELECT $1::numeric + $2::numeric > $3::numeric AS over", [b.amount, pending.p, bal])).over)
    throw E.rule("EXCEEDS_CUSTODY", `المبلغ أكبر من العهدة النقدية لدى المندوب (${bal})`, `Amount exceeds the rep's cash custody (${bal})`, { custody: bal });
  const h = await one(db, "INSERT INTO cash_handovers (tenant_id, company_id, rep_id, handover_date, declared_amount, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [u.tenantId, rep.company_id, rep.id, b.handoverDate, b.amount, b.notes ?? null, u.userId]);
  await log(db, u, "cash_handover.submitted", "cash_handover", h.id, b);
  return h;
}

/** cashier counts the cash: Dr cash box (counted) + Dr rep receivable (shortage) / Cr rep custody (declared) */
export async function confirmHandover(db: Db, u: UserCtx, id: string, b: { countedAmount: string; notes?: string }) {
  const h = await one(db, "SELECT h.*, r.user_id FROM cash_handovers h JOIN sales_reps r ON r.id = h.rep_id WHERE h.id = $1 FOR UPDATE OF h", [id]);
  if (!h) throw E.notFound("cash handover");
  if (h.status !== "submitted") throw E.rule("ALREADY_PROCESSED", "تمت معالجة التسليم مسبقًا", "Handover already processed");
  if (h.user_id === u.userId || h.created_by === u.userId) throw E.sod();
  if ((await one(db, "SELECT $1::numeric > $2::numeric AS over", [b.countedAmount, h.declared_amount])).over)
    throw E.rule("COUNTED_EXCEEDS_DECLARED", "المبلغ المعدود أكبر من المصرّح به — أعد العد أو اطلب من المندوب تصحيح التصريح", "Counted exceeds declared — recount or have the rep correct the declaration");
  const shortage = (await one(db, "SELECT ($1::numeric - $2::numeric)::text AS s", [h.declared_amount, b.countedAmount])).s;
  const number = await docNumber(db, u, h.company_id, "CH", h.handover_date);
  const je = await postJournal(db, u, { companyId: h.company_id, date: h.handover_date, memo: `تسليم عهدة نقدية ${number}`, sourceType: "cash_handover", sourceId: id, parts: [
    { role: "cash_main", amount: b.countedAmount }, { role: "employee_advances", amount: shortage }, { role: "rep_cash_custody", amount: "-" + h.declared_amount } ] });
  const r = await one(db, `UPDATE cash_handovers SET status = 'confirmed', number = $2, counted_amount = $3, journal_entry_id = $4, confirmed_by = $5, confirmed_at = now(),
     notes = coalesce($6, notes) WHERE id = $1 RETURNING *`, [id, number, b.countedAmount, je, u.userId, b.notes ?? null]);
  await log(db, u, "cash_handover.confirmed", "cash_handover", id, { counted: b.countedAmount, shortage });
  return { ...r, shortage };
}

// ------------------------------------------------------------------ end-of-day van settlement
export async function submitSettlement(db: Db, u: UserCtx, b: { settlementDate: string; counts: { itemId: string; countedQty: string }[]; notes?: string }) {
  const rep = await repOfUser(db, u.userId);
  const book = (await db.query("SELECT item_id, qty::text FROM stock_balances WHERE warehouse_id = $1 AND qty > 0", [rep.van_warehouse_id])).rows;
  const counted = new Map(b.counts.map((c) => [c.itemId, c.countedQty]));
  const missing = book.filter((x) => !counted.has(x.item_id));
  if (missing.length) throw E.rule("COUNT_INCOMPLETE", "يجب عدّ كل أصناف السيارة", "Every item in the van must be counted", { missing: missing.map((m) => m.item_id) });
  const s = await one(db, "INSERT INTO van_settlements (tenant_id, company_id, rep_id, settlement_date, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [u.tenantId, rep.company_id, rep.id, b.settlementDate, b.notes ?? null, u.userId]);
  for (const c of b.counts) {
    const bq = book.find((x) => x.item_id === c.itemId)?.qty ?? "0";
    await db.query("INSERT INTO van_settlement_lines (tenant_id, settlement_id, item_id, book_qty, counted_qty) VALUES ($1,$2,$3,$4,$5)", [u.tenantId, s.id, c.itemId, bq, c.countedQty]);
  }
  await log(db, u, "van_settlement.submitted", "van_settlement", s.id, b);
  return getSettlement(db, s.id);
}

export async function getSettlement(db: Db, id: string) {
  const s = await one(db, "SELECT s.*, r.code AS rep_code FROM van_settlements s JOIN sales_reps r ON r.id = s.rep_id WHERE s.id = $1", [id]);
  if (!s) throw E.notFound("van settlement");
  const lines = (await db.query(`SELECT l.*, (l.counted_qty - l.book_qty) AS diff, i.code AS item_code, i.name_ar AS item_name_ar FROM van_settlement_lines l
     JOIN items i ON i.id = l.item_id WHERE l.settlement_id = $1 ORDER BY i.code`, [id])).rows;
  return { ...s, lines, custody: await custodyBalance(db, s.rep_id) };
}

/**
 * Supervisor approval. Differences are measured against the CURRENT book
 * quantity (movements after submission are respected):
 *   shortage → stock out at average cost, charged to the rep (Dr employee_advances / Cr van inventory)
 *   overage  → stock in at average cost (Dr van inventory / Cr inventory_adjustment)
 */
export async function approveSettlement(db: Db, u: UserCtx, id: string) {
  const s = await one(db, "SELECT s.*, r.user_id, r.van_warehouse_id FROM van_settlements s JOIN sales_reps r ON r.id = s.rep_id WHERE s.id = $1 FOR UPDATE OF s", [id]);
  if (!s) throw E.notFound("van settlement");
  if (s.status !== "submitted") throw E.rule("ALREADY_PROCESSED", "تمت معالجة التسوية مسبقًا", "Settlement already processed");
  if (s.user_id === u.userId) throw E.sod();
  const lines = (await db.query("SELECT l.*, i.code, i.track_lots FROM van_settlement_lines l JOIN items i ON i.id = l.item_id WHERE l.settlement_id = $1", [id])).rows;
  const m = await minorUnits(db, s.company_id);
  let shortage = "0", overage = "0";
  const src = { companyId: s.company_id, date: s.settlement_date, sourceType: "van_settlement", sourceId: id };
  for (const l of lines) {
    const cur = (await one(db, "SELECT coalesce((SELECT qty FROM stock_balances WHERE warehouse_id = $1 AND item_id = $2), 0)::text AS q", [s.van_warehouse_id, l.item_id])).q;
    const diff = (await one(db, "SELECT ($1::numeric - $2::numeric)::text AS d", [l.counted_qty, cur])).d;
    await db.query("UPDATE van_settlement_lines SET book_qty = $3 WHERE settlement_id = $1 AND item_id = $2", [id, l.item_id, cur]);
    if (Number(diff) < 0) {
      const out = await stockOut(db, u, { ...src, warehouseId: s.van_warehouse_id, itemId: l.item_id, qty: diff.slice(1), trackLots: l.track_lots, itemCode: l.code });
      shortage = (await one(db, "SELECT ($1::numeric + $2::numeric)::text AS t", [shortage, out.value])).t;
    } else if (Number(diff) > 0) {
      const avg = await one(db, `SELECT CASE WHEN sum(qty) > 0 THEN sum(value) / sum(qty) ELSE 0 END AS c FROM stock_balances WHERE item_id = $1`, [l.item_id]);
      let lotId: string | null = null;
      if (l.track_lots) {
        const lot = await one(db, `SELECT lot_id FROM stock_moves WHERE warehouse_id = $1 AND item_id = $2 AND lot_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [s.van_warehouse_id, l.item_id]);
        if (!lot) throw E.rule("LOT_UNKNOWN", `لا يمكن تحديد تشغيلة الزيادة للصنف ${l.code}`, `Cannot determine the lot for the overage of ${l.code}`);
        lotId = lot.lot_id;
      }
      const value = (await one(db, "SELECT round($1::numeric * $2::numeric, $3)::text AS v", [diff, avg.c, m])).v;
      const v = await stockIn(db, u, { ...src, warehouseId: s.van_warehouse_id, itemId: l.item_id, lotId, qty: diff, value });
      overage = (await one(db, "SELECT ($1::numeric + $2::numeric)::text AS t", [overage, v])).t;
    }
  }
  const number = await docNumber(db, u, s.company_id, "VS", s.settlement_date);
  const je = await postJournal(db, u, { ...src, memo: `تسوية يوم المندوب ${number}`, parts: [
    { role: "employee_advances", amount: shortage }, { role: "inventory_van", amount: "-" + shortage },
    { role: "inventory_van", amount: overage }, { role: "inventory_adjustment", amount: "-" + overage } ] });
  await db.query("UPDATE van_settlements SET status = 'approved', number = $2, shortage_value = $3, overage_value = $4, journal_entry_id = $5, approved_by = $6, approved_at = now() WHERE id = $1",
    [id, number, shortage, overage, je, u.userId]);
  await log(db, u, "van_settlement.approved", "van_settlement", id, { number, shortage, overage });
  return getSettlement(db, id);
}

// ------------------------------------------------------------------ commissions (on collected money)
export async function collectedBy(db: Db, repId: string, from: string, to: string) {
  return (await one(db, `SELECT (
     (SELECT coalesce(sum(total),0) FROM sales_invoices WHERE rep_id = $1 AND status = 'posted' AND payment_type = 'cash' AND invoice_date BETWEEN $2 AND $3)
   + (SELECT coalesce(sum(amount),0) FROM payments WHERE rep_id = $1 AND status = 'posted' AND direction = 'in' AND payment_date BETWEEN $2 AND $3))::numeric(20,4)::text AS c`, [repId, from, to])).c as string;
}

export async function commissionFor(db: Db, rep: any, collected: string, m: number) {
  if (rep.commission_type === "flat") return (await one(db, "SELECT round($1::numeric * $2::numeric / 100, $3)::text AS c", [collected, rep.commission_rate, m])).c as string;
  if (rep.commission_type !== "tiered") return "0";
  const tiers = (await db.query("SELECT up_to, rate FROM commission_tiers WHERE rep_id = $1 ORDER BY tier_no", [rep.id])).rows;
  let total = "0", lower = "0";
  for (const t of tiers) {
    const slice = (await one(db, "SELECT greatest(least($1::numeric, coalesce($2::numeric, $1::numeric)) - $3::numeric, 0)::text AS s", [collected, t.up_to, lower])).s;
    total = (await one(db, "SELECT ($1::numeric + $2::numeric * $3::numeric / 100)::text AS t", [total, slice, t.rate])).t;
    if (t.up_to === null) break;
    lower = t.up_to;
  }
  return (await one(db, "SELECT round($1::numeric, $2)::text AS c", [total, m])).c as string;
}

export async function createCommissionRun(db: Db, u: UserCtx, b: { companyId: string; period: string }) {
  const from = `${b.period}-01`;
  const to = (await one(db, "SELECT (($1::date + interval '1 month') - interval '1 day')::date::text AS t", [from])).t;
  const m = await minorUnits(db, b.companyId);
  const run = await one(db, "INSERT INTO commission_runs (tenant_id, company_id, period, created_by) VALUES ($1,$2,$3,$4) RETURNING *", [u.tenantId, b.companyId, b.period, u.userId]);
  let total = "0";
  for (const rep of (await db.query("SELECT * FROM sales_reps WHERE company_id = $1 AND commission_type <> 'none'", [b.companyId])).rows) {
    const collected = await collectedBy(db, rep.id, from, to);
    const c = await commissionFor(db, rep, collected, m);
    await db.query("INSERT INTO commission_lines (tenant_id, run_id, rep_id, collected, commission) VALUES ($1,$2,$3,$4,$5)", [u.tenantId, run.id, rep.id, collected, c]);
    total = (await one(db, "SELECT ($1::numeric + $2::numeric)::text AS t", [total, c])).t;
  }
  await db.query("UPDATE commission_runs SET total = $2 WHERE id = $1", [run.id, total]);
  await log(db, u, "commission_run.created", "commission_run", run.id, { period: b.period, total });
  return getCommissionRun(db, run.id);
}

export async function getCommissionRun(db: Db, id: string) {
  const r = await one(db, "SELECT * FROM commission_runs WHERE id = $1", [id]);
  if (!r) throw E.notFound("commission run");
  const lines = (await db.query("SELECT l.*, s.code AS rep_code, u.full_name FROM commission_lines l JOIN sales_reps s ON s.id = l.rep_id JOIN users u ON u.id = s.user_id WHERE l.run_id = $1 ORDER BY s.code", [id])).rows;
  return { ...r, lines };
}

export async function postCommissionRun(db: Db, u: UserCtx, id: string) {
  const r = await one(db, "SELECT * FROM commission_runs WHERE id = $1 FOR UPDATE", [id]);
  if (!r) throw E.notFound("commission run");
  if (r.status !== "draft") throw E.rule("ALREADY_POSTED", "تم ترحيل العمولات مسبقًا", "Commission run already posted");
  if (u.enforceSod && r.created_by === u.userId) throw E.sod();
  const date = (await one(db, "SELECT (($1 || '-01')::date + interval '1 month' - interval '1 day')::date::text AS d", [r.period])).d;
  const je = Number(r.total) > 0 ? await postJournal(db, u, { companyId: r.company_id, date, memo: `عمولات المناديب ${r.period}`, sourceType: "commission_run", sourceId: id,
    parts: [{ role: "commission_expense", amount: r.total }, { role: "commissions_payable", amount: "-" + r.total }] }) : null;
  await db.query("UPDATE commission_runs SET status = 'posted', journal_entry_id = $2, posted_by = $3, posted_at = now() WHERE id = $1", [id, je, u.userId]);
  await log(db, u, "commission_run.posted", "commission_run", id, { total: r.total, journal: je });
  return getCommissionRun(db, id);
}

// ------------------------------------------------------------------ performance
export async function repPerformance(db: Db, companyId: string, period: string) {
  const from = `${period}-01`;
  const to = (await one(db, "SELECT (($1::date + interval '1 month') - interval '1 day')::date::text AS t", [from])).t;
  const reps = (await db.query(`SELECT r.*, u.full_name, w.code AS van_code, t.sales_target, t.collection_target, t.visits_target
     FROM sales_reps r JOIN users u ON u.id = r.user_id JOIN warehouses w ON w.id = r.van_warehouse_id LEFT JOIN rep_targets t ON t.rep_id = r.id AND t.period = $2
     WHERE r.company_id = $1 ORDER BY r.code`, [companyId, period])).rows;
  const out = [];
  for (const r of reps) {
    const s = await one(db, `SELECT
        (SELECT coalesce(sum(total),0) FROM sales_invoices WHERE rep_id = $1 AND status = 'posted' AND invoice_date BETWEEN $2 AND $3) AS sales,
        (SELECT count(*) FROM sales_invoices WHERE rep_id = $1 AND status = 'posted' AND invoice_date BETWEEN $2 AND $3) AS invoices,
        (SELECT count(*) FROM visits WHERE rep_id = $1 AND visited_at::date BETWEEN $2 AND $3) AS visits,
        (SELECT count(DISTINCT customer_id) FROM visits WHERE rep_id = $1 AND visited_at::date BETWEEN $2 AND $3) AS customers_visited,
        (SELECT coalesce(sum(value),0) FROM stock_balances WHERE warehouse_id = $4) AS van_stock_value`, [r.id, from, to, r.van_warehouse_id]);
    const collected = await collectedBy(db, r.id, from, to);
    const pct = (a: unknown, t: unknown) => (Number(t) > 0 ? Math.round((Number(a) * 10000) / Number(t)) / 100 : null);
    out.push({ id: r.id, code: r.code, name: r.full_name, van: r.van_code, ...s, collected, custody: await custodyBalance(db, r.id),
      targets: { sales: r.sales_target, collection: r.collection_target, visits: r.visits_target },
      achievement: { sales: pct(s.sales, r.sales_target), collection: pct(collected, r.collection_target), visits: pct(s.visits, r.visits_target) } });
  }
  return { period, from, to, reps: out };
}
