// Point of sale (Phase 6b). A POS sale is a sales invoice created and posted
// in one transaction (stock FEFO excluding expired/held lots, COGS, revenue,
// discounts) whose payment is settled to the register's drawer / card
// accounts; whatever is "on account" stays in receivables for the customer.
// Returns go to the register's quarantine warehouse (food safety) and are
// refunded from the drawer or the card account.
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { assertBranchAccess } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { docNumber, postAccounts, postableAccount, warehouseOf } from "../erp/common.js";
import { createInvoice, postInvoice, getInvoice, createReturn, postReturn } from "../erp/sales.service.js";

/** POS documents are posted by the system at the counter; controls are the shift reconciliation, not creator ≠ poster */
const posCtx = (u: UserCtx): UserCtx => ({ ...u, enforceSod: false });
const ev = (db: Db, u: UserCtx, action: string, entityType: string, entityId: string, after?: unknown) =>
  audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action, entityType, entityId, after });
const num = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];

// ------------------------------------------------------------------ registers
export interface RegisterInput {
  companyId: string; branchId: string; code: string; nameAr: string; warehouseId: string; returnWarehouseId: string; walkInCustomerId: string;
  cashAccountId: string; safeAccountId: string; cardAccountId?: string | null; varianceAccountId?: string | null; maxDiscountPct?: string; receiptHeader?: string; receiptFooter?: string;
}
export async function createRegister(db: Db, u: UserCtx, b: RegisterInput) {
  assertBranchAccess(u, b.branchId);
  const wh = await warehouseOf(db, b.warehouseId, b.companyId);
  if (!wh.is_sellable) throw E.rule("WAREHOUSE_NOT_SELLABLE", "مخزن نقطة البيع يجب أن يكون صالحًا للبيع", "The register must sell from a sellable warehouse");
  const rw = await warehouseOf(db, b.returnWarehouseId, b.companyId);
  if (rw.kind !== "quarantine") throw E.rule("RETURN_MUST_GO_TO_QUARANTINE", "مخزن المرتجعات يجب أن يكون مخزن حجر/فحص", "Returns warehouse must be a quarantine warehouse");
  const c = (await db.query("SELECT 1 FROM parties WHERE id = $1 AND company_id = $2 AND kind IN ('customer','both')", [b.walkInCustomerId, b.companyId])).rowCount;
  if (!c) throw E.validation([{ path: "walkInCustomerId", message: "customer not found in this company" }]);
  await postableAccount(db, b.companyId, b.cashAccountId, "cashAccountId", ["asset"], { noControl: true });
  await postableAccount(db, b.companyId, b.safeAccountId, "safeAccountId", ["asset"], { noControl: true });
  if (b.cardAccountId) await postableAccount(db, b.companyId, b.cardAccountId, "cardAccountId", ["asset"], { noControl: true });
  if (b.varianceAccountId) await postableAccount(db, b.companyId, b.varianceAccountId, "varianceAccountId", ["expense", "revenue"]);
  const r = (await db.query(
    `INSERT INTO pos_registers (tenant_id, company_id, branch_id, code, name_ar, warehouse_id, return_warehouse_id, walk_in_customer_id, cash_account_id, safe_account_id,
       card_account_id, variance_account_id, max_discount_pct, receipt_header, receipt_footer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [u.tenantId, b.companyId, b.branchId, b.code, b.nameAr, b.warehouseId, b.returnWarehouseId, b.walkInCustomerId, b.cashAccountId, b.safeAccountId,
      b.cardAccountId ?? null, b.varianceAccountId ?? null, b.maxDiscountPct ?? "0", b.receiptHeader ?? null, b.receiptFooter ?? null])).rows[0];
  await ev(db, u, "pos_register.created", "pos_register", r.id, r);
  return r;
}

// ------------------------------------------------------------------ shifts
async function lockShift(db: Db, u: UserCtx, shiftId: string, opts: { allowSupervisor?: boolean } = {}) {
  const s = (await db.query(
    `SELECT s.*, r.code AS register_code, r.warehouse_id, r.return_warehouse_id, r.walk_in_customer_id, r.cash_account_id, r.safe_account_id, r.card_account_id,
            r.variance_account_id, r.max_discount_pct, r.branch_id FROM pos_shifts s JOIN pos_registers r ON r.id = s.register_id WHERE s.id = $1 FOR UPDATE OF s`, [shiftId])).rows[0];
  if (!s) throw E.notFound("pos_shifts");
  if (s.status !== "open") throw E.rule("SHIFT_CLOSED", "الوردية مغلقة", "The shift is closed");
  const mine = s.cashier_id === u.userId;
  if (!mine && !(opts.allowSupervisor && u.permissions.has("pos.shifts.supervise")))
    throw E.rule("NOT_YOUR_SHIFT", "هذه الوردية لكاشير آخر", "This shift belongs to another cashier");
  return s;
}

const expectedCash = async (db: Db, shiftId: string) =>
  (await num(db, `SELECT (s.opening_float + coalesce((SELECT sum(amount) FROM pos_payments p WHERE p.shift_id = s.id AND p.tender = 'cash'), 0))::numeric(20,4)::text AS e
                    FROM pos_shifts s WHERE s.id = $1`, [shiftId])).e as string;

/** opens the cashier's shift; the opening float is moved from the main safe into the drawer */
export async function openShift(db: Db, u: UserCtx, b: { registerId: string; openingFloat: string; businessDate: string }) {
  const r = (await db.query("SELECT * FROM pos_registers WHERE id = $1", [b.registerId])).rows[0];
  if (!r) throw E.validation([{ path: "registerId", message: "register not found" }]);
  if (!r.is_active) throw E.rule("REGISTER_INACTIVE", "نقطة البيع موقوفة", "Register is inactive");
  assertBranchAccess(u, r.branch_id);
  const number = await docNumber(db, u, r.company_id, "PS", b.businessDate);
  const s = (await db.query(
    `INSERT INTO pos_shifts (tenant_id, company_id, register_id, number, cashier_id, business_date, opening_float) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [u.tenantId, r.company_id, r.id, number, u.userId, b.businessDate, b.openingFloat])).rows[0];
  if (Number(b.openingFloat) > 0) {
    const je = await postAccounts(db, u, { companyId: r.company_id, date: b.businessDate, memo: `عهدة افتتاح الوردية ${number} — ${r.code}`, sourceType: "pos_shift_open", sourceId: s.id,
      parts: [{ accountId: r.cash_account_id, amount: b.openingFloat }, { accountId: r.safe_account_id, amount: `-${b.openingFloat}` }] });
    await db.query("UPDATE pos_shifts SET open_journal_id = $2 WHERE id = $1", [s.id, je]);
  }
  await ev(db, u, "pos_shift.opened", "pos_shift", s.id, { number, register: r.code, openingFloat: b.openingFloat });
  return shiftReport(db, s.id);
}

