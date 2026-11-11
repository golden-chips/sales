import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb, assertBranchAccess } from "../../core/auth.js";
import { parse, zPage, pageSql, paged, zUuid, zMoney, zDate, idempotent } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import * as sales from "./sales.service.js";
import * as inv from "./inventory.service.js";

const zQty = z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((s) => /^-?\d{1,12}(\.\d{1,4})?$/.test(s) && Number(s) !== 0, "non-zero quantity with ≤ 4 decimals");
const zPos = zQty.refine((s) => !s.startsWith("-"), "must be positive");
const zPct = z.union([z.string(), z.number()]).transform((v) => String(v)).refine((s) => /^\d{1,3}(\.\d{1,4})?$/.test(s) && Number(s) <= 100, "0..100");

interface DocDef {
  path: string; table: string; tag: string; view: string; create: string; post: string; numberCol?: string; dateCol: string; partyCol?: string;
  bodySchema: z.ZodTypeAny; create_: (db: any, u: any, b: any) => Promise<any>; post_: (db: any, u: any, id: string) => Promise<any>; get_: (db: any, id: string) => Promise<any>;
  extraFilter?: string;
}

function registerDoc(app: FastifyInstance, d: DocDef) {
  const T = { tags: [d.tag] };
  app.get(d.path, { schema: { ...T, summary: `List ${d.table}` }, preHandler: can(d.view) }, async (req) => {
    const q = parse(zPage.extend({ companyId: zUuid, status: z.enum(["draft", "posted", "cancelled"]).optional(), from: zDate.optional(), to: zDate.optional(), partyId: zUuid.optional(), q: z.string().optional() }), req.query);
    const { limit, offset } = pageSql(q);
    return tdb(req, async (db) => {
      const where = `WHERE x.company_id = $1 ${d.extraFilter ?? ""} AND ($2::doc_status IS NULL OR x.status = $2) AND ($3::date IS NULL OR x.${d.dateCol} >= $3) AND ($4::date IS NULL OR x.${d.dateCol} <= $4)
        AND ($5::uuid IS NULL OR ${d.partyCol ? `x.${d.partyCol} = $5` : "true"}) AND ($6::text IS NULL OR x.number ILIKE '%'||$6||'%')`;
      const args = [q.companyId, q.status ?? null, q.from ?? null, q.to ?? null, q.partyId ?? null, q.q ?? null];
      const total = Number((await db.query(`SELECT count(*) FROM ${d.table} x ${where}`, args)).rows[0].count);
      const rows = (await db.query(
        `SELECT x.*${d.partyCol ? ", p.code AS party_code, p.name_ar AS party_name_ar" : ""}, cu.full_name AS created_by_name FROM ${d.table} x
          ${d.partyCol ? `JOIN parties p ON p.id = x.${d.partyCol}` : ""} JOIN users cu ON cu.id = x.created_by
          ${where} ORDER BY x.${d.dateCol} DESC, x.created_at DESC LIMIT $7 OFFSET $8`, [...args, limit, offset])).rows;
      return paged(rows, total, q);
    });
  });
  app.get(`${d.path}/:id`, { schema: { ...T, summary: `Get ${d.table}` }, preHandler: can(d.view) }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return tdb(req, (db) => d.get_(db, id));
  });
  app.post(d.path, { schema: { ...T, summary: `Create draft (${d.table}) — Idempotency-Key supported` }, preHandler: can(d.create) }, async (req, reply) => {
    const b = parse(d.bodySchema, req.body);
    if ((b as any).branchId) assertBranchAccess(req.user!, (b as any).branchId);
    return tdb(req, (db) => idempotent(req, reply, db, req.user!.tenantId, async () => ({ status: 201, body: await d.create_(db, req.user!, b) })));
  });
  app.post(`${d.path}/:id/post`, { schema: { ...T, summary: `Post (${d.table}): stock + journal in one transaction; segregation of duties` }, preHandler: can(d.post) }, async (req, reply) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return tdb(req, (db) => idempotent(req, reply, db, req.user!.tenantId, async () => ({ status: 200, body: await d.post_(db, req.user!, id) })));
  });
  app.delete(`${d.path}/:id`, { schema: { ...T, summary: `Delete a draft (${d.table})` }, preHandler: can(d.create) }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await tdb(req, async (db) => {
      const before = (await db.query(`SELECT * FROM ${d.table} WHERE id = $1`, [id])).rows[0];
      if (!before) throw E.notFound(d.table);
      await db.query(`DELETE FROM ${d.table} WHERE id = $1`, [id]); // status guard trigger rejects non-drafts
      await audit(db, { tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId, action: `${d.table}.draft_deleted`, entityType: d.table, entityId: id, before });
    });
    return { ok: true };
  });
}

