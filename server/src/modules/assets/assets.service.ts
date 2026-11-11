// Fixed assets & maintenance (Phase 6a).
// Money is computed in PostgreSQL numeric and rounded to the currency's minor
// units, so the subledger (asset accumulated depreciation) always equals the GL.
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { postAccounts, postableAccount, accountByRole, inventoryRole, minorUnits, docNumber, itemUom } from "../erp/common.js";
import { stockOut } from "../erp/stock.js";

const ev = (db: Db, u: UserCtx, action: string, entityType: string, entityId: string, after?: unknown) =>
  audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action, entityType, entityId, after });

// ------------------------------------------------------------------ categories
export async function createCategory(db: Db, u: UserCtx, b: { companyId: string; code: string; nameAr: string; nameEn?: string; method: string; usefulLifeMonths: number; residualPct: string;
  assetAccountId: string; accumAccountId: string; expenseAccountId: string; maintenanceAccountId?: string | null }) {
  await postableAccount(db, b.companyId, b.assetAccountId, "assetAccountId", ["asset"]);
  await postableAccount(db, b.companyId, b.accumAccountId, "accumAccountId", ["asset"]);   // contra-asset
  await postableAccount(db, b.companyId, b.expenseAccountId, "expenseAccountId", ["expense"]);
  if (b.maintenanceAccountId) await postableAccount(db, b.companyId, b.maintenanceAccountId, "maintenanceAccountId", ["expense"]);
  const r = (await db.query(
    `INSERT INTO asset_categories (tenant_id, company_id, code, name_ar, name_en, method, useful_life_months, residual_pct, asset_account_id, accum_account_id, expense_account_id, maintenance_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [u.tenantId, b.companyId, b.code, b.nameAr, b.nameEn ?? null, b.method, b.usefulLifeMonths, b.residualPct, b.assetAccountId, b.accumAccountId, b.expenseAccountId, b.maintenanceAccountId ?? null])).rows[0];
  await ev(db, u, "asset_category.created", "asset_category", r.id, r);
  return r;
}

// ------------------------------------------------------------------ asset cards
export interface AssetInput {
  companyId: string; categoryId: string; code: string; nameAr: string; nameEn?: string; kind: string; branchId?: string | null; serialNo?: string; manufacturer?: string; model?: string;
  location?: string; workCenterId?: string | null; warehouseId?: string | null; acquisitionDate: string; inServiceDate?: string; cost: string; residualValue?: string;
  usefulLifeMonths?: number; method?: string; openingAccumulated?: string; openingMonthsUsed?: number; fundingAccountId?: string | null; notes?: string;
}

export async function createAsset(db: Db, u: UserCtx, b: AssetInput) {
  const c = (await db.query("SELECT * FROM asset_categories WHERE id = $1 AND company_id = $2", [b.categoryId, b.companyId])).rows[0];
  if (!c) throw E.validation([{ path: "categoryId", message: "category not found in this company" }]);
  if (b.fundingAccountId) await postableAccount(db, b.companyId, b.fundingAccountId, "fundingAccountId", undefined, { noControl: true });
  const m = await minorUnits(db, b.companyId);
  const residual = b.residualValue ?? (await db.query("SELECT round($1::numeric * $2::numeric / 100, $3)::text AS r", [b.cost, c.residual_pct, m])).rows[0].r;
  const r = (await db.query(
    `INSERT INTO fixed_assets (tenant_id, company_id, branch_id, category_id, code, name_ar, name_en, kind, serial_no, manufacturer, model, location, work_center_id, warehouse_id,
       acquisition_date, in_service_date, cost, residual_value, useful_life_months, method, opening_accumulated, opening_months_used, funding_account_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
    [u.tenantId, b.companyId, b.branchId ?? null, b.categoryId, b.code, b.nameAr, b.nameEn ?? null, b.kind, b.serialNo ?? null, b.manufacturer ?? null, b.model ?? null, b.location ?? null,
      b.workCenterId ?? null, b.warehouseId ?? null, b.acquisitionDate, b.inServiceDate ?? b.acquisitionDate, b.cost, residual, b.usefulLifeMonths ?? c.useful_life_months,
      b.method ?? c.method, b.openingAccumulated ?? "0", b.openingMonthsUsed ?? 0, b.fundingAccountId ?? null, b.notes ?? null, u.userId])).rows[0];
  await ev(db, u, "asset.created", "fixed_asset", r.id, r);
  return r;
}

/**
 * Capitalization: Dr asset cost / Cr accumulated depreciation brought forward
 * (assets already in use at go-live) / Cr funding account for the rest.
 * Creator ≠ poster when segregation of duties is enforced.
 */
export async function capitalize(db: Db, u: UserCtx, id: string, b: { fundingAccountId?: string; postingDate?: string }) {
  const a = (await db.query("SELECT a.*, c.asset_account_id, c.accum_account_id FROM fixed_assets a JOIN asset_categories c ON c.id = a.category_id WHERE a.id = $1 FOR UPDATE OF a", [id])).rows[0];
  if (!a) throw E.notFound("fixed_assets");
  if (a.status !== "draft") throw E.rule("ALREADY_POSTED", "الأصل مرسمل مسبقًا", "Asset is already capitalized");
  if (u.enforceSod && a.created_by === u.userId) throw E.sod();
  const funding = b.fundingAccountId ?? a.funding_account_id;
  if (!funding) throw E.validation([{ path: "fundingAccountId", message: "required: the account credited for the asset (supplier, bank, opening balance…)" }]);
  await postableAccount(db, a.company_id, funding, "fundingAccountId", undefined, { noControl: true });
  const date = b.postingDate ?? String(a.acquisition_date);
  const net = (await db.query("SELECT ($1::numeric - $2::numeric)::text AS n", [a.cost, a.opening_accumulated])).rows[0].n;
  const je = await postAccounts(db, u, { companyId: a.company_id, date, memo: `رسملة الأصل ${a.code} — ${a.name_ar}`, sourceType: "asset_capitalization", sourceId: a.id, parts: [
    { accountId: a.asset_account_id, amount: a.cost, description: `تكلفة ${a.code}` },
    { accountId: a.accum_account_id, amount: `-${a.opening_accumulated}`, description: "إهلاك متراكم مرحّل" },
    { accountId: funding, amount: `-${net}` },
  ] });
  await db.query(`UPDATE fixed_assets SET status = 'active', funding_account_id = $2, journal_entry_id = $3, accumulated_depreciation = opening_accumulated,
     months_depreciated = opening_months_used, posted_by = $4, posted_at = now() WHERE id = $1`, [id, funding, je, u.userId]);
  await ev(db, u, "asset.capitalized", "fixed_asset", id, { journalEntryId: je });
  return getAsset(db, id);
}

export async function getAsset(db: Db, id: string) {
  const a = (await db.query(
    `SELECT a.*, c.code AS category_code, c.name_ar AS category_name_ar, (a.cost - a.accumulated_depreciation)::numeric(20,4)::text AS book_value,
            (a.cost - a.residual_value - a.accumulated_depreciation)::numeric(20,4)::text AS remaining_depreciable
       FROM fixed_assets a JOIN asset_categories c ON c.id = a.category_id WHERE a.id = $1`, [id])).rows[0];
  if (!a) throw E.notFound("fixed_assets");
  return a;
}

/** life history of an asset: capitalization, every depreciation month, every maintenance order, disposal */
export async function assetHistory(db: Db, id: string) {
  const asset = await getAsset(db, id);
  const depreciation = (await db.query(
    `SELECT l.period, l.amount, l.accumulated_after, l.book_value_after, r.number AS run_number, r.status FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id
      WHERE l.asset_id = $1 ORDER BY l.period`, [id])).rows;
  const maintenance = (await db.query(
    `SELECT id, number, kind, priority, status, description, failure_code, reported_at, completion_date, downtime_minutes, parts_cost, external_cost, total_cost
       FROM maintenance_orders WHERE asset_id = $1 ORDER BY reported_at`, [id])).rows;
  const totals = (await db.query(
    `SELECT count(*) FILTER (WHERE kind = 'corrective' AND status <> 'cancelled')::int AS breakdowns, coalesce(sum(downtime_minutes) FILTER (WHERE status = 'completed'), 0)::int AS downtime_minutes,
            coalesce(sum(total_cost) FILTER (WHERE status = 'completed'), 0)::numeric(20,4)::text AS maintenance_cost FROM maintenance_orders WHERE asset_id = $1`, [id])).rows[0];
  return { asset, depreciation, maintenance, totals };
}

// ------------------------------------------------------------------ depreciation
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;

/**
 * Prepares (or re-prepares) the draft depreciation run of a month. Runs are
 * sequential: after the first posted run, the next one must be the following
 * month — a month can be neither skipped nor depreciated twice.
 *
 * Convention (documented): depreciation starts in the month AFTER the
 * in-service month. Straight line spreads the remaining depreciable amount
 * evenly over the remaining months (exact at the end, no rounding residue);
 * declining balance uses twice the straight-line rate on book value and
 * switches to straight line when that becomes larger.
 */
export async function prepareRun(db: Db, u: UserCtx, b: { companyId: string; period: string }) {
  const period = monthStart(b.period);
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dep:${b.companyId}`]);
  const last = (await db.query("SELECT max(period)::text AS p FROM depreciation_runs WHERE company_id = $1 AND status = 'posted'", [b.companyId])).rows[0].p as string | null;
  if (last) {
    const next = (await db.query("SELECT ($1::date + interval '1 month')::date::text AS n", [last])).rows[0].n;
    if (period <= last) throw E.rule("PERIOD_ALREADY_DEPRECIATED", `تم ترحيل الإهلاك حتى ${last.slice(0, 7)}`, `Depreciation is already posted up to ${last.slice(0, 7)}`);
    if (period !== next) throw E.rule("DEPRECIATION_GAP", `يجب إعداد إهلاك ${next.slice(0, 7)} أولًا`, `Depreciation for ${next.slice(0, 7)} must be run first`, { expected: next });
  }
  await db.query("DELETE FROM depreciation_runs WHERE company_id = $1 AND period = $2 AND status = 'draft'", [b.companyId, period]);
  const run = (await db.query("INSERT INTO depreciation_runs (tenant_id, company_id, period, created_by) VALUES ($1,$2,$3,$4) RETURNING *", [u.tenantId, b.companyId, period, u.userId])).rows[0];
  const m = await minorUnits(db, b.companyId);
  const assets = (await db.query(
    `SELECT * FROM fixed_assets WHERE company_id = $1 AND status = 'active' AND date_trunc('month', in_service_date) < $2::date
        AND months_depreciated < useful_life_months AND cost - residual_value - accumulated_depreciation > 0 ORDER BY code`, [b.companyId, period])).rows;
  for (const a of assets) {
    const amount: string = (await db.query(
      `WITH x AS (SELECT $1::numeric AS cost, $2::numeric AS residual, $3::numeric AS acc, $4::int AS life, $5::int AS used, $6::text AS method, $7::int AS m),
            y AS (SELECT *, cost - residual - acc AS left_, life - used AS rem FROM x),
            z AS (SELECT *, round(left_ / greatest(rem, 1), m) AS sl, round((cost - acc) * 2 / life, m) AS ddb FROM y)
       SELECT (CASE WHEN rem <= 1 THEN left_ WHEN method = 'declining_balance' THEN least(greatest(ddb, sl), left_) ELSE least(sl, left_) END)::numeric(20,4)::text AS amount FROM z`,
      [a.cost, a.residual_value, a.accumulated_depreciation, a.useful_life_months, a.months_depreciated, a.method, m])).rows[0].amount;
    if (Number(amount) <= 0) continue;
    await db.query(
      `INSERT INTO depreciation_lines (tenant_id, run_id, asset_id, period, amount, accumulated_before, accumulated_after, book_value_after)
       VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$6::numeric + $5::numeric,$7::numeric - $6::numeric - $5::numeric)`,
      [u.tenantId, run.id, a.id, period, amount, a.accumulated_depreciation, a.cost]);
  }
  await db.query("UPDATE depreciation_runs SET total = (SELECT coalesce(sum(amount), 0) FROM depreciation_lines WHERE run_id = $1) WHERE id = $1", [run.id]);
  await ev(db, u, "depreciation.prepared", "depreciation_run", run.id, { period });
  return getRun(db, run.id);
}

export async function getRun(db: Db, id: string) {
  const run = (await db.query("SELECT * FROM depreciation_runs WHERE id = $1", [id])).rows[0];
  if (!run) throw E.notFound("depreciation_runs");
  const lines = (await db.query(
    `SELECT l.*, a.code, a.name_ar, c.code AS category_code FROM depreciation_lines l JOIN fixed_assets a ON a.id = l.asset_id JOIN asset_categories c ON c.id = a.category_id
      WHERE l.run_id = $1 ORDER BY a.code`, [id])).rows;
  return { ...run, lines };
}

/** Posts the run: Dr depreciation expense / Cr accumulated depreciation, per category account. */
export async function postRun(db: Db, u: UserCtx, id: string) {
  const run = (await db.query("SELECT * FROM depreciation_runs WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!run) throw E.notFound("depreciation_runs");
  if (run.status !== "draft") throw E.rule("ALREADY_POSTED", "المستند مرحّل مسبقًا", "Document is already posted");
  if (u.enforceSod && run.created_by === u.userId) throw E.sod();
  const lines = (await db.query(
    `SELECT l.*, a.code, a.status AS asset_status, a.accumulated_depreciation AS current_acc, c.expense_account_id, c.accum_account_id
       FROM depreciation_lines l JOIN fixed_assets a ON a.id = l.asset_id JOIN asset_categories c ON c.id = a.category_id WHERE l.run_id = $1 FOR UPDATE OF a`, [id])).rows;
  for (const l of lines) {
    const same = (await db.query("SELECT $1::numeric = $2::numeric AS s", [l.current_acc, l.accumulated_before])).rows[0].s;
    if (l.asset_status !== "active" || !same)
      throw E.rule("STALE_DEPRECIATION_RUN", `تغيّر الأصل ${l.code} بعد إعداد الدورة — أعد إعدادها`, `Asset ${l.code} changed after the run was prepared — prepare it again`);
  }
  const lastDay = (await db.query("SELECT ($1::date + interval '1 month' - interval '1 day')::date::text AS d", [run.period])).rows[0].d;
  const je = await postAccounts(db, u, { companyId: run.company_id, date: lastDay, memo: `إهلاك الأصول الثابتة لشهر ${String(run.period).slice(0, 7)}`, sourceType: "depreciation_run", sourceId: run.id,
    parts: lines.flatMap((l) => [{ accountId: l.expense_account_id, amount: l.amount }, { accountId: l.accum_account_id, amount: `-${l.amount}` }]) });
  for (const l of lines)
    await db.query("UPDATE fixed_assets SET accumulated_depreciation = accumulated_depreciation + $2::numeric, months_depreciated = months_depreciated + 1 WHERE id = $1", [l.asset_id, l.amount]);
  const number = await docNumber(db, u, run.company_id, "DEP", lastDay);
  await db.query("UPDATE depreciation_runs SET status = 'posted', number = $2, journal_entry_id = $3, posted_by = $4, posted_at = now() WHERE id = $1", [id, number, je, u.userId]);
  await ev(db, u, "depreciation.posted", "depreciation_run", id, { number, journalEntryId: je, total: run.total });
  return getRun(db, id);
}

/**
 * Disposal / sale: Dr accumulated depreciation, Dr proceeds account, Cr asset
 * cost; the difference is a loss (Dr) or gain (Cr) on the chosen account.
 * Depreciation must already be posted up to the month before the disposal.
 */
export async function dispose(db: Db, u: UserCtx, id: string, b: { date: string; proceeds: string; proceedsAccountId?: string | null; gainLossAccountId?: string | null; reason: string }) {
  const a = (await db.query("SELECT a.*, c.asset_account_id, c.accum_account_id FROM fixed_assets a JOIN asset_categories c ON c.id = a.category_id WHERE a.id = $1 FOR UPDATE OF a", [id])).rows[0];
  if (!a) throw E.notFound("fixed_assets");
  if (a.status !== "active") throw E.rule("ASSET_NOT_ACTIVE", "لا يمكن استبعاد أصل غير مرسمل أو مستبعد مسبقًا", "Only an active (capitalized) asset can be disposed of");
  if (b.date < String(a.in_service_date)) throw E.validation([{ path: "date", message: "before the in-service date" }]);
  const later = (await db.query("SELECT 1 FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id WHERE l.asset_id = $1 AND l.period >= $2::date AND r.status = 'posted'", [id, monthStart(b.date)])).rowCount;
  if (later) throw E.rule("DEPRECIATED_AFTER_DISPOSAL", "يوجد إهلاك مرحّل لشهر الاستبعاد أو بعده", "Depreciation is already posted for the disposal month or later");
  const draft = (await db.query("SELECT 1 FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id WHERE l.asset_id = $1 AND r.status = 'draft'", [id])).rowCount;
  if (draft) throw E.rule("DRAFT_DEPRECIATION_PENDING", "الأصل ضمن دورة إهلاك غير مرحّلة — رحّلها أو احذفها أولًا", "The asset is in an unposted depreciation run — post or delete it first");
  if (Number(b.proceeds) > 0) {
    if (!b.proceedsAccountId) throw E.validation([{ path: "proceedsAccountId", message: "required when there are proceeds" }]);
    await postableAccount(db, a.company_id, b.proceedsAccountId, "proceedsAccountId", ["asset"], { noControl: true });
  }
  const diff = (await db.query("SELECT ($1::numeric - $2::numeric - $3::numeric)::text AS d", [a.cost, a.accumulated_depreciation, b.proceeds])).rows[0].d; // >0 loss, <0 gain
  if (Number(diff) !== 0) {
    if (!b.gainLossAccountId) throw E.validation([{ path: "gainLossAccountId", message: "required: book value differs from proceeds" }]);
    await postableAccount(db, a.company_id, b.gainLossAccountId, "gainLossAccountId", ["revenue", "expense"]);
  }
  const parts = [
    { accountId: a.accum_account_id, amount: a.accumulated_depreciation, description: "إقفال الإهلاك المتراكم" },
    { accountId: a.asset_account_id, amount: `-${a.cost}`, description: "إقفال تكلفة الأصل" },
  ];
  if (Number(b.proceeds) > 0) parts.push({ accountId: b.proceedsAccountId!, amount: b.proceeds, description: "متحصلات البيع" });
  if (Number(diff) !== 0) parts.push({ accountId: b.gainLossAccountId!, amount: diff, description: Number(diff) > 0 ? "خسارة استبعاد" : "ربح استبعاد" });
  const je = await postAccounts(db, u, { companyId: a.company_id, date: b.date, memo: `استبعاد الأصل ${a.code}: ${b.reason}`, sourceType: "asset_disposal", sourceId: a.id, parts });
  await db.query(`UPDATE fixed_assets SET status = 'disposed', disposal_date = $2, disposal_proceeds = $3, disposal_reason = $4, disposal_journal_id = $5 WHERE id = $1`,
    [id, b.date, b.proceeds, b.reason, je]);
  await db.query("UPDATE maintenance_plans SET is_active = false WHERE asset_id = $1", [id]);
  await ev(db, u, "asset.disposed", "fixed_asset", id, { date: b.date, proceeds: b.proceeds, gainLoss: diff, journalEntryId: je });
  return getAsset(db, id);
}

// ------------------------------------------------------------------ maintenance
export async function createPlan(db: Db, u: UserCtx, b: { assetId: string; nameAr: string; intervalDays: number; firstDueDate: string; checklist?: string }) {
  const a = (await db.query("SELECT company_id, status FROM fixed_assets WHERE id = $1", [b.assetId])).rows[0];
  if (!a) throw E.validation([{ path: "assetId", message: "asset not found" }]);
  if (a.status === "disposed") throw E.rule("ASSET_DISPOSED", "الأصل مستبعد", "Asset is disposed");
  const r = (await db.query(
    `INSERT INTO maintenance_plans (tenant_id, company_id, asset_id, name_ar, interval_days, next_due_date, checklist, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [u.tenantId, a.company_id, b.assetId, b.nameAr, b.intervalDays, b.firstDueDate, b.checklist ?? null, u.userId])).rows[0];
  await ev(db, u, "maintenance_plan.created", "maintenance_plan", r.id, r);
  return r;
}

