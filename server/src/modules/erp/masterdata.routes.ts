import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zPage, pageSql, paged, zUuid, zMoney } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";

const T = { tags: ["Master data"] };
const zPartyBody = z.object({
  companyId: zUuid, code: z.string().regex(/^[A-Z0-9_-]{1,30}$/), nameAr: z.string().min(2), nameEn: z.string().optional(), phone: z.string().optional(),
  city: z.string().optional(), taxNumber: z.string().optional(), creditLimit: zMoney.nullable().optional(), paymentTermsDays: z.number().int().min(0).max(365).default(0),
});

function partyPerm(kind: "customer" | "supplier", write: boolean) {
  return kind === "customer" ? (write ? "sales.customers.manage" : "sales.customers.view") : (write ? "purchasing.suppliers.manage" : "purchasing.suppliers.view");
}
const ac = (req: FastifyRequest) => ({ tenantId: req.user!.tenantId, actorType: "user" as const, actorId: req.user!.userId, ip: req.ip, requestId: req.id });

export async function masterDataRoutes(app: FastifyInstance) {
  for (const kind of ["customer", "supplier"] as const) {
    const path = kind === "customer" ? "/customers" : "/suppliers";
    app.get(path, { schema: { ...T, summary: `List ${kind}s with balances` }, preHandler: can(partyPerm(kind, false)) }, async (req) => {
      const q = parse(zPage.extend({ companyId: zUuid, q: z.string().optional(), active: z.enum(["true", "false"]).optional() }), req.query);
      const { limit, offset } = pageSql(q);
      return tdb(req, async (db) => {
        const where = `WHERE p.company_id = $1 AND p.kind IN ($2::party_kind, 'both') AND ($3::text IS NULL OR p.code ILIKE '%'||$3||'%' OR p.name_ar ILIKE '%'||$3||'%' OR p.name_en ILIKE '%'||$3||'%' OR p.phone ILIKE '%'||$3||'%')
          AND ($4::boolean IS NULL OR p.is_active = $4)`;
        const args = [q.companyId, kind, q.q ?? null, q.active === undefined ? null : q.active === "true"];
        const total = Number((await db.query(`SELECT count(*) FROM parties p ${where}`, args)).rows[0].count);
        const balance = kind === "customer"
          ? "(SELECT coalesce(sum(total - amount_paid - amount_returned),0) FROM sales_invoices si WHERE si.customer_id = p.id AND si.status = 'posted')"
          : "(SELECT coalesce(sum(total - amount_paid),0) FROM supplier_invoices x WHERE x.supplier_id = p.id AND x.status = 'posted')";
        const rows = (await db.query(`SELECT p.*, ${balance}::text AS balance FROM parties p ${where} ORDER BY p.code LIMIT $5 OFFSET $6`, [...args, limit, offset])).rows;
        return paged(rows, total, q);
      });
    });

    app.post(path, { schema: { ...T, summary: `Create ${kind}` }, preHandler: can(partyPerm(kind, true)) }, async (req, reply) => {
      const b = parse(zPartyBody, req.body);
      const r = await tdb(req, async (db) => {
        const x = (await db.query(
          `INSERT INTO parties (tenant_id, company_id, kind, code, name_ar, name_en, phone, city, tax_number, credit_limit, payment_terms_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [req.user!.tenantId, b.companyId, kind, b.code, b.nameAr, b.nameEn ?? null, b.phone ?? null, b.city ?? null, b.taxNumber ?? null, b.creditLimit ?? null, b.paymentTermsDays])).rows[0];
        await audit(db, { ...ac(req), action: `${kind}.created`, entityType: "party", entityId: x.id, after: x });
        return x;
      });
      return reply.code(201).send(r);
    });

    app.patch(`${path}/:id`, { schema: { ...T, summary: `Update ${kind} (credit limit, terms, activation)` }, preHandler: can(partyPerm(kind, true)) }, async (req) => {
      const { id } = parse(z.object({ id: zUuid }), req.params);
      const b = parse(z.object({ nameAr: z.string().min(2).optional(), nameEn: z.string().nullable().optional(), phone: z.string().nullable().optional(), city: z.string().nullable().optional(),
        creditLimit: zMoney.nullable().optional(), paymentTermsDays: z.number().int().min(0).max(365).optional(), isActive: z.boolean().optional() }), req.body);
      return tdb(req, async (db) => {
        const before = (await db.query("SELECT * FROM parties WHERE id = $1 AND kind IN ($2::party_kind, 'both')", [id, kind])).rows[0];
        if (!before) throw E.notFound(kind);
        const r = (await db.query(
          `UPDATE parties SET name_ar = coalesce($2, name_ar), name_en = CASE WHEN $3 THEN $4 ELSE name_en END, phone = CASE WHEN $5 THEN $6 ELSE phone END,
             city = CASE WHEN $7 THEN $8 ELSE city END, credit_limit = CASE WHEN $9 THEN $10::numeric ELSE credit_limit END,
             payment_terms_days = coalesce($11, payment_terms_days), is_active = coalesce($12, is_active) WHERE id = $1 RETURNING *`,
          [id, b.nameAr ?? null, b.nameEn !== undefined, b.nameEn ?? null, b.phone !== undefined, b.phone ?? null, b.city !== undefined, b.city ?? null,
           b.creditLimit !== undefined, b.creditLimit ?? null, b.paymentTermsDays ?? null, b.isActive ?? null])).rows[0];
        await audit(db, { ...ac(req), action: `${kind}.updated`, entityType: "party", entityId: id, before, after: r });
        return r;
      });
    });
  }

  app.put("/customers/:id/prices", { schema: { ...T, summary: "Replace a customer's special prices" }, preHandler: can("sales.customers.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ prices: z.array(z.object({ itemId: zUuid, price: zMoney })).max(2000) }), req.body);
    return tdb(req, async (db) => {
      const before = (await db.query("SELECT item_id, price FROM customer_prices WHERE party_id = $1", [id])).rows;
      await db.query("DELETE FROM customer_prices WHERE party_id = $1", [id]);
      for (const p of b.prices) await db.query("INSERT INTO customer_prices (tenant_id, party_id, item_id, price) VALUES ($1,$2,$3,$4)", [req.user!.tenantId, id, p.itemId, p.price]);
      await audit(db, { ...ac(req), action: "customer.prices_replaced", entityType: "party", entityId: id, before, after: b.prices });
      return { ok: true, count: b.prices.length };
    });
  });

  app.get("/uoms", { schema: { ...T, summary: "Units of measure" }, preHandler: can("inventory.items.view") }, async (req) =>
    tdb(req, async (db) => (await db.query("SELECT * FROM uoms ORDER BY code")).rows));
  app.post("/uoms", { schema: { ...T, summary: "Create unit of measure" }, preHandler: can("inventory.items.manage") }, async (req, reply) => {
    const b = parse(z.object({ code: z.string().regex(/^[A-Z0-9_]{1,12}$/), nameAr: z.string().min(1), nameEn: z.string().optional() }), req.body);
    return reply.code(201).send(await tdb(req, async (db) =>
      (await db.query("INSERT INTO uoms (tenant_id, code, name_ar, name_en) VALUES ($1,$2,$3,$4) RETURNING *", [req.user!.tenantId, b.code, b.nameAr, b.nameEn ?? null])).rows[0]));
  });

  app.get("/items", { schema: { ...T, summary: "Items with stock on hand and units" }, preHandler: can("inventory.items.view") }, async (req) => {
    const q = parse(zPage.extend({ companyId: zUuid, q: z.string().optional(), kind: z.enum(["raw", "packaging", "semi_finished", "finished", "service"]).optional() }), req.query);
    const { limit, offset } = pageSql(q);
    return tdb(req, async (db) => {
      const where = `WHERE i.company_id = $1 AND ($2::text IS NULL OR i.code ILIKE '%'||$2||'%' OR i.name_ar ILIKE '%'||$2||'%' OR i.name_en ILIKE '%'||$2||'%' OR i.barcode = $2) AND ($3::item_kind IS NULL OR i.kind = $3)`;
      const args = [q.companyId, q.q ?? null, q.kind ?? null];
      const total = Number((await db.query(`SELECT count(*) FROM items i ${where}`, args)).rows[0].count);
      const rows = (await db.query(
        `SELECT i.*, u.code AS base_uom_code, u.name_ar AS base_uom_name_ar,
                (SELECT coalesce(sum(qty),0) FROM stock_balances b WHERE b.item_id = i.id)::text AS on_hand,
                (SELECT coalesce(sum(value),0) FROM stock_balances b WHERE b.item_id = i.id)::text AS stock_value,
                coalesce((SELECT json_agg(json_build_object('uomId', iu.uom_id, 'code', u2.code, 'nameAr', u2.name_ar, 'factor', iu.factor)) FROM item_uoms iu JOIN uoms u2 ON u2.id = iu.uom_id WHERE iu.item_id = i.id), '[]') AS units
           FROM items i JOIN uoms u ON u.id = i.base_uom_id ${where} ORDER BY i.code LIMIT $4 OFFSET $5`, [...args, limit, offset])).rows;
      return paged(rows, total, q);
    });
  });

  app.post("/items", { schema: { ...T, summary: "Create item (raw, packaging, semi-finished, finished, service)" }, preHandler: can("inventory.items.manage") }, async (req, reply) => {
    const b = parse(z.object({
      companyId: zUuid, code: z.string().regex(/^[A-Z0-9_.-]{1,30}$/), nameAr: z.string().min(2), nameEn: z.string().optional(),
      kind: z.enum(["raw", "packaging", "semi_finished", "finished", "service"]), baseUomId: zUuid, barcode: z.string().optional(),
      trackLots: z.boolean().default(false), shelfLifeDays: z.number().int().positive().optional(), salesPrice: zMoney.optional(), reorderLevel: zMoney.optional(),
      units: z.array(z.object({ uomId: zUuid, factor: z.string().regex(/^\d{1,10}(\.\d{1,6})?$/) })).default([]),
    }), req.body);
    const r = await tdb(req, async (db) => {
      const x = (await db.query(
        `INSERT INTO items (tenant_id, company_id, code, name_ar, name_en, kind, base_uom_id, barcode, track_lots, shelf_life_days, sales_price, reorder_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.user!.tenantId, b.companyId, b.code, b.nameAr, b.nameEn ?? null, b.kind, b.baseUomId, b.barcode ?? null, b.trackLots, b.shelfLifeDays ?? null, b.salesPrice ?? null, b.reorderLevel ?? null])).rows[0];
      for (const un of b.units) {
        if (un.uomId === b.baseUomId) throw E.validation([{ path: "units", message: "base unit cannot be an alternative unit" }]);
        await db.query("INSERT INTO item_uoms (tenant_id, item_id, uom_id, factor) VALUES ($1,$2,$3,$4)", [req.user!.tenantId, x.id, un.uomId, un.factor]);
      }
      await audit(db, { ...ac(req), action: "item.created", entityType: "item", entityId: x.id, after: b });
      return x;
    });
    return reply.code(201).send(r);
  });

  app.patch("/items/:id", { schema: { ...T, summary: "Update item price / reorder level / activation" }, preHandler: can("inventory.items.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ nameAr: z.string().min(2).optional(), nameEn: z.string().nullable().optional(), salesPrice: zMoney.nullable().optional(),
      reorderLevel: zMoney.nullable().optional(), isActive: z.boolean().optional(), barcode: z.string().nullable().optional() }), req.body);
    return tdb(req, async (db) => {
      const before = (await db.query("SELECT * FROM items WHERE id = $1", [id])).rows[0];
      if (!before) throw E.notFound("item");
      const r = (await db.query(
        `UPDATE items SET name_ar = coalesce($2, name_ar), name_en = CASE WHEN $3 THEN $4 ELSE name_en END, sales_price = CASE WHEN $5 THEN $6::numeric ELSE sales_price END,
           reorder_level = CASE WHEN $7 THEN $8::numeric ELSE reorder_level END, is_active = coalesce($9, is_active), barcode = CASE WHEN $10 THEN $11 ELSE barcode END WHERE id = $1 RETURNING *`,
        [id, b.nameAr ?? null, b.nameEn !== undefined, b.nameEn ?? null, b.salesPrice !== undefined, b.salesPrice ?? null, b.reorderLevel !== undefined, b.reorderLevel ?? null,
         b.isActive ?? null, b.barcode !== undefined, b.barcode ?? null])).rows[0];
      await audit(db, { ...ac(req), action: "item.updated", entityType: "item", entityId: id, before, after: r });
      return r;
    });
  });
}
