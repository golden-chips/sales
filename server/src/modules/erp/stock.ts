// Perpetual inventory engine — weighted average cost per (warehouse, item),
// lot quantities per (warehouse, lot), FEFO allocation for issues.
// All arithmetic is done in PostgreSQL numeric; balances carry CHECK (qty >= 0)
// so negative stock is impossible even under concurrency (rows are locked).
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";

export interface MoveSource { companyId: string; date: string; sourceType: string; sourceId: string; sourceLineId?: string | null }

export async function ensureLot(db: Db, u: UserCtx, itemId: string, lotNo: string, productionDate?: string | null, expiryDate?: string | null, supplierId?: string | null) {
  const ex = (await db.query("SELECT * FROM lots WHERE item_id = $1 AND lot_no = $2", [itemId, lotNo])).rows[0];
  if (ex) {
    if ((expiryDate && ex.expiry_date && ex.expiry_date !== expiryDate) || (productionDate && ex.production_date && ex.production_date !== productionDate))
      throw E.rule("LOT_DATES_MISMATCH", `التشغيلة ${lotNo} مسجلة بتواريخ مختلفة`, `Lot ${lotNo} already exists with different dates`);
    return ex.id as string;
  }
  return (await db.query("INSERT INTO lots (tenant_id, item_id, lot_no, production_date, expiry_date, supplier_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [u.tenantId, itemId, lotNo, productionDate ?? null, expiryDate ?? null, supplierId ?? null])).rows[0].id as string;
}

/**
 * Stock in. Either unitCost (per base unit) or an exact total value is given;
 * an exact value avoids rounding drift between the document total and the GL.
 */
export async function stockIn(db: Db, u: UserCtx, s: MoveSource & { warehouseId: string; itemId: string; lotId?: string | null; qty: string; unitCost?: string; value?: string }) {
  const r = (await db.query(
    `WITH v AS (SELECT coalesce($6::numeric, round($4::numeric * $5::numeric, 4)) AS v)
     INSERT INTO stock_balances (tenant_id, warehouse_id, item_id, qty, value) SELECT $1,$2,$3,$4::numeric, v.v FROM v
     ON CONFLICT (warehouse_id, item_id) DO UPDATE SET qty = stock_balances.qty + EXCLUDED.qty, value = stock_balances.value + EXCLUDED.value, updated_at = now()
     RETURNING (SELECT v::text FROM v) AS v, round((SELECT v FROM v) / $4::numeric, 6)::text AS uc`,
    [u.tenantId, s.warehouseId, s.itemId, s.qty, s.unitCost ?? "0", s.value ?? null])).rows[0];
  if (s.lotId) await db.query(
    `INSERT INTO lot_balances (tenant_id, warehouse_id, lot_id, qty) VALUES ($1,$2,$3,$4) ON CONFLICT (warehouse_id, lot_id) DO UPDATE SET qty = lot_balances.qty + EXCLUDED.qty`,
    [u.tenantId, s.warehouseId, s.lotId, s.qty]);
  await db.query(
    `INSERT INTO stock_moves (tenant_id, company_id, warehouse_id, item_id, lot_id, move_date, qty, unit_cost, value, source_type, source_id, source_line_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [u.tenantId, s.companyId, s.warehouseId, s.itemId, s.lotId ?? null, s.date, s.qty, r.uc, r.v, s.sourceType, s.sourceId, s.sourceLineId ?? null, u.userId]);
  return r.v as string;
}

/**
 * Stock out at the current weighted-average cost. If the item tracks lots and
 * no lot is given, quantities are allocated FEFO (earliest expiry first).
 * Returns total cost value and the lot allocations.
 */
export async function stockOut(db: Db, u: UserCtx, s: MoveSource & { warehouseId: string; itemId: string; lotId?: string | null; qty: string; trackLots: boolean; itemCode: string; forSale?: boolean }) {
  const bal = (await db.query("SELECT qty, value FROM stock_balances WHERE warehouse_id = $1 AND item_id = $2 FOR UPDATE", [s.warehouseId, s.itemId])).rows[0];
  const enough = bal ? (await db.query("SELECT $1::numeric >= $2::numeric AS ok", [bal.qty, s.qty])).rows[0].ok : false;
  if (!enough) throw E.rule("INSUFFICIENT_STOCK", `الكمية غير متوفرة للصنف ${s.itemCode} (المتاح ${bal?.qty ?? 0})`, `Insufficient stock for ${s.itemCode} (available ${bal?.qty ?? 0})`, { itemId: s.itemId, available: bal?.qty ?? "0", requested: s.qty });

  let allocations: { lotId: string | null; qty: string }[] = [{ lotId: null, qty: s.qty }];
  if (s.trackLots) {
    if (s.lotId) {
      // food safety: an expired lot can be moved (quarantine, write-off) but never sold
      if (s.forSale) {
        const exp = (await db.query("SELECT lot_no, expiry_date FROM lots WHERE id = $1 AND expiry_date < $2::date", [s.lotId, s.date])).rows[0];
        if (exp) throw E.rule("LOT_EXPIRED", `التشغيلة ${exp.lot_no} منتهية الصلاحية (${exp.expiry_date}) ولا يجوز بيعها`, `Lot ${exp.lot_no} expired on ${exp.expiry_date} and cannot be sold`);
      }
      allocations = [{ lotId: s.lotId, qty: s.qty }];
    } else {
      const lots = (await db.query(
        `SELECT lb.lot_id, lb.qty FROM lot_balances lb JOIN lots l ON l.id = lb.lot_id
          WHERE lb.warehouse_id = $1 AND l.item_id = $2 AND lb.qty > 0 AND ($3::boolean IS NOT TRUE OR l.expiry_date IS NULL OR l.expiry_date >= $4::date)
          ORDER BY l.expiry_date NULLS LAST, l.created_at FOR UPDATE OF lb`, [s.warehouseId, s.itemId, !!s.forSale, s.date])).rows;
      allocations = [];
      let remaining = s.qty;
      for (const l of lots) {
        if (Number(remaining) <= 0) break;
        const take = (await db.query("SELECT least($1::numeric, $2::numeric)::text AS t, ($1::numeric - least($1::numeric, $2::numeric))::text AS r", [remaining, l.qty])).rows[0];
        allocations.push({ lotId: l.lot_id, qty: take.t });
        remaining = take.r;
      }
      if (Number(remaining) > 0) throw E.rule("INSUFFICIENT_LOT_STOCK", `كميات التشغيلات الصالحة غير كافية للصنف ${s.itemCode}${s.forSale ? " (التشغيلات المنتهية مستبعدة من البيع)" : ""}`,
        `Not enough valid lot quantity for ${s.itemCode}${s.forSale ? " (expired lots are excluded from sale)" : ""}`);
    }
    for (const a of allocations) {
      const ok = await db.query("UPDATE lot_balances SET qty = qty - $3 WHERE warehouse_id = $1 AND lot_id = $2 AND qty >= $3", [s.warehouseId, a.lotId, a.qty]);
      if (!ok.rowCount) throw E.rule("INSUFFICIENT_LOT_STOCK", `الكمية غير متوفرة في التشغيلة المحددة للصنف ${s.itemCode}`, `Insufficient quantity in the selected lot of ${s.itemCode}`);
    }
  }

  let total = "0";
  for (const a of allocations) {
    // value of this slice at average cost; the slice that empties the balance takes the remaining value exactly (no rounding residue)
    const r = (await db.query(
      `WITH b AS (SELECT qty, value FROM stock_balances WHERE warehouse_id = $1 AND item_id = $2),
            c AS (SELECT CASE WHEN b.qty = $3::numeric THEN b.value ELSE round(b.value * $3::numeric / b.qty, 4) END AS v, round(b.value / b.qty, 6) AS uc FROM b)
       UPDATE stock_balances sb SET qty = sb.qty - $3::numeric, value = sb.value - c.v, updated_at = now() FROM c
        WHERE sb.warehouse_id = $1 AND sb.item_id = $2 RETURNING c.v::text AS v, c.uc::text AS uc`, [s.warehouseId, s.itemId, a.qty])).rows[0];
    await db.query(
      `INSERT INTO stock_moves (tenant_id, company_id, warehouse_id, item_id, lot_id, move_date, qty, unit_cost, value, source_type, source_id, source_line_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,-$7::numeric,$8,-$9::numeric,$10,$11,$12,$13)`,
      [u.tenantId, s.companyId, s.warehouseId, s.itemId, a.lotId, s.date, a.qty, r.uc, r.v, s.sourceType, s.sourceId, s.sourceLineId ?? null, u.userId]);
    total = (await db.query("SELECT ($1::numeric + $2::numeric)::text AS t", [total, r.v])).rows[0].t;
  }
  return { value: total, allocations };
}
