// Quotations, sales orders and purchase orders — routes (v0.8).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zPage, pageSql, paged, zUuid, zMoney, zDate, idempotent, send } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import * as o from "./orders.service.js";

const zQty = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((s) => /^\d{1,12}(\.\d{1,4})?$/.test(s) && Number(s) > 0, "positive quantity with ≤ 4 decimals");
const zPct = z.union([z.string(), z.number()]).transform((v) => String(v)).refine((s) => /^\d{1,3}(\.\d{1,4})?$/.test(s) && Number(s) <= 100, "0..100");
const zSalesLine = z.object({ itemId: zUuid, uomId: zUuid.nullable().optional(), qty: zQty, unitPrice: zMoney.optional(), discountPct: zPct.optional() });
const id$ = z.object({ id: zUuid });
const Q = { tags: ["Orders"] };

/** any one of the permissions (module must be enabled) */
const canAny = (...perms: string[]) => async (req: FastifyRequest, reply: any) => {
  await can(null, perms[0].split(".")[0])(req, reply);
  if (!perms.some((p) => req.user!.permissions.has(p))) throw E.forbidden(perms.join(" | "));
};
const write = <T>(req: FastifyRequest, reply: any, status: number, fn: (db: any) => Promise<T>) =>
  tdb(req, (db) => idempotent(req, db, req.user!.tenantId, async () => ({ status, body: await fn(db) }))).then((r) => send(reply, r));

const list = (table: string, dateCol: string, partyCol: string, statusType: string) => async (req: FastifyRequest) => {
  const q = parse(zPage.extend({ companyId: zUuid, status: z.string().regex(/^[a-z_]+$/).optional(), partyId: zUuid.optional(), q: z.string().max(60).optional() }), req.query);
  const { limit, offset } = pageSql(q);
  return tdb(req, async (db) => {
    const where = `WHERE x.company_id = $1 AND ($2::${statusType} IS NULL OR x.status = $2) AND ($3::uuid IS NULL OR x.${partyCol} = $3) AND ($4::text IS NULL OR x.number ILIKE '%'||$4||'%' OR p.name_ar ILIKE '%'||$4||'%')`;
    const args = [q.companyId, q.status ?? null, q.partyId ?? null, q.q ?? null];
    const total = Number((await db.query(`SELECT count(*) FROM ${table} x JOIN parties p ON p.id = x.${partyCol} ${where}`, args)).rows[0].count);
    const rows = (await db.query(`SELECT x.*, p.code AS party_code, p.name_ar AS party_name_ar FROM ${table} x JOIN parties p ON p.id = x.${partyCol} ${where}
        ORDER BY x.${dateCol} DESC, x.created_at DESC LIMIT ${limit} OFFSET ${offset}`, args)).rows;
    return paged(rows, total, q);
  });
};

