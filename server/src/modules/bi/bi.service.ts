// BI & reporting (Phase 6c). Every figure is computed live from the posted
// transactional data (GL, invoices, stock, production…), never from a copy,
// so a dashboard always agrees with the underlying reports. Each KPI carries
// a drill-down path to the page that lists the documents behind it.
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";

export const AREAS = ["executive", "financial", "sales", "inventory", "manufacturing", "procurement", "hr", "distribution", "quality"] as const;
export type Area = (typeof AREAS)[number];

/** module that must be in the plan + permission the user needs, per dashboard */
export const AREA_ACCESS: Record<Area, { module: string; permission: string }> = {
  executive: { module: "bi", permission: "bi.executive.view" },
  financial: { module: "accounting", permission: "accounting.reports.view" },
  sales: { module: "sales", permission: "sales.reports.view" },
  inventory: { module: "inventory", permission: "inventory.stock.view" },
  manufacturing: { module: "manufacturing", permission: "manufacturing.orders.view" },
  procurement: { module: "purchasing", permission: "purchasing.receipts.view" },
  hr: { module: "hr", permission: "hr.employees.view" },
  distribution: { module: "distribution", permission: "distribution.reps.view" },
  quality: { module: "quality", permission: "quality.view" },
};

export function assertArea(u: UserCtx, area: Area) {
  const a = AREA_ACCESS[area];
  if (!u.modules.has(a.module)) throw E.moduleNotInPlan(a.module);
  if (!u.permissions.has(a.permission)) throw E.forbidden(a.permission);
}

export interface Ctx { companyId: string; from: string; to: string; prevFrom: string; prevTo: string; branchId: string | null; warehouseId: string | null }
export interface Kpi { key: string; ar: string; en: string; value: string | number | null; previous?: string | number | null; format: "money" | "number" | "pct" | "days"; drill?: string; better?: "up" | "down" }
export interface Table { key: string; ar: string; en: string; columns: { key: string; ar: string; en: string; format?: Kpi["format"] }[]; rows: Record<string, unknown>[] }
export interface Series { key: string; ar: string; en: string; points: { period: string; value: string | number }[] }
export interface Dashboard { area: Area; filters: Ctx & { applied: string[] }; kpis: Kpi[]; series: Series[]; tables: Table[] }

const row = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
const rows = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 10000) / 100 : null);

/** previous period of the same length, or the same dates one year earlier */
export async function makeCtx(db: Db, q: { companyId: string; from: string; to: string; compare?: "previous_period" | "previous_year"; branchId?: string | null; warehouseId?: string | null }): Promise<Ctx> {
  if (q.from > q.to) throw E.validation([{ path: "from", message: "after to" }]);
  const p = q.compare === "previous_year"
    ? await row(db, "SELECT ($1::date - interval '1 year')::date::text AS f, ($2::date - interval '1 year')::date::text AS t", [q.from, q.to])
    : await row(db, "SELECT ($1::date - ($2::date - $1::date) - 1)::text AS f, ($1::date - 1)::text AS t", [q.from, q.to]);
  return { companyId: q.companyId, from: q.from, to: q.to, prevFrom: p.f, prevTo: p.t, branchId: q.branchId ?? null, warehouseId: q.warehouseId ?? null };
}

const monthSeries = (db: Db, c: Ctx, valueSql: string, args: unknown[] = []) => rows(db,
  `WITH m AS (SELECT generate_series(date_trunc('month', $2::date), date_trunc('month', $3::date), interval '1 month')::date AS p)
   SELECT to_char(m.p, 'YYYY-MM') AS period, (${valueSql})::numeric(20,4)::text AS value FROM m ORDER BY m.p`, [c.companyId, c.from, c.to, ...args]);

// ------------------------------------------------------------------ financial (general ledger)
async function glTotals(db: Db, companyId: string, from: string, to: string) {
  return row(db,
    `SELECT coalesce(-sum(l.debit - l.credit) FILTER (WHERE a.type = 'revenue'), 0)::numeric(20,4) AS revenue,
            coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0)::numeric(20,4) AS expenses,
            coalesce(sum(l.debit - l.credit) FILTER (WHERE a.role = 'cogs'), 0)::numeric(20,4) AS cogs
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = $1 AND e.status <> 'draft' AND e.entry_date BETWEEN $2 AND $3`, [companyId, from, to]);
}
const CASH_ROLES = ["cash_main", "bank_main", "pos_cash", "rep_cash_custody", "transfers_in_transit"];
async function glBalances(db: Db, companyId: string, asOf: string) {
  return row(db,
    `SELECT coalesce(sum(l.debit - l.credit) FILTER (WHERE a.role = ANY($3)), 0)::numeric(20,4)::text AS cash,
            coalesce(sum(l.debit - l.credit) FILTER (WHERE a.role = 'ar'), 0)::numeric(20,4)::text AS ar,
            coalesce(-sum(l.debit - l.credit) FILTER (WHERE a.role = 'ap'), 0)::numeric(20,4)::text AS ap,
            coalesce(sum(l.debit - l.credit) FILTER (WHERE a.role LIKE 'inventory%'), 0)::numeric(20,4)::text AS inventory
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = $1 AND e.status <> 'draft' AND e.entry_date <= $2`, [companyId, asOf, CASH_ROLES]);
}