// ------------------------------------------------------------------ selling
export interface SaleInput {
  clientId: string; customerId?: string | null; notes?: string;
  lines: { itemId?: string; barcode?: string; uomId?: string | null; qty: string; discountPct?: string }[];
  cash: string; card: string; credit: string; tendered?: string;
}

async function resolveLine(db: Db, companyId: string, l: SaleInput["lines"][number]) {
  if (l.itemId) return { itemId: l.itemId, uomId: l.uomId ?? null };
  // a barcode may identify the base unit (items.barcode) or a pack unit (item_uoms.barcode, e.g. a carton)
  const r = (await db.query(
    `SELECT i.id AS item_id, NULL::uuid AS uom_id FROM items i WHERE i.company_id = $1 AND i.barcode = $2
     UNION ALL SELECT iu.item_id, iu.uom_id FROM item_uoms iu JOIN items i ON i.id = iu.item_id WHERE i.company_id = $1 AND iu.barcode = $2 LIMIT 1`, [companyId, l.barcode])).rows[0];
  if (!r) throw E.rule("UNKNOWN_BARCODE", `الباركود ${l.barcode} غير معرّف`, `Unknown barcode ${l.barcode}`, { barcode: l.barcode });
  return { itemId: r.item_id as string, uomId: (r.uom_id as string | null) ?? null };
}

