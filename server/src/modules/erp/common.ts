import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { postFromSource, nextNumber } from "../accounting/accounting.service.js";

export const ITEM_ACCOUNT_ROLE: Record<string, string> = {
  raw: "inventory_raw", packaging: "inventory_packaging", semi_finished: "inventory_wip", finished: "inventory_fg", service: "",
};

/** inventory GL account role for stock of an item kind held in a warehouse kind */
export function inventoryRole(warehouseKind: string, itemKind: string): string {
  if (warehouseKind === "quarantine") return "inventory_quarantine";
  if (warehouseKind === "van") return "inventory_van";
  if (warehouseKind === "transit") return "inventory_transit";
  return ITEM_ACCOUNT_ROLE[itemKind] || "inventory_fg";
}

const roleCache = new WeakMap<Db, Map<string, string>>();
/** resolves the posting account for a role tag on the company's chart of accounts */
export async function accountByRole(db: Db, companyId: string, role: string): Promise<string> {
  let m = roleCache.get(db);
  if (!m) { m = new Map(); roleCache.set(db, m); }
  const k = `${companyId}:${role}`;
  if (m.has(k)) return m.get(k)!;
  const r = (await db.query("SELECT id FROM accounts WHERE company_id = $1 AND role = $2 AND is_active AND is_postable", [companyId, role])).rows[0];
  if (!r) throw E.rule("ACCOUNT_ROLE_MISSING", `لا يوجد حساب نشط مرتبط بالدور «${role}» في دليل الحسابات`, `No active posting account has the role "${role}" in the chart of accounts`, { role });
  m.set(k, r.id);
  return r.id;
}

export async function minorUnits(db: Db, companyId: string): Promise<number> {
  return (await db.query("SELECT cur.minor_units FROM companies c JOIN currencies cur ON cur.code = c.base_currency WHERE c.id = $1", [companyId])).rows[0].minor_units;
}

/**
 * Builds a balanced journal from signed role amounts (+ debit / − credit),
 * merging lines per account and dropping zeros, then posts it via the GL
 * integration contract (idempotent per source).
 */
export async function postJournal(db: Db, u: UserCtx, p: { companyId: string; date: string; memo: string; sourceType: string; sourceId: string; parts: { role: string; amount: string | number; description?: string }[] }) {
  const byAcc = new Map<string, { amount: string; description?: string }>();
  for (const part of p.parts) {
    const acc = await accountByRole(db, p.companyId, part.role);
    const prev = byAcc.get(acc);
    const sum = (await db.query("SELECT ($1::numeric + $2::numeric)::text AS s", [prev?.amount ?? "0", String(part.amount)])).rows[0].s;
    byAcc.set(acc, { amount: sum, description: prev?.description ?? part.description });
  }
  const lines = [...byAcc.entries()].filter(([, v]) => Number(v.amount) !== 0).map(([accountId, v]) =>
    v.amount.startsWith("-") ? { accountId, credit: v.amount.slice(1), description: v.description } : { accountId, debit: v.amount, description: v.description });
  if (lines.length < 2) return null; // nothing with financial effect (e.g. zero-cost transfer)
  const r = await postFromSource(db, u, { companyId: p.companyId, entryDate: p.date, memo: p.memo, sourceType: p.sourceType, sourceId: p.sourceId, lines });
  return r.entry.id as string;
}

export async function docNumber(db: Db, u: UserCtx, companyId: string, prefix: string, date: string) {
  return nextNumber(db, u.tenantId, companyId, prefix, prefix, date.slice(0, 4));
}

/** loads a draft for posting with a row lock and enforces segregation of duties */
export async function lockDraft(db: Db, u: UserCtx, table: string, id: string) {
  const d = (await db.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!d) throw E.notFound(table);
  if (d.status !== "draft") throw E.rule("ALREADY_POSTED", "المستند مرحّل مسبقًا", "Document is already posted");
  if (u.enforceSod && d.created_by === u.userId) throw E.sod();
  return d;
}

export async function markPosted(db: Db, u: UserCtx, table: string, id: string, number: string, journalId: string | null, extra: Record<string, unknown> = {}) {
  const keys = Object.keys(extra);
  const sets = keys.map((k, i) => `${k} = $${i + 5}`).join(", ");
  await db.query(`UPDATE ${table} SET status = 'posted', number = $2, journal_entry_id = $3, posted_by = $4, posted_at = now()${sets ? ", " + sets : ""} WHERE id = $1`,
    [id, number, journalId, u.userId, ...keys.map((k) => extra[k])]);
}

export async function itemUom(db: Db, itemId: string, uomId?: string | null) {
  const it = (await db.query("SELECT * FROM items WHERE id = $1", [itemId])).rows[0];
  if (!it) throw E.validation([{ path: "itemId", message: "item not found" }]);
  if (!it.is_active) throw E.rule("ITEM_INACTIVE", `الصنف ${it.code} موقوف`, `Item ${it.code} is inactive`);
  if (!uomId || uomId === it.base_uom_id) return { item: it, uomId: it.base_uom_id as string, factor: "1" };
  const f = (await db.query("SELECT factor FROM item_uoms WHERE item_id = $1 AND uom_id = $2", [itemId, uomId])).rows[0];
  if (!f) throw E.validation([{ path: "uomId", message: `unit not defined for item ${it.code}` }]);
  return { item: it, uomId, factor: f.factor as string };
}

export async function warehouseOf(db: Db, id: string, companyId: string) {
  const w = (await db.query("SELECT w.*, b.company_id FROM warehouses w JOIN branches b ON b.id = w.branch_id WHERE w.id = $1", [id])).rows[0];
  if (!w || w.company_id !== companyId) throw E.validation([{ path: "warehouseId", message: "warehouse not found in this company" }]);
  if (!w.is_active) throw E.rule("WAREHOUSE_INACTIVE", "المخزن موقوف", "Warehouse is inactive");
  return w;
}
