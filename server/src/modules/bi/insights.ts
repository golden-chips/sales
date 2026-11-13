// Smart insights (Phase 6e) — advisory analytics from posted data. Each result
// carries the method used, so a person can judge it; nothing here posts,
// orders, pays or changes data. Statistics are deliberately simple and
// explainable (moving averages, z-scores, explicit rules) rather than opaque.
import type { Db } from "../../db/pool.js";

const CONSUMPTION = ["sales_invoice", "production_order", "maintenance_order"];
const companyWh = "w.branch_id IN (SELECT id FROM branches WHERE company_id = $1) AND w.kind <> 'quarantine'";
const rows = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows;

/** stock with value that has not been consumed (sold, used in production or maintenance) for N days */
export async function slowStock(db: Db, companyId: string, asOf: string, days: number) {
  const items = await rows(db,
    `WITH bal AS (SELECT sb.item_id, sum(sb.qty) AS qty, sum(sb.value) AS value FROM stock_balances sb JOIN warehouses w ON w.id = sb.warehouse_id
                   WHERE ${companyWh} GROUP BY sb.item_id HAVING sum(sb.qty) > 0),
          last_out AS (SELECT item_id, max(move_date) AS d FROM stock_moves WHERE company_id = $1 AND qty < 0 AND source_type = ANY($3) AND move_date <= $2 GROUP BY item_id)
     SELECT i.code, i.name_ar, i.kind, bal.qty::numeric(20,4)::text AS qty, bal.value::numeric(20,4)::text AS value, lo.d::text AS last_consumed,
            CASE WHEN lo.d IS NULL THEN NULL ELSE ($2::date - lo.d) END AS idle_days
       FROM bal JOIN items i ON i.id = bal.item_id LEFT JOIN last_out lo ON lo.item_id = bal.item_id
      WHERE lo.d IS NULL OR lo.d < $2::date - $4::int ORDER BY bal.value DESC LIMIT 100`, [companyId, asOf, CONSUMPTION, days]);
  const total = items.reduce((s: number, x: any) => s + Number(x.value), 0);
  return { method: { ar: `أصناف لها رصيد ولم تُستهلك (بيع/إنتاج/صيانة) منذ ${days} يومًا أو أكثر`, en: `Items with stock not consumed (sales/production/maintenance) for ${days}+ days` },
    totalValue: total.toFixed(4), items };
}

/**
 * Demand forecast per finished item: monthly quantities sold (net of returns)
 * over the last 6 complete months; next month = weighted moving average of
 * the last 3 months (weights 1-2-3). Confidence drops with fewer months or
 * high variability (coefficient of variation).
 */