export async function sell(db: Db, u: UserCtx, shiftId: string, b: SaleInput) {
  const s = await lockShift(db, u, shiftId);
  const prev = (await db.query("SELECT id FROM sales_invoices WHERE pos_shift_id = $1 AND pos_client_id = $2", [shiftId, b.clientId])).rows[0];
  if (prev) return { ...(await receipt(db, prev.id)), replayed: true };   // offline retry / double click

  const customerId = b.customerId ?? s.walk_in_customer_id;
  if (Number(b.credit) > 0) {
    if (!u.permissions.has("pos.sales.credit")) throw E.forbidden("pos.sales.credit");
    if (customerId === s.walk_in_customer_id) throw E.rule("CREDIT_NEEDS_CUSTOMER", "البيع الآجل يتطلب اختيار عميل مسجّل", "Selling on account requires a registered customer");
  }
  if (Number(b.card) > 0 && !s.card_account_id) throw E.rule("CARD_NOT_CONFIGURED", "لم يُحدد حساب البطاقات لنقطة البيع", "No card account is configured for this register");
  const lines = [];
  for (const l of b.lines) {
    const disc = l.discountPct ?? "0";
    if (Number(disc) > Number(s.max_discount_pct) && !u.permissions.has("pos.sales.discount_override"))
      throw E.rule("DISCOUNT_ABOVE_LIMIT", `الخصم ${disc}% يتجاوز حد نقطة البيع ${Number(s.max_discount_pct)}%`, `Discount ${disc}% exceeds the register limit ${Number(s.max_discount_pct)}%`);
    lines.push({ ...(await resolveLine(db, s.company_id, l)), qty: l.qty, discountPct: disc });
  }
  const ctx = posCtx(u);
  const draft = await createInvoice(db, ctx, { companyId: s.company_id, branchId: s.branch_id, warehouseId: s.warehouse_id, customerId, invoiceDate: String(s.business_date).slice(0, 10),
    paymentType: Number(b.credit) > 0 ? "credit" : "cash", notes: b.notes, posShiftId: shiftId, posClientId: b.clientId, lines });
  const sum = (await num(db, "SELECT ($1::numeric + $2::numeric + $3::numeric)::text AS s, ($1::numeric + $2::numeric + $3::numeric) = $4::numeric AS ok", [b.cash, b.card, b.credit, draft.total]));
  if (!sum.ok) throw E.rule("PAYMENT_MISMATCH", `مجموع الدفع ${sum.s} لا يساوي إجمالي الفاتورة ${draft.total}`, `Payments ${sum.s} do not equal the invoice total ${draft.total}`, { total: draft.total });
  if (b.tendered !== undefined && Number(b.tendered) < Number(b.cash)) throw E.validation([{ path: "tendered", message: "less than the cash part" }]);
  const settlement = [{ accountId: s.cash_account_id, amount: b.cash }, ...(Number(b.card) > 0 ? [{ accountId: s.card_account_id, amount: b.card }] : [])].filter((x) => Number(x.amount) > 0);
  await postInvoice(db, ctx, draft.id, { settlement });
  for (const [tender, amount] of [["cash", b.cash], ["card", b.card], ["credit", b.credit]] as const)
    if (Number(amount) > 0) await db.query("INSERT INTO pos_payments (tenant_id, shift_id, kind, tender, amount, invoice_id, created_by) VALUES ($1,$2,'sale',$3,$4,$5,$6)",
      [u.tenantId, shiftId, tender, amount, draft.id, u.userId]);
  const change = b.tendered !== undefined ? (await num(db, "SELECT ($1::numeric - $2::numeric)::numeric(20,4)::text AS c", [b.tendered, b.cash])).c : "0.0000";
  return { ...(await receipt(db, draft.id)), tendered: b.tendered ?? null, change, replayed: false };
}