/** creates one preventive order per due plan; idempotent (a plan never has two open orders) */
export async function generateDueOrders(db: Db, u: UserCtx, b: { companyId: string; asOf: string }) {
  const due = (await db.query(
    `SELECT p.*, a.code AS asset_code FROM maintenance_plans p JOIN fixed_assets a ON a.id = p.asset_id
      WHERE p.company_id = $1 AND p.is_active AND a.status <> 'disposed' AND p.next_due_date <= $2::date
        AND NOT EXISTS (SELECT 1 FROM maintenance_orders o WHERE o.plan_id = p.id AND o.status IN ('open', 'in_progress')) ORDER BY p.next_due_date`, [b.companyId, b.asOf])).rows;
  const created = [];
  for (const p of due) {
    const number = await docNumber(db, u, b.companyId, "WO", b.asOf);
    const r = (await db.query(
      `INSERT INTO maintenance_orders (tenant_id, company_id, number, asset_id, plan_id, kind, description, created_by)
       VALUES ($1,$2,$3,$4,$5,'preventive',$6,$7) ON CONFLICT (plan_id) WHERE status IN ('open', 'in_progress') DO NOTHING RETURNING *`,
      [u.tenantId, b.companyId, number, p.asset_id, p.id, `${p.name_ar} (استحقاق ${String(p.next_due_date).slice(0, 10)})${p.checklist ? ` — ${p.checklist}` : ""}`, u.userId])).rows[0];
    if (r) created.push(r);
  }
  return created;
}