async function financial(db: Db, c: Ctx): Promise<Omit<Dashboard, "area" | "filters">> {
  const [cur, prev, bal] = [await glTotals(db, c.companyId, c.from, c.to), await glTotals(db, c.companyId, c.prevFrom, c.prevTo), await glBalances(db, c.companyId, c.to)];
  const np = (x: any) => (Number(x.revenue) - Number(x.expenses)).toFixed(4);
  const gm = (x: any) => pct(Number(x.revenue) - Number(x.cogs), Number(x.revenue));
  const sql = (expr: string) => `(SELECT coalesce(${expr}, 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = $1 AND e.status <> 'draft' AND date_trunc('month', e.entry_date) = m.p AND e.entry_date BETWEEN $2 AND $3)`;
  return {
    kpis: [
      { key: "revenue", ar: "الإيرادات", en: "Revenue", value: cur.revenue, previous: prev.revenue, format: "money", drill: "/trial-balance", better: "up" },
      { key: "expenses", ar: "التكاليف والمصروفات", en: "Costs & expenses", value: cur.expenses, previous: prev.expenses, format: "money", drill: "/trial-balance", better: "down" },
      { key: "net_profit", ar: "صافي الربح", en: "Net profit", value: np(cur), previous: np(prev), format: "money", drill: "/trial-balance", better: "up" },
      { key: "gross_margin_pct", ar: "هامش الربح الإجمالي", en: "Gross margin", value: gm(cur), previous: gm(prev), format: "pct", better: "up" },
      { key: "cash", ar: "النقدية والبنوك", en: "Cash & bank", value: bal.cash, format: "money", drill: "/trial-balance" },
      { key: "ar", ar: "ذمم العملاء", en: "Receivables", value: bal.ar, format: "money", drill: "/sales/aging" },
      { key: "ap", ar: "ذمم الموردين", en: "Payables", value: bal.ap, format: "money", drill: "/purchasing/invoices" },
      { key: "inventory_gl", ar: "المخزون (دفتريًا)", en: "Inventory (GL)", value: bal.inventory, format: "money", drill: "/inventory/stock" },
    ],
    series: [
      { key: "revenue", ar: "الإيرادات شهريًا", en: "Monthly revenue", points: await monthSeries(db, c, sql("-sum(l.debit - l.credit) FILTER (WHERE a.type = 'revenue')")) },
      { key: "expenses", ar: "المصروفات شهريًا", en: "Monthly expenses", points: await monthSeries(db, c, sql("sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense')")) },
    ],
    tables: [{ key: "top_expenses", ar: "أكبر بنود المصروفات", en: "Largest expense accounts",
      columns: [{ key: "code", ar: "الحساب", en: "Account" }, { key: "name_ar", ar: "الاسم", en: "Name" }, { key: "amount", ar: "المبلغ", en: "Amount", format: "money" }],
      rows: await rows(db, `SELECT a.code, a.name_ar, sum(l.debit - l.credit)::numeric(20,4)::text AS amount FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE e.company_id = $1 AND e.status <> 'draft' AND e.entry_date BETWEEN $2 AND $3 AND a.type = 'expense' GROUP BY a.id HAVING sum(l.debit - l.credit) <> 0 ORDER BY 3 DESC LIMIT 10`, [c.companyId, c.from, c.to]) }],
  };
}

// ------------------------------------------------------------------ sales
async function salesTotals(db: Db, c: Ctx, from: string, to: string) {
  return row(db,
    `WITH inv AS (SELECT * FROM sales_invoices WHERE company_id = $1 AND status = 'posted' AND NOT is_opening AND invoice_date BETWEEN $2 AND $3
                    AND ($4::uuid IS NULL OR branch_id = $4) AND ($5::uuid IS NULL OR warehouse_id = $5)),
          ret AS (SELECT r.* FROM sales_returns r JOIN sales_invoices i ON i.id = r.invoice_id WHERE r.company_id = $1 AND r.status = 'posted' AND r.return_date BETWEEN $2 AND $3
                    AND ($4::uuid IS NULL OR i.branch_id = $4) AND ($5::uuid IS NULL OR i.warehouse_id = $5))
     SELECT (SELECT count(*) FROM inv)::int AS invoices, (SELECT count(DISTINCT customer_id) FROM inv)::int AS customers,
            (SELECT coalesce(sum(total - tax_total), 0) FROM inv)::numeric(20,4) AS gross_sales, (SELECT coalesce(sum(cogs_total), 0) FROM inv)::numeric(20,4) AS cogs,
            (SELECT coalesce(sum(discount_total), 0) FROM inv)::numeric(20,4) AS discounts,
            (SELECT coalesce(sum(total), 0) FROM ret)::numeric(20,4) AS returns, (SELECT coalesce(sum(cost_total), 0) FROM ret)::numeric(20,4) AS returns_cost`,
    [c.companyId, from, to, c.branchId, c.warehouseId]);
}