export async function demandForecast(db: Db, companyId: string, asOf: string) {
  const hist = await rows(db,
    `WITH m AS (SELECT generate_series(date_trunc('month', $2::date) - interval '6 months', date_trunc('month', $2::date) - interval '1 month', interval '1 month')::date AS p),
          s AS (SELECT l.item_id, date_trunc('month', i.invoice_date)::date AS p, sum(l.base_qty) AS q FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.doc_id
                 WHERE i.company_id = $1 AND i.status = 'posted' AND i.invoice_date >= date_trunc('month', $2::date) - interval '6 months' AND i.invoice_date < date_trunc('month', $2::date) GROUP BY 1, 2),
          r AS (SELECT il.item_id, date_trunc('month', sr.return_date)::date AS p, sum(rl.base_qty) AS q FROM sales_return_lines rl JOIN sales_returns sr ON sr.id = rl.doc_id
                  JOIN sales_invoice_lines il ON il.id = rl.invoice_line_id
                 WHERE sr.company_id = $1 AND sr.status = 'posted' AND sr.return_date >= date_trunc('month', $2::date) - interval '6 months' AND sr.return_date < date_trunc('month', $2::date) GROUP BY 1, 2)
     SELECT it.id, it.code, it.name_ar, to_char(m.p, 'YYYY-MM') AS period, (coalesce(s.q, 0) - coalesce(r.q, 0))::numeric(20,4) AS qty
       FROM items it CROSS JOIN m LEFT JOIN s ON s.item_id = it.id AND s.p = m.p LEFT JOIN r ON r.item_id = it.id AND r.p = m.p
      WHERE it.company_id = $1 AND it.kind = 'finished' AND it.is_active
        AND EXISTS (SELECT 1 FROM s s2 WHERE s2.item_id = it.id)
      ORDER BY it.code, m.p`, [companyId, asOf]);
  const byItem = new Map<string, { code: string; name_ar: string; history: { period: string; qty: number }[] }>();
  for (const h of hist) {
    if (!byItem.has(h.id)) byItem.set(h.id, { code: h.code, name_ar: h.name_ar, history: [] });
    byItem.get(h.id)!.history.push({ period: h.period, qty: Number(h.qty) });
  }
  const stock = new Map((await rows(db, `SELECT sb.item_id, sum(sb.qty)::numeric AS q FROM stock_balances sb JOIN warehouses w ON w.id = sb.warehouse_id WHERE ${companyWh} GROUP BY 1`, [companyId]))
    .map((r: any) => [r.item_id, Number(r.q)]));
  const items = [...byItem.entries()].map(([id, x]) => {
    const last3 = x.history.slice(-3).map((h) => h.qty);
    const active = x.history.filter((h) => h.qty > 0).length;
    const forecast = Math.max(0, Math.round(((last3[0] ?? 0) * 1 + (last3[1] ?? 0) * 2 + (last3[2] ?? 0) * 3) / 6 * 100) / 100);
    const mean = x.history.reduce((s, h) => s + h.qty, 0) / (x.history.length || 1);
    const sd = Math.sqrt(x.history.reduce((s, h) => s + (h.qty - mean) ** 2, 0) / (x.history.length || 1));
    const cv = mean > 0 ? sd / mean : null;
    const confidence = active < 3 ? "low" : cv !== null && cv > 0.5 ? "medium" : "high";
    const onHand = stock.get(id) ?? 0;
    return { code: x.code, name_ar: x.name_ar, history: x.history, forecast_next_month: forecast, confidence, variability_cv: cv === null ? null : Math.round(cv * 100) / 100,
      on_hand: onHand, suggested_production: Math.max(0, Math.round((forecast - onHand) * 100) / 100) };
  });
  return { method: { ar: "متوسط متحرك موزون لآخر 3 أشهر كاملة (أوزان 1-2-3) من صافي المبيعات بعد المرتجعات؛ الثقة منخفضة مع أقل من 3 أشهر بيع ومتوسطة مع تذبذب عالٍ. اقتراح الإنتاج = التنبؤ − الرصيد الحالي.",
    en: "Weighted moving average of the last 3 complete months (weights 1-2-3) of net sales after returns; low confidence with < 3 selling months, medium with high variability. Suggested production = forecast − stock on hand." }, items };
}

/** reorder suggestions for purchased materials from average daily consumption over the last 90 days */
export async function purchaseSuggestions(db: Db, companyId: string, asOf: string, leadDays: number, safetyDays: number) {
  const items = await rows(db,
    `WITH use AS (SELECT item_id, -sum(qty) AS q FROM stock_moves WHERE company_id = $1 AND qty < 0 AND source_type = ANY($3) AND move_date BETWEEN $2::date - 89 AND $2 GROUP BY item_id),
          bal AS (SELECT sb.item_id, sum(sb.qty) AS q FROM stock_balances sb JOIN warehouses w ON w.id = sb.warehouse_id WHERE ${companyWh} GROUP BY sb.item_id),
          incoming AS (SELECT 0 AS q)   -- purchase orders are not implemented yet (K13): nothing is "on order"
     SELECT i.code, i.name_ar, i.kind, u.code AS uom, round(use.q / 90, 4)::text AS daily_use, coalesce(bal.q, 0)::numeric(20,4)::text AS on_hand,
            CASE WHEN use.q > 0 THEN floor(coalesce(bal.q, 0) / (use.q / 90)) END AS days_of_cover,
            ceil(greatest(0, use.q / 90 * ($4::int + $5::int) - coalesce(bal.q, 0)))::text AS suggested_qty, i.reorder_level::text AS reorder_level
       FROM use JOIN items i ON i.id = use.item_id JOIN uoms u ON u.id = i.base_uom_id LEFT JOIN bal ON bal.item_id = use.item_id
      WHERE i.company_id = $1 AND i.kind IN ('raw', 'packaging') AND use.q > 0 AND use.q / 90 * ($4::int + $5::int) > coalesce(bal.q, 0)
      ORDER BY CASE WHEN use.q > 0 THEN coalesce(bal.q, 0) / (use.q / 90) END NULLS FIRST LIMIT 100`, [companyId, asOf, CONSUMPTION, leadDays, safetyDays]);
  return { method: { ar: `متوسط الاستهلاك اليومي لآخر 90 يومًا × (مدة التوريد ${leadDays} + أيام أمان ${safetyDays}) − الرصيد الحالي. لا تُحتسب أوامر الشراء المفتوحة لأنها غير منفذة بعد.`,
    en: `Average daily use over 90 days × (lead time ${leadDays} + safety ${safetyDays} days) − stock on hand. Open purchase orders are not counted (not implemented yet).` }, items };
}

