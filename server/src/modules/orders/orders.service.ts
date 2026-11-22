// Quotations, sales orders and purchase orders (order-to-cash / procure-to-pay).
// Orders never post to the GL: invoices and goods receipts do, as before, and
// each of their lines points back to the order line it fulfils.
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { docNumber, itemUom, minorUnits, warehouseOf } from "../erp/common.js";
import { createInvoice, getInvoice } from "../erp/sales.service.js";
import { createReceipt, getReceipt } from "../erp/inventory.service.js";

type Line = { itemId: string; uomId?: string | null; qty: string; unitPrice?: string; discountPct?: string };
const ev = (db: Db, u: UserCtx, action: string, type: string, id: string, after?: unknown) => audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action, entityType: type, entityId: id, after });
const one = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];

async function customerOf(db: Db, id: string, companyId: string) {
  const c = await one(db, "SELECT * FROM parties WHERE id = $1 AND company_id = $2 AND kind IN ('customer','both')", [id, companyId]);
  if (!c) throw E.validation([{ path: "customerId", message: "customer not found in this company" }]);
  if (!c.is_active) throw E.rule("CUSTOMER_INACTIVE", "العميل موقوف", "Customer is inactive");
  return c;
}

/** list price or the customer's special price, per chosen unit (same rule as invoices) */
async function priced(db: Db, customerId: string, l: Line) {
  const { item, uomId, factor } = await itemUom(db, l.itemId, l.uomId);
  let price = l.unitPrice;
  if (price === undefined) {
    const special = await one(db, "SELECT price FROM customer_prices WHERE party_id = $1 AND item_id = $2", [customerId, l.itemId]);
    const base = special?.price ?? item.sales_price;
    if (base === null || base === undefined) throw E.rule("NO_PRICE", `لا يوجد سعر للصنف ${item.code}`, `No price for item ${item.code}`);
    price = (await one(db, "SELECT round($1::numeric * $2::numeric, 4)::text AS p", [base, factor])).p as string;
  }
  return { item, uomId, factor, price: price!, discountPct: l.discountPct ?? "0" };
}

async function writeSalesLines(db: Db, u: UserCtx, table: "sales_quotation_lines" | "sales_order_lines", docId: string, customerId: string, companyId: string, lines: Line[]) {
  const m = await minorUnits(db, companyId);
  let i = 0;
  for (const l of lines) {
    const p = await priced(db, customerId, l);
    await db.query(
      `INSERT INTO ${table} (tenant_id, doc_id, line_no, item_id, uom_id, factor, qty, base_qty, unit_price, discount_pct, line_total)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric, round($7::numeric * $6::numeric, 4), $8::numeric, $9::numeric, round(round($7::numeric * $8::numeric, $10) * (1 - $9::numeric / 100), $10))`,
      [u.tenantId, docId, ++i, l.itemId, p.uomId, p.factor, l.qty, p.price, p.discountPct, m]);
  }
  const parent = table === "sales_quotation_lines" ? "sales_quotations" : "sales_orders";
  await db.query(`UPDATE ${parent} d SET subtotal = x.g, discount_total = x.g - x.t, total = x.t FROM (
      SELECT sum(round(qty * unit_price, $2)) AS g, sum(line_total) AS t FROM ${table} WHERE doc_id = $1) x WHERE d.id = $1`, [docId, m]);
}

