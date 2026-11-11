// Purchasing (goods receipt → supplier invoice) and stock documents
// (opening balance, count adjustment, damage write-off, transfer, quarantine release).
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { ensureLot, stockIn, stockOut } from "./stock.js";
import { docNumber, inventoryRole, itemUom, lockDraft, markPosted, minorUnits, postJournal, warehouseOf } from "./common.js";

const n = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];

async function lotDates(db: Db, item: any, productionDate?: string | null, expiryDate?: string | null) {
  if (expiryDate || !productionDate || !item.shelf_life_days) return expiryDate ?? null;
  return (await n(db, "SELECT ($1::date + $2::int)::text AS d", [productionDate, item.shelf_life_days])).d as string;
}

// ------------------------------------------------------------------ goods receipt
export async function createReceipt(db: Db, u: UserCtx, b: { companyId: string; supplierId: string; warehouseId: string; receiptDate: string; supplierRef?: string;
  lines: { itemId: string; uomId?: string | null; qty: string; unitCost: string; lotNo?: string; productionDate?: string; expiryDate?: string }[] }) {
  const s = (await db.query("SELECT * FROM parties WHERE id = $1 AND company_id = $2 AND kind IN ('supplier','both') AND is_active", [b.supplierId, b.companyId])).rows[0];
  if (!s) throw E.validation([{ path: "supplierId", message: "active supplier not found in this company" }]);
  await warehouseOf(db, b.warehouseId, b.companyId);
  const m = await minorUnits(db, b.companyId);
  const r = (await db.query("INSERT INTO purchase_receipts (tenant_id, company_id, supplier_id, warehouse_id, receipt_date, supplier_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [u.tenantId, b.companyId, b.supplierId, b.warehouseId, b.receiptDate, b.supplierRef ?? null, u.userId])).rows[0];
  let i = 0;
  for (const l of b.lines) {
    const { item, uomId, factor } = await itemUom(db, l.itemId, l.uomId);
    if (item.kind === "service") throw E.validation([{ path: `lines.${i}`, message: "services are not received into stock" }]);
    if (item.track_lots && !l.lotNo) throw E.rule("LOT_REQUIRED", `رقم التشغيلة إلزامي للصنف ${item.code}`, `Lot number is required for ${item.code}`);
    const expiry = await lotDates(db, item, l.productionDate, l.expiryDate);
    await db.query(
      `INSERT INTO purchase_receipt_lines (tenant_id, doc_id, line_no, item_id, uom_id, factor, qty, base_qty, unit_cost, line_total, lot_no, production_date, expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric, round($7::numeric * $6::numeric, 4), $8::numeric, round($7::numeric * $8::numeric, $12), $9, $10, $11)`,
      [u.tenantId, r.id, ++i, l.itemId, uomId, factor, l.qty, l.unitCost, l.lotNo ?? null, l.productionDate ?? null, expiry, m]);
  }
  await db.query("UPDATE purchase_receipts SET total = (SELECT sum(line_total) FROM purchase_receipt_lines WHERE doc_id = $1) WHERE id = $1", [r.id]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "purchase_receipt.draft_created", entityType: "purchase_receipt", entityId: r.id, after: b });
  return getReceipt(db, r.id);
}

export async function postReceipt(db: Db, u: UserCtx, id: string) {
  const d = await lockDraft(db, u, "purchase_receipts", id);
  const wh = await warehouseOf(db, d.warehouse_id, d.company_id);
  const lines = (await db.query("SELECT l.*, i.kind, i.code FROM purchase_receipt_lines l JOIN items i ON i.id = l.item_id WHERE doc_id = $1 ORDER BY line_no", [id])).rows;
  const parts: { role: string; amount: string }[] = [];
  for (const l of lines) {
    const lotId = l.lot_no ? await ensureLot(db, u, l.item_id, l.lot_no, l.production_date, l.expiry_date, d.supplier_id) : null;
    if (lotId) await db.query("UPDATE purchase_receipt_lines SET lot_id = $2 WHERE id = $1", [l.id, lotId]);
    const v = await stockIn(db, u, { companyId: d.company_id, date: d.receipt_date, sourceType: "purchase_receipt", sourceId: id, sourceLineId: l.id,
      warehouseId: d.warehouse_id, itemId: l.item_id, lotId, qty: l.base_qty, value: l.line_total });
    parts.push({ role: inventoryRole(wh.kind, l.kind), amount: v });
  }
  parts.push({ role: "grni", amount: "-" + d.total });
  const number = await docNumber(db, u, d.company_id, "GR", d.receipt_date);
  const je = await postJournal(db, u, { companyId: d.company_id, date: d.receipt_date, memo: `إذن استلام ${number}`, sourceType: "purchase_receipt", sourceId: id, parts });
  await markPosted(db, u, "purchase_receipts", id, number, je);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "purchase_receipt.posted", entityType: "purchase_receipt", entityId: id, after: { number, total: d.total } });
  return getReceipt(db, id);
}

