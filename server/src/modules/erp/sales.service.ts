// Sales cycle: invoice (draft → posted: stock out FEFO at average cost + AR/revenue/COGS journal),
// customer returns (always into a quarantine warehouse), customer receipts (FIFO allocation).
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { stockIn, stockOut } from "./stock.js";
import { docNumber, inventoryRole, itemUom, lockDraft, markPosted, minorUnits, postJournal, warehouseOf } from "./common.js";

const n = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
const METHOD_ROLE = { cash: "cash_main", bank: "bank_main", rep_custody: "rep_cash_custody" } as const;

export interface InvoiceInput {
  companyId: string; branchId?: string | null; warehouseId: string; customerId: string; invoiceDate: string; paymentType: "cash" | "credit"; notes?: string;
  lines: { itemId: string; uomId?: string | null; qty: string; unitPrice?: string; discountPct?: string; taxPct?: string; lotId?: string | null }[];
}

async function customerOf(db: Db, id: string, companyId: string) {
  const c = (await db.query("SELECT * FROM parties WHERE id = $1 AND company_id = $2 AND kind IN ('customer','both')", [id, companyId])).rows[0];
  if (!c) throw E.validation([{ path: "customerId", message: "customer not found in this company" }]);
  if (!c.is_active) throw E.rule("CUSTOMER_INACTIVE", "العميل موقوف", "Customer is inactive");
  return c;
}