// ------------------------------------------------------------------ quotations
export async function createQuotation(db: Db, u: UserCtx, b: { companyId: string; branchId?: string | null; customerId: string; quoteDate: string; validUntil?: string; notes?: string; lines: Line[] }) {
  await customerOf(db, b.customerId, b.companyId);
  const days = (await one(db, "SELECT quotation_valid_days AS d FROM order_settings WHERE company_id = $1", [b.companyId]))?.d ?? 15;
  const valid = b.validUntil ?? (await one(db, "SELECT ($1::date + $2::int)::text AS v", [b.quoteDate, days])).v;
  const number = await docNumber(db, u, b.companyId, "QT", b.quoteDate);
  const q = await one(db, `INSERT INTO sales_quotations (tenant_id, company_id, branch_id, customer_id, number, quote_date, valid_until, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [u.tenantId, b.companyId, b.branchId ?? null, b.customerId, number, b.quoteDate, valid, b.notes ?? null, u.userId]);
  await writeSalesLines(db, u, "sales_quotation_lines", q.id, b.customerId, b.companyId, b.lines);
  await ev(db, u, "quotation.created", "sales_quotation", q.id, { number });
  return getQuotation(db, q.id);
}
export async function getQuotation(db: Db, id: string) {
  const q = await one(db, `SELECT q.*, p.code AS customer_code, p.name_ar AS customer_name_ar, (q.status IN ('draft','sent') AND q.valid_until < current_date) AS expired
      FROM sales_quotations q JOIN parties p ON p.id = q.customer_id WHERE q.id = $1`, [id]);
  if (!q) throw E.notFound("sales_quotations");
  const lines = (await db.query(`SELECT l.*, i.code AS item_code, i.name_ar AS item_name_ar, u.code AS uom_code FROM sales_quotation_lines l JOIN items i ON i.id = l.item_id JOIN uoms u ON u.id = l.uom_id
      WHERE l.doc_id = $1 ORDER BY l.line_no`, [id])).rows;
  return { ...q, lines };
}
export async function setQuotationStatus(db: Db, u: UserCtx, id: string, status: "sent" | "rejected", reason?: string) {
  const r = await db.query(`UPDATE sales_quotations SET status = $2, reject_reason = $3 WHERE id = $1 AND status IN ('draft', 'sent') RETURNING id`, [id, status, reason ?? null]);
  if (!r.rowCount) throw E.rule("QUOTATION_CLOSED", "عرض السعر مغلق", "Quotation is closed");
  await ev(db, u, `quotation.${status}`, "sales_quotation", id, { reason });
  return getQuotation(db, id);
}
/** accepted quotation → draft sales order with the same lines and prices */
export async function quotationToOrder(db: Db, u: UserCtx, id: string, b: { warehouseId: string; orderDate: string; deliveryDate?: string; paymentType?: "cash" | "credit" }) {
  const q = await one(db, "SELECT * FROM sales_quotations WHERE id = $1 FOR UPDATE", [id]);
  if (!q) throw E.notFound("sales_quotations");
  if (!["draft", "sent", "accepted"].includes(q.status)) throw E.rule("QUOTATION_CLOSED", "عرض السعر مغلق أو محوّل مسبقًا", "Quotation is closed or already converted");
  if (q.valid_until < b.orderDate) throw E.rule("QUOTATION_EXPIRED", `انتهت صلاحية العرض في ${String(q.valid_until).slice(0, 10)}`, "Quotation has expired");
  const lines = (await db.query("SELECT item_id, uom_id, qty, unit_price, discount_pct FROM sales_quotation_lines WHERE doc_id = $1 ORDER BY line_no", [id])).rows;
  const o = await createOrder(db, u, { companyId: q.company_id, branchId: q.branch_id, warehouseId: b.warehouseId, customerId: q.customer_id, orderDate: b.orderDate, deliveryDate: b.deliveryDate,
    paymentType: b.paymentType ?? "credit", quotationId: id, notes: q.notes,
    lines: lines.map((l: any) => ({ itemId: l.item_id, uomId: l.uom_id, qty: l.qty, unitPrice: l.unit_price, discountPct: l.discount_pct })) });
  await db.query("UPDATE sales_quotations SET status = 'converted' WHERE id = $1", [id]);
  return o;
}

// ------------------------------------------------------------------ sales orders
export async function createOrder(db: Db, u: UserCtx, b: { companyId: string; branchId?: string | null; warehouseId: string; customerId: string; orderDate: string; deliveryDate?: string;
  paymentType: "cash" | "credit"; quotationId?: string | null; notes?: string; lines: Line[] }) {
  await customerOf(db, b.customerId, b.companyId);
  const wh = await warehouseOf(db, b.warehouseId, b.companyId);
  if (!wh.is_sellable) throw E.rule("WAREHOUSE_NOT_SELLABLE", "لا يمكن البيع من هذا المخزن", "Cannot sell from a non-sellable warehouse");
  const number = await docNumber(db, u, b.companyId, "SO", b.orderDate);
  const o = await one(db, `INSERT INTO sales_orders (tenant_id, company_id, branch_id, warehouse_id, customer_id, quotation_id, number, order_date, delivery_date, payment_type, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [u.tenantId, b.companyId, b.branchId ?? null, b.warehouseId, b.customerId, b.quotationId ?? null, number, b.orderDate, b.deliveryDate ?? null, b.paymentType, b.notes ?? null, u.userId]);
  await writeSalesLines(db, u, "sales_order_lines", o.id, b.customerId, b.companyId, b.lines);
  await ev(db, u, "sales_order.created", "sales_order", o.id, { number });
  return getOrder(db, o.id);
}
export async function getOrder(db: Db, id: string) {
  const o = await one(db, `SELECT o.*, p.code AS customer_code, p.name_ar AS customer_name_ar, w.code AS warehouse_code, q.number AS quotation_number
      FROM sales_orders o JOIN parties p ON p.id = o.customer_id JOIN warehouses w ON w.id = o.warehouse_id LEFT JOIN sales_quotations q ON q.id = o.quotation_id WHERE o.id = $1`, [id]);
  if (!o) throw E.notFound("sales_orders");
  const lines = (await db.query(`SELECT l.*, (l.base_qty - l.delivered_base_qty)::numeric(20,4)::text AS remaining_base_qty, i.code AS item_code, i.name_ar AS item_name_ar, u.code AS uom_code
      FROM sales_order_lines l JOIN items i ON i.id = l.item_id JOIN uoms u ON u.id = l.uom_id WHERE l.doc_id = $1 ORDER BY l.line_no`, [id])).rows;
  const invoices = (await db.query("SELECT id, number, status, invoice_date, total FROM sales_invoices WHERE sales_order_id = $1 ORDER BY created_at", [id])).rows;
  return { ...o, lines, invoices };
}

/** quantity an item can still be promised from a warehouse: sellable stock (not expired, not on hold) minus what confirmed orders have reserved */
export async function availableToPromise(db: Db, warehouseId: string, itemId: string, excludeOrderId?: string) {
  return (await one(db,
    `SELECT ((SELECT CASE WHEN i.track_lots THEN (SELECT coalesce(sum(lb.qty), 0) FROM lot_balances lb JOIN lots l ON l.id = lb.lot_id
                                                   WHERE lb.warehouse_id = $1 AND l.item_id = i.id AND NOT l.on_hold AND (l.expiry_date IS NULL OR l.expiry_date >= current_date))
                          ELSE (SELECT coalesce(sum(qty), 0) FROM stock_balances WHERE warehouse_id = $1 AND item_id = i.id) END FROM items i WHERE i.id = $2)
           - (SELECT coalesce(sum(l.base_qty - l.delivered_base_qty), 0) FROM sales_order_lines l JOIN sales_orders o ON o.id = l.doc_id
               WHERE o.warehouse_id = $1 AND l.item_id = $2 AND o.status IN ('confirmed', 'partially_delivered') AND o.id IS DISTINCT FROM $3::uuid))::numeric(20,4)::text AS atp`,
    [warehouseId, itemId, excludeOrderId ?? null])).atp as string;
}

/**
 * Confirming reserves the stock and commits to the customer:
 *  - the credit limit must hold for open receivables + other open orders + this order (on-account orders)
 *  - every line must fit in the available-to-promise quantity (unless allowBackorder)
 */
export async function confirmOrder(db: Db, u: UserCtx, id: string, b: { allowBackorder?: boolean } = {}) {
  const o = await one(db, "SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!o) throw E.notFound("sales_orders");
  if (o.status !== "draft") throw E.rule("ORDER_NOT_DRAFT", "الأمر ليس مسودة", "Order is not a draft");
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`atp:${o.warehouse_id}`]);   // two confirmations cannot promise the same stock
  const lines = (await db.query("SELECT l.*, i.code FROM sales_order_lines l JOIN items i ON i.id = l.item_id WHERE l.doc_id = $1 ORDER BY line_no", [id])).rows;
  if (!lines.length) throw E.rule("EMPTY_DOCUMENT", "الأمر بلا أسطر", "Order has no lines");
  const c = await customerOf(db, o.customer_id, o.company_id);
  if (o.payment_type === "credit" && c.credit_limit !== null) {
    const exposure = (await one(db,
      `SELECT ((SELECT coalesce(sum(total - amount_paid - amount_returned), 0) FROM sales_invoices WHERE customer_id = $1 AND status = 'posted')
             + (SELECT coalesce(sum(l.line_total * (l.base_qty - l.delivered_base_qty) / l.base_qty), 0) FROM sales_order_lines l JOIN sales_orders x ON x.id = l.doc_id
                 WHERE x.customer_id = $1 AND x.status IN ('confirmed', 'partially_delivered') AND x.payment_type = 'credit'))::numeric(20,4)::text AS e`, [c.id])).e;
    if (Number(exposure) + Number(o.total) > Number(c.credit_limit))
      throw E.rule("CREDIT_LIMIT_EXCEEDED", `تجاوز حد الائتمان (الرصيد والأوامر المفتوحة ${exposure} + الأمر ${o.total} > الحد ${c.credit_limit})`,
        `Credit limit exceeded (open ${exposure} + order ${o.total} > limit ${c.credit_limit})`, { open: exposure, order: o.total, limit: c.credit_limit });
  }
  if (!b.allowBackorder) {
    const short = [];
    const need = new Map<string, { code: string; qty: number }>();
    for (const l of lines) need.set(l.item_id, { code: l.code, qty: (need.get(l.item_id)?.qty ?? 0) + Number(l.base_qty) });
    for (const [itemId, n] of need) {
      const atp = Number(await availableToPromise(db, o.warehouse_id, itemId, id));
      if (atp < n.qty) short.push({ item: n.code, requested: n.qty, available: atp });
    }
    if (short.length) throw E.rule("INSUFFICIENT_AVAILABLE", `الكمية المتاحة غير كافية: ${short.map((s) => `${s.item} (المتاح ${s.available})`).join("، ")}`,
      `Not enough available stock: ${short.map((s) => `${s.item} (available ${s.available})`).join(", ")}`, short);
  }
  await db.query("UPDATE sales_orders SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1", [id, u.userId]);
  await ev(db, u, "sales_order.confirmed", "sales_order", id, { backorder: !!b.allowBackorder });
  return getOrder(db, id);
}