async function sales(db: Db, c: Ctx): Promise<Omit<Dashboard, "area" | "filters">> {
  const [cur, prev] = [await salesTotals(db, c, c.from, c.to), await salesTotals(db, c, c.prevFrom, c.prevTo)];
  const net = (x: any) => Number(x.gross_sales) - Number(x.returns);
  const margin = (x: any) => pct(net(x) - (Number(x.cogs) - Number(x.returns_cost)), net(x));
  const avg = (x: any) => (x.invoices ? (Number(x.gross_sales) / x.invoices).toFixed(4) : null);
  const f = [c.companyId, c.from, c.to, c.branchId, c.warehouseId];
  const invWhere = `i.company_id = $1 AND i.status = 'posted' AND NOT i.is_opening AND i.invoice_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR i.branch_id = $4) AND ($5::uuid IS NULL OR i.warehouse_id = $5)`;
  const overdue = await row(db, `SELECT coalesce(sum(total - amount_paid - amount_returned), 0)::numeric(20,4)::text AS v FROM sales_invoices
      WHERE company_id = $1 AND status = 'posted' AND due_date < $2 AND total - amount_paid - amount_returned > 0 AND ($3::uuid IS NULL OR branch_id = $3)`, [c.companyId, c.to, c.branchId]);
  return {
    kpis: [
      { key: "net_sales", ar: "صافي المبيعات", en: "Net sales", value: net(cur).toFixed(4), previous: net(prev).toFixed(4), format: "money", drill: "/sales/invoices", better: "up" },
      { key: "invoices", ar: "عدد الفواتير", en: "Invoices", value: cur.invoices, previous: prev.invoices, format: "number", drill: "/sales/invoices", better: "up" },
      { key: "avg_invoice", ar: "متوسط الفاتورة", en: "Average invoice", value: avg(cur), previous: avg(prev), format: "money", better: "up" },
      { key: "gross_margin_pct", ar: "هامش الربح الإجمالي", en: "Gross margin", value: margin(cur), previous: margin(prev), format: "pct", better: "up" },
      { key: "returns", ar: "المرتجعات", en: "Returns", value: cur.returns, previous: prev.returns, format: "money", drill: "/sales/returns", better: "down" },
      { key: "discounts", ar: "الخصومات", en: "Discounts", value: cur.discounts, previous: prev.discounts, format: "money", better: "down" },
      { key: "active_customers", ar: "عملاء اشتروا", en: "Buying customers", value: cur.customers, previous: prev.customers, format: "number", better: "up" },
      { key: "overdue_ar", ar: "ديون متأخرة السداد", en: "Overdue receivables", value: overdue.v, format: "money", drill: "/sales/aging", better: "down" },
    ],
    series: [{ key: "net_sales", ar: "المبيعات شهريًا", en: "Monthly sales", points: await monthSeries(db, c,
      `SELECT coalesce(sum(total - tax_total), 0) FROM sales_invoices i WHERE ${invWhere} AND date_trunc('month', i.invoice_date) = m.p`, [c.branchId, c.warehouseId]) }],
    tables: [
      { key: "by_channel", ar: "المبيعات حسب القناة", en: "Sales by channel", columns: [{ key: "channel", ar: "القناة", en: "Channel" }, { key: "invoices", ar: "الفواتير", en: "Invoices", format: "number" }, { key: "amount", ar: "المبلغ", en: "Amount", format: "money" }],
        rows: await rows(db, `SELECT CASE WHEN pos_shift_id IS NOT NULL THEN 'pos' WHEN rep_id IS NOT NULL THEN 'field' ELSE 'office' END AS channel, count(*)::int AS invoices,
            sum(total - tax_total)::numeric(20,4)::text AS amount FROM sales_invoices i WHERE ${invWhere} GROUP BY 1 ORDER BY 3 DESC`, f) },
      { key: "top_customers", ar: "أكبر العملاء", en: "Top customers", columns: [{ key: "code", ar: "الرمز", en: "Code" }, { key: "name_ar", ar: "العميل", en: "Customer" }, { key: "amount", ar: "المبيعات", en: "Sales", format: "money" }],
        rows: await rows(db, `SELECT p.code, p.name_ar, sum(i.total - i.tax_total)::numeric(20,4)::text AS amount FROM sales_invoices i JOIN parties p ON p.id = i.customer_id WHERE ${invWhere}
            GROUP BY p.id ORDER BY sum(i.total - i.tax_total) DESC LIMIT 10`, f) },
      { key: "top_items", ar: "الأصناف الأكثر مبيعًا", en: "Top items", columns: [{ key: "code", ar: "الرمز", en: "Code" }, { key: "name_ar", ar: "الصنف", en: "Item" }, { key: "qty", ar: "الكمية", en: "Qty", format: "number" },
          { key: "amount", ar: "المبيعات", en: "Sales", format: "money" }, { key: "margin_pct", ar: "الهامش %", en: "Margin %", format: "pct" }],
        rows: await rows(db, `SELECT it.code, it.name_ar, sum(l.base_qty)::numeric(20,4)::text AS qty, sum(l.net_amount)::numeric(20,4)::text AS amount,
            CASE WHEN sum(l.net_amount) > 0 THEN round((sum(l.net_amount) - sum(coalesce(l.cost_amount, 0))) * 100 / sum(l.net_amount), 2) END AS margin_pct
            FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.doc_id JOIN items it ON it.id = l.item_id WHERE ${invWhere} GROUP BY it.id ORDER BY sum(l.net_amount) DESC LIMIT 10`, f) },
    ],
  };
}