export async function createOrder(db: Db, u: UserCtx, b: { assetId: string; kind: "corrective"; priority: string; description: string; failureCode?: string; warehouseId?: string | null;
  parts?: { itemId: string; uomId?: string | null; qty: string }[] }) {
  const a = (await db.query("SELECT company_id, status, code FROM fixed_assets WHERE id = $1", [b.assetId])).rows[0];
  if (!a) throw E.validation([{ path: "assetId", message: "asset not found" }]);
  if (a.status === "disposed") throw E.rule("ASSET_DISPOSED", "الأصل مستبعد", "Asset is disposed");
  const number = await docNumber(db, u, a.company_id, "WO", new Date().toISOString().slice(0, 10));
  const o = (await db.query(
    `INSERT INTO maintenance_orders (tenant_id, company_id, number, asset_id, kind, priority, description, failure_code, warehouse_id, created_by)
     VALUES ($1,$2,$3,$4,'corrective',$5,$6,$7,$8,$9) RETURNING *`,
    [u.tenantId, a.company_id, number, b.assetId, b.priority, b.description, b.failureCode ?? null, b.warehouseId ?? null, u.userId])).rows[0];
  if (b.parts?.length) await setParts(db, u, o.id, { warehouseId: b.warehouseId ?? null, parts: b.parts });
  await ev(db, u, "maintenance_order.created", "maintenance_order", o.id, { number, asset: a.code, kind: "corrective" });
  return getOrder(db, o.id);
}