export async function createInvoice(db: Db, u: UserCtx, b: InvoiceInput) {
  await customerOf(db, b.customerId, b.companyId);
  const wh = await warehouseOf(db, b.warehouseId, b.companyId);
  if (!wh.is_sellable) throw E.rule("WAREHOUSE_NOT_SELLABLE", "لا يمكن البيع من هذا المخزن (حجر/تالف/خامات)", "Cannot sell from a non-sellable warehouse");
  const m = await minorUnits(db, b.companyId);
  const cur = (await db.query("SELECT base_currency FROM companies WHERE id = $1", [b.companyId])).rows[0].base_currency;
  const inv = (await db.query(
    `INSERT INTO sales_invoices (tenant_id, company_id, branch_id, warehouse_id, customer_id, invoice_date, payment_type, currency, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [u.tenantId, b.companyId, b.branchId ?? null, b.warehouseId, b.customerId, b.invoiceDate, b.paymentType, cur, b.notes ?? null, u.userId])).rows[0];
  let i = 0;
  for (const l of b.lines) {
    const { item, uomId, factor } = await itemUom(db, l.itemId, l.uomId);
    let price = l.unitPrice;
    if (price === undefined) {
      // special customer price, else list price — both per BASE unit, converted to the selected unit
      const special = (await db.query("SELECT price FROM customer_prices WHERE party_id = $1 AND item_id = $2", [b.customerId, l.itemId])).rows[0];
      const basePrice = special?.price ?? item.sales_price;
      if (basePrice === null || basePrice === undefined) throw E.rule("NO_PRICE", `لا يوجد سعر للصنف ${item.code}`, `No price for item ${item.code}`);
      price = (await n(db, "SELECT round($1::numeric * $2::numeric, 4)::text AS p", [basePrice, factor])).p as string;
    }
    await db.query(
      `WITH c AS (SELECT round($6::numeric * $8::numeric, $12) AS gross),
            d AS (SELECT gross, round(gross * $9::numeric / 100, $12) AS disc FROM c),
            t AS (SELECT gross, disc, gross - disc AS net, round((gross - disc) * $10::numeric / 100, $12) AS tax FROM d)
       INSERT INTO sales_invoice_lines (tenant_id, doc_id, line_no, item_id, uom_id, factor, qty, base_qty, unit_price, discount_pct, tax_pct, net_amount, tax_amount, line_total, lot_id)
       SELECT $1,$2,$3,$4,$5,$7::numeric,$6::numeric, round($6::numeric * $7::numeric, 4), $8::numeric, $9::numeric, $10::numeric, t.net, t.tax, t.net + t.tax, $11 FROM t`,
      [u.tenantId, inv.id, ++i, l.itemId, uomId, l.qty, factor, price, l.discountPct ?? "0", l.taxPct ?? "0", l.lotId ?? null, m]);
  }
  // header totals: gross (subtotal) − discount + tax = total, all from the rounded line amounts
  await db.query(
    `UPDATE sales_invoices s SET subtotal = x.gross, discount_total = x.gross - x.net, tax_total = x.tax, total = x.total FROM (
       SELECT sum(round(qty * unit_price, $2)) AS gross, sum(net_amount) AS net, sum(tax_amount) AS tax, sum(line_total) AS total
         FROM sales_invoice_lines WHERE doc_id = $1) x WHERE s.id = $1`, [inv.id, m]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "sales_invoice.draft_created", entityType: "sales_invoice", entityId: inv.id, after: b });
  return getInvoice(db, inv.id);
}

export async function postInvoice(db: Db, u: UserCtx, id: string) {
  const d = await lockDraft(db, u, "sales_invoices", id);
  const c = await customerOf(db, d.customer_id, d.company_id);
  const wh = await warehouseOf(db, d.warehouse_id, d.company_id);
  if (d.payment_type === "credit" && c.credit_limit !== null) {
    const open = (await n(db, "SELECT coalesce(sum(total - amount_paid - amount_returned),0)::text AS o FROM sales_invoices WHERE customer_id = $1 AND status = 'posted'", [c.id])).o;
    const over = (await n(db, "SELECT ($1::numeric + $2::numeric) > $3::numeric AS over", [open, d.total, c.credit_limit])).over;
    if (over) throw E.rule("CREDIT_LIMIT_EXCEEDED", `تجاوز حد الائتمان للعميل (الرصيد ${open} + الفاتورة ${d.total} > الحد ${c.credit_limit})`,
      `Credit limit exceeded (open ${open} + invoice ${d.total} > limit ${c.credit_limit})`, { open, invoice: d.total, limit: c.credit_limit });
  }
  const lines = (await db.query("SELECT l.*, i.code, i.kind, i.track_lots FROM sales_invoice_lines l JOIN items i ON i.id = l.item_id WHERE l.doc_id = $1 ORDER BY line_no", [id])).rows;
  if (!lines.length) throw E.rule("EMPTY_DOCUMENT", "المستند بلا أسطر", "Document has no lines");
  const parts: { role: string; amount: string }[] = [];
  let cogs = "0";
  for (const l of lines) {
    if (l.kind === "service") continue;
    const out = await stockOut(db, u, { companyId: d.company_id, date: d.invoice_date, sourceType: "sales_invoice", sourceId: id, sourceLineId: l.id,
      warehouseId: d.warehouse_id, itemId: l.item_id, lotId: l.lot_id, qty: l.base_qty, trackLots: l.track_lots, itemCode: l.code });
    await db.query("UPDATE sales_invoice_lines SET cost_amount = $2, lot_id = coalesce(lot_id, $3) WHERE id = $1",
      [l.id, out.value, out.allocations.length === 1 ? out.allocations[0].lotId : null]);
    parts.push({ role: "cogs", amount: out.value }, { role: inventoryRole(wh.kind, l.kind), amount: "-" + out.value });
    cogs = (await n(db, "SELECT ($1::numeric + $2::numeric)::text AS t", [cogs, out.value])).t;
  }
  parts.push(
    { role: d.payment_type === "cash" ? "cash_main" : "ar", amount: d.total },
    { role: "sales_revenue", amount: "-" + d.subtotal },
    { role: "sales_discounts", amount: d.discount_total },
    { role: "tax_payable", amount: "-" + d.tax_total },
  );
  const number = await docNumber(db, u, d.company_id, "SI", d.invoice_date);
  const je = await postJournal(db, u, { companyId: d.company_id, date: d.invoice_date, memo: `فاتورة مبيعات ${number} — ${c.name_ar}`, sourceType: "sales_invoice", sourceId: id, parts });
  const due = (await n(db, "SELECT ($1::date + $2::int)::text AS d", [d.invoice_date, d.payment_type === "credit" ? c.payment_terms_days : 0])).d;
  await markPosted(db, u, "sales_invoices", id, number, je, { cogs_total: cogs, due_date: due, amount_paid: d.payment_type === "cash" ? d.total : 0 });
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "sales_invoice.posted", entityType: "sales_invoice", entityId: id, after: { number, total: d.total, cogs, journal: je } });
  return getInvoice(db, id);
}

export async function getInvoice(db: Db, id: string) {
  const h = (await db.query(
    `SELECT s.*, p.code AS customer_code, p.name_ar AS customer_name_ar, w.code AS warehouse_code, je.number AS journal_number
       FROM sales_invoices s JOIN parties p ON p.id = s.customer_id JOIN warehouses w ON w.id = s.warehouse_id LEFT JOIN journal_entries je ON je.id = s.journal_entry_id
      WHERE s.id = $1`, [id])).rows[0];
  if (!h) throw E.notFound("sales invoice");
  const lines = (await db.query(
    `SELECT l.*, i.code AS item_code, i.name_ar AS item_name_ar, u.code AS uom_code, lt.lot_no, lt.expiry_date
       FROM sales_invoice_lines l JOIN items i ON i.id = l.item_id JOIN uoms u ON u.id = l.uom_id LEFT JOIN lots lt ON lt.id = l.lot_id WHERE l.doc_id = $1 ORDER BY line_no`, [id])).rows;
  return { ...h, lines };
}

// ------------------------------------------------------------------ returns
export async function createReturn(db: Db, u: UserCtx, b: { invoiceId: string; warehouseId: string; returnDate: string; reason: string; lines: { invoiceLineId: string; qty: string }[] }) {
  const inv = (await db.query("SELECT * FROM sales_invoices WHERE id = $1", [b.invoiceId])).rows[0];
  if (!inv || inv.status !== "posted") throw E.rule("INVOICE_NOT_POSTED", "يمكن الإرجاع من فاتورة مرحّلة فقط", "Returns require a posted invoice");
  const wh = await warehouseOf(db, b.warehouseId, inv.company_id);
  if (wh.kind !== "quarantine")
    throw E.rule("RETURN_MUST_GO_TO_QUARANTINE", "المرتجعات تدخل مخزن الحجر/الفحص فقط، ولا تعود للمخزون الصالح للبيع قبل فحص الجودة", "Customer returns must be received into a quarantine warehouse");
  const r = (await db.query("INSERT INTO sales_returns (tenant_id, company_id, invoice_id, warehouse_id, return_date, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [u.tenantId, inv.company_id, b.invoiceId, b.warehouseId, b.returnDate, b.reason, u.userId])).rows[0];
  const m = await minorUnits(db, inv.company_id);
  let i = 0;
  for (const l of b.lines) {
    const il = (await db.query("SELECT * FROM sales_invoice_lines WHERE id = $1 AND doc_id = $2", [l.invoiceLineId, b.invoiceId])).rows[0];
    if (!il) throw E.validation([{ path: "lines", message: "invoice line not found on this invoice" }]);
    await db.query(
      `INSERT INTO sales_return_lines (tenant_id, doc_id, line_no, invoice_line_id, base_qty, amount, cost_amount)
       VALUES ($1,$2,$3,$4,$5::numeric, round($6::numeric * $5::numeric / $7::numeric, $9), round(coalesce($8::numeric,0) * $5::numeric / $7::numeric, 4))`,
      [u.tenantId, r.id, ++i, il.id, l.qty, il.line_total, il.base_qty, il.cost_amount, m]);
  }
  await db.query("UPDATE sales_returns SET total = (SELECT sum(amount) FROM sales_return_lines WHERE doc_id = $1) WHERE id = $1", [r.id]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "sales_return.draft_created", entityType: "sales_return", entityId: r.id, after: b });
  return (await db.query("SELECT * FROM sales_returns WHERE id = $1", [r.id])).rows[0];
}

export async function postReturn(db: Db, u: UserCtx, id: string) {
  const d = await lockDraft(db, u, "sales_returns", id);
  const inv = (await db.query("SELECT * FROM sales_invoices WHERE id = $1 FOR UPDATE", [d.invoice_id])).rows[0];
  const lines = (await db.query(
    `SELECT rl.*, il.item_id, il.base_qty AS inv_qty, il.cost_amount AS inv_cost, i.code, i.kind FROM sales_return_lines rl
       JOIN sales_invoice_lines il ON il.id = rl.invoice_line_id JOIN items i ON i.id = il.item_id WHERE rl.doc_id = $1 ORDER BY rl.line_no`, [id])).rows;
  let cost = "0";
  for (const l of lines) {
    const already = (await n(db,
      `SELECT coalesce(sum(rl.base_qty),0)::text AS q FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.doc_id WHERE rl.invoice_line_id = $1 AND r.status = 'posted'`, [l.invoice_line_id])).q;
    if ((await n(db, "SELECT $1::numeric + $2::numeric > $3::numeric AS over", [already, l.base_qty, l.inv_qty])).over)
      throw E.rule("RETURN_EXCEEDS_SOLD", `الكمية المرتجعة للصنف ${l.code} تتجاوز المباع (${l.inv_qty}، سبق إرجاع ${already})`, `Returned quantity for ${l.code} exceeds sold quantity`);
    if (l.kind === "service") continue;
    // return into the same lots the goods left from (exact traceability)
    const outs = (await db.query("SELECT lot_id, -qty AS qty FROM stock_moves WHERE source_type = 'sales_invoice' AND source_line_id = $1 ORDER BY id", [l.invoice_line_id])).rows;
    let remaining = l.base_qty;
    let lineCost = "0";
    for (const o of outs) {
      if (Number(remaining) <= 0) break;
      const take = (await n(db, "SELECT least($1::numeric, $2::numeric)::text AS t, ($1::numeric - least($1::numeric, $2::numeric))::text AS r", [remaining, o.qty])).t;
      remaining = (await n(db, "SELECT ($1::numeric - $2::numeric)::text AS r", [remaining, take])).r;
      const value = (await n(db, "SELECT round(coalesce($1::numeric,0) * $2::numeric / $3::numeric, 4)::text AS v", [l.inv_cost, take, l.inv_qty])).v;
      const v = await stockIn(db, u, { companyId: d.company_id, date: d.return_date, sourceType: "sales_return", sourceId: id, sourceLineId: l.id,
        warehouseId: d.warehouse_id, itemId: l.item_id, lotId: o.lot_id, qty: take, value });
      lineCost = (await n(db, "SELECT ($1::numeric + $2::numeric)::text AS t", [lineCost, v])).t;
    }
    await db.query("UPDATE sales_return_lines SET cost_amount = $2 WHERE id = $1", [l.id, lineCost]);
    cost = (await n(db, "SELECT ($1::numeric + $2::numeric)::text AS t", [cost, lineCost])).t;
  }
  if (inv.payment_type === "credit") {
    const open = (await n(db, "SELECT ($1::numeric - $2::numeric - $3::numeric)::text AS o", [inv.total, inv.amount_paid, inv.amount_returned])).o;
    if ((await n(db, "SELECT $1::numeric > $2::numeric AS over", [d.total, open])).over)
      throw E.rule("RETURN_EXCEEDS_OPEN_BALANCE", "قيمة المرتجع تتجاوز الرصيد غير المسدد للفاتورة — يلزم رد نقدي (غير مدعوم بعد)", "Return value exceeds the invoice's open balance (cash refund flow not supported yet)", { open });
    await db.query("UPDATE sales_invoices SET amount_returned = amount_returned + $2 WHERE id = $1", [inv.id, d.total]);
  } else {
    await db.query("UPDATE sales_invoices SET amount_paid = amount_paid - $2, amount_returned = amount_returned + $2 WHERE id = $1", [inv.id, d.total]);
  }
  const number = await docNumber(db, u, d.company_id, "SR", d.return_date);
  const je = await postJournal(db, u, { companyId: d.company_id, date: d.return_date, memo: `مرتجع مبيعات ${number} على الفاتورة ${inv.number}`, sourceType: "sales_return", sourceId: id, parts: [
    { role: "sales_returns", amount: d.total }, { role: inv.payment_type === "cash" ? "cash_main" : "ar", amount: "-" + d.total },
    { role: "inventory_quarantine", amount: cost }, { role: "cogs", amount: "-" + cost },
  ] });
  await markPosted(db, u, "sales_returns", id, number, je, { cost_total: cost });
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "sales_return.posted", entityType: "sales_return", entityId: id, after: { number, total: d.total, cost } });
  return (await db.query("SELECT * FROM sales_returns WHERE id = $1", [id])).rows[0];
}

// ------------------------------------------------------------------ payments (receipts & supplier payments)
export async function createPayment(db: Db, u: UserCtx, b: { companyId: string; direction: "in" | "out"; partyId: string; method: "cash" | "bank" | "rep_custody"; paymentDate: string; amount: string; reference?: string; salesInvoiceId?: string | null; supplierInvoiceId?: string | null }) {
  const p = (await db.query("SELECT * FROM parties WHERE id = $1 AND company_id = $2", [b.partyId, b.companyId])).rows[0];
  if (!p) throw E.validation([{ path: "partyId", message: "party not found in this company" }]);
  if (b.direction === "out" && !b.supplierInvoiceId) throw E.validation([{ path: "supplierInvoiceId", message: "supplier payments must reference a supplier invoice" }]);
  const r = (await db.query(
    `INSERT INTO payments (tenant_id, company_id, direction, party_id, method, payment_date, amount, reference, sales_invoice_id, supplier_invoice_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [u.tenantId, b.companyId, b.direction, b.partyId, b.method, b.paymentDate, b.amount, b.reference ?? null, b.salesInvoiceId ?? null, b.supplierInvoiceId ?? null, u.userId])).rows[0];
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: `payment_${b.direction}.draft_created`, entityType: "payment", entityId: r.id, after: b });
  return r;
}