// ------------------------------------------------------------------ inventory (position today)
async function inventory(db: Db, c: Ctx): Promise<Omit<Dashboard, "area" | "filters">> {
  const wf = `w.branch_id IN (SELECT id FROM branches WHERE company_id = $1) AND ($2::uuid IS NULL OR w.branch_id = $2) AND ($3::uuid IS NULL OR w.id = $3)`;
  const f = [c.companyId, c.branchId, c.warehouseId];
  const v = await row(db, `SELECT coalesce(sum(sb.value), 0)::numeric(20,4)::text AS value, coalesce(sum(sb.value) FILTER (WHERE w.kind = 'quarantine'), 0)::numeric(20,4)::text AS quarantine,
      count(DISTINCT sb.item_id) FILTER (WHERE sb.qty > 0)::int AS items FROM stock_balances sb JOIN warehouses w ON w.id = sb.warehouse_id WHERE ${wf}`, f);
  const expiring = await rows(db, `SELECT it.code, it.name_ar, l.lot_no, l.expiry_date::text AS expiry_date, w.code AS warehouse, lb.qty::numeric(20,4)::text AS qty, (l.expiry_date - $4::date) AS days_left
      FROM lot_balances lb JOIN lots l ON l.id = lb.lot_id JOIN items it ON it.id = l.item_id JOIN warehouses w ON w.id = lb.warehouse_id
     WHERE ${wf} AND lb.qty > 0 AND w.kind <> 'quarantine' AND l.expiry_date IS NOT NULL AND l.expiry_date <= $4::date + 30 ORDER BY l.expiry_date LIMIT 50`, [...f, c.to]);
  const below = await rows(db, `SELECT it.code, it.name_ar, it.reorder_level::numeric(20,4)::text AS reorder_level, coalesce(sum(sb.qty), 0)::numeric(20,4)::text AS qty
      FROM items it LEFT JOIN (stock_balances sb JOIN warehouses w ON w.id = sb.warehouse_id AND w.kind <> 'quarantine' AND ($2::uuid IS NULL OR w.branch_id = $2) AND ($3::uuid IS NULL OR w.id = $3)) ON sb.item_id = it.id
     WHERE it.company_id = $1 AND it.is_active AND it.reorder_level IS NOT NULL GROUP BY it.id HAVING coalesce(sum(sb.qty), 0) < it.reorder_level ORDER BY it.code LIMIT 50`, f);
  const cogs = await row(db, `SELECT coalesce(-sum(m.value), 0)::numeric AS v FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id
      WHERE ${wf} AND m.source_type = 'sales_invoice' AND m.move_date BETWEEN $4 AND $5`, [...f, c.from, c.to]);
  const days = Math.max(1, (Date.parse(c.to) - Date.parse(c.from)) / 86400000 + 1);
  const cover = Number(cogs.v) > 0 ? Math.round(Number(v.value) / (Number(cogs.v) / days)) : null;
  const expired = expiring.filter((x: any) => x.days_left < 0);
  return {
    kpis: [
      { key: "stock_value", ar: "قيمة المخزون", en: "Stock value", value: v.value, format: "money", drill: "/inventory/stock" },
      { key: "quarantine_value", ar: "قيمة بضاعة الحجر", en: "Quarantine value", value: v.quarantine, format: "money", drill: "/inventory/stock", better: "down" },
      { key: "items_in_stock", ar: "أصناف بالمخزون", en: "Items in stock", value: v.items, format: "number" },
      { key: "below_reorder", ar: "أصناف تحت حد الطلب", en: "Items below reorder level", value: below.length, format: "number", drill: "/inventory/items", better: "down" },
      { key: "expiring_lots", ar: "تشغيلات تنتهي خلال 30 يومًا", en: "Lots expiring in 30 days", value: expiring.length - expired.length, format: "number", drill: "/quality/trace", better: "down" },
      { key: "expired_lots", ar: "تشغيلات منتهية بمخازن صالحة", en: "Expired lots in sellable stores", value: expired.length, format: "number", drill: "/quality/trace", better: "down" },
      { key: "days_of_cover", ar: "أيام تغطية المخزون", en: "Days of stock cover", value: cover, format: "days" },
    ],
    series: [],
    tables: [
      { key: "expiring", ar: "تشغيلات قاربت/انتهت صلاحيتها", en: "Lots near or past expiry", columns: [{ key: "code", ar: "الصنف", en: "Item" }, { key: "lot_no", ar: "التشغيلة", en: "Lot" },
        { key: "warehouse", ar: "المخزن", en: "Warehouse" }, { key: "expiry_date", ar: "الانتهاء", en: "Expiry" }, { key: "days_left", ar: "أيام متبقية", en: "Days left", format: "number" }, { key: "qty", ar: "الكمية", en: "Qty", format: "number" }], rows: expiring },
      { key: "below_reorder", ar: "تحت حد إعادة الطلب", en: "Below reorder level", columns: [{ key: "code", ar: "الصنف", en: "Item" }, { key: "name_ar", ar: "الاسم", en: "Name" },
        { key: "qty", ar: "المتاح", en: "On hand", format: "number" }, { key: "reorder_level", ar: "حد الطلب", en: "Reorder level", format: "number" }], rows: below },
    ],
  };
}