/** customers who bought regularly before but stopped recently */
export async function lapsedCustomers(db: Db, companyId: string, asOf: string) {
  const items = await rows(db,
    `SELECT p.code, p.name_ar, p.phone, count(*) FILTER (WHERE i.invoice_date BETWEEN $2::date - 120 AND $2::date - 31)::int AS invoices_before,
            coalesce(sum(i.total) FILTER (WHERE i.invoice_date BETWEEN $2::date - 120 AND $2::date - 31), 0)::numeric(20,4)::text AS value_before,
            max(i.invoice_date)::text AS last_invoice, ($2::date - max(i.invoice_date)) AS days_since
       FROM sales_invoices i JOIN parties p ON p.id = i.customer_id
      WHERE i.company_id = $1 AND i.status = 'posted' AND i.invoice_date <= $2 AND p.is_active
      GROUP BY p.id
     HAVING count(*) FILTER (WHERE i.invoice_date BETWEEN $2::date - 120 AND $2::date - 31) >= 3 AND count(*) FILTER (WHERE i.invoice_date > $2::date - 30) = 0
      ORDER BY sum(i.total) FILTER (WHERE i.invoice_date BETWEEN $2::date - 120 AND $2::date - 31) DESC LIMIT 100`, [companyId, asOf]);
  return { method: { ar: "عملاء لهم 3 فواتير أو أكثر بين 31 و120 يومًا مضت، ولا شيء خلال آخر 30 يومًا — للمتابعة من المندوب أو خدمة العملاء", en: "Customers with 3+ invoices 31–120 days ago and none in the last 30 days — for follow-up" }, items };
}

/** production orders whose actual unit cost drifts from standard by more than the threshold */
export async function productionCostDrift(db: Db, companyId: string, asOf: string, thresholdPct: number) {
  const items = await rows(db,
    `SELECT o.number, it.code, it.name_ar, o.completed_at::date::text AS completed, o.produced_qty::numeric(20,4)::text AS produced,
            round(o.actual_cost / nullif(o.produced_qty, 0), 4)::text AS actual_unit_cost, round(o.std_unit_cost, 4)::text AS std_unit_cost,
            round((o.actual_cost / nullif(o.produced_qty, 0) - o.std_unit_cost) * 100 / nullif(o.std_unit_cost, 0), 1) AS drift_pct,
            CASE WHEN o.produced_qty + o.scrap_qty > 0 THEN round(o.scrap_qty * 100 / (o.produced_qty + o.scrap_qty), 1) END AS scrap_pct
       FROM production_orders o JOIN items it ON it.id = o.item_id
      WHERE o.company_id = $1 AND o.status = 'completed' AND o.completed_at::date BETWEEN $2::date - 89 AND $2 AND o.std_unit_cost > 0 AND o.produced_qty > 0
        AND abs(o.actual_cost / o.produced_qty - o.std_unit_cost) * 100 / o.std_unit_cost > $3
      ORDER BY abs(o.actual_cost / o.produced_qty - o.std_unit_cost) * 100 / o.std_unit_cost DESC LIMIT 100`, [companyId, asOf, thresholdPct]);
  return { method: { ar: `أوامر إنتاج آخر 90 يومًا انحرفت تكلفة الوحدة الفعلية فيها عن المعيارية بأكثر من ${thresholdPct}% — راجع الوصفة، الهالك، أسعار المواد`,
    en: `Production orders of the last 90 days whose actual unit cost drifts more than ${thresholdPct}% from standard — check formula, scrap, material prices` }, items };
}