export async function getReceipt(db: Db, id: string) {
  const h = (await db.query(`SELECT r.*, p.code AS supplier_code, p.name_ar AS supplier_name_ar, w.code AS warehouse_code FROM purchase_receipts r
     JOIN parties p ON p.id = r.supplier_id JOIN warehouses w ON w.id = r.warehouse_id WHERE r.id = $1`, [id])).rows[0];
  if (!h) throw E.notFound("purchase receipt");
  const lines = (await db.query(`SELECT l.*, i.code AS item_code, i.name_ar AS item_name_ar, u.code AS uom_code FROM purchase_receipt_lines l
     JOIN items i ON i.id = l.item_id JOIN uoms u ON u.id = l.uom_id WHERE l.doc_id = $1 ORDER BY line_no`, [id])).rows;
  return { ...h, lines };
}

// ------------------------------------------------------------------ supplier invoice (matched to a receipt)
export async function createSupplierInvoice(db: Db, u: UserCtx, b: { receiptId: string; supplierInvoiceNo: string; invoiceDate: string; total: string }) {
  const r = (await db.query("SELECT * FROM purchase_receipts WHERE id = $1", [b.receiptId])).rows[0];
  if (!r || r.status !== "posted") throw E.rule("RECEIPT_NOT_POSTED", "يجب ترحيل إذن الاستلام أولًا", "The goods receipt must be posted first");
  const x = (await db.query(
    `INSERT INTO supplier_invoices (tenant_id, company_id, supplier_id, receipt_id, supplier_invoice_no, invoice_date, total, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [u.tenantId, r.company_id, r.supplier_id, r.id, b.supplierInvoiceNo, b.invoiceDate, b.total, u.userId])).rows[0];
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "supplier_invoice.draft_created", entityType: "supplier_invoice", entityId: x.id, after: b });
  return x;
}

export async function postSupplierInvoice(db: Db, u: UserCtx, id: string) {
  const d = await lockDraft(db, u, "supplier_invoices", id);
  const r = (await db.query("SELECT * FROM purchase_receipts WHERE id = $1 FOR UPDATE", [d.receipt_id])).rows[0];
  if ((await n(db, "SELECT $1::numeric > ($2::numeric - $3::numeric) AS over", [d.total, r.total, r.amount_invoiced])).over)
    throw E.rule("INVOICE_EXCEEDS_RECEIPT", `قيمة فاتورة المورد تتجاوز المتبقي غير المفوتر من الاستلام (${r.total} − ${r.amount_invoiced})`,
      "Supplier invoice exceeds the receipt's uninvoiced value (price variances are not supported yet)", { receiptTotal: r.total, invoiced: r.amount_invoiced });
  await db.query("UPDATE purchase_receipts SET amount_invoiced = amount_invoiced + $2 WHERE id = $1", [r.id, d.total]);
  const terms = (await n(db, "SELECT payment_terms_days FROM parties WHERE id = $1", [d.supplier_id])).payment_terms_days;
  const due = (await n(db, "SELECT ($1::date + $2::int)::text AS d", [d.invoice_date, terms])).d;
  const number = await docNumber(db, u, d.company_id, "PI", d.invoice_date);
  const je = await postJournal(db, u, { companyId: d.company_id, date: d.invoice_date, memo: `فاتورة مورد ${d.supplier_invoice_no} (${number})`, sourceType: "supplier_invoice", sourceId: id,
    parts: [{ role: "grni", amount: d.total }, { role: "ap", amount: "-" + d.total }] });
  await markPosted(db, u, "supplier_invoices", id, number, je, { due_date: due });
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "supplier_invoice.posted", entityType: "supplier_invoice", entityId: id, after: { number, total: d.total } });
  return (await db.query("SELECT * FROM supplier_invoices WHERE id = $1", [id])).rows[0];
}

// ------------------------------------------------------------------ stock documents
type Reason = "opening" | "count" | "damage" | "quarantine_release" | "transfer";
export async function createStockDoc(db: Db, u: UserCtx, b: { companyId: string; reason: Reason; warehouseId: string; toWarehouseId?: string | null; docDate: string; notes?: string;
  lines: { itemId: string; qtyDelta: string; unitCost?: string; lotNo?: string; lotId?: string | null; productionDate?: string; expiryDate?: string }[] }) {
  const from = await warehouseOf(db, b.warehouseId, b.companyId);
  const to = b.toWarehouseId ? await warehouseOf(db, b.toWarehouseId, b.companyId) : null;
  if (b.reason === "transfer" && from.kind === "quarantine") throw E.rule("USE_QUARANTINE_RELEASE", "إخراج بضاعة من الحجر يتم عبر «إفراج بعد الفحص» فقط", "Stock leaves quarantine only through a quarantine release");
  if (b.reason === "quarantine_release" && from.kind !== "quarantine") throw E.rule("NOT_QUARANTINE", "الإفراج يكون من مخزن الحجر فقط", "Release must come from a quarantine warehouse");
  const d = (await db.query("INSERT INTO stock_documents (tenant_id, company_id, reason, warehouse_id, to_warehouse_id, doc_date, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    [u.tenantId, b.companyId, b.reason, b.warehouseId, to?.id ?? null, b.docDate, b.notes ?? null, u.userId])).rows[0];
  let i = 0;
  for (const l of b.lines) {
    const { item } = await itemUom(db, l.itemId);
    const neg = l.qtyDelta.trim().startsWith("-");
    if (["opening"].includes(b.reason) && neg) throw E.validation([{ path: `lines.${i}`, message: "opening quantities must be positive" }]);
    if (["damage"].includes(b.reason) && !neg) throw E.validation([{ path: `lines.${i}`, message: "damage write-off quantities must be negative" }]);
    if (["transfer", "quarantine_release"].includes(b.reason) && neg) throw E.validation([{ path: `lines.${i}`, message: "transfer quantities must be positive" }]);
    if (!neg && ["opening", "count"].includes(b.reason) && l.unitCost === undefined) throw E.validation([{ path: `lines.${i}.unitCost`, message: "unit cost is required for stock increases" }]);
    if (!neg && ["opening", "count"].includes(b.reason) && item.track_lots && !l.lotNo) throw E.rule("LOT_REQUIRED", `رقم التشغيلة إلزامي للصنف ${item.code}`, `Lot number is required for ${item.code}`);
    const expiry = await lotDates(db, item, l.productionDate, l.expiryDate);
    await db.query(`INSERT INTO stock_document_lines (tenant_id, doc_id, line_no, item_id, qty_delta, unit_cost, lot_no, production_date, expiry_date, lot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [u.tenantId, d.id, ++i, l.itemId, l.qtyDelta, l.unitCost ?? null, l.lotNo ?? null, l.productionDate ?? null, expiry, l.lotId ?? null]);
  }
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "stock_document.draft_created", entityType: "stock_document", entityId: d.id, after: b });
  return getStockDoc(db, d.id);
}

