// Go-live (Phase 7): readiness computed from the company's own data, the
// reconciliation of every subledger with its GL control account, posting of
// imported opening documents (creator ≠ poster), and stage sign-offs.
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { docNumber, markPosted, postJournal } from "../erp/common.js";

type Status = "ok" | "warn" | "fail" | "na";
export interface Check { key: string; area: string; ar: string; en: string; status: Status; detail: string; link?: string }

const one = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
const n = async (db: Db, sql: string, args: unknown[]) => Number((await one(db, sql, args)).n);

/** every account role the posting code relies on — a missing one makes some documents impossible to post */
const REQUIRED_ROLES = ["cash_main", "bank_main", "ar", "ap", "grni", "sales_revenue", "sales_returns", "sales_discounts", "cogs", "inventory_raw", "inventory_packaging",
  "inventory_wip", "inventory_fg", "inventory_quarantine", "inventory_van", "inventory_adjustment", "opening_balance", "tax_payable", "retained_earnings"];

// ------------------------------------------------------------------ reconciliation
export async function reconciliation(db: Db, companyId: string, asOf: string) {
  const gl = async (roles: string[]) => (await one(db,
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(20,4)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = $1 AND e.status <> 'draft' AND e.entry_date <= $2 AND a.role = ANY($3)`, [companyId, asOf, roles])).v as string;
  // customers: open invoices; the unallocated part of receipts is posted to customer advances (a liability), reconciled separately
  const arSub = (await one(db,
    `SELECT coalesce(sum(total - amount_paid - amount_returned), 0)::numeric(20,4)::text AS v FROM sales_invoices WHERE company_id = $1 AND status = 'posted' AND invoice_date <= $2`, [companyId, asOf])).v;
  const advSub = (await one(db,
    `SELECT (-coalesce(sum(p.amount - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0)), 0))::numeric(20,4)::text AS v FROM payments p
      WHERE p.company_id = $1 AND p.status = 'posted' AND p.direction = 'in' AND p.payment_date <= $2`, [companyId, asOf])).v;
  const apSub = (await one(db,
    `SELECT (-((SELECT coalesce(sum(total - amount_paid), 0) FROM supplier_invoices WHERE company_id = $1 AND status = 'posted' AND invoice_date <= $2)
            - (SELECT coalesce(sum(p.amount - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0)), 0) FROM payments p
                WHERE p.company_id = $1 AND p.status = 'posted' AND p.direction = 'out' AND p.payment_date <= $2)))::numeric(20,4)::text AS v`, [companyId, asOf])).v;
  // stock: value of balances by the account role their warehouse/item kind posts to (same mapping as the posting code)
  const inv = (await db.query(
    `SELECT CASE WHEN w.kind = 'quarantine' THEN 'inventory_quarantine' WHEN w.kind = 'van' THEN 'inventory_van' WHEN w.kind = 'transit' THEN 'inventory_transit'
                 WHEN i.kind = 'raw' THEN 'inventory_raw' WHEN i.kind = 'packaging' THEN 'inventory_packaging' WHEN i.kind = 'semi_finished' THEN 'inventory_wip' ELSE 'inventory_fg' END AS role,
            sum(sb.value)::numeric(20,4)::text AS v
       FROM stock_balances sb JOIN warehouses w ON w.id = sb.warehouse_id JOIN items i ON i.id = sb.item_id
      WHERE w.branch_id IN (SELECT id FROM branches WHERE company_id = $1) GROUP BY 1`, [companyId])).rows;
  // work in progress: issued + conversion − returned − value already moved to finished goods, for orders not yet closed
  const wip = (await one(db,
    `SELECT coalesce(sum(CASE pe.kind WHEN 'issue' THEN pe.value WHEN 'conversion' THEN pe.value WHEN 'return' THEN -pe.value END), 0)::numeric(20,4)::text AS v
       FROM production_entries pe JOIN production_orders o ON o.id = pe.order_id WHERE o.company_id = $1 AND o.status IN ('released', 'in_progress')`, [companyId]));
  const stockByRole = new Map(inv.map((r: any) => [r.role, r.v as string]));
  const drawers = (await one(db,
    `SELECT coalesce(sum(s.opening_float + coalesce((SELECT sum(p.amount) FROM pos_payments p WHERE p.shift_id = s.id AND p.tender = 'cash'), 0)), 0)::numeric(20,4)::text AS v
       FROM pos_shifts s WHERE s.company_id = $1 AND s.status = 'open'`, [companyId])).v;

  const line = (key: string, ar: string, en: string, glv: string, sub: string, link: string, note?: { ar: string; en: string }) => {
    const diff = Math.round((Number(glv) - Number(sub)) * 10000) / 10000;
    return { key, ar, en, gl: glv, subledger: sub, difference: diff.toFixed(4), ok: Math.abs(diff) < 0.0005, link, note };
  };
  const rows = [
    line("ar", "ذمم العملاء", "Receivables", await gl(["ar"]), arSub, "/sales/aging"),
    line("ap", "ذمم الموردين", "Payables", await gl(["ap"]), apSub, "/purchasing/invoices"),
    line("customer_advances", "دفعات مقدمة من العملاء", "Customer advances", await gl(["customer_advances"]), advSub, "/sales/receipts",
      { ar: "الجزء غير الموزع من سندات القبض (رصيد دائن للعميل)", en: "Unallocated part of customer receipts (customer credit)" }),
  ];
  for (const [role, ar, en] of [["inventory_raw", "مخزون المواد الخام", "Raw materials"], ["inventory_packaging", "مواد التعبئة", "Packaging"], ["inventory_fg", "المنتجات التامة", "Finished goods"],
    ["inventory_van", "بضاعة بالسيارات", "Vans"], ["inventory_quarantine", "بضاعة بالحجر", "Quarantine"], ["inventory_transit", "بضاعة بالطريق", "In transit"]] as const)
    rows.push(line(role, ar, en, await gl([role]), stockByRole.get(role) ?? "0.0000", "/inventory/stock"));
  rows.push(line("inventory_wip", "إنتاج تحت التشغيل + نصف مصنع", "Work in progress + semi-finished", await gl(["inventory_wip"]),
    (Number(wip.v) + Number(stockByRole.get("inventory_wip") ?? 0)).toFixed(4), "/manufacturing/orders",
    { ar: "يشمل أوامر الإنتاج المفتوحة (صرف + تحويل − مرتجع) ورصيد الأصناف نصف المصنعة", en: "Open production orders (issued + conversion − returned) plus semi-finished stock" }));
  rows.push(line("pos_cash", "صناديق نقاط البيع", "POS drawers", await gl(["pos_cash"]), drawers, "/pos/shifts", { ar: "النقدية المتوقعة في الورديات المفتوحة", en: "Expected cash of open shifts" }));
  return { asOf, balanced: rows.every((r) => r.ok), rows };
}

// ------------------------------------------------------------------ readiness
export async function readiness(db: Db, u: UserCtx, companyId: string) {
  const has = (m: string) => u.modules.has(m);
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const today = new Date().toISOString().slice(0, 10);
  const sign = new Map((await db.query("SELECT item, approved_at, note, u.full_name FROM go_live_signoffs s JOIN users u ON u.id = s.approved_by WHERE s.company_id = $1 AND s.revoked_at IS NULL", [companyId])).rows
    .map((r: any) => [r.item, r]));

  // accounting
  const accounts = await n(db, "SELECT count(*) AS n FROM accounts WHERE company_id = $1", [companyId]);
  add({ key: "coa", area: "accounting", ar: "دليل الحسابات موجود", en: "Chart of accounts exists", status: accounts ? "ok" : "fail", detail: `${accounts}`, link: "/accounts" });
  const roles = new Set((await db.query("SELECT DISTINCT role FROM accounts WHERE company_id = $1 AND role IS NOT NULL AND is_active AND is_postable", [companyId])).rows.map((r: any) => r.role));
  const missing = REQUIRED_ROLES.filter((r) => !roles.has(r));
  add({ key: "coa_roles", area: "accounting", ar: "ربط الحسابات بأدوارها (المبيعات، الذمم، المخزون…)", en: "Posting roles mapped to accounts", status: missing.length ? "fail" : "ok",
    detail: missing.length ? missing.join(", ") : `${REQUIRED_ROLES.length}/${REQUIRED_ROLES.length}`, link: "/accounts" });
  const coaSign = sign.get("chart_of_accounts");
  add({ key: "coa_approved", area: "accounting", ar: "اعتماد المحاسب لدليل الحسابات", en: "Accountant approved the chart of accounts", status: coaSign ? "ok" : "fail",
    detail: coaSign ? `${coaSign.full_name} · ${String(coaSign.approved_at).slice(0, 10)}` : "—", link: "/go-live" });
  const fy = await n(db, "SELECT count(*) AS n FROM fiscal_periods WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date AND status = 'open'", [companyId, today]);
  add({ key: "fiscal", area: "accounting", ar: "سنة مالية وفترة مفتوحة لتاريخ اليوم", en: "Open fiscal period for today", status: fy ? "ok" : "fail", detail: today, link: "/periods" });

  // organisation & master data
  const wh = (await one(db, `SELECT count(*) FILTER (WHERE is_sellable)::int AS sellable, count(*) FILTER (WHERE kind = 'quarantine')::int AS quarantine, count(*) FILTER (WHERE kind = 'raw_materials')::int AS raw
      FROM warehouses WHERE branch_id IN (SELECT id FROM branches WHERE company_id = $1)`, [companyId]));
  add({ key: "warehouses", area: "organisation", ar: "مخازن: صالح للبيع + حجر/فحص + خامات", en: "Warehouses: sellable + quarantine + raw", status: wh.sellable && wh.quarantine && wh.raw ? "ok" : "fail",
    detail: `${wh.sellable} / ${wh.quarantine} / ${wh.raw}`, link: "/organization" });
  const users = await n(db, "SELECT count(*) AS n FROM users WHERE is_active", []);
  add({ key: "users", area: "organisation", ar: "مستخدمون بأدوارهم", en: "Users with roles", status: users > 1 ? "ok" : "warn", detail: `${users}`, link: "/users" });
  const privNoMfa = await n(db, `SELECT count(DISTINCT u.id) AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active AND NOT u.mfa_enabled AND r.code IN ('tenant_owner', 'company_admin', 'finance_manager', 'accountant')`, []);
  add({ key: "mfa", area: "organisation", ar: "التحقق الثنائي للأدوار المالية والإدارية", en: "MFA for finance & admin roles", status: privNoMfa ? "warn" : "ok", detail: privNoMfa ? `${privNoMfa} بدون تحقق ثنائي` : "✓", link: "/users" });
  const items = await one(db, `SELECT count(*) FILTER (WHERE kind = 'finished')::int AS fg, count(*) FILTER (WHERE kind IN ('raw', 'packaging'))::int AS rm,
      count(*) FILTER (WHERE kind = 'finished' AND sales_price IS NULL)::int AS no_price, count(*) FILTER (WHERE kind = 'finished' AND track_lots AND shelf_life_days IS NULL)::int AS no_life
      FROM items WHERE company_id = $1 AND is_active`, [companyId]);
  add({ key: "items", area: "master_data", ar: "الأصناف: منتجات تامة ومواد", en: "Items: finished goods & materials", status: items.fg && items.rm ? "ok" : "fail", detail: `${items.fg} / ${items.rm}`, link: "/inventory/items" });
  add({ key: "prices", area: "master_data", ar: "أسعار بيع للمنتجات التامة", en: "Sales prices for finished goods", status: items.no_price ? "warn" : items.fg ? "ok" : "na", detail: items.no_price ? `${items.no_price} بدون سعر` : "✓", link: "/inventory/items" });
  add({ key: "shelf_life", area: "master_data", ar: "مدة صلاحية للمنتجات المتتبعة بالتشغيلة", en: "Shelf life on lot-tracked products", status: items.no_life ? "warn" : items.fg ? "ok" : "na", detail: items.no_life ? `${items.no_life}` : "✓", link: "/inventory/items" });
  const parties = await one(db, `SELECT count(*) FILTER (WHERE kind IN ('customer', 'both'))::int AS c, count(*) FILTER (WHERE kind IN ('supplier', 'both'))::int AS s FROM parties WHERE company_id = $1`, [companyId]);
  add({ key: "customers", area: "master_data", ar: "العملاء", en: "Customers", status: parties.c ? "ok" : "fail", detail: `${parties.c}`, link: "/customers" });
  add({ key: "suppliers", area: "master_data", ar: "الموردون", en: "Suppliers", status: parties.s ? "ok" : "warn", detail: `${parties.s}`, link: "/suppliers" });

  if (has("manufacturing")) {
    const noBom = await n(db, `SELECT count(*) AS n FROM items i WHERE i.company_id = $1 AND i.kind = 'finished' AND i.is_active AND NOT EXISTS (SELECT 1 FROM boms b WHERE b.item_id = i.id AND b.status = 'approved')`, [companyId]);
    add({ key: "boms", area: "manufacturing", ar: "وصفات معتمدة لكل منتج تام", en: "Approved formula for each finished product", status: !items.fg ? "na" : noBom ? "fail" : "ok", detail: noBom ? `${noBom} بدون وصفة معتمدة` : "✓", link: "/manufacturing/boms" });
  }
  if (has("quality")) {
    const noSpec = await n(db, `SELECT count(*) AS n FROM items i WHERE i.company_id = $1 AND i.kind = 'finished' AND i.is_active AND NOT EXISTS (SELECT 1 FROM quality_specs q WHERE q.item_id = i.id)`, [companyId]);
    add({ key: "specs", area: "quality", ar: "مواصفات جودة للمنتجات التامة", en: "Quality specs for finished goods", status: !items.fg ? "na" : noSpec ? "warn" : "ok", detail: noSpec ? `${noSpec}` : "✓", link: "/quality/specs" });
  }
  if (has("distribution")) {
    const reps = await n(db, "SELECT count(*) AS n FROM sales_reps WHERE company_id = $1 AND is_active", [companyId]);
    add({ key: "reps", area: "distribution", ar: "المناديب وسياراتهم", en: "Sales reps with vans", status: reps ? "ok" : "warn", detail: `${reps}`, link: "/distribution/reps" });
  }
  if (has("hr")) {
    const emp = await n(db, "SELECT count(*) AS n FROM employees WHERE company_id = $1 AND status = 'active'", [companyId]);
    const dev = await n(db, "SELECT count(*) AS n FROM attendance_devices WHERE company_id = $1 AND is_active", [companyId]);
    add({ key: "employees", area: "hr", ar: "الموظفون", en: "Employees", status: emp ? "ok" : "warn", detail: `${emp}`, link: "/hr/employees" });
    add({ key: "devices", area: "hr", ar: "أجهزة البصمة مسجلة", en: "Fingerprint devices registered", status: dev ? "ok" : "warn", detail: `${dev}`, link: "/hr/employees" });
  }

  // opening balances & integrity
  const opening = await one(db, `SELECT (SELECT count(*) FROM stock_documents WHERE company_id = $1 AND reason = 'opening' AND status = 'posted')::int AS stock,
      (SELECT count(*) FROM stock_documents WHERE company_id = $1 AND reason = 'opening' AND status = 'draft')::int AS stock_draft,
      (SELECT count(*) FROM sales_invoices WHERE company_id = $1 AND is_opening AND status = 'draft')::int + (SELECT count(*) FROM supplier_invoices WHERE company_id = $1 AND is_opening AND status = 'draft')::int AS docs_draft,
      (SELECT count(*) FROM journal_entries WHERE company_id = $1 AND status = 'draft')::int AS je_draft`, [companyId]);
  add({ key: "opening_stock", area: "opening", ar: "أرصدة المخزون الافتتاحية مرحّلة", en: "Opening stock posted", status: opening.stock_draft ? "warn" : opening.stock ? "ok" : "fail",
    detail: `${opening.stock}${opening.stock_draft ? ` (+${opening.stock_draft} مسودة)` : ""}`, link: "/inventory/documents" });
  add({ key: "opening_docs", area: "opening", ar: "أرصدة العملاء والموردين الافتتاحية مرحّلة", en: "Opening customer/supplier balances posted", status: opening.docs_draft ? "warn" : "ok",
    detail: opening.docs_draft ? `${opening.docs_draft} مسودة بانتظار الترحيل` : "✓", link: "/go-live" });
  add({ key: "drafts", area: "opening", ar: "لا قيود مسودة معلقة", en: "No pending draft entries", status: opening.je_draft ? "warn" : "ok", detail: `${opening.je_draft}`, link: "/journal?status=draft" });
  const rec = await reconciliation(db, companyId, today);
  add({ key: "reconciliation", area: "opening", ar: "مطابقة الأستاذ المساعد مع الأستاذ العام", en: "Subledgers agree with the GL", status: rec.balanced ? "ok" : "fail",
    detail: rec.balanced ? "✓" : rec.rows.filter((r) => !r.ok).map((r) => `${r.en}: ${r.difference}`).join("; "), link: "/go-live" });
  for (const [item, ar, en] of [["opening_balances", "اعتماد الأرصدة الافتتاحية", "Opening balances signed off"], ["uat", "اعتماد اختبارات القبول", "UAT signed off"]] as const) {
    const s = sign.get(item);
    add({ key: `signoff_${item}`, area: "signoff", ar, en, status: s ? "ok" : "fail", detail: s ? `${s.full_name} · ${String(s.approved_at).slice(0, 10)}` : "—", link: "/go-live" });
  }
  const blocking = checks.filter((c) => c.status === "fail").length, warnings = checks.filter((c) => c.status === "warn").length;
  const scored = checks.filter((c) => c.status !== "na");
  return { ready: blocking === 0, blocking, warnings, score: Math.round((scored.filter((c) => c.status === "ok").length / (scored.length || 1)) * 100), checks, signoffs: [...sign.entries()].map(([item, s]) => ({ item, ...s })) };
}

// ------------------------------------------------------------------ opening documents
/** posts every imported opening receivable/payable draft: Dr AR / Cr opening equity, Dr opening equity / Cr AP. Importer ≠ poster. */
/** `cutoverDate`: GL date of the opening entries; each document keeps its original date for ageing */
export async function postOpeningDocuments(db: Db, u: UserCtx, companyId: string, cutoverDate: string) {
  const sales = (await db.query("SELECT * FROM sales_invoices WHERE company_id = $1 AND is_opening AND status = 'draft' ORDER BY invoice_date FOR UPDATE", [companyId])).rows;
  const supp = (await db.query("SELECT * FROM supplier_invoices WHERE company_id = $1 AND is_opening AND status = 'draft' ORDER BY invoice_date FOR UPDATE", [companyId])).rows;
  if (!sales.length && !supp.length) throw E.rule("NOTHING_TO_POST", "لا توجد أرصدة افتتاحية مسودة", "No draft opening balances");
  if (u.enforceSod && [...sales, ...supp].some((d) => d.created_by === u.userId)) throw E.sod();
  let total = 0;
  for (const d of sales) {
    const number = await docNumber(db, u, companyId, "OB", cutoverDate);
    const je = await postJournal(db, u, { companyId, date: cutoverDate, memo: `رصيد افتتاحي للعميل ${number}${d.opening_reference ? ` (${d.opening_reference})` : ""}`, sourceType: "opening_receivable", sourceId: d.id,
      parts: [{ role: "ar", amount: d.total }, { role: "opening_balance", amount: `-${d.total}` }] });
    await markPosted(db, u, "sales_invoices", d.id, number, je);
    total += Number(d.total);
  }
  for (const d of supp) {
    const number = await docNumber(db, u, companyId, "OBS", cutoverDate);
    const je = await postJournal(db, u, { companyId, date: cutoverDate, memo: `رصيد افتتاحي للمورد ${number} (${d.supplier_invoice_no})`, sourceType: "opening_payable", sourceId: d.id,
      parts: [{ role: "opening_balance", amount: d.total }, { role: "ap", amount: `-${d.total}` }] });
    await markPosted(db, u, "supplier_invoices", d.id, number, je);
  }
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "golive.opening_documents_posted", entityType: "company", entityId: companyId, after: { receivables: sales.length, payables: supp.length } });
  return { receivables: sales.length, payables: supp.length, receivablesTotal: total.toFixed(4) };
}

// ------------------------------------------------------------------ sign-offs
const SIGNOFF_PERMISSION: Record<string, string> = { chart_of_accounts: "accounting.accounts.manage", opening_balances: "accounting.journal.post", uat: "core.golive.manage", go_live: "core.golive.manage" };
export async function signOff(db: Db, u: UserCtx, companyId: string, item: string, note?: string) {
  const perm = SIGNOFF_PERMISSION[item];
  if (!u.permissions.has(perm)) throw E.forbidden(perm);
  let evidence: unknown = null;
  if (item === "opening_balances") {
    const rec = await reconciliation(db, companyId, new Date().toISOString().slice(0, 10));
    if (!rec.balanced) throw E.rule("RECONCILIATION_FAILED", "لا يمكن اعتماد الأرصدة الافتتاحية والأستاذ المساعد لا يطابق الأستاذ العام", "Opening balances cannot be signed off while subledgers disagree with the GL", rec.rows.filter((r) => !r.ok));
    evidence = rec;
  }
  if (item === "go_live") {
    const r = await readiness(db, u, companyId);
    const blocking = r.checks.filter((c) => c.status === "fail" && c.key !== "signoff_go_live");
    if (blocking.length) throw E.rule("NOT_READY", `يوجد ${blocking.length} بند غير جاهز`, `${blocking.length} blocking item(s)`, blocking.map((c) => c.key));
    evidence = { score: r.score, warnings: r.warnings };
  }
  const r = (await db.query(`INSERT INTO go_live_signoffs (tenant_id, company_id, item, approved_by, note, evidence) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [u.tenantId, companyId, item, u.userId, note ?? null, evidence ? JSON.stringify(evidence) : null])).rows[0];
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: `golive.signoff_${item}`, entityType: "company", entityId: companyId, after: { note } });
  return r;
}
export async function revokeSignOff(db: Db, u: UserCtx, companyId: string, item: string, reason: string) {
  const perm = SIGNOFF_PERMISSION[item];
  if (!u.permissions.has(perm)) throw E.forbidden(perm);
  const r = await db.query("UPDATE go_live_signoffs SET revoked_at = now(), revoked_by = $3 WHERE company_id = $1 AND item = $2 AND revoked_at IS NULL RETURNING id", [companyId, item, u.userId]);
  if (!r.rowCount) throw E.notFound("go_live_signoffs");
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: `golive.signoff_revoked_${item}`, entityType: "company", entityId: companyId, after: { reason } });
  return { revoked: true };
}