// ------------------------------------------------------------------ manufacturing
async function mfgTotals(db: Db, c: Ctx, from: string, to: string) {
  return row(db, `SELECT count(*)::int AS orders, coalesce(sum(produced_qty), 0)::numeric AS produced, coalesce(sum(scrap_qty), 0)::numeric AS scrap,
      coalesce(sum(actual_cost), 0)::numeric(20,4) AS actual, coalesce(sum(std_unit_cost * produced_qty), 0)::numeric(20,4) AS std
      FROM production_orders WHERE company_id = $1 AND status = 'completed' AND completed_at::date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR output_warehouse_id = $4)`, [c.companyId, from, to, c.warehouseId]);
}
async function manufacturing(db: Db, c: Ctx): Promise<Omit<Dashboard, "area" | "filters">> {
  const [cur, prev] = [await mfgTotals(db, c, c.from, c.to), await mfgTotals(db, c, c.prevFrom, c.prevTo)];
  const scrap = (x: any) => pct(Number(x.scrap), Number(x.produced) + Number(x.scrap));
  const variance = (x: any) => (Number(x.std) ? (Number(x.actual) - Number(x.std)).toFixed(4) : null);
  const open = await row(db, "SELECT count(*)::int AS n FROM production_orders WHERE company_id = $1 AND status IN ('released', 'in_progress')", [c.companyId]);
  return {
    kpis: [
      { key: "orders_completed", ar: "أوامر إنتاج منجزة", en: "Orders completed", value: cur.orders, previous: prev.orders, format: "number", drill: "/manufacturing/orders", better: "up" },
      { key: "production_cost", ar: "تكلفة الإنتاج الفعلية", en: "Actual production cost", value: cur.actual, previous: prev.actual, format: "money", drill: "/manufacturing/orders" },
      { key: "cost_variance", ar: "انحراف التكلفة عن المعيار", en: "Variance vs standard", value: variance(cur), previous: variance(prev), format: "money", better: "down" },
      { key: "scrap_pct", ar: "نسبة الهالك", en: "Scrap rate", value: scrap(cur), previous: scrap(prev), format: "pct", better: "down" },
      { key: "open_orders", ar: "أوامر مفتوحة", en: "Open orders", value: open.n, format: "number", drill: "/manufacturing/orders" },
    ],
    series: [{ key: "production_cost", ar: "تكلفة الإنتاج شهريًا", en: "Monthly production cost", points: await monthSeries(db, c,
      `SELECT coalesce(sum(actual_cost), 0) FROM production_orders WHERE company_id = $1 AND status = 'completed' AND completed_at::date BETWEEN $2 AND $3 AND date_trunc('month', completed_at) = m.p`) }],
    tables: [{ key: "by_item", ar: "الإنتاج حسب الصنف", en: "Output by item", columns: [{ key: "code", ar: "الصنف", en: "Item" }, { key: "name_ar", ar: "الاسم", en: "Name" },
      { key: "produced", ar: "المنتج", en: "Produced", format: "number" }, { key: "scrap", ar: "الهالك", en: "Scrap", format: "number" },
      { key: "actual_unit_cost", ar: "تكلفة الوحدة الفعلية", en: "Actual unit cost", format: "money" }, { key: "std_unit_cost", ar: "المعيارية", en: "Standard", format: "money" }],
      rows: await rows(db, `SELECT it.code, it.name_ar, sum(o.produced_qty)::numeric(20,4)::text AS produced, sum(o.scrap_qty)::numeric(20,4)::text AS scrap,
          CASE WHEN sum(o.produced_qty) > 0 THEN round(sum(o.actual_cost) / sum(o.produced_qty), 4)::text END AS actual_unit_cost, round(avg(o.std_unit_cost), 4)::text AS std_unit_cost
          FROM production_orders o JOIN items it ON it.id = o.item_id WHERE o.company_id = $1 AND o.status = 'completed' AND o.completed_at::date BETWEEN $2 AND $3
          GROUP BY it.id ORDER BY sum(o.actual_cost) DESC LIMIT 20`, [c.companyId, c.from, c.to]) }],
  };
}

// ------------------------------------------------------------------ procurement
async function procurement(db: Db, c: Ctx): Promise<Omit<Dashboard, "area" | "filters">> {
  const t = async (from: string, to: string) => row(db, `SELECT (SELECT coalesce(sum(total), 0) FROM purchase_receipts WHERE company_id = $1 AND status = 'posted' AND receipt_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR warehouse_id = $4))::numeric(20,4) AS received,
      (SELECT count(*) FROM purchase_receipts WHERE company_id = $1 AND status = 'posted' AND receipt_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR warehouse_id = $4))::int AS receipts,
      (SELECT coalesce(sum(total), 0) FROM supplier_invoices WHERE company_id = $1 AND status = 'posted' AND NOT is_opening AND invoice_date BETWEEN $2 AND $3)::numeric(20,4) AS invoiced`, [c.companyId, from, to, c.warehouseId]);
  const [cur, prev] = [await t(c.from, c.to), await t(c.prevFrom, c.prevTo)];
  const snap = await row(db, `SELECT (SELECT coalesce(sum(total - amount_paid), 0) FROM supplier_invoices WHERE company_id = $1 AND status = 'posted')::numeric(20,4)::text AS ap_open,
      (SELECT coalesce(sum(total - amount_paid), 0) FROM supplier_invoices WHERE company_id = $1 AND status = 'posted' AND due_date < $2 AND total > amount_paid)::numeric(20,4)::text AS ap_overdue,
      (SELECT coalesce(sum(total - amount_invoiced), 0) FROM purchase_receipts WHERE company_id = $1 AND status = 'posted')::numeric(20,4)::text AS uninvoiced`, [c.companyId, c.to]);
  return {
    kpis: [
      { key: "received", ar: "قيمة المستلم", en: "Goods received", value: cur.received, previous: prev.received, format: "money", drill: "/purchasing/receipts" },
      { key: "receipts", ar: "عدد الاستلامات", en: "Receipts", value: cur.receipts, previous: prev.receipts, format: "number", drill: "/purchasing/receipts" },
      { key: "invoiced", ar: "فواتير الموردين", en: "Supplier invoices", value: cur.invoiced, previous: prev.invoiced, format: "money", drill: "/purchasing/invoices" },
      { key: "ap_open", ar: "المستحق للموردين", en: "Payables open", value: snap.ap_open, format: "money", drill: "/purchasing/invoices" },
      { key: "ap_overdue", ar: "مستحق متأخر للموردين", en: "Payables overdue", value: snap.ap_overdue, format: "money", drill: "/purchasing/invoices", better: "down" },
      { key: "uninvoiced", ar: "مستلم لم تصل فاتورته", en: "Received not invoiced", value: snap.uninvoiced, format: "money", drill: "/purchasing/receipts", better: "down" },
    ],
    series: [{ key: "received", ar: "المشتريات شهريًا", en: "Monthly purchases", points: await monthSeries(db, c,
      `SELECT coalesce(sum(total), 0) FROM purchase_receipts WHERE company_id = $1 AND status = 'posted' AND receipt_date BETWEEN $2 AND $3 AND date_trunc('month', receipt_date) = m.p`) }],
    tables: [{ key: "top_suppliers", ar: "أكبر الموردين", en: "Top suppliers", columns: [{ key: "code", ar: "الرمز", en: "Code" }, { key: "name_ar", ar: "المورد", en: "Supplier" }, { key: "amount", ar: "المستلم", en: "Received", format: "money" }],
      rows: await rows(db, `SELECT p.code, p.name_ar, sum(r.total)::numeric(20,4)::text AS amount FROM purchase_receipts r JOIN parties p ON p.id = r.supplier_id
          WHERE r.company_id = $1 AND r.status = 'posted' AND r.receipt_date BETWEEN $2 AND $3 GROUP BY p.id ORDER BY sum(r.total) DESC LIMIT 10`, [c.companyId, c.from, c.to]) }],
  };
}

