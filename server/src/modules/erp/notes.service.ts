// Customer credit notes and supplier debit notes (K15): money adjustments after the
// fact, against one posted invoice, without goods moving.
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { accountByRole, docNumber, lockDraft, markPosted, postAccounts, postableAccount } from "./common.js";

type Kind = "customer_credit" | "supplier_debit";
const one = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];

/** open balance of the invoice the note applies to (customer: total − paid − returned/credited; supplier: total − paid/debited) */
async function openOf(db: Db, kind: Kind, invoiceId: string, lock = false) {
  const inv = kind === "customer_credit"
    ? await one(db, `SELECT id, company_id, customer_id AS party_id, number, status, payment_type, (total - amount_paid - amount_returned)::numeric(20,4)::text AS open FROM sales_invoices WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [invoiceId])
    : await one(db, `SELECT id, company_id, supplier_id AS party_id, number, status, (total - amount_paid)::numeric(20,4)::text AS open FROM supplier_invoices WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [invoiceId]);
  if (!inv || inv.status !== "posted") throw E.rule("INVOICE_NOT_POSTED", "الإشعار يُطبّق على فاتورة مرحّلة فقط", "A note applies to a posted invoice only");
  return inv;
}

export async function createNote(db: Db, u: UserCtx, kind: Kind, b: { invoiceId: string; noteDate: string; amount: string; reason: string; accountId?: string | null }) {
  const inv = await openOf(db, kind, b.invoiceId);
  if (Number(b.amount) > Number(inv.open))
    throw E.rule("NOTE_EXCEEDS_OPEN", `قيمة الإشعار ${b.amount} تتجاوز المتبقي على الفاتورة ${inv.number} (${inv.open})`, `Amount exceeds the invoice's open balance (${inv.open})`, { open: inv.open });
  const account = b.accountId ?? (kind === "customer_credit" ? await accountByRole(db, inv.company_id, "sales_discounts") : null);
  if (!account) throw E.validation([{ path: "accountId", message: "choose the account the supplier discount goes to (e.g. stock adjustment or other income)" }]);
  // the other side may be revenue / expense / an asset like stock — never a receivable/payable control account
  await postableAccount(db, inv.company_id, account, "accountId", undefined, { noControl: true });
  const r = await one(db,
    `INSERT INTO adjustment_notes (tenant_id, company_id, kind, note_date, party_id, sales_invoice_id, supplier_invoice_id, amount, account_id, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [u.tenantId, inv.company_id, kind, b.noteDate, inv.party_id, kind === "customer_credit" ? inv.id : null, kind === "supplier_debit" ? inv.id : null, b.amount, account, b.reason, u.userId]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: `${kind}_note.draft_created`, entityType: "adjustment_note", entityId: r.id, after: b });
  return getNote(db, r.id);
}

export async function postNote(db: Db, u: UserCtx, id: string) {
  const d = await lockDraft(db, u, "adjustment_notes", id);
  const kind = d.kind as Kind;
  const inv = await openOf(db, kind, kind === "customer_credit" ? d.sales_invoice_id : d.supplier_invoice_id, true);
  if (Number(d.amount) > Number(inv.open))
    throw E.rule("NOTE_EXCEEDS_OPEN", `قيمة الإشعار تتجاوز المتبقي على الفاتورة ${inv.number} (${inv.open})`, `Amount exceeds the invoice's open balance (${inv.open})`, { open: inv.open });
  const number = await docNumber(db, u, d.company_id, kind === "customer_credit" ? "CN" : "DN", String(d.note_date).slice(0, 10));
  const memo = `${kind === "customer_credit" ? "إشعار دائن للعميل" : "إشعار مدين للمورد"} ${number} على الفاتورة ${inv.number} — ${d.reason}`;
  const je = kind === "customer_credit"
    ? await postAccounts(db, u, { companyId: d.company_id, date: String(d.note_date).slice(0, 10), memo, sourceType: "adjustment_note", sourceId: id,
        parts: [{ accountId: d.account_id, amount: d.amount }, { accountId: await accountByRole(db, d.company_id, "ar"), amount: `-${d.amount}` }] })
    : await postAccounts(db, u, { companyId: d.company_id, date: String(d.note_date).slice(0, 10), memo, sourceType: "adjustment_note", sourceId: id,
        parts: [{ accountId: await accountByRole(db, d.company_id, "ap"), amount: d.amount }, { accountId: d.account_id, amount: `-${d.amount}` }] });
  // the invoice's open balance goes down by the note (same running totals every balance report already uses)
  if (kind === "customer_credit") await db.query("UPDATE sales_invoices SET amount_returned = amount_returned + $2 WHERE id = $1", [inv.id, d.amount]);
  else await db.query("UPDATE supplier_invoices SET amount_paid = amount_paid + $2 WHERE id = $1", [inv.id, d.amount]);
  await markPosted(db, u, "adjustment_notes", id, number, je);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: `${kind}_note.posted`, entityType: "adjustment_note", entityId: id, after: { number, amount: d.amount } });
  return getNote(db, id);
}

export async function getNote(db: Db, id: string) {
  const r = await one(db,
    `SELECT n.*, p.code AS party_code, p.name_ar AS party_name_ar, a.code AS account_code, a.name_ar AS account_name,
            coalesce(si.number, su.number) AS invoice_number, u.full_name AS created_by_name
       FROM adjustment_notes n JOIN parties p ON p.id = n.party_id JOIN accounts a ON a.id = n.account_id JOIN users u ON u.id = n.created_by
       LEFT JOIN sales_invoices si ON si.id = n.sales_invoice_id LEFT JOIN supplier_invoices su ON su.id = n.supplier_invoice_id WHERE n.id = $1`, [id]);
  if (!r) throw E.notFound("adjustment_notes");
  return r;
}