export async function setParts(db: Db, u: UserCtx, id: string, b: { warehouseId: string | null; parts: { itemId: string; uomId?: string | null; qty: string }[] }) {
  const o = (await db.query("SELECT * FROM maintenance_orders WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!o) throw E.notFound("maintenance_orders");
  if (b.parts.length && !b.warehouseId) throw E.validation([{ path: "warehouseId", message: "required to issue spare parts" }]);
  await db.query("DELETE FROM maintenance_parts WHERE order_id = $1", [id]);
  for (const p of b.parts) {
    const { item, uomId, factor } = await itemUom(db, p.itemId, p.uomId);
    if (item.company_id !== o.company_id) throw E.validation([{ path: "parts.itemId", message: "item of another company" }]);
    if (item.kind === "service") throw E.validation([{ path: "parts.itemId", message: `${item.code} is a service item` }]);
    await db.query("INSERT INTO maintenance_parts (tenant_id, order_id, item_id, uom_id, qty, base_qty) VALUES ($1,$2,$3,$4,$5::numeric,$5::numeric * $6::numeric)",
      [u.tenantId, id, p.itemId, uomId, p.qty, factor]);
  }
  await db.query("UPDATE maintenance_orders SET warehouse_id = $2 WHERE id = $1", [id, b.warehouseId]);
  return getOrder(db, id);
}

export async function startOrder(db: Db, u: UserCtx, id: string) {
  const r = await db.query("UPDATE maintenance_orders SET status = 'in_progress', started_at = now() WHERE id = $1 AND status = 'open' RETURNING id", [id]);
  if (!r.rowCount) throw E.rule("INVALID_STATE", "أمر الصيانة ليس مفتوحًا", "Maintenance order is not open");
  await ev(db, u, "maintenance_order.started", "maintenance_order", id);
  return getOrder(db, id);
}

/**
 * Completion: issues the spare parts from stock at weighted average cost and
 * posts Dr maintenance expense / Cr inventory (parts) / Cr external account
 * (contractor invoice, cash…). A preventive order moves its plan forward.
 */
export async function completeOrder(db: Db, u: UserCtx, id: string, b: { completionDate: string; downtimeMinutes: number; externalCost: string; externalAccountId?: string | null;
  expenseAccountId?: string | null; resolution: string }) {
  const o = (await db.query(
    `SELECT o.*, a.code AS asset_code, c.maintenance_account_id FROM maintenance_orders o JOIN fixed_assets a ON a.id = o.asset_id JOIN asset_categories c ON c.id = a.category_id
      WHERE o.id = $1 FOR UPDATE OF o`, [id])).rows[0];
  if (!o) throw E.notFound("maintenance_orders");
  if (!["open", "in_progress"].includes(o.status)) throw E.rule("INVALID_STATE", "أمر الصيانة مغلق", "Maintenance order is closed");
  const expense = b.expenseAccountId ?? o.maintenance_account_id;
  if (!expense) throw E.validation([{ path: "expenseAccountId", message: "required: the asset category has no maintenance expense account" }]);
  await postableAccount(db, o.company_id, expense, "expenseAccountId", ["expense"]);
  if (Number(b.externalCost) > 0) {
    if (!b.externalAccountId) throw E.validation([{ path: "externalAccountId", message: "required when there is an external cost" }]);
    await postableAccount(db, o.company_id, b.externalAccountId, "externalAccountId", ["liability", "asset"], { noControl: true });
  }
  const parts = (await db.query(
    `SELECT p.*, i.code, i.kind, i.track_lots FROM maintenance_parts p JOIN items i ON i.id = p.item_id WHERE p.order_id = $1 ORDER BY i.code`, [id])).rows;
  const wh = o.warehouse_id ? (await db.query("SELECT kind FROM warehouses WHERE id = $1", [o.warehouse_id])).rows[0] : null;
  if (parts.length && !wh) throw E.validation([{ path: "warehouseId", message: "required to issue spare parts" }]);
  if (parts.length && wh.kind === "quarantine") throw E.rule("QUARANTINE_NOT_USABLE", "لا يجوز صرف قطع غيار من مخزن الحجر", "Spare parts cannot be issued from a quarantine warehouse");
  const journal: { accountId: string; amount: string; description?: string }[] = [];
  let partsCost = "0";
  for (const p of parts) {
    const out = await stockOut(db, u, { companyId: o.company_id, date: b.completionDate, sourceType: "maintenance_order", sourceId: id, sourceLineId: p.id,
      warehouseId: o.warehouse_id, itemId: p.item_id, qty: p.base_qty, trackLots: p.track_lots, itemCode: p.code });
    await db.query("UPDATE maintenance_parts SET value = $2 WHERE id = $1", [p.id, out.value]);
    journal.push({ accountId: await accountByRole(db, o.company_id, inventoryRole(wh.kind, p.kind)), amount: `-${out.value}`, description: `قطع غيار ${p.code}` });
    partsCost = (await db.query("SELECT ($1::numeric + $2::numeric)::text AS t", [partsCost, out.value])).rows[0].t;
  }
  if (Number(b.externalCost) > 0) journal.push({ accountId: b.externalAccountId!, amount: `-${b.externalCost}`, description: "تكلفة صيانة خارجية" });
  const total = (await db.query("SELECT ($1::numeric + $2::numeric)::text AS t", [partsCost, b.externalCost])).rows[0].t;
  journal.push({ accountId: expense, amount: total, description: `صيانة ${o.asset_code}` });
  const je = await postAccounts(db, u, { companyId: o.company_id, date: b.completionDate, memo: `أمر صيانة ${o.number} — ${o.asset_code}`, sourceType: "maintenance_order", sourceId: id, parts: journal });
  if (o.plan_id)
    await db.query("UPDATE maintenance_plans SET last_done_date = $2, next_due_date = $2::date + interval_days WHERE id = $1", [o.plan_id, b.completionDate]);
  await db.query(
    `UPDATE maintenance_orders SET status = 'completed', completed_at = now(), completion_date = $2, downtime_minutes = $3, external_cost = $4, external_account_id = $5,
       expense_account_id = $6, parts_cost = $7, total_cost = $8, resolution = $9, journal_entry_id = $10, completed_by = $11, started_at = coalesce(started_at, now()) WHERE id = $1`,
    [id, b.completionDate, b.downtimeMinutes, b.externalCost, b.externalAccountId ?? null, expense, partsCost, total, b.resolution, je, u.userId]);
  await ev(db, u, "maintenance_order.completed", "maintenance_order", id, { partsCost, total, journalEntryId: je });
  return getOrder(db, id);
}

export async function cancelOrder(db: Db, u: UserCtx, id: string, reason: string) {
  const r = await db.query("UPDATE maintenance_orders SET status = 'cancelled', resolution = $2 WHERE id = $1 AND status IN ('open', 'in_progress') RETURNING id", [id, `ملغى: ${reason}`]);
  if (!r.rowCount) throw E.rule("INVALID_STATE", "أمر الصيانة مغلق", "Maintenance order is closed");
  await ev(db, u, "maintenance_order.cancelled", "maintenance_order", id, { reason });
  return getOrder(db, id);
}

export async function getOrder(db: Db, id: string) {
  const o = (await db.query(
    `SELECT o.*, a.code AS asset_code, a.name_ar AS asset_name_ar FROM maintenance_orders o JOIN fixed_assets a ON a.id = o.asset_id WHERE o.id = $1`, [id])).rows[0];
  if (!o) throw E.notFound("maintenance_orders");
  const parts = (await db.query(
    `SELECT p.*, i.code AS item_code, i.name_ar AS item_name_ar, u.code AS uom_code FROM maintenance_parts p JOIN items i ON i.id = p.item_id JOIN uoms u ON u.id = p.uom_id
      WHERE p.order_id = $1 ORDER BY i.code`, [id])).rows;
  return { ...o, parts };
}

/** reliability & cost per asset over a period: breakdowns, downtime, MTBF (days), maintenance cost, depreciation */
export async function maintenanceSummary(db: Db, b: { companyId: string; from: string; to: string }) {
  return (await db.query(
    `SELECT a.id, a.code, a.name_ar, a.kind,
            count(o.id) FILTER (WHERE o.kind = 'corrective' AND o.status <> 'cancelled')::int AS breakdowns,
            count(o.id) FILTER (WHERE o.kind = 'preventive' AND o.status = 'completed')::int AS preventive_done,
            coalesce(sum(o.downtime_minutes) FILTER (WHERE o.status = 'completed'), 0)::int AS downtime_minutes,
            coalesce(sum(o.total_cost) FILTER (WHERE o.status = 'completed'), 0)::numeric(20,4)::text AS maintenance_cost,
            CASE WHEN count(o.id) FILTER (WHERE o.kind = 'corrective' AND o.status <> 'cancelled') > 0
                 THEN round(($3::date - $2::date + 1)::numeric / count(o.id) FILTER (WHERE o.kind = 'corrective' AND o.status <> 'cancelled'), 1)::text END AS mtbf_days,
            (SELECT coalesce(sum(l.amount), 0) FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id
              WHERE l.asset_id = a.id AND r.status = 'posted' AND l.period BETWEEN date_trunc('month', $2::date) AND $3::date)::numeric(20,4)::text AS depreciation
       FROM fixed_assets a
       LEFT JOIN maintenance_orders o ON o.asset_id = a.id AND coalesce(o.completion_date, o.reported_at::date) BETWEEN $2::date AND $3::date
      WHERE a.company_id = $1 AND a.status <> 'draft'
      GROUP BY a.id ORDER BY breakdowns DESC, a.code`, [b.companyId, b.from, b.to])).rows;
}