// ------------------------------------------------------------------ HR (salary figures only with the sensitive permission)
async function hr(db: Db, c: Ctx, u: UserCtx): Promise<Omit<Dashboard, "area" | "filters">> {
  const bf = "($2::uuid IS NULL OR e.branch_id = $2)";
  const head = await row(db, `SELECT count(*) FILTER (WHERE e.hire_date <= $3 AND (e.end_date IS NULL OR e.end_date > $3))::int AS headcount,
      count(*) FILTER (WHERE e.hire_date BETWEEN $4 AND $3)::int AS hires, count(*) FILTER (WHERE e.end_date BETWEEN $4 AND $3)::int AS exits
      FROM employees e WHERE e.company_id = $1 AND ${bf}`, [c.companyId, c.branchId, c.to, c.from]);
  const leave = await row(db, `SELECT coalesce(sum(least(l.to_date, $4::date) - greatest(l.from_date, $3::date) + 1), 0)::int AS days FROM leave_requests l JOIN employees e ON e.id = l.employee_id
      WHERE e.company_id = $1 AND ${bf} AND l.status = 'approved' AND l.from_date <= $4 AND l.to_date >= $3`, [c.companyId, c.branchId, c.from, c.to]);
  const kpis: Kpi[] = [
    { key: "headcount", ar: "عدد الموظفين", en: "Headcount", value: head.headcount, format: "number", drill: "/hr/employees" },
    { key: "hires", ar: "تعيينات الفترة", en: "Hires", value: head.hires, format: "number" },
    { key: "exits", ar: "حالات ترك العمل", en: "Exits", value: head.exits, format: "number", better: "down" },
    { key: "leave_days", ar: "أيام الإجازات المعتمدة", en: "Approved leave days", value: leave.days, format: "number", drill: "/hr/leave" },
  ];
  if (u.permissions.has("hr.salaries.view")) {
    const pay = async (from: string, to: string) => row(db, `SELECT coalesce(sum(total_earned), 0)::numeric(20,4)::text AS earned FROM payroll_runs
        WHERE company_id = $1 AND status IN ('approved', 'paid') AND period BETWEEN to_char($2::date, 'YYYY-MM') AND to_char($3::date, 'YYYY-MM')`, [c.companyId, from, to]);
    const loans = await row(db, "SELECT coalesce(sum(amount - recovered), 0)::numeric(20,4)::text AS v FROM employee_loans WHERE company_id = $1 AND status = 'active'", [c.companyId]);
    kpis.push({ key: "payroll_cost", ar: "تكلفة الرواتب", en: "Payroll cost", value: (await pay(c.from, c.to)).earned, previous: (await pay(c.prevFrom, c.prevTo)).earned, format: "money", drill: "/hr/payroll" },
      { key: "loans_outstanding", ar: "سلف قائمة", en: "Loans outstanding", value: loans.v, format: "money", drill: "/hr/payroll" });
  }
  return { kpis, series: [], tables: [{ key: "by_department", ar: "الموظفون حسب القسم", en: "Headcount by department", columns: [{ key: "code", ar: "القسم", en: "Department" }, { key: "name_ar", ar: "الاسم", en: "Name" }, { key: "headcount", ar: "العدد", en: "Headcount", format: "number" }],
    rows: await rows(db, `SELECT coalesce(d.code, '—') AS code, coalesce(d.name_ar, 'بدون قسم') AS name_ar, count(*)::int AS headcount FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.company_id = $1 AND ${bf} AND e.hire_date <= $3 AND (e.end_date IS NULL OR e.end_date > $3) GROUP BY d.id ORDER BY 3 DESC`, [c.companyId, c.branchId, c.to]) }] };
}