export async function postPayment(db: Db, u: UserCtx, id: string) {
  const d = await lockDraft(db, u, "payments", id);
  const parts: { role: string; amount: string }[] = [];
  const cashRole = METHOD_ROLE[d.method as keyof typeof METHOD_ROLE];
  if (d.direction === "in") {
    const open = d.sales_invoice_id
      ? (await db.query("SELECT id, (total - amount_paid - amount_returned)::text AS open FROM sales_invoices WHERE id = $1 AND customer_id = $2 AND status = 'posted' FOR UPDATE", [d.sales_invoice_id, d.party_id])).rows
      : (await db.query(`SELECT id, (total - amount_paid - amount_returned)::text AS open FROM sales_invoices WHERE customer_id = $1 AND status = 'posted' AND payment_type = 'credit'
                          AND total - amount_paid - amount_returned > 0 ORDER BY due_date, invoice_date, number FOR UPDATE`, [d.party_id])).rows;
    if (d.sales_invoice_id && !open.length) throw E.validation([{ path: "salesInvoiceId", message: "posted invoice of this customer not found" }]);
    let remaining = d.amount;
    for (const inv of open) {
      if (Number(remaining) <= 0) break;
      const take = (await n(db, "SELECT least($1::numeric, $2::numeric)::text AS t", [remaining, inv.open])).t;
      if (Number(take) <= 0) continue;
      await db.query("UPDATE sales_invoices SET amount_paid = amount_paid + $2 WHERE id = $1", [inv.id, take]);
      await db.query("INSERT INTO payment_allocations (tenant_id, payment_id, sales_invoice_id, amount) VALUES ($1,$2,$3,$4)", [u.tenantId, id, inv.id, take]);
      remaining = (await n(db, "SELECT ($1::numeric - $2::numeric)::text AS r", [remaining, take])).r;
    }
    if (d.sales_invoice_id && Number(remaining) > 0) throw E.rule("PAYMENT_EXCEEDS_INVOICE", "المبلغ أكبر من المتبقي على الفاتورة", "Amount exceeds the invoice's open balance");
    const applied = (await n(db, "SELECT ($1::numeric - $2::numeric)::text AS a", [d.amount, remaining])).a;
    parts.push({ role: cashRole, amount: d.amount }, { role: "ar", amount: "-" + applied }, { role: "customer_advances", amount: "-" + remaining });
  } else {
    const si = (await db.query("SELECT * FROM supplier_invoices WHERE id = $1 AND supplier_id = $2 AND status = 'posted' FOR UPDATE", [d.supplier_invoice_id, d.party_id])).rows[0];
    if (!si) throw E.validation([{ path: "supplierInvoiceId", message: "posted invoice of this supplier not found" }]);
    if ((await n(db, "SELECT $1::numeric > ($2::numeric - $3::numeric) AS over", [d.amount, si.total, si.amount_paid])).over)
      throw E.rule("PAYMENT_EXCEEDS_INVOICE", "المبلغ أكبر من المتبقي على فاتورة المورد", "Amount exceeds the supplier invoice's open balance");
    await db.query("UPDATE supplier_invoices SET amount_paid = amount_paid + $2 WHERE id = $1", [si.id, d.amount]);
    await db.query("INSERT INTO payment_allocations (tenant_id, payment_id, supplier_invoice_id, amount) VALUES ($1,$2,$3,$4)", [u.tenantId, id, si.id, d.amount]);
    parts.push({ role: "ap", amount: d.amount }, { role: cashRole, amount: "-" + d.amount });
  }
  const prefix = d.direction === "in" ? "RV" : "PV";
  const number = await docNumber(db, u, d.company_id, prefix, d.payment_date);
  const je = await postJournal(db, u, { companyId: d.company_id, date: d.payment_date, memo: `${d.direction === "in" ? "سند قبض" : "سند صرف"} ${number}`, sourceType: `payment_${d.direction}`, sourceId: id, parts });
  await markPosted(db, u, "payments", id, number, je);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: `payment_${d.direction}.posted`, entityType: "payment", entityId: id, after: { number, amount: d.amount } });
  return { ...(await db.query("SELECT * FROM payments WHERE id = $1", [id])).rows[0],
    allocations: (await db.query("SELECT * FROM payment_allocations WHERE payment_id = $1", [id])).rows };
}