export async function orderRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------- settings
  app.get("/order-settings", { schema: { ...Q, summary: "PO approval threshold & quotation validity" }, preHandler: canAny("purchasing.orders.manage", "purchasing.orders.approve", "sales.quotations.manage") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT po_approval_threshold, quotation_valid_days FROM order_settings WHERE company_id = $1", [q.companyId])).rows[0]
      ?? { po_approval_threshold: "0.0000", quotation_valid_days: 15 });
  });
  app.put("/order-settings", { schema: { ...Q, summary: "Set PO approval threshold (0 = every PO needs approval)" }, preHandler: can("purchasing.settings.manage") }, async (req) => {
    const b = parse(z.object({ companyId: zUuid, poApprovalThreshold: zMoney, quotationValidDays: z.number().int().min(1).max(365).default(15) }), req.body);
    return tdb(req, async (db) => {
      const u = req.user!;
      if (!(await db.query("SELECT 1 FROM companies WHERE id = $1", [b.companyId])).rowCount) throw E.notFound("companies");
      const r = (await db.query(`INSERT INTO order_settings (tenant_id, company_id, po_approval_threshold, quotation_valid_days) VALUES ($1,$2,$3,$4)
          ON CONFLICT (company_id) DO UPDATE SET po_approval_threshold = EXCLUDED.po_approval_threshold, quotation_valid_days = EXCLUDED.quotation_valid_days
          RETURNING po_approval_threshold, quotation_valid_days`, [u.tenantId, b.companyId, b.poApprovalThreshold, b.quotationValidDays])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "order_settings.updated", entityType: "company", entityId: b.companyId, after: b });
      return r;
    });
  });

  // -------------------------------------------------------------- quotations
  app.get("/sales-quotations", { schema: { ...Q, summary: "List quotations" }, preHandler: can("sales.quotations.manage") }, list("sales_quotations", "quote_date", "customer_id", "quotation_status"));
  app.get("/sales-quotations/:id", { schema: { ...Q, summary: "Quotation with lines" }, preHandler: can("sales.quotations.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => o.getQuotation(db, id));
  });
  app.post("/sales-quotations", { schema: { ...Q, summary: "Create quotation (prices default to the customer's / list price)" }, preHandler: can("sales.quotations.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, branchId: zUuid.nullable().optional(), customerId: zUuid, quoteDate: zDate, validUntil: zDate.optional(), notes: z.string().max(2000).optional(),
      lines: z.array(zSalesLine).min(1).max(200) }), req.body);
    return write(req, reply, 201, (db) => o.createQuotation(db, req.user!, b));
  });
  app.post("/sales-quotations/:id/send", { schema: { ...Q, summary: "Mark quotation as sent" }, preHandler: can("sales.quotations.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    return write(req, reply, 200, (db) => o.setQuotationStatus(db, req.user!, id, "sent"));
  });
  app.post("/sales-quotations/:id/reject", { schema: { ...Q, summary: "Customer rejected the quotation" }, preHandler: can("sales.quotations.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ reason: z.string().min(2).max(500) }), req.body);
    return write(req, reply, 200, (db) => o.setQuotationStatus(db, req.user!, id, "rejected", b.reason));
  });
  app.post("/sales-quotations/:id/convert", { schema: { ...Q, summary: "Accepted quotation → draft sales order" }, preHandler: can("sales.orders.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ warehouseId: zUuid, orderDate: zDate, deliveryDate: zDate.optional(), paymentType: z.enum(["cash", "credit"]).optional() }), req.body);
    return write(req, reply, 201, (db) => o.quotationToOrder(db, req.user!, id, b));
  });

  // -------------------------------------------------------------- sales orders
  app.get("/sales-orders", { schema: { ...Q, summary: "List sales orders" }, preHandler: can("sales.orders.manage") }, list("sales_orders", "order_date", "customer_id", "sales_order_status"));
  app.get("/sales-orders/:id", { schema: { ...Q, summary: "Sales order with lines, delivered quantities and invoices" }, preHandler: can("sales.orders.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => o.getOrder(db, id));
  });
  app.get("/sales-orders/availability", { schema: { ...Q, summary: "Available-to-promise for an item in a warehouse" }, preHandler: can("sales.orders.manage") }, async (req) => {
    const q = parse(z.object({ warehouseId: zUuid, itemId: zUuid }), req.query);
    return tdb(req, async (db) => ({ availableToPromise: await o.availableToPromise(db, q.warehouseId, q.itemId) }));
  });
  app.post("/sales-orders", { schema: { ...Q, summary: "Create draft sales order" }, preHandler: can("sales.orders.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, branchId: zUuid.nullable().optional(), warehouseId: zUuid, customerId: zUuid, orderDate: zDate, deliveryDate: zDate.optional(),
      paymentType: z.enum(["cash", "credit"]).default("credit"), notes: z.string().max(2000).optional(), lines: z.array(zSalesLine).min(1).max(200) }), req.body);
    return write(req, reply, 201, (db) => o.createOrder(db, req.user!, b));
  });
  app.post("/sales-orders/:id/confirm", { schema: { ...Q, summary: "Confirm: credit-limit check + stock reservation (available to promise)" }, preHandler: can("sales.orders.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ allowBackorder: z.boolean().default(false) }), req.body ?? {});
    return write(req, reply, 200, (db) => o.confirmOrder(db, req.user!, id, b));
  });
  app.post("/sales-orders/:id/invoice", { schema: { ...Q, summary: "Draft invoice for the remaining (or given) quantities; posting it delivers the order" }, preHandler: can("sales.orders.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ invoiceDate: zDate, lines: z.array(z.object({ orderLineId: zUuid, qty: zQty })).min(1).optional() }), req.body);
    if (!req.user!.permissions.has("sales.invoices.create")) throw E.forbidden("sales.invoices.create");
    return write(req, reply, 201, (db) => o.invoiceFromOrder(db, req.user!, id, b));
  });
  app.post("/sales-orders/:id/close", { schema: { ...Q, summary: "Cancel (nothing delivered) or close the rest of the order" }, preHandler: can("sales.orders.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ reason: z.string().min(2).max(500) }), req.body);
    return write(req, reply, 200, (db) => o.closeOrder(db, req.user!, id, b.reason));
  });

  // -------------------------------------------------------------- purchase orders
  const poView = canAny("purchasing.orders.manage", "purchasing.orders.approve");
  app.get("/purchase-orders", { schema: { ...Q, summary: "List purchase orders" }, preHandler: poView }, list("purchase_orders", "order_date", "supplier_id", "purchase_order_status"));
  app.get("/purchase-orders/:id", { schema: { ...Q, summary: "Purchase order with lines, received quantities and receipts" }, preHandler: poView }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => o.getPurchaseOrder(db, id));
  });
  app.post("/purchase-orders", { schema: { ...Q, summary: "Create draft purchase order" }, preHandler: can("purchasing.orders.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, supplierId: zUuid, warehouseId: zUuid, orderDate: zDate, expectedDate: zDate.optional(), notes: z.string().max(2000).optional(),
      lines: z.array(z.object({ itemId: zUuid, uomId: zUuid.nullable().optional(), qty: zQty, unitCost: zMoney })).min(1).max(200) }), req.body);
    return write(req, reply, 201, (db) => o.createPurchaseOrder(db, req.user!, b));
  });
  app.post("/purchase-orders/:id/submit", { schema: { ...Q, summary: "Submit: auto-approved at or below the threshold, otherwise waits for an approver" }, preHandler: can("purchasing.orders.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    return write(req, reply, 200, (db) => o.submitPurchaseOrder(db, req.user!, id));
  });
  app.post("/purchase-orders/:id/decide", { schema: { ...Q, summary: "Approve / reject (approver must differ from the creator)" }, preHandler: can("purchasing.orders.approve") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ decision: z.enum(["approved", "rejected"]), reason: z.string().max(500).optional() }), req.body);
    return write(req, reply, 200, (db) => o.decidePurchaseOrder(db, req.user!, id, b));
  });
  app.post("/purchase-orders/:id/receive", { schema: { ...Q, summary: "Draft goods receipt against the order (no over-receipt)" }, preHandler: can("purchasing.orders.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ receiptDate: zDate, supplierRef: z.string().max(60).optional(),
      lines: z.array(z.object({ orderLineId: zUuid, qty: zQty, lotNo: z.string().max(60).optional(), productionDate: zDate.optional(), expiryDate: zDate.optional() })).min(1) }), req.body);
    if (!req.user!.permissions.has("purchasing.receipts.create")) throw E.forbidden("purchasing.receipts.create");
    return write(req, reply, 201, (db) => o.receiveFromPurchaseOrder(db, req.user!, id, b));
  });
  app.post("/purchase-orders/:id/close", { schema: { ...Q, summary: "Cancel (nothing received) or close the rest of the order" }, preHandler: can("purchasing.orders.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ reason: z.string().min(2).max(500) }), req.body);
    return write(req, reply, 200, (db) => o.closePurchaseOrder(db, req.user!, id, b.reason));
  });
}