// ------------------------------------------------------------------ distribution (field sales)
async function distribution(db: Db, c: Ctx): Promise<Omit<Dashboard, "area" | "filters">> {
  const t = async (from: string, to: string) => row(db, `SELECT
      (SELECT coalesce(sum(total - tax_total), 0) FROM sales_invoices WHERE company_id = $1 AND status = 'posted' AND rep_id IS NOT NULL AND invoice_date BETWEEN $2 AND $3)::numeric(20,4) AS sales,
      (SELECT coalesce(sum(amount), 0) FROM payments WHERE company_id = $1 AND status = 'posted' AND direction = 'in' AND rep_id IS NOT NULL AND payment_date BETWEEN $2 AND $3)::numeric(20,4) AS collections,
      (SELECT count(*) FROM visits v JOIN sales_reps r ON r.id = v.rep_id WHERE r.company_id = $1 AND v.visited_at::date BETWEEN $2 AND $3)::int AS visits,
      (SELECT count(*) FROM visits v JOIN sales_reps r ON r.id = v.rep_id WHERE r.company_id = $1 AND v.visited_at::date BETWEEN $2 AND $3 AND v.outcome IN ('sale', 'collection'))::int AS productive,
      (SELECT coalesce(sum(shortage_value), 0) FROM van_settlements WHERE company_id = $1 AND status = 'approved' AND settlement_date BETWEEN $2 AND $3)::numeric(20,4) AS shortages`, [c.companyId, from, to]);
  const [cur, prev] = [await t(c.from, c.to), await t(c.prevFrom, c.prevTo)];
  const cust = await row(db, `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(20,4)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = $1 AND e.status <> 'draft' AND e.entry_date <= $2 AND a.role = 'rep_cash_custody'`, [c.companyId, c.to]);
  return {
    kpis: [
      { key: "field_sales", ar: "مبيعات المناديب", en: "Field sales", value: cur.sales, previous: prev.sales, format: "money", drill: "/distribution/performance", better: "up" },
      { key: "collections", ar: "تحصيلات المناديب", en: "Field collections", value: cur.collections, previous: prev.collections, format: "money", drill: "/distribution/performance", better: "up" },
      { key: "visits", ar: "الزيارات", en: "Visits", value: cur.visits, previous: prev.visits, format: "number", better: "up" },
      { key: "productive_visits_pct", ar: "الزيارات المنتجة", en: "Productive visits", value: pct(cur.productive, cur.visits), previous: pct(prev.productive, prev.visits), format: "pct", better: "up" },
      { key: "cash_custody", ar: "نقدية بعهدة المناديب", en: "Cash with reps", value: cust.v, format: "money", drill: "/distribution/settlements", better: "down" },
      { key: "van_shortages", ar: "عجز تسويات السيارات", en: "Van shortages", value: cur.shortages, previous: prev.shortages, format: "money", drill: "/distribution/settlements", better: "down" },
    ],
    series: [],
    tables: [{ key: "by_rep", ar: "أداء المناديب", en: "Rep performance", columns: [{ key: "code", ar: "المندوب", en: "Rep" }, { key: "full_name", ar: "الاسم", en: "Name" },
      { key: "sales", ar: "المبيعات", en: "Sales", format: "money" }, { key: "collections", ar: "التحصيل", en: "Collections", format: "money" }, { key: "visits", ar: "الزيارات", en: "Visits", format: "number" }],
      rows: await rows(db, `SELECT r.code, u.full_name,
          (SELECT coalesce(sum(total - tax_total), 0) FROM sales_invoices i WHERE i.rep_id = r.id AND i.status = 'posted' AND i.invoice_date BETWEEN $2 AND $3)::numeric(20,4)::text AS sales,
          (SELECT coalesce(sum(amount), 0) FROM payments p WHERE p.rep_id = r.id AND p.status = 'posted' AND p.direction = 'in' AND p.payment_date BETWEEN $2 AND $3)::numeric(20,4)::text AS collections,
          (SELECT count(*) FROM visits v WHERE v.rep_id = r.id AND v.visited_at::date BETWEEN $2 AND $3)::int AS visits
          FROM sales_reps r JOIN users u ON u.id = r.user_id WHERE r.company_id = $1 ORDER BY 3 DESC`, [c.companyId, c.from, c.to]) }],
  };
}