export async function documentRoutes(app: FastifyInstance) {
  registerDoc(app, {
    path: "/sales/invoices", table: "sales_invoices", tag: "Sales", view: "sales.invoices.view", create: "sales.invoices.create", post: "sales.invoices.post",
    dateCol: "invoice_date", partyCol: "customer_id",
    bodySchema: z.object({ companyId: zUuid, branchId: zUuid.nullable().optional(), warehouseId: zUuid, customerId: zUuid, invoiceDate: zDate, paymentType: z.enum(["cash", "credit"]),
      notes: z.string().max(1000).optional(),
      lines: z.array(z.object({ itemId: zUuid, uomId: zUuid.nullable().optional(), qty: zPos, unitPrice: zMoney.optional(), discountPct: zPct.optional(), taxPct: zPct.optional(), lotId: zUuid.nullable().optional() })).min(1).max(300) }),
    create_: sales.createInvoice, post_: sales.postInvoice, get_: sales.getInvoice,
  });
  registerDoc(app, {
    path: "/sales/returns", table: "sales_returns", tag: "Sales", view: "sales.invoices.view", create: "sales.returns.create", post: "sales.returns.post", dateCol: "return_date",
    bodySchema: z.object({ invoiceId: zUuid, warehouseId: zUuid, returnDate: zDate, reason: z.string().min(3).max(500), lines: z.array(z.object({ invoiceLineId: zUuid, qty: zPos })).min(1) }),
    create_: sales.createReturn, post_: sales.postReturn,
    get_: async (db, id) => ({ ...(await db.query("SELECT * FROM sales_returns WHERE id = $1", [id])).rows[0], lines: (await db.query("SELECT * FROM sales_return_lines WHERE doc_id = $1 ORDER BY line_no", [id])).rows }),
  });
  const zPay = (dir: "in" | "out") => z.object({ companyId: zUuid, partyId: zUuid, method: z.enum(["cash", "bank", "rep_custody"]), paymentDate: zDate, amount: zMoney.refine((s) => Number(s) > 0, "> 0"),
    reference: z.string().max(200).optional(), ...(dir === "in" ? { salesInvoiceId: zUuid.nullable().optional() } : { supplierInvoiceId: zUuid }) }).transform((b) => ({ ...b, direction: dir }));
  const getPay = async (db: any, id: string) => ({ ...(await db.query("SELECT * FROM payments WHERE id = $1", [id])).rows[0], allocations: (await db.query("SELECT * FROM payment_allocations WHERE payment_id = $1", [id])).rows });
  registerDoc(app, {
    path: "/sales/receipts", table: "payments", tag: "Sales", view: "sales.invoices.view", create: "sales.receipts.create", post: "sales.receipts.post", dateCol: "payment_date", partyCol: "party_id",
    extraFilter: "AND x.direction = 'in'", bodySchema: zPay("in"), create_: sales.createPayment, post_: sales.postPayment, get_: getPay,
  });
  registerDoc(app, {
    path: "/purchasing/payments", table: "payments", tag: "Purchasing", view: "purchasing.receipts.view", create: "purchasing.payments.create", post: "purchasing.payments.post", dateCol: "payment_date", partyCol: "party_id",
    extraFilter: "AND x.direction = 'out'", bodySchema: zPay("out"), create_: sales.createPayment, post_: sales.postPayment, get_: getPay,
  });
  registerDoc(app, {
    path: "/purchasing/receipts", table: "purchase_receipts", tag: "Purchasing", view: "purchasing.receipts.view", create: "purchasing.receipts.create", post: "purchasing.receipts.post",
    dateCol: "receipt_date", partyCol: "supplier_id",
    bodySchema: z.object({ companyId: zUuid, supplierId: zUuid, warehouseId: zUuid, receiptDate: zDate, supplierRef: z.string().max(100).optional(),
      lines: z.array(z.object({ itemId: zUuid, uomId: zUuid.nullable().optional(), qty: zPos, unitCost: zMoney, lotNo: z.string().max(60).optional(), productionDate: zDate.optional(), expiryDate: zDate.optional() })).min(1).max(300) }),
    create_: inv.createReceipt, post_: inv.postReceipt, get_: inv.getReceipt,
  });
  registerDoc(app, {
    path: "/purchasing/invoices", table: "supplier_invoices", tag: "Purchasing", view: "purchasing.receipts.view", create: "purchasing.invoices.create", post: "purchasing.invoices.post",
    dateCol: "invoice_date", partyCol: "supplier_id",
    bodySchema: z.object({ receiptId: zUuid, supplierInvoiceNo: z.string().min(1).max(60), invoiceDate: zDate, total: zMoney.refine((s) => Number(s) > 0, "> 0") }),
    create_: inv.createSupplierInvoice, post_: inv.postSupplierInvoice, get_: async (db, id) => (await db.query("SELECT * FROM supplier_invoices WHERE id = $1", [id])).rows[0] ?? Promise.reject(E.notFound("supplier invoice")),
  });
  registerDoc(app, {
    path: "/inventory/documents", table: "stock_documents", tag: "Inventory", view: "inventory.stock.view", create: "inventory.moves.create", post: "inventory.moves.post", dateCol: "doc_date",
    bodySchema: z.object({ companyId: zUuid, reason: z.enum(["opening", "count", "damage", "quarantine_release", "transfer"]), warehouseId: zUuid, toWarehouseId: zUuid.nullable().optional(),
      docDate: zDate, notes: z.string().max(1000).optional(),
      lines: z.array(z.object({ itemId: zUuid, qtyDelta: zQty, unitCost: zMoney.optional(), lotNo: z.string().max(60).optional(), lotId: zUuid.nullable().optional(), productionDate: zDate.optional(), expiryDate: zDate.optional() })).min(1).max(500) }),
    create_: inv.createStockDoc, post_: inv.postStockDoc, get_: inv.getStockDoc,
  });
}
