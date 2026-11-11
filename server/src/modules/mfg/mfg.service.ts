// Manufacturing: versioned formulas (BOM), standard cost roll-up, material
// requirements, production orders with actual costing through WIP.
//   issue      : Dr inventory_wip            / Cr raw | packaging | semi inventory
//   return     : Dr raw | packaging inventory / Cr inventory_wip
//   conversion : Dr inventory_wip            / Cr overhead_absorbed   (line hours × rate)
//   complete   : Dr inventory_quarantine     / Cr inventory_wip       (output lot, awaiting QC release)
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { ensureLot, stockIn, stockOut } from "../erp/stock.js";
import { docNumber, inventoryRole, minorUnits, postJournal, warehouseOf } from "../erp/common.js";

const one = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
const add = async (db: Db, a: string, b: string) => (await one(db, "SELECT ($1::numeric + $2::numeric)::text AS v", [a, b])).v as string;
const log = (db: Db, u: UserCtx, action: string, entityType: string, entityId: string, after?: unknown) =>
  audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action, entityType, entityId, after });

// ------------------------------------------------------------------ formulas
export async function createBom(db: Db, u: UserCtx, b: { companyId: string; itemId: string; batchQty: string; stdScrapPct?: string; stdHours?: string; notes?: string;
  lines: { itemId: string; qty: string; scrapPct?: string; substituteItemId?: string | null }[] }) {
  const item = await one(db, "SELECT * FROM items WHERE id = $1 AND company_id = $2", [b.itemId, b.companyId]);
  if (!item) throw E.validation([{ path: "itemId", message: "item not found in this company" }]);
  if (!["finished", "semi_finished"].includes(item.kind)) throw E.rule("NOT_MANUFACTURABLE", "الوصفة تكون لمنتج تام أو نصف مصنع فقط", "Formulas are for finished or semi-finished items only");
  const seen = new Set<string>();
  for (const l of b.lines) {
    if (l.itemId === b.itemId) throw E.rule("BOM_SELF_REFERENCE", "لا يمكن أن يدخل المنتج في وصفته", "A product cannot be a component of itself");
    if (seen.has(l.itemId)) throw E.validation([{ path: "lines", message: "duplicate component" }]);
    seen.add(l.itemId);
    const c = await one(db, "SELECT kind, code FROM items WHERE id = $1 AND company_id = $2", [l.itemId, b.companyId]);
    if (!c || c.kind === "service") throw E.validation([{ path: "lines", message: "components must be stock items of this company" }]);
  }
  const version = (await one(db, "SELECT coalesce(max(version), 0) + 1 AS v FROM boms WHERE item_id = $1", [b.itemId])).v;
  const bom = await one(db, `INSERT INTO boms (tenant_id, company_id, item_id, version, batch_qty, std_scrap_pct, std_hours, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [u.tenantId, b.companyId, b.itemId, version, b.batchQty, b.stdScrapPct ?? "0", b.stdHours ?? "0", b.notes ?? null, u.userId]);
  let i = 0;
  for (const l of b.lines)
    await db.query("INSERT INTO bom_lines (tenant_id, bom_id, line_no, item_id, qty, scrap_pct, substitute_item_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [u.tenantId, bom.id, ++i, l.itemId, l.qty, l.scrapPct ?? "0", l.substituteItemId ?? null]);
  await log(db, u, "bom.created", "bom", bom.id, b);
  return getBom(db, bom.id);
}

export async function approveBom(db: Db, u: UserCtx, id: string) {
  const bom = await one(db, "SELECT * FROM boms WHERE id = $1 FOR UPDATE", [id]);
  if (!bom) throw E.notFound("bom");
  if (bom.status !== "draft") throw E.rule("BOM_NOT_DRAFT", "الإصدار معتمد أو مؤرشف مسبقًا", "Only draft versions can be approved");
  if (u.enforceSod && bom.created_by === u.userId) throw E.sod();
  if (!Number((await one(db, "SELECT count(*) AS n FROM bom_lines WHERE bom_id = $1", [id])).n)) throw E.rule("EMPTY_DOCUMENT", "الوصفة بلا مكونات", "Formula has no components");
  await db.query("UPDATE boms SET status = 'archived' WHERE item_id = $1 AND status = 'approved'", [bom.item_id]);
  await db.query("UPDATE boms SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1", [id, u.userId]);
  await log(db, u, "bom.approved", "bom", id, { version: bom.version });
  return getBom(db, id);
}

export async function getBom(db: Db, id: string) {
  const h = await one(db, `SELECT b.*, i.code AS item_code, i.name_ar AS item_name_ar, u.code AS uom FROM boms b JOIN items i ON i.id = b.item_id JOIN uoms u ON u.id = i.base_uom_id WHERE b.id = $1`, [id]);
  if (!h) throw E.notFound("bom");
  const lines = (await db.query(`SELECT l.*, i.code AS item_code, i.name_ar AS item_name_ar, i.kind, u.code AS uom, s.code AS substitute_code
     FROM bom_lines l JOIN items i ON i.id = l.item_id JOIN uoms u ON u.id = i.base_uom_id LEFT JOIN items s ON s.id = l.substitute_item_id WHERE l.bom_id = $1 ORDER BY line_no`, [id])).rows;
  return { ...h, lines };
}

/** standard cost of one output unit = Σ(component qty × (1+scrap%) × current average cost) + line hours × rate, ÷ batch output */
export async function standardCost(db: Db, bomId: string, workCenterId?: string | null) {
  const bom = await getBom(db, bomId);
  const parts = [];
  let material = "0";
  for (const l of bom.lines) {
    const avg = await one(db, `SELECT CASE WHEN sum(qty) > 0 THEN round(sum(value) / sum(qty), 6) END AS c FROM stock_balances WHERE item_id = $1`, [l.item_id]);
    const qty = (await one(db, "SELECT round($1::numeric * (1 + $2::numeric / 100), 6)::text AS q", [l.qty, l.scrap_pct])).q;
    const cost = avg.c === null ? null : (await one(db, "SELECT round($1::numeric * $2::numeric, 4)::text AS v", [qty, avg.c])).v;
    if (cost) material = await add(db, material, cost);
    parts.push({ itemId: l.item_id, code: l.item_code, qty, unitCost: avg.c, cost, missingCost: avg.c === null });
  }
  const wc = workCenterId ? await one(db, "SELECT rate_per_hour FROM work_centers WHERE id = $1", [workCenterId]) : null;
  const conversion = (await one(db, "SELECT round($1::numeric * $2::numeric, 4)::text AS v", [bom.std_hours, wc?.rate_per_hour ?? 0])).v;
  const unit = (await one(db, "SELECT round(($1::numeric + $2::numeric) / $3::numeric, 6)::text AS v", [material, conversion, bom.batch_qty])).v;
  return { bomId, batchQty: bom.batch_qty, material, conversion, unitCost: unit, parts, complete: !parts.some((p) => p.missingCost) };
}

// ------------------------------------------------------------------ requirements & MRP
/** components required for `qty` of output, compared with what is issued and available (valid, non-held lots only) */
export async function requirements(db: Db, bomId: string, qty: string, warehouseId: string, orderId?: string | null, date?: string) {
  const bom = await getBom(db, bomId);
  const out = [];
  for (const l of bom.lines) {
    const required = (await one(db, "SELECT round($1::numeric * $2::numeric / $3::numeric * (1 + $4::numeric / 100), 4)::text AS r", [l.qty, qty, bom.batch_qty, l.scrap_pct])).r;
    const issued = orderId
      ? (await one(db, `SELECT coalesce(sum(CASE WHEN kind = 'issue' THEN qty ELSE -qty END), 0)::text AS q FROM production_entries WHERE order_id = $1 AND item_id = ANY($2::uuid[]) AND kind IN ('issue','return')`,
          [orderId, [l.item_id, l.substitute_item_id].filter(Boolean)])).q : "0";
    const avail = await one(db,
      `SELECT CASE WHEN i.track_lots THEN coalesce((SELECT sum(lb.qty) FROM lot_balances lb JOIN lots lt ON lt.id = lb.lot_id WHERE lb.warehouse_id = $2 AND lt.item_id = i.id
                AND NOT lt.on_hold AND (lt.expiry_date IS NULL OR lt.expiry_date >= $3::date)), 0)
              ELSE coalesce((SELECT qty FROM stock_balances WHERE warehouse_id = $2 AND item_id = i.id), 0) END::text AS a FROM items i WHERE i.id = $1`,
      [l.item_id, warehouseId, date ?? new Date().toISOString().slice(0, 10)]);
    const remaining = (await one(db, "SELECT greatest($1::numeric - $2::numeric, 0)::text AS r", [required, issued])).r;
    const shortage = (await one(db, "SELECT greatest($1::numeric - $2::numeric, 0)::text AS s", [remaining, avail.a])).s;
    out.push({ itemId: l.item_id, code: l.item_code, name: l.item_name_ar, uom: l.uom, required, issued, remaining, available: avail.a, shortage, substituteCode: l.substitute_code });
  }
  return out;
}

/** MRP: net requirements of all open orders against stock in non-quarantine warehouses, with purchase suggestions */
export async function mrp(db: Db, companyId: string) {
  const orders = (await db.query("SELECT * FROM production_orders WHERE company_id = $1 AND status IN ('draft','released','in_progress')", [companyId])).rows;
  const need = new Map<string, string>();
  for (const o of orders) {
    for (const r of await requirements(db, o.bom_id, o.planned_qty, o.material_warehouse_id, o.id)) need.set(r.itemId, await add(db, need.get(r.itemId) ?? "0", r.remaining));
  }
  if (!need.size) return { orders: orders.length, lines: [] };
  const rows = (await db.query(
    `SELECT i.id, i.code, i.name_ar, i.kind, u.code AS uom, i.reorder_level,
            coalesce((SELECT sum(b.qty) FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id WHERE b.item_id = i.id AND w.kind NOT IN ('quarantine','damaged')), 0) AS on_hand
       FROM items i JOIN uoms u ON u.id = i.base_uom_id WHERE i.id = ANY($1::uuid[]) ORDER BY i.code`, [[...need.keys()]])).rows;
  const lines = [];
  for (const r of rows) {
    const s = await one(db, "SELECT greatest($1::numeric - $2::numeric, 0)::text AS short, greatest($1::numeric - $2::numeric + coalesce($3::numeric, 0), 0)::text AS suggest",
      [need.get(r.id), r.on_hand, r.reorder_level]);
    lines.push({ ...r, required: need.get(r.id), shortage: s.short, suggestedPurchase: Number(s.short) > 0 ? s.suggest : "0" });
  }
  return { orders: orders.length, lines };
}

// ------------------------------------------------------------------ production orders
export async function createOrder(db: Db, u: UserCtx, b: { companyId: string; itemId: string; bomId?: string; workCenterId?: string | null; plannedQty: string;
  materialWarehouseId: string; outputWarehouseId: string; plannedDate: string; notes?: string }) {
  const bom = b.bomId ? await one(db, "SELECT * FROM boms WHERE id = $1 AND item_id = $2", [b.bomId, b.itemId])
    : await one(db, "SELECT * FROM boms WHERE item_id = $1 AND status = 'approved'", [b.itemId]);
  if (!bom || bom.status !== "approved") throw E.rule("NO_APPROVED_BOM", "لا توجد وصفة معتمدة لهذا المنتج", "The product has no approved formula");
  await warehouseOf(db, b.materialWarehouseId, b.companyId);
  const out = await warehouseOf(db, b.outputWarehouseId, b.companyId);
  if (out.kind !== "quarantine") throw E.rule("OUTPUT_MUST_BE_QUARANTINE", "الإنتاج التام يدخل مخزن الحجر حتى يُفحص ويُفرج عنه", "Finished output must go to a quarantine warehouse until QC release");
  if (b.workCenterId && !(await one(db, "SELECT 1 AS x FROM work_centers WHERE id = $1 AND company_id = $2 AND is_active", [b.workCenterId, b.companyId])))
    throw E.validation([{ path: "workCenterId", message: "work center not found" }]);
  const o = await one(db, `INSERT INTO production_orders (tenant_id, company_id, item_id, bom_id, work_center_id, planned_qty, material_warehouse_id, output_warehouse_id, planned_date, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [u.tenantId, b.companyId, b.itemId, bom.id, b.workCenterId ?? null, b.plannedQty, b.materialWarehouseId, b.outputWarehouseId, b.plannedDate, b.notes ?? null, u.userId]);
  await log(db, u, "production_order.created", "production_order", o.id, b);
  return getOrder(db, o.id);
}

async function lockOrder(db: Db, id: string, allowed: string[]) {
  const o = await one(db, "SELECT * FROM production_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!o) throw E.notFound("production order");
  if (!allowed.includes(o.status)) throw E.rule("ORDER_STATUS", `أمر الإنتاج في حالة «${o.status}» ولا يسمح بهذه العملية`, `Production order is ${o.status}; operation not allowed`, { status: o.status });
  return o;
}

export async function releaseOrder(db: Db, u: UserCtx, id: string) {
  const o = await lockOrder(db, id, ["draft"]);
  const bom = await one(db, "SELECT status FROM boms WHERE id = $1", [o.bom_id]);
  if (bom.status !== "approved") throw E.rule("NO_APPROVED_BOM", "إصدار الوصفة لم يعد معتمدًا", "The formula version is no longer approved");
  const std = await standardCost(db, o.bom_id, o.work_center_id);
  const number = await docNumber(db, u, o.company_id, "MO", o.planned_date);
  await db.query("UPDATE production_orders SET status = 'released', number = $2, std_unit_cost = $3, released_by = $4 WHERE id = $1", [id, number, std.unitCost, u.userId]);
  await log(db, u, "production_order.released", "production_order", id, { number, stdUnitCost: std.unitCost });
  return getOrder(db, id);
}

export async function issueMaterial(db: Db, u: UserCtx, id: string, b: { itemId: string; qty: string; lotId?: string | null; entryDate: string; kind?: "issue" | "return" }) {
  const o = await lockOrder(db, id, ["released", "in_progress"]);
  const kind = b.kind ?? "issue";
  const allowed = (await db.query("SELECT item_id, substitute_item_id FROM bom_lines WHERE bom_id = $1", [o.bom_id])).rows.flatMap((r) => [r.item_id, r.substitute_item_id]).filter(Boolean);
  if (!allowed.includes(b.itemId)) throw E.rule("NOT_IN_BOM", "المادة ليست ضمن الوصفة المعتمدة ولا بديلًا معتمدًا لها", "Material is not a component or approved substitute of this formula");
  const item = await one(db, "SELECT * FROM items WHERE id = $1", [b.itemId]);
  const wh = await warehouseOf(db, o.material_warehouse_id, o.company_id);
  const src = { companyId: o.company_id, date: b.entryDate, sourceType: "production_order", sourceId: id };
  const role = inventoryRole(wh.kind, item.kind);
  const created: string[] = [];
  if (kind === "issue") {
    // expired or held material never goes into food (forSale = strict lot rules)
    const out = await stockOut(db, u, { ...src, warehouseId: wh.id, itemId: b.itemId, lotId: b.lotId, qty: b.qty, trackLots: item.track_lots, itemCode: item.code, forSale: true });
    let left = out.value;
    for (const [k, a] of out.allocations.entries()) {
      const v = k === out.allocations.length - 1 ? left : (await one(db, "SELECT round($1::numeric * $2::numeric / $3::numeric, $4)::text AS v", [out.value, a.qty, b.qty, await minorUnits(db, o.company_id)])).v;
      left = (await one(db, "SELECT ($1::numeric - $2::numeric)::text AS r", [left, v])).r;
      created.push((await one(db, `INSERT INTO production_entries (tenant_id, order_id, kind, entry_date, item_id, lot_id, qty, value, created_by) VALUES ($1,$2,'issue',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [u.tenantId, id, b.entryDate, b.itemId, a.lotId, a.qty, v, u.userId])).id);
    }
    const je = await postJournal(db, u, { ...src, memo: `صرف مواد لأمر الإنتاج ${o.number}`, sourceType: "production_issue", sourceId: created[0],
      parts: [{ role: "inventory_wip", amount: out.value }, { role, amount: "-" + out.value }] });
    await db.query("UPDATE production_orders SET status = 'in_progress', started_at = coalesce(started_at, now()) WHERE id = $1", [id]);
    await log(db, u, "production.material_issued", "production_order", id, { itemId: b.itemId, qty: b.qty, value: out.value, journal: je });
    return { value: out.value, allocations: out.allocations };
  }
  // return unused material at the order's own issue cost for that item/lot
  if (item.track_lots && !b.lotId) throw E.rule("LOT_REQUIRED", "حدد التشغيلة المرتجعة", "Specify the lot being returned");
  const net = await one(db, `SELECT coalesce(sum(CASE WHEN kind = 'issue' THEN qty ELSE -qty END),0)::text AS q, coalesce(sum(CASE WHEN kind = 'issue' THEN value ELSE -value END),0)::text AS v
     FROM production_entries WHERE order_id = $1 AND item_id = $2 AND lot_id IS NOT DISTINCT FROM $3`, [id, b.itemId, b.lotId ?? null]);
  if ((await one(db, "SELECT $1::numeric > $2::numeric AS over", [b.qty, net.q])).over) throw E.rule("RETURN_EXCEEDS_ISSUED", "الكمية المرتجعة أكبر من المصروف للأمر", "Returned quantity exceeds the net issued quantity");
  const value = (await one(db, "SELECT CASE WHEN $1::numeric = $2::numeric THEN $3::numeric ELSE round($3::numeric * $1::numeric / $2::numeric, $4) END::numeric(20,4)::text AS v", [b.qty, net.q, net.v, await minorUnits(db, o.company_id)])).v;
  await stockIn(db, u, { ...src, warehouseId: wh.id, itemId: b.itemId, lotId: b.lotId ?? null, qty: b.qty, value });
  const e = await one(db, `INSERT INTO production_entries (tenant_id, order_id, kind, entry_date, item_id, lot_id, qty, value, created_by) VALUES ($1,$2,'return',$3,$4,$5,$6,$7,$8) RETURNING id`,
    [u.tenantId, id, b.entryDate, b.itemId, b.lotId ?? null, b.qty, value, u.userId]);
  await postJournal(db, u, { ...src, memo: `إرجاع مواد من أمر الإنتاج ${o.number}`, sourceType: "production_return", sourceId: e.id,
    parts: [{ role, amount: value }, { role: "inventory_wip", amount: "-" + value }] });
  await log(db, u, "production.material_returned", "production_order", id, { itemId: b.itemId, qty: b.qty, value });
  return { value };
}

export async function recordTime(db: Db, u: UserCtx, id: string, b: { hours: string; entryDate: string; notes?: string }) {
  const o = await lockOrder(db, id, ["released", "in_progress"]);
  if (!o.work_center_id) throw E.rule("NO_WORK_CENTER", "حدد خط الإنتاج للأمر أولًا", "The order has no work center");
  const wc = await one(db, "SELECT * FROM work_centers WHERE id = $1", [o.work_center_id]);
  const value = (await one(db, "SELECT round($1::numeric * $2::numeric, $3)::numeric(20,4)::text AS v", [b.hours, wc.rate_per_hour, await minorUnits(db, o.company_id)])).v;
  const e = await one(db, `INSERT INTO production_entries (tenant_id, order_id, kind, entry_date, hours, value, notes, created_by) VALUES ($1,$2,'conversion',$3,$4,$5,$6,$7) RETURNING id`,
    [u.tenantId, id, b.entryDate, b.hours, value, b.notes ?? null, u.userId]);
  await postJournal(db, u, { companyId: o.company_id, date: b.entryDate, memo: `ساعات تشغيل ${wc.code} لأمر الإنتاج ${o.number}`, sourceType: "production_conversion", sourceId: e.id,
    parts: [{ role: "inventory_wip", amount: value }, { role: "overhead_absorbed", amount: "-" + value }] });
  await db.query("UPDATE production_orders SET status = 'in_progress', started_at = coalesce(started_at, now()) WHERE id = $1", [id]);
  await log(db, u, "production.time_recorded", "production_order", id, { hours: b.hours, value });
  return { value };
}

export async function completeOrder(db: Db, u: UserCtx, id: string, b: { producedQty: string; scrapQty?: string; lotNo: string; productionDate: string; expiryDate?: string; entryDate: string }) {
  const o = await lockOrder(db, id, ["in_progress"]);
  const wip = await one(db, `SELECT coalesce(sum(CASE WHEN kind = 'return' THEN -value ELSE value END),0)::text AS v,
       count(*) FILTER (WHERE kind = 'issue') AS issues FROM production_entries WHERE order_id = $1`, [id]);
  if (!Number(wip.issues)) throw E.rule("NO_MATERIAL_ISSUED", "لم تُصرف أي مواد لهذا الأمر", "No material was issued to this order");
  const item = await one(db, "SELECT * FROM items WHERE id = $1", [o.item_id]);
  let expiry = b.expiryDate ?? null;
  if (!expiry && item.shelf_life_days) expiry = (await one(db, "SELECT ($1::date + $2::int)::text AS d", [b.productionDate, item.shelf_life_days])).d;
  const lotId = await ensureLot(db, u, o.item_id, b.lotNo, b.productionDate, expiry);
  if ((await one(db, "SELECT count(*) AS n FROM stock_moves WHERE lot_id = $1", [lotId])).n > 0) throw E.rule("LOT_ALREADY_USED", "رقم التشغيلة مستخدم مسبقًا", "This lot number already has stock movements");
  const out = await warehouseOf(db, o.output_warehouse_id, o.company_id);
  await stockIn(db, u, { companyId: o.company_id, date: b.entryDate, sourceType: "production_order", sourceId: id, warehouseId: out.id, itemId: o.item_id, lotId, qty: b.producedQty, value: wip.v });
  const je = await postJournal(db, u, { companyId: o.company_id, date: b.entryDate, memo: `استلام إنتاج تام — أمر ${o.number} — تشغيلة ${b.lotNo}`, sourceType: "production_output", sourceId: id,
    parts: [{ role: inventoryRole(out.kind, item.kind), amount: wip.v }, { role: "inventory_wip", amount: "-" + wip.v }] });
  await db.query(`UPDATE production_orders SET status = 'completed', produced_qty = $2, scrap_qty = $3, output_lot_id = $4, actual_cost = $5, completed_by = $6, completed_at = now() WHERE id = $1`,
    [id, b.producedQty, b.scrapQty ?? "0", lotId, wip.v, u.userId]);
  await log(db, u, "production_order.completed", "production_order", id, { producedQty: b.producedQty, scrapQty: b.scrapQty, lot: b.lotNo, actualCost: wip.v, journal: je });
  return getOrder(db, id);
}

export async function getOrder(db: Db, id: string) {
  const o = await one(db, `SELECT o.*, i.code AS item_code, i.name_ar AS item_name_ar, u.code AS uom, b.version AS bom_version, wc.code AS work_center_code,
       mw.code AS material_warehouse_code, ow.code AS output_warehouse_code, l.lot_no AS output_lot_no, l.expiry_date AS output_expiry
     FROM production_orders o JOIN items i ON i.id = o.item_id JOIN uoms u ON u.id = i.base_uom_id JOIN boms b ON b.id = o.bom_id LEFT JOIN work_centers wc ON wc.id = o.work_center_id
     JOIN warehouses mw ON mw.id = o.material_warehouse_id JOIN warehouses ow ON ow.id = o.output_warehouse_id LEFT JOIN lots l ON l.id = o.output_lot_id WHERE o.id = $1`, [id]);
  if (!o) throw E.notFound("production order");
  const entries = (await db.query(`SELECT e.*, i.code AS item_code, i.name_ar AS item_name_ar, l.lot_no FROM production_entries e LEFT JOIN items i ON i.id = e.item_id
     LEFT JOIN lots l ON l.id = e.lot_id WHERE e.order_id = $1 ORDER BY e.created_at`, [id])).rows;
  return { ...o, entries };
}

/** actual vs standard by component, conversion, unit cost, yield */
export async function costReport(db: Db, id: string) {
  const o = await getOrder(db, id);
  const bom = await getBom(db, o.bom_id);
  const basis = o.produced_qty ?? o.planned_qty;
  const components = [];
  for (const l of bom.lines) {
    const act = await one(db, `SELECT coalesce(sum(CASE WHEN kind = 'issue' THEN qty ELSE -qty END),0)::text AS q, coalesce(sum(CASE WHEN kind = 'issue' THEN value ELSE -value END),0)::text AS v
       FROM production_entries WHERE order_id = $1 AND item_id = ANY($2::uuid[]) AND kind IN ('issue','return')`, [id, [l.item_id, l.substitute_item_id].filter(Boolean)]);
    const stdQty = (await one(db, "SELECT round($1::numeric * $2::numeric / $3::numeric * (1 + $4::numeric / 100), 4)::text AS q", [l.qty, basis, bom.batch_qty, l.scrap_pct])).q;
    const variance = (await one(db, "SELECT ($1::numeric - $2::numeric)::text AS d, CASE WHEN $2::numeric > 0 THEN round(($1::numeric - $2::numeric) * 100 / $2::numeric, 2) END AS pct", [act.q, stdQty]));
    components.push({ code: l.item_code, name: l.item_name_ar, uom: l.uom, stdQty, actualQty: act.q, qtyVariance: variance.d, qtyVariancePct: variance.pct, actualValue: act.v });
  }
  const conv = await one(db, "SELECT coalesce(sum(hours),0)::text AS h, coalesce(sum(value),0)::text AS v FROM production_entries WHERE order_id = $1 AND kind = 'conversion'", [id]);
  const total = await one(db, "SELECT coalesce(sum(CASE WHEN kind = 'return' THEN -value ELSE value END),0)::text AS v FROM production_entries WHERE order_id = $1", [id]);
  const unit = o.produced_qty ? (await one(db, "SELECT round($1::numeric / $2::numeric, 6)::text AS u", [total.v, o.produced_qty])).u : null;
  const stdTotal = o.std_unit_cost ? (await one(db, "SELECT round($1::numeric * $2::numeric, 4)::text AS t", [o.std_unit_cost, basis])).t : null;
  return {
    order: { id, number: o.number, status: o.status, item: o.item_code, plannedQty: o.planned_qty, producedQty: o.produced_qty, scrapQty: o.scrap_qty, lot: o.output_lot_no },
    yieldPct: o.produced_qty ? (Number(o.produced_qty) * 100 / Number(o.planned_qty)).toFixed(2) : null,
    components, conversion: { hours: conv.h, value: conv.v },
    actualTotal: total.v, actualUnitCost: unit, standardUnitCost: o.std_unit_cost, standardTotal: stdTotal,
    costVariance: stdTotal ? (await one(db, "SELECT ($1::numeric - $2::numeric)::text AS v", [total.v, stdTotal])).v : null,
  };
}