// ------------------------------------------------------------------ quality
async function quality(db: Db, c: Ctx): Promise<Omit<Dashboard, "area" | "filters">> {
  const t = async (from: string, to: string) => row(db, `SELECT count(*)::int AS checks, count(*) FILTER (WHERE result = 'fail')::int AS fails,
      (SELECT count(*) FROM nonconformances WHERE company_id = $1 AND created_at::date BETWEEN $2 AND $3)::int AS ncr
      FROM quality_checks WHERE company_id = $1 AND checked_at::date BETWEEN $2 AND $3`, [c.companyId, from, to]);
  const [cur, prev] = [await t(c.from, c.to), await t(c.prevFrom, c.prevTo)];
  const snap = await row(db, `SELECT (SELECT count(*) FROM nonconformances WHERE company_id = $1 AND status = 'open')::int AS open_ncr,
      (SELECT count(*) FROM recalls WHERE company_id = $1 AND status = 'open')::int AS open_recalls,
      (SELECT count(*) FROM lots l JOIN items i ON i.id = l.item_id WHERE i.company_id = $1 AND l.on_hold)::int AS lots_on_hold`, [c.companyId]);
  const pass = (x: any) => (x.checks ? pct(x.checks - x.fails, x.checks) : null);
  return {
    kpis: [
      { key: "checks", ar: "فحوصات الجودة", en: "Quality checks", value: cur.checks, previous: prev.checks, format: "number", drill: "/quality/checks" },
      { key: "pass_rate", ar: "نسبة النجاح", en: "Pass rate", value: pass(cur), previous: pass(prev), format: "pct", drill: "/quality/checks", better: "up" },
      { key: "ncr_opened", ar: "حالات عدم مطابقة جديدة", en: "New non-conformances", value: cur.ncr, previous: prev.ncr, format: "number", drill: "/quality/ncr", better: "down" },
      { key: "open_ncr", ar: "عدم مطابقة مفتوحة", en: "Open non-conformances", value: snap.open_ncr, format: "number", drill: "/quality/ncr", better: "down" },
      { key: "open_recalls", ar: "استدعاءات مفتوحة", en: "Open recalls", value: snap.open_recalls, format: "number", drill: "/quality/trace", better: "down" },
      { key: "lots_on_hold", ar: "تشغيلات موقوفة", en: "Lots on hold", value: snap.lots_on_hold, format: "number", drill: "/quality/trace", better: "down" },
    ],
    series: [],
    tables: [{ key: "failures", ar: "آخر الفحوصات الفاشلة", en: "Latest failed checks", columns: [{ key: "number", ar: "الفحص", en: "Check" }, { key: "item", ar: "الصنف", en: "Item" }, { key: "lot_no", ar: "التشغيلة", en: "Lot" }, { key: "checked_at", ar: "التاريخ", en: "Date" }],
      rows: await rows(db, `SELECT q.number, it.code AS item, l.lot_no, q.checked_at::date::text AS checked_at FROM quality_checks q JOIN lots l ON l.id = q.lot_id JOIN items it ON it.id = l.item_id
          WHERE q.company_id = $1 AND q.result = 'fail' AND q.checked_at::date BETWEEN $2 AND $3 ORDER BY q.checked_at DESC LIMIT 20`, [c.companyId, c.from, c.to]) }],
  };
}

// ------------------------------------------------------------------ executive: headline figures across the modules the tenant has
async function executive(db: Db, c: Ctx, u: UserCtx): Promise<Omit<Dashboard, "area" | "filters">> {
  const pick = (d: { kpis: Kpi[] }, keys: string[]) => d.kpis.filter((k) => keys.includes(k.key));
  const kpis: Kpi[] = [];
  const series: Series[] = [];
  if (u.modules.has("sales")) { const s = await sales(db, c); kpis.push(...pick(s, ["net_sales", "gross_margin_pct", "overdue_ar"])); series.push(...s.series); }
  if (u.modules.has("accounting")) { const f = await financial(db, c); kpis.push(...pick(f, ["net_profit", "cash", "ar", "ap"])); }
  if (u.modules.has("inventory")) kpis.push(...pick(await inventory(db, c), ["stock_value", "expired_lots"]));
  if (u.modules.has("manufacturing")) kpis.push(...pick(await manufacturing(db, c), ["production_cost", "scrap_pct"]));
  if (u.modules.has("quality")) kpis.push(...pick(await quality(db, c), ["open_ncr", "open_recalls"]));
  return { kpis, series, tables: [] };
}

export async function dashboard(db: Db, u: UserCtx, area: Area, c: Ctx): Promise<Dashboard> {
  assertArea(u, area);
  const body = area === "financial" ? await financial(db, c) : area === "sales" ? await sales(db, c) : area === "inventory" ? await inventory(db, c)
    : area === "manufacturing" ? await manufacturing(db, c) : area === "procurement" ? await procurement(db, c) : area === "hr" ? await hr(db, c, u)
    : area === "distribution" ? await distribution(db, c) : area === "quality" ? await quality(db, c) : await executive(db, c, u);
  const applied = ["company", "period"];
  if (c.branchId && ["sales", "inventory", "hr"].includes(area)) applied.push("branch");
  if (c.warehouseId && ["sales", "inventory", "manufacturing", "procurement"].includes(area)) applied.push("warehouse");
  return { area, filters: { ...c, applied }, ...body };
}

// ------------------------------------------------------------------ alerts
/** evaluates the active rules on month-to-date figures (as of `asOf`) */
export async function evaluateAlerts(db: Db, u: UserCtx, companyId: string, asOf: string) {
  const rules = (await db.query("SELECT * FROM bi_alert_rules WHERE company_id = $1 AND is_active ORDER BY area, name_ar", [companyId])).rows;
  const ctx = await makeCtx(db, { companyId, from: `${asOf.slice(0, 7)}-01`, to: asOf });
  const cache = new Map<string, Dashboard>();
  const out = [];
  for (const r of rules) {
    const a = AREA_ACCESS[r.area as Area];
    if (!u.modules.has(a.module) || !u.permissions.has(a.permission)) continue;   // a user only sees alerts on figures they may see
    if (!cache.has(r.area)) cache.set(r.area, await dashboard(db, u, r.area, ctx));
    const k = cache.get(r.area)!.kpis.find((x) => x.key === r.metric);
    const value = k?.value === null || k?.value === undefined ? null : Number(k.value);
    const triggered = value !== null && (r.operator === "gt" ? value > Number(r.threshold) : value < Number(r.threshold));
    out.push({ id: r.id, name_ar: r.name_ar, area: r.area, metric: r.metric, operator: r.operator, threshold: r.threshold, value, triggered, drill: k?.drill ?? null, recipient: r.recipient, label: k ? { ar: k.ar, en: k.en } : null });
  }
  return out;
}