export async function receipt(db: Db, invoiceId: string) {
  const inv = await getInvoice(db, invoiceId);
  if (!inv.pos_shift_id) throw E.rule("NOT_A_POS_SALE", "الفاتورة ليست من نقطة البيع", "Not a POS sale");
  const meta = (await db.query(
    `SELECT s.number AS shift_number, r.code AS register_code, r.name_ar AS register_name, r.receipt_header, r.receipt_footer, u.full_name AS cashier, c.name_ar AS company_name,
            p.code AS customer_code, p.name_ar AS customer_name
       FROM pos_shifts s JOIN pos_registers r ON r.id = s.register_id JOIN users u ON u.id = s.cashier_id JOIN companies c ON c.id = s.company_id
       JOIN sales_invoices i ON i.id = $2 JOIN parties p ON p.id = i.customer_id WHERE s.id = $1`, [inv.pos_shift_id, invoiceId])).rows[0];
  const payments = (await db.query("SELECT kind, tender, amount FROM pos_payments WHERE invoice_id = $1 ORDER BY id", [invoiceId])).rows;
  return { invoice: inv, ...meta, payments };
}

// ------------------------------------------------------------------ returns, drops, close
export async function returnSale(db: Db, u: UserCtx, shiftId: string, b: { invoiceId: string; lines: { invoiceLineId: string; qty: string }[]; refundTender: "cash" | "card"; reason: string }) {
  const s = await lockShift(db, u, shiftId);
  const inv = (await db.query("SELECT i.*, ps.register_id FROM sales_invoices i JOIN pos_shifts ps ON ps.id = i.pos_shift_id WHERE i.id = $1", [b.invoiceId])).rows[0];
  if (!inv || inv.company_id !== s.company_id) throw E.rule("NOT_A_POS_SALE", "الفاتورة ليست من نقاط بيع هذه الشركة", "Not a POS sale of this company");
  const ctx = posCtx(u);
  const r = await createReturn(db, ctx, { invoiceId: b.invoiceId, warehouseId: s.return_warehouse_id, returnDate: String(s.business_date).slice(0, 10), reason: b.reason, lines: b.lines });
  let tender: "cash" | "card" | "credit" = inv.payment_type === "credit" ? "credit" : b.refundTender;
  if (tender === "card" && !s.card_account_id) throw E.rule("CARD_NOT_CONFIGURED", "لم يُحدد حساب البطاقات لنقطة البيع", "No card account is configured for this register");
  if (tender === "cash" && Number(await expectedCash(db, shiftId)) < Number(r.total))
    throw E.rule("DRAWER_INSUFFICIENT", "النقدية في الدرج لا تكفي للرد", "Not enough cash in the drawer for this refund");
  await postReturn(db, ctx, r.id, { refundAccountId: tender === "cash" ? s.cash_account_id : tender === "card" ? s.card_account_id : undefined });
  await db.query("INSERT INTO pos_payments (tenant_id, shift_id, kind, tender, amount, invoice_id, return_id, note, created_by) VALUES ($1,$2,'refund',$3,-$4::numeric,$5,$6,$7,$8)",
    [u.tenantId, shiftId, tender, r.total, b.invoiceId, r.id, b.reason, u.userId]);
  await ev(db, u, "pos.refund", "sales_return", r.id, { invoice: inv.number, total: r.total, tender });
  return { returnId: r.id, total: r.total, tender, quarantineWarehouseId: s.return_warehouse_id };
}

/** cash drop: part of the drawer taken to the main safe during the shift (supervisor) */
export async function cashDrop(db: Db, u: UserCtx, shiftId: string, b: { amount: string; note?: string }) {
  const s = await lockShift(db, u, shiftId, { allowSupervisor: true });
  if (Number(await expectedCash(db, shiftId)) < Number(b.amount)) throw E.rule("DRAWER_INSUFFICIENT", "المبلغ يتجاوز النقدية المتوقعة في الدرج", "Amount exceeds the expected drawer cash");
  const p = (await db.query("INSERT INTO pos_payments (tenant_id, shift_id, kind, tender, amount, note, created_by) VALUES ($1,$2,'drop','cash',-$3::numeric,$4,$5) RETURNING id",
    [u.tenantId, shiftId, b.amount, b.note ?? null, u.userId])).rows[0];
  await postAccounts(db, u, { companyId: s.company_id, date: String(s.business_date).slice(0, 10), memo: `سحب نقدية من الوردية ${s.number} إلى الخزينة`, sourceType: "pos_cash_drop", sourceId: String(p.id),
    parts: [{ accountId: s.safe_account_id, amount: b.amount }, { accountId: s.cash_account_id, amount: `-${b.amount}` }] });
  await ev(db, u, "pos.cash_drop", "pos_shift", shiftId, b);
  return shiftReport(db, shiftId);
}

