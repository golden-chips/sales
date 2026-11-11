// Quality & traceability: specs (incl. HACCP CCPs), checks, non-conformance (CAPA),
// full backward/forward genealogy through production orders, and recalls.
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { docNumber } from "../erp/common.js";

const one = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
const today = () => new Date().toISOString().slice(0, 10);

export async function replaceSpecs(db: Db, u: UserCtx, itemId: string, stage: string, specs: { parameter: string; unit?: string; min?: string | null; max?: string | null; isCcp?: boolean }[]) {
  const before = (await db.query("SELECT * FROM quality_specs WHERE item_id = $1 AND stage = $2", [itemId, stage])).rows;
  await db.query("DELETE FROM quality_specs WHERE item_id = $1 AND stage = $2", [itemId, stage]);
  for (const s of specs)
    await db.query("INSERT INTO quality_specs (tenant_id, item_id, stage, parameter, unit, min_value, max_value, is_ccp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [u.tenantId, itemId, stage, s.parameter, s.unit ?? null, s.min ?? null, s.max ?? null, !!s.isCcp]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "quality.specs_replaced", entityType: "item", entityId: itemId, before, after: { stage, specs } });
  return (await db.query("SELECT * FROM quality_specs WHERE item_id = $1 AND stage = $2 ORDER BY parameter", [itemId, stage])).rows;
}

/**
 * Records a check. Every spec of (item, stage) must be measured; numeric
 * values are judged against min/max by the system (not by the inspector).
 * Any failure (CCP or not) fails the lot, puts it ON HOLD and opens an NCR.
 */
export async function recordCheck(db: Db, u: UserCtx, b: { companyId: string; lotId: string; stage: "receiving" | "in_process" | "final" | "return"; productionOrderId?: string | null;
  sampleSize?: string; notes?: string; results: { parameter: string; value?: string | null; textValue?: string | null; passed?: boolean }[] }) {
  const lot = await one(db, "SELECT l.*, i.company_id FROM lots l JOIN items i ON i.id = l.item_id WHERE l.id = $1", [b.lotId]);
  if (!lot || lot.company_id !== b.companyId) throw E.validation([{ path: "lotId", message: "lot not found in this company" }]);
  const specs = (await db.query("SELECT * FROM quality_specs WHERE item_id = $1 AND stage = $2", [lot.item_id, b.stage])).rows;
  const given = new Map(b.results.map((r) => [r.parameter, r]));
  const missing = specs.filter((s) => !given.has(s.parameter)).map((s) => s.parameter);
  if (missing.length) throw E.rule("QC_RESULTS_MISSING", `نتائج ناقصة للمواصفات: ${missing.join("، ")}`, `Missing results for: ${missing.join(", ")}`, { missing });
  if (!specs.length && !b.results.length) throw E.validation([{ path: "results", message: "at least one result is required" }]);
  const rows = [];
  for (const r of b.results) {
    const s = specs.find((x) => x.parameter === r.parameter);
    let passed: boolean;
    if (s && (s.min_value !== null || s.max_value !== null)) {
      if (r.value === undefined || r.value === null || r.value === "") throw E.validation([{ path: r.parameter, message: "numeric value required" }]);
      passed = (await one(db, "SELECT ($2::numeric IS NULL OR $1::numeric >= $2::numeric) AND ($3::numeric IS NULL OR $1::numeric <= $3::numeric) AS ok", [r.value, s.min_value, s.max_value])).ok;
    } else {
      if (r.passed === undefined) throw E.validation([{ path: r.parameter, message: "pass/fail required for non-numeric parameters" }]);
      passed = r.passed;
    }
    rows.push({ ...r, unit: s?.unit ?? null, min: s?.min_value ?? null, max: s?.max_value ?? null, isCcp: !!s?.is_ccp, passed });
  }
  const result = rows.every((r) => r.passed) ? "pass" : "fail";
  const number = await docNumber(db, u, b.companyId, "QC", today());
  const chk = await one(db, `INSERT INTO quality_checks (tenant_id, company_id, number, lot_id, stage, production_order_id, result, sample_size, notes, checked_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [u.tenantId, b.companyId, number, b.lotId, b.stage, b.productionOrderId ?? null, result, b.sampleSize ?? null, b.notes ?? null, u.userId]);
  for (const r of rows)
    await db.query(`INSERT INTO quality_check_results (tenant_id, check_id, parameter, unit, min_value, max_value, value, text_value, is_ccp, passed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [u.tenantId, chk.id, r.parameter, r.unit, r.min, r.max, r.value ?? null, r.textValue ?? null, r.isCcp, r.passed]);
  let ncr = null;
  if (result === "fail") {
    const failed = rows.filter((r) => !r.passed);
    const ccp = failed.some((r) => r.isCcp);
    await db.query("UPDATE lots SET on_hold = true, hold_reason = $2 WHERE id = $1", [b.lotId, `QC ${number} failed${ccp ? " (CCP)" : ""}`]);
    ncr = await one(db, `INSERT INTO nonconformances (tenant_id, company_id, number, lot_id, check_id, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [u.tenantId, b.companyId, await docNumber(db, u, b.companyId, "NCR", today()), b.lotId, chk.id,
       `${ccp ? "فشل نقطة تحكم حرجة (CCP): " : "عدم مطابقة: "}${failed.map((f) => `${f.parameter}=${f.value ?? f.textValue ?? "✗"}`).join("، ")}`, u.userId]);
  } else if (lot.on_hold && String(lot.hold_reason ?? "").startsWith("QC ")) {
    // a later passing re-inspection lifts a QC hold — but never a recall hold
    const openNcr = await one(db, "SELECT count(*) AS n FROM nonconformances WHERE lot_id = $1 AND status = 'open'", [b.lotId]);
    if (Number(openNcr.n) === 0) await db.query("UPDATE lots SET on_hold = false, hold_reason = NULL WHERE id = $1", [b.lotId]);
  }
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: `quality.check_${result}`, entityType: "lot", entityId: b.lotId, after: { number, stage: b.stage, ncr: ncr?.number } });
  return { ...chk, results: rows, ncr };
}

export async function closeNcr(db: Db, u: UserCtx, id: string, b: { disposition: "rework" | "scrap" | "return_to_supplier" | "use_as_is"; rootCause: string; correctiveAction: string; preventiveAction?: string }) {
  const n = await one(db, "SELECT * FROM nonconformances WHERE id = $1 FOR UPDATE", [id]);
  if (!n) throw E.notFound("nonconformance");
  if (n.status === "closed") throw E.rule("NCR_CLOSED", "الحالة مغلقة مسبقًا", "Already closed");
  const r = await one(db, `UPDATE nonconformances SET status = 'closed', disposition = $2, root_cause = $3, corrective_action = $4, preventive_action = $5, closed_by = $6, closed_at = now()
     WHERE id = $1 RETURNING *`, [id, b.disposition, b.rootCause, b.correctiveAction, b.preventiveAction ?? null, u.userId]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "quality.ncr_closed", entityType: "nonconformance", entityId: id, before: n, after: r });
  return r;
}

// ------------------------------------------------------------------ genealogy
/** backward: which supplier lots went into this lot (recursively through production) */
export async function traceBackward(db: Db, lotId: string) {
  const seen = new Set<string>(); const nodes: any[] = []; const queue = [{ lotId, depth: 0 }];
  while (queue.length) {
    const { lotId: id, depth } = queue.shift()!;
    if (seen.has(id)) continue; seen.add(id);
    const lot = await one(db, `SELECT l.id, l.lot_no, l.production_date, l.expiry_date, l.on_hold, i.code AS item_code, i.name_ar AS item_name_ar, i.kind, s.code AS supplier_code, s.name_ar AS supplier_name_ar,
        (SELECT o.number FROM production_orders o WHERE o.output_lot_id = l.id) AS produced_by_order
      FROM lots l JOIN items i ON i.id = l.item_id LEFT JOIN parties s ON s.id = l.supplier_id WHERE l.id = $1`, [id]);
    const inputs = (await db.query(`SELECT e.lot_id, sum(e.qty) AS qty FROM production_entries e JOIN production_orders o ON o.id = e.order_id
        WHERE o.output_lot_id = $1 AND e.kind = 'issue' AND e.lot_id IS NOT NULL GROUP BY e.lot_id`, [id])).rows;
    nodes.push({ ...lot, depth, inputs: inputs.map((x) => ({ lotId: x.lot_id, qty: x.qty })) });
    for (const x of inputs) queue.push({ lotId: x.lot_id, depth: depth + 1 });
  }
  return nodes;
}

/** forward: every lot made from this lot (recursively), where each lot is now, and every customer who received any of them */
export async function traceForward(db: Db, lotId: string) {
  const lots: string[] = []; const seen = new Set<string>(); const queue = [lotId];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue; seen.add(id); lots.push(id);
    const children = (await db.query(`SELECT DISTINCT o.output_lot_id AS id FROM production_entries e JOIN production_orders o ON o.id = e.order_id
        WHERE e.lot_id = $1 AND e.kind = 'issue' AND o.output_lot_id IS NOT NULL`, [id])).rows;
    for (const c of children) queue.push(c.id);
  }
  const affectedLots = (await db.query(`SELECT l.id, l.lot_no, l.expiry_date, l.on_hold, i.code AS item_code, i.name_ar AS item_name_ar,
       coalesce((SELECT json_agg(json_build_object('warehouse', w.code, 'kind', w.kind, 'qty', lb.qty)) FROM lot_balances lb JOIN warehouses w ON w.id = lb.warehouse_id WHERE lb.lot_id = l.id AND lb.qty > 0), '[]') AS on_hand
     FROM lots l JOIN items i ON i.id = l.item_id WHERE l.id = ANY($1::uuid[]) ORDER BY i.code, l.lot_no`, [lots])).rows;
  const customers = (await db.query(`WITH x AS (
       SELECT si.customer_id, m.lot_id, -m.qty AS sold, 0::numeric AS returned FROM stock_moves m JOIN sales_invoices si ON si.id = m.source_id WHERE m.source_type = 'sales_invoice' AND m.lot_id = ANY($1::uuid[])
       UNION ALL
       SELECT si.customer_id, m.lot_id, 0, m.qty FROM stock_moves m JOIN sales_returns sr ON sr.id = m.source_id JOIN sales_invoices si ON si.id = sr.invoice_id WHERE m.source_type = 'sales_return' AND m.lot_id = ANY($1::uuid[]))
     SELECT p.id, p.code, p.name_ar, p.phone, p.city, l.lot_no, sum(x.sold) AS sold, sum(x.returned) AS returned, sum(x.sold) - sum(x.returned) AS in_market
       FROM x JOIN parties p ON p.id = x.customer_id JOIN lots l ON l.id = x.lot_id GROUP BY p.id, l.lot_no ORDER BY p.code, l.lot_no`, [lots])).rows;
  return { lots: affectedLots, customers };
}

export async function createRecall(db: Db, u: UserCtx, b: { companyId: string; lotId: string; reason: string }) {
  const lot = await one(db, "SELECT l.*, i.company_id FROM lots l JOIN items i ON i.id = l.item_id WHERE l.id = $1", [b.lotId]);
  if (!lot || lot.company_id !== b.companyId) throw E.validation([{ path: "lotId", message: "lot not found in this company" }]);
  const forward = await traceForward(db, b.lotId);
  const backward = await traceBackward(db, b.lotId);
  const number = await docNumber(db, u, b.companyId, "RC", today());
  // stop every affected lot immediately: no sale, no release, no production use
  await db.query("UPDATE lots SET on_hold = true, hold_reason = $2 WHERE id = ANY($1::uuid[])", [forward.lots.map((l) => l.id), `RECALL ${number}`]);
  const r = await one(db, `INSERT INTO recalls (tenant_id, company_id, number, lot_id, reason, snapshot, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [u.tenantId, b.companyId, number, b.lotId, b.reason, JSON.stringify({ forward, backward, at: new Date().toISOString() }), u.userId]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "quality.recall_created", entityType: "recall", entityId: r.id,
    after: { number, lot: lot.lot_no, lotsHeld: forward.lots.length, customers: forward.customers.length } });
  return { ...r, forward, backward };
}