/**
 * Unusual journal entries for review (never "fraud" by themselves):
 *  - manual entries far above the usual size for the account (z-score > 3 over 12 months)
 *  - manual entries posted on the weekly day off or between 22:00 and 05:00
 *  - large round amounts in manual entries
 *  - possible duplicate payments (same party, amount and date)
 */
export async function anomalies(db: Db, companyId: string, asOf: string, weekendDow: number[]) {
  const big = await rows(db,
    `WITH m AS (SELECT l.account_id, e.id AS entry_id, e.number, e.entry_date, e.memo, greatest(l.debit, l.credit) AS amt, e.posted_at, e.created_by
                  FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                 WHERE e.company_id = $1 AND e.status <> 'draft' AND e.source_type = 'manual' AND e.reversal_of IS NULL AND e.entry_date BETWEEN $2::date - 365 AND $2),
          s AS (SELECT account_id, avg(amt) AS mu, stddev_pop(amt) AS sd, count(*) AS n FROM m GROUP BY account_id)
     SELECT m.number, m.entry_date::text AS date, a.code AS account, m.amt::numeric(20,4)::text AS amount, round(((m.amt - s.mu) / nullif(s.sd, 0))::numeric, 1) AS z, m.memo
       FROM m JOIN s ON s.account_id = m.account_id JOIN accounts a ON a.id = m.account_id
      WHERE s.n >= 8 AND s.sd > 0 AND (m.amt - s.mu) / s.sd > 3 ORDER BY 5 DESC LIMIT 50`, [companyId, asOf]);
  const offHours = await rows(db,
    `SELECT e.number, e.entry_date::text AS date, e.posted_at, u.full_name AS posted_by, e.memo
       FROM journal_entries e LEFT JOIN users u ON u.id = e.posted_by
      WHERE e.company_id = $1 AND e.status <> 'draft' AND e.source_type = 'manual' AND e.reversal_of IS NULL AND e.entry_date BETWEEN $2::date - 90 AND $2
        AND (extract(dow FROM e.posted_at AT TIME ZONE (SELECT timezone FROM tenants WHERE id = app_tenant_id()))::int = ANY($3)
             OR extract(hour FROM e.posted_at AT TIME ZONE (SELECT timezone FROM tenants WHERE id = app_tenant_id())) NOT BETWEEN 5 AND 21)
      ORDER BY e.posted_at DESC LIMIT 50`, [companyId, asOf, weekendDow]);
  const round = await rows(db,
    `SELECT e.number, e.entry_date::text AS date, sum(l.debit)::numeric(20,4)::text AS amount, e.memo FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.company_id = $1 AND e.status <> 'draft' AND e.source_type = 'manual' AND e.reversal_of IS NULL AND e.entry_date BETWEEN $2::date - 90 AND $2
      GROUP BY e.id HAVING sum(l.debit) >= 10000 AND mod(sum(l.debit), 1000) = 0 ORDER BY sum(l.debit) DESC LIMIT 50`, [companyId, asOf]);
  const dupPayments = await rows(db,
    `SELECT p.code AS party, p.name_ar, x.payment_date::text AS date, x.amount::numeric(20,4)::text AS amount, x.direction, count(*)::int AS times, string_agg(x.number, ', ') AS numbers
       FROM payments x JOIN parties p ON p.id = x.party_id
      WHERE x.company_id = $1 AND x.status = 'posted' AND x.payment_date BETWEEN $2::date - 90 AND $2
      GROUP BY p.id, x.payment_date, x.amount, x.direction HAVING count(*) > 1 ORDER BY x.payment_date DESC LIMIT 50`, [companyId, asOf]);
  return {
    method: { ar: "تنبيهات للمراجعة وليست اتهامًا: قيود يدوية أكبر بكثير من المعتاد لنفس الحساب (أكثر من 3 انحرافات معيارية خلال سنة)، قيود يدوية رُحّلت يوم العطلة أو ليلًا، مبالغ كبيرة مقرّبة، ودفعات متطابقة لنفس الطرف في نفس اليوم.",
      en: "Signals for review, not accusations: manual entries far above the account's usual size (z > 3 over a year), manual entries posted on the day off or at night, large round amounts, identical payments to the same party on the same day." },
    unusual_size: big, off_hours: offHours, round_amounts: round, duplicate_payments: dupPayments,
  };
}
