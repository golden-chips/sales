// Purchase price variance and landed costs (K14). Both spread an amount over the lines of
// one posted goods receipt and add it to the value of the goods still on hand in the
// receiving warehouse; the share of goods already used goes to stock differences.
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { accountByRole, docNumber, inventoryRole, lockDraft, markPosted, minorUnits, postAccounts, postableAccount } from "./common.js";

const one = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];

/**
 * Spreads `amount` (signed: a lower supplier price is negative) over a receipt's lines, by value or quantity.
 * Updates stock values and returns the debit side of the journal (stock by account role + stock differences).
 * Works in the currency's minor units so the parts add up exactly to `amount`.
 */
export async function spreadOverReceipt(db: Db, u: UserCtx, s: { companyId: string; date: string; receiptId: string; amount: string; split: "value" | "qty"; sourceType: string; sourceId: string }) {
  const m = await minorUnits(db, s.companyId);
  const f = 10 ** m;
  const total = Math.round(Number(s.amount) * f);
  const lines = (await db.query(
    `SELECT l.id, l.item_id, l.base_qty::numeric AS qty, l.line_total::numeric AS value, i.kind AS item_kind, r.warehouse_id, w.kind AS wh_kind
       FROM purchase_receipt_lines l JOIN purchase_receipts r ON r.id = l.doc_id JOIN items i ON i.id = l.item_id JOIN warehouses w ON w.id = r.warehouse_id
      WHERE l.doc_id = $1 AND i.kind <> 'service' ORDER BY l.line_no`, [s.receiptId])).rows;
  if (!lines.length) throw E.rule("NOTHING_TO_SPREAD", "لا توجد أصناف مخزنية في إذن الاستلام", "The receipt has no stock items");
  const weight = (l: any) => Number(s.split === "qty" ? l.qty : l.value);
  const W = lines.reduce((a, l) => a + weight(l), 0) || lines.length;
  let given = 0;
  const debit = new Map<string, number>();   // account role → minor units
  let capitalized = 0, expensed = 0;
  for (const [k, l] of lines.entries()) {
    const share = k === lines.length - 1 ? total - given : Math.round(total * (weight(l) || 1) / W);
    given += share;
    if (!share) continue;
    // only the part of the received quantity that is still in the warehouse can carry the cost
    const bal = await one(db, "SELECT qty::numeric AS qty, value::numeric AS value FROM stock_balances WHERE warehouse_id = $1 AND item_id = $2 FOR UPDATE", [l.warehouse_id, l.item_id]);
    const onHand = Math.min(Number(l.qty), Number(bal?.qty ?? 0));
    let cap = Math.round(share * onHand / Number(l.qty));
    if (cap < 0) cap = Math.max(cap, -Math.round(Number(bal?.value ?? 0) * f));   // never below zero value
    const exp = share - cap;
    if (cap) {
      const v = (cap / f).toFixed(m);
      await db.query("UPDATE stock_balances SET value = value + $3::numeric, updated_at = now() WHERE warehouse_id = $1 AND item_id = $2", [l.warehouse_id, l.item_id, v]);
      await db.query(`INSERT INTO stock_value_adjustments (tenant_id, company_id, warehouse_id, item_id, adj_date, value, source_type, source_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [u.tenantId, s.companyId, l.warehouse_id, l.item_id, s.date, v, s.sourceType, s.sourceId, u.userId]);
      const role = inventoryRole(l.wh_kind, l.item_kind);
      debit.set(role, (debit.get(role) ?? 0) + cap);
      capitalized += cap;
    }
    if (exp) { debit.set("inventory_adjustment", (debit.get("inventory_adjustment") ?? 0) + exp); expensed += exp; }
  }
  const parts = [];
  for (const [role, v] of debit) if (v) parts.push({ accountId: await accountByRole(db, s.companyId, role), amount: (v / f).toFixed(m) });
  return { parts, capitalized: (capitalized / f).toFixed(m), expensed: (expensed / f).toFixed(m) };
}

// ------------------------------------------------------------------ landed costs
export async function createLandedCost(db: Db, u: UserCtx, b: { receiptId: string; costDate: string; description: string; amount: string; split: "value" | "qty"; creditAccountId: string }) {
  const r = await one(db, "SELECT * FROM purchase_receipts WHERE id = $1", [b.receiptId]);
  if (!r || r.status !== "posted") throw E.rule("RECEIPT_NOT_POSTED", "يجب ترحيل إذن الاستلام أولًا", "The goods receipt must be posted first");
  // paid from cash / bank or accrued — never straight to a customer/supplier control account (use a supplier invoice for that)
  await postableAccount(db, r.company_id, b.creditAccountId, "creditAccountId", ["asset", "liability"], { noControl: true });
  const x = await one(db, `INSERT INTO landed_costs (tenant_id, company_id, receipt_id, cost_date, description, amount, split, credit_account_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [u.tenantId, r.company_id, r.id, b.costDate, b.description, b.amount, b.split, b.creditAccountId, u.userId]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "landed_cost.draft_created", entityType: "landed_cost", entityId: x.id, after: b });
  return getLandedCost(db, x.id);
}
export async function postLandedCost(db: Db, u: UserCtx, id: string) {
  const d = await lockDraft(db, u, "landed_costs", id);
  const date = String(d.cost_date).slice(0, 10);
  const number = await docNumber(db, u, d.company_id, "LC", date);
  const sp = await spreadOverReceipt(db, u, { companyId: d.company_id, date, receiptId: d.receipt_id, amount: d.amount, split: d.split, sourceType: "landed_cost", sourceId: id });
  const rc = await one(db, "SELECT number FROM purchase_receipts WHERE id = $1", [d.receipt_id]);
  const je = await postAccounts(db, u, { companyId: d.company_id, date, memo: `تكاليف إضافية ${number} على الاستلام ${rc.number} — ${d.description}`, sourceType: "landed_cost", sourceId: id,
    parts: [...sp.parts, { accountId: d.credit_account_id, amount: `-${d.amount}` }] });
  await markPosted(db, u, "landed_costs", id, number, je, { capitalized: sp.capitalized, expensed: sp.expensed });
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "landed_cost.posted", entityType: "landed_cost", entityId: id, after: { number, ...sp } });
  return getLandedCost(db, id);
}
export async function getLandedCost(db: Db, id: string) {
  const r = await one(db, `SELECT x.*, rc.number AS receipt_number, p.name_ar AS supplier_name_ar, a.code AS account_code, a.name_ar AS account_name
      FROM landed_costs x JOIN purchase_receipts rc ON rc.id = x.receipt_id JOIN parties p ON p.id = rc.supplier_id JOIN accounts a ON a.id = x.credit_account_id WHERE x.id = $1`, [id]);
  if (!r) throw E.notFound("landed_costs");
  return r;
}