/** draft invoice for the remaining (or given) quantities; posting it delivers the order lines */
export async function invoiceFromOrder(db: Db, u: UserCtx, id: string, b: { invoiceDate: string; lines?: { orderLineId: string; qty: string }[] }) {
  const o = await one(db, "SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!o) throw E.notFound("sales_orders");
  if (!["confirmed", "partially_delivered"].includes(o.status)) throw E.rule("ORDER_NOT_OPEN", "الأمر غير مؤكد أو مغلق", "Order is not confirmed or is closed");
  const pending = await one(db, "SELECT number FROM sales_invoices WHERE sales_order_id = $1 AND status = 'draft' LIMIT 1", [id]);
  if (pending) throw E.rule("DRAFT_INVOICE_EXISTS", `توجد فاتورة مسودة للأمر (${pending.number ?? "مسودة"}) — رحّلها أو احذفها أولًا`, "A draft invoice already exists for this order");
  const lines = (await db.query("SELECT * FROM sales_order_lines WHERE doc_id = $1 ORDER BY line_no", [id])).rows;
  const pick = b.lines ? new Map(b.lines.map((x) => [x.orderLineId, x.qty])) : null;
  const inv = [];
  for (const l of lines) {
    const remainingUnits = (Number(l.base_qty) - Number(l.delivered_base_qty)) / Number(l.factor);
    const qty = pick ? Number(pick.get(l.id) ?? 0) : remainingUnits;
    if (qty <= 0) continue;
    if (qty > remainingUnits + 1e-9) throw E.rule("EXCEEDS_ORDER", `الكمية تتجاوز المتبقي في السطر ${l.line_no} (${remainingUnits})`, `Quantity exceeds the remaining quantity on line ${l.line_no}`);
    inv.push({ itemId: l.item_id, uomId: l.uom_id, qty: String(Math.round(qty * 10000) / 10000), unitPrice: l.unit_price, discountPct: l.discount_pct, orderLineId: l.id });
  }
  if (!inv.length) throw E.rule("NOTHING_TO_INVOICE", "لا توجد كميات متبقية للفوترة", "Nothing left to invoice");
  const d = await createInvoice(db, u, { companyId: o.company_id, branchId: o.branch_id, warehouseId: o.warehouse_id, customerId: o.customer_id, invoiceDate: b.invoiceDate,
    paymentType: o.payment_type, notes: `من أمر البيع ${o.number}`, salesOrderId: id, lines: inv });
  return getInvoice(db, d.id);
}
export async function closeOrder(db: Db, u: UserCtx, id: string, reason: string) {
  const o = await one(db, "SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!o) throw E.notFound("sales_orders");
  if (["delivered", "closed", "cancelled"].includes(o.status)) throw E.rule("ORDER_CLOSED", "الأمر مغلق", "Order is closed");
  // nothing delivered → cancelled; partly delivered → closed (the rest is no longer reserved)
  const status = o.status === "partially_delivered" ? "closed" : "cancelled";
  await db.query("UPDATE sales_orders SET status = $2, close_reason = $3 WHERE id = $1", [id, status, reason]);
  await ev(db, u, `sales_order.${status}`, "sales_order", id, { reason });
  return getOrder(db, id);
}

// ------------------------------------------------------------------ purchase orders
export async function createPurchaseOrder(db: Db, u: UserCtx, b: { companyId: string; supplierId: string; warehouseId: string; orderDate: string; expectedDate?: string; notes?: string;
  lines: { itemId: string; uomId?: string | null; qty: string; unitCost: string }[] }) {
  const s = await one(db, "SELECT * FROM parties WHERE id = $1 AND company_id = $2 AND kind IN ('supplier','both') AND is_active", [b.supplierId, b.companyId]);
  if (!s) throw E.validation([{ path: "supplierId", message: "active supplier not found in this company" }]);
  await warehouseOf(db, b.warehouseId, b.companyId);
  const m = await minorUnits(db, b.companyId);
  const number = await docNumber(db, u, b.companyId, "PO", b.orderDate);
  const po = await one(db, `INSERT INTO purchase_orders (tenant_id, company_id, supplier_id, warehouse_id, number, order_date, expected_date, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [u.tenantId, b.companyId, b.supplierId, b.warehouseId, number, b.orderDate, b.expectedDate ?? null, b.notes ?? null, u.userId]);
  let i = 0;
  for (const l of b.lines) {
    const { item, uomId, factor } = await itemUom(db, l.itemId, l.uomId);
    if (item.kind === "service") throw E.validation([{ path: "lines", message: `${item.code} is a service item` }]);
    await db.query(`INSERT INTO purchase_order_lines (tenant_id, doc_id, line_no, item_id, uom_id, factor, qty, base_qty, unit_cost, line_total)
        VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric, round($7::numeric * $6::numeric, 4), $8::numeric, round($7::numeric * $8::numeric, $9))`,
      [u.tenantId, po.id, ++i, l.itemId, uomId, factor, l.qty, l.unitCost, m]);
  }
  await db.query("UPDATE purchase_orders SET total = (SELECT sum(line_total) FROM purchase_order_lines WHERE doc_id = $1) WHERE id = $1", [po.id]);
  await ev(db, u, "purchase_order.created", "purchase_order", po.id, { number });
  return getPurchaseOrder(db, po.id);
}
export async function getPurchaseOrder(db: Db, id: string) {
  const o = await one(db, `SELECT o.*, p.code AS supplier_code, p.name_ar AS supplier_name_ar, w.code AS warehouse_code, cu.full_name AS created_by_name, au.full_name AS approved_by_name
      FROM purchase_orders o JOIN parties p ON p.id = o.supplier_id JOIN warehouses w ON w.id = o.warehouse_id JOIN users cu ON cu.id = o.created_by LEFT JOIN users au ON au.id = o.approved_by WHERE o.id = $1`, [id]);
  if (!o) throw E.notFound("purchase_orders");
  const lines = (await db.query(`SELECT l.*, (l.base_qty - l.received_base_qty)::numeric(20,4)::text AS remaining_base_qty, i.code AS item_code, i.name_ar AS item_name_ar, i.track_lots, u.code AS uom_code
      FROM purchase_order_lines l JOIN items i ON i.id = l.item_id JOIN uoms u ON u.id = l.uom_id WHERE l.doc_id = $1 ORDER BY l.line_no`, [id])).rows;
  const receipts = (await db.query("SELECT id, number, status, receipt_date, total FROM purchase_receipts WHERE purchase_order_id = $1 ORDER BY created_at", [id])).rows;
  return { ...o, lines, receipts };
}
/** submit: at or below the company threshold it is approved at once; above it waits for an approver */
export async function submitPurchaseOrder(db: Db, u: UserCtx, id: string) {
  const o = await one(db, "SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!o) throw E.notFound("purchase_orders");
  if (o.status !== "draft") throw E.rule("ORDER_NOT_DRAFT", "الأمر ليس مسودة", "Order is not a draft");
  if (Number(o.total) <= 0) throw E.rule("EMPTY_DOCUMENT", "الأمر بلا أسطر", "Order has no lines");
  const th = (await one(db, "SELECT po_approval_threshold AS t FROM order_settings WHERE company_id = $1", [o.company_id]))?.t ?? "0";
  const auto = Number(o.total) <= Number(th);
  await db.query(`UPDATE purchase_orders SET status = $2, approved_by = CASE WHEN $3 THEN $4::uuid END, approved_at = CASE WHEN $3 THEN now() END WHERE id = $1`,
    [id, auto ? "approved" : "pending_approval", auto, u.userId]);
  await ev(db, u, auto ? "purchase_order.auto_approved" : "purchase_order.submitted", "purchase_order", id, { total: o.total, threshold: th });
  return getPurchaseOrder(db, id);
}
export async function decidePurchaseOrder(db: Db, u: UserCtx, id: string, b: { decision: "approved" | "rejected"; reason?: string }) {
  const o = await one(db, "SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!o) throw E.notFound("purchase_orders");
  if (o.status !== "pending_approval") throw E.rule("NOT_PENDING", "الأمر ليس بانتظار الاعتماد", "Order is not pending approval");
  if (o.created_by === u.userId) throw E.sod();
  if (b.decision === "rejected" && !b.reason) throw E.validation([{ path: "reason", message: "a reason is required to reject" }]);
  await db.query("UPDATE purchase_orders SET status = $2, approved_by = $3, approved_at = now(), decision_reason = $4 WHERE id = $1", [id, b.decision, u.userId, b.reason ?? null]);
  await ev(db, u, `purchase_order.${b.decision}`, "purchase_order", id, { reason: b.reason });
  return getPurchaseOrder(db, id);
}
/** draft goods receipt for the remaining (or given) quantities at the ordered cost; posting it receives the order lines */
export async function receiveFromPurchaseOrder(db: Db, u: UserCtx, id: string, b: { receiptDate: string; supplierRef?: string;
  lines: { orderLineId: string; qty: string; lotNo?: string; productionDate?: string; expiryDate?: string }[] }) {
  const o = await one(db, "SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!o) throw E.notFound("purchase_orders");
  if (!["approved", "partially_received"].includes(o.status)) throw E.rule("ORDER_NOT_APPROVED", "أمر الشراء غير معتمد أو مغلق", "Purchase order is not approved or is closed");
  const pending = await one(db, "SELECT 1 FROM purchase_receipts WHERE purchase_order_id = $1 AND status = 'draft' LIMIT 1", [id]);
  if (pending) throw E.rule("DRAFT_RECEIPT_EXISTS", "يوجد إذن استلام مسودة لهذا الأمر — رحّله أو احذفه أولًا", "A draft receipt already exists for this order");
  const ol = new Map((await db.query("SELECT * FROM purchase_order_lines WHERE doc_id = $1", [id])).rows.map((l: any) => [l.id, l]));
  const lines = [];
  for (const x of b.lines) {
    const l: any = ol.get(x.orderLineId);
    if (!l) throw E.validation([{ path: "lines.orderLineId", message: "line not on this order" }]);
    const remaining = (Number(l.base_qty) - Number(l.received_base_qty)) / Number(l.factor);
    if (Number(x.qty) > remaining + 1e-9) throw E.rule("EXCEEDS_ORDER", `الكمية تتجاوز المتبقي في السطر ${l.line_no} (${remaining})`, `Quantity exceeds the remaining quantity on line ${l.line_no}`);
    if (Number(x.qty) > 0) lines.push({ itemId: l.item_id, uomId: l.uom_id, qty: x.qty, unitCost: l.unit_cost, lotNo: x.lotNo, productionDate: x.productionDate, expiryDate: x.expiryDate, orderLineId: l.id });
  }
  if (!lines.length) throw E.rule("NOTHING_TO_RECEIVE", "لا توجد كميات للاستلام", "Nothing to receive");
  const r = await createReceipt(db, u, { companyId: o.company_id, supplierId: o.supplier_id, warehouseId: o.warehouse_id, receiptDate: b.receiptDate, supplierRef: b.supplierRef, purchaseOrderId: id, lines });
  return getReceipt(db, r.id);
}
export async function closePurchaseOrder(db: Db, u: UserCtx, id: string, reason: string) {
  const o = await one(db, "SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!o) throw E.notFound("purchase_orders");
  if (["received", "closed", "cancelled", "rejected"].includes(o.status)) throw E.rule("ORDER_CLOSED", "الأمر مغلق", "Order is closed");
  const status = o.status === "partially_received" ? "closed" : "cancelled";
  await db.query("UPDATE purchase_orders SET status = $2, decision_reason = $3 WHERE id = $1", [id, status, reason]);
  await ev(db, u, `purchase_order.${status}`, "purchase_order", id, { reason });
  return getPurchaseOrder(db, id);
}