/**
 * Close (Z): counted cash goes back to the main safe; the drawer account is
 * credited with the EXPECTED cash, so it nets to zero; the difference is
 * posted to the register's over/short account.
 */
export async function closeShift(db: Db, u: UserCtx, shiftId: string, b: { countedCash: string; notes?: string }) {
  const s = await lockShift(db, u, shiftId, { allowSupervisor: true });
  const expected = await expectedCash(db, shiftId);
  const variance = (await num(db, "SELECT ($1::numeric - $2::numeric)::numeric(20,4)::text AS v", [b.countedCash, expected])).v as string;
  if (Number(variance) !== 0 && !s.variance_account_id)
    throw E.rule("VARIANCE_ACCOUNT_MISSING", `يوجد فرق ${variance} ولم يُحدد حساب العجز والزيادة لنقطة البيع`, `There is a variance of ${variance} and no over/short account is configured`);
  const parts = [
    { accountId: s.safe_account_id, amount: b.countedCash },
    { accountId: s.cash_account_id, amount: `-${expected}` },
    ...(Number(variance) !== 0 ? [{ accountId: s.variance_account_id, amount: (await num(db, "SELECT (-$1::numeric)::text AS v", [variance])).v as string }] : []),
  ];
  const je = await postAccounts(db, u, { companyId: s.company_id, date: String(s.business_date).slice(0, 10), memo: `إقفال الوردية ${s.number} — ${s.register_code}`, sourceType: "pos_shift_close", sourceId: shiftId, parts });
  await db.query(`UPDATE pos_shifts SET status = 'closed', closed_at = now(), closed_by = $2, expected_cash = $3, counted_cash = $4, variance = $5, close_notes = $6, close_journal_id = $7 WHERE id = $1`,
    [shiftId, u.userId, expected, b.countedCash, variance, b.notes ?? null, je]);
  await ev(db, u, "pos_shift.closed", "pos_shift", shiftId, { expected, counted: b.countedCash, variance });
  return shiftReport(db, shiftId);
}

/** X report while open, Z report once closed */
export async function shiftReport(db: Db, shiftId: string) {
  const s = (await db.query(
    `SELECT s.*, r.code AS register_code, r.name_ar AS register_name, u.full_name AS cashier FROM pos_shifts s JOIN pos_registers r ON r.id = s.register_id
       JOIN users u ON u.id = s.cashier_id WHERE s.id = $1`, [shiftId])).rows[0];
  if (!s) throw E.notFound("pos_shifts");
  const t = (await db.query(
    `SELECT count(*)::int AS invoices, coalesce(sum(subtotal), 0)::numeric(20,4)::text AS gross, coalesce(sum(discount_total), 0)::numeric(20,4)::text AS discounts,
            coalesce(sum(total), 0)::numeric(20,4)::text AS net, coalesce(sum(cogs_total), 0)::numeric(20,4)::text AS cogs
       FROM sales_invoices WHERE pos_shift_id = $1 AND status = 'posted'`, [shiftId])).rows[0];
  const byTender = (await db.query(
    `SELECT kind, tender, count(*)::int AS n, sum(amount)::numeric(20,4)::text AS amount FROM pos_payments WHERE shift_id = $1 GROUP BY kind, tender ORDER BY kind, tender`, [shiftId])).rows;
  const topItems = (await db.query(
    `SELECT it.code, it.name_ar, sum(l.base_qty)::numeric(20,4)::text AS qty, sum(l.line_total)::numeric(20,4)::text AS amount
       FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.doc_id JOIN items it ON it.id = l.item_id
      WHERE i.pos_shift_id = $1 AND i.status = 'posted' GROUP BY it.id ORDER BY sum(l.line_total) DESC LIMIT 10`, [shiftId])).rows;
  return { shift: s, totals: t, byTender, topItems, expectedCash: s.status === "open" ? await expectedCash(db, shiftId) : s.expected_cash };
}