export async function postStockDoc(db: Db, u: UserCtx, id: string) {
  const d = await lockDraft(db, u, "stock_documents", id);
  if (d.reason === "quarantine_release" && !u.permissions.has("inventory.quarantine.release")) throw E.forbidden("inventory.quarantine.release");
  const from = await warehouseOf(db, d.warehouse_id, d.company_id);
  const to = d.to_warehouse_id ? await warehouseOf(db, d.to_warehouse_id, d.company_id) : null;
  const lines = (await db.query("SELECT l.*, i.kind, i.code, i.track_lots FROM stock_document_lines l JOIN items i ON i.id = l.item_id WHERE doc_id = $1 ORDER BY line_no", [id])).rows;
  const parts: { role: string; amount: string }[] = [];
  const src = { companyId: d.company_id, date: d.doc_date, sourceType: "stock_document", sourceId: id };
  for (const l of lines) {
    const neg = String(l.qty_delta).startsWith("-");
    const qty = neg ? String(l.qty_delta).slice(1) : String(l.qty_delta);
    const invRole = inventoryRole(from.kind, l.kind);
    if (d.reason === "transfer" || d.reason === "quarantine_release") {
      const out = await stockOut(db, u, { ...src, sourceLineId: l.id, warehouseId: from.id, itemId: l.item_id, lotId: l.lot_id, qty, trackLots: l.track_lots, itemCode: l.code });
      // the value moves with the goods; the last lot slice takes the rounding remainder so stock value == GL exactly
      let left = out.value;
      for (const [k, a] of out.allocations.entries()) {
        const value = k === out.allocations.length - 1 ? left
          : (await n(db, "SELECT round($1::numeric * $2::numeric / $3::numeric, 4)::text AS v", [out.value, a.qty, qty])).v;
        left = (await n(db, "SELECT ($1::numeric - $2::numeric)::text AS r", [left, value])).r;
        await stockIn(db, u, { ...src, sourceLineId: l.id, warehouseId: to!.id, itemId: l.item_id, lotId: a.lotId, qty: a.qty, value });
      }
      parts.push({ role: inventoryRole(to!.kind, l.kind), amount: out.value }, { role: invRole, amount: "-" + out.value });
    } else if (neg) {
      const out = await stockOut(db, u, { ...src, sourceLineId: l.id, warehouseId: from.id, itemId: l.item_id, lotId: l.lot_id, qty, trackLots: l.track_lots, itemCode: l.code });
      parts.push({ role: d.reason === "damage" ? "production_scrap" : "inventory_adjustment", amount: out.value }, { role: invRole, amount: "-" + out.value });
    } else {
      const lotId = l.lot_no ? await ensureLot(db, u, l.item_id, l.lot_no, l.production_date, l.expiry_date) : l.lot_id;
      if (lotId && !l.lot_id) await db.query("UPDATE stock_document_lines SET lot_id = $2 WHERE id = $1", [l.id, lotId]);
      const v = await stockIn(db, u, { ...src, sourceLineId: l.id, warehouseId: from.id, itemId: l.item_id, lotId, qty, unitCost: l.unit_cost });
      parts.push({ role: invRole, amount: v }, { role: d.reason === "opening" ? "opening_balance" : "inventory_adjustment", amount: "-" + v });
    }
  }
  const number = await docNumber(db, u, d.company_id, "ST", d.doc_date);
  const labels: Record<string, string> = { opening: "رصيد افتتاحي للمخزون", count: "تسوية جرد", damage: "إتلاف", transfer: "تحويل مخزني", quarantine_release: "إفراج من الحجر بعد الفحص" };
  const je = await postJournal(db, u, { companyId: d.company_id, date: d.doc_date, memo: `${labels[d.reason]} ${number}`, sourceType: "stock_document", sourceId: id, parts });
  await markPosted(db, u, "stock_documents", id, number, je);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "stock_document.posted", entityType: "stock_document", entityId: id, after: { number, reason: d.reason } });
  return getStockDoc(db, id);
}

export async function getStockDoc(db: Db, id: string) {
  const h = (await db.query("SELECT * FROM stock_documents WHERE id = $1", [id])).rows[0];
  if (!h) throw E.notFound("stock document");
  const lines = (await db.query(`SELECT l.*, i.code AS item_code, i.name_ar AS item_name_ar, lt.lot_no AS lot FROM stock_document_lines l JOIN items i ON i.id = l.item_id
     LEFT JOIN lots lt ON lt.id = l.lot_id WHERE l.doc_id = $1 ORDER BY line_no`, [id])).rows;
  return { ...h, lines };
}
