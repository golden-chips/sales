import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zDate } from "../../core/http.js";
import { E } from "../../core/errors.js";

const T = { tags: ["Reports"] };

export async function erpReportRoutes(app: FastifyInstance) {
  app.get("/inventory/stock", { schema: { ...T, summary: "Stock on hand by warehouse/item with average cost, value, lots & expiry" }, preHandler: can("inventory.stock.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, warehouseId: zUuid.optional(), itemId: zUuid.optional(), belowReorder: z.enum(["true", "false"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT w.id AS warehouse_id, w.code AS warehouse_code, w.name_ar AS warehouse_name_ar, w.kind AS warehouse_kind, w.is_sellable,
              i.id AS item_id, i.code AS item_code, i.name_ar AS item_name_ar, i.kind AS item_kind, u.code AS uom, i.reorder_level,
              b.qty, b.value, CASE WHEN b.qty > 0 THEN round(b.value / b.qty, 4) ELSE 0 END AS avg_cost,
              coalesce((SELECT json_agg(json_build_object('lotId', l.id, 'lotNo', l.lot_no, 'qty', lb.qty, 'expiryDate', l.expiry_date,
                        'daysToExpiry', l.expiry_date - current_date) ORDER BY l.expiry_date NULLS LAST)
                 FROM lot_balances lb JOIN lots l ON l.id = lb.lot_id WHERE lb.warehouse_id = b.warehouse_id AND l.item_id = b.item_id AND lb.qty > 0), '[]') AS lots
         FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id JOIN branches br ON br.id = w.branch_id JOIN items i ON i.id = b.item_id JOIN uoms u ON u.id = i.base_uom_id
        WHERE br.company_id = $1 AND ($2::uuid IS NULL OR b.warehouse_id = $2) AND ($3::uuid IS NULL OR b.item_id = $3) AND ($5::uuid[] IS NULL OR w.branch_id = ANY($5))
          AND ($4::boolean IS NOT TRUE OR (i.reorder_level IS NOT NULL AND b.qty <= i.reorder_level))
        ORDER BY i.code, w.code`, [q.companyId, q.warehouseId ?? null, q.itemId ?? null, q.belowReorder === "true", req.user!.branchIds])).rows);
  });

  app.get("/inventory/items/:id/card", { schema: { ...T, summary: "Item card: every movement with running quantity and value, linked to its source document" }, preHandler: can("inventory.stock.view") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const q = parse(z.object({ warehouseId: zUuid.optional(), from: zDate.optional(), to: zDate.optional() }), req.query);
    return tdb(req, async (db) => {
      const item = (await db.query("SELECT * FROM items WHERE id = $1", [id])).rows[0];
      if (!item) throw E.notFound("item");
      const moves = (await db.query(
        `SELECT m.id, m.move_date, w.code AS warehouse_code, l.lot_no, m.qty, m.unit_cost, m.value, m.source_type, m.source_id,
                sum(m.qty) OVER (ORDER BY m.move_date, m.id) AS running_qty, sum(m.value) OVER (ORDER BY m.move_date, m.id) AS running_value
           FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN lots l ON l.id = m.lot_id
          WHERE m.item_id = $1 AND ($2::uuid IS NULL OR m.warehouse_id = $2)
          ORDER BY m.move_date, m.id`, [id, q.warehouseId ?? null])).rows
        .filter((m) => (!q.from || m.move_date >= q.from) && (!q.to || m.move_date <= q.to));
      return { item, moves };
    });
  });

  app.get("/inventory/lots/:id/trace", { schema: { ...T, summary: "Lot trace: supplier origin, every movement, and the customers who received it" }, preHandler: can("inventory.stock.view") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return tdb(req, async (db) => {
      const lot = (await db.query("SELECT l.*, i.code AS item_code, i.name_ar AS item_name_ar, s.code AS supplier_code, s.name_ar AS supplier_name_ar FROM lots l JOIN items i ON i.id = l.item_id LEFT JOIN parties s ON s.id = l.supplier_id WHERE l.id = $1", [id])).rows[0];
      if (!lot) throw E.notFound("lot");
      const moves = (await db.query(
        `SELECT m.move_date, w.code AS warehouse_code, w.kind AS warehouse_kind, m.qty, m.source_type, m.source_id,
                coalesce(si.number, sr.number, pr.number, sd.number) AS document_number, cust.code AS customer_code, cust.name_ar AS customer_name_ar
           FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id
           LEFT JOIN sales_invoices si ON m.source_type = 'sales_invoice' AND si.id = m.source_id
           LEFT JOIN sales_returns sr ON m.source_type = 'sales_return' AND sr.id = m.source_id
           LEFT JOIN purchase_receipts pr ON m.source_type = 'purchase_receipt' AND pr.id = m.source_id
           LEFT JOIN stock_documents sd ON m.source_type = 'stock_document' AND sd.id = m.source_id
           LEFT JOIN parties cust ON cust.id = coalesce(si.customer_id, (SELECT customer_id FROM sales_invoices x WHERE x.id = sr.invoice_id))
          WHERE m.lot_id = $1 ORDER BY m.move_date, m.id`, [id])).rows;
      const onHand = (await db.query("SELECT w.code AS warehouse_code, w.kind, lb.qty FROM lot_balances lb JOIN warehouses w ON w.id = lb.warehouse_id WHERE lb.lot_id = $1 AND lb.qty > 0", [id])).rows;
      const customers = (await db.query(
        `WITH x AS (
           SELECT si.customer_id, -m.qty AS sold, 0::numeric AS returned FROM stock_moves m JOIN sales_invoices si ON si.id = m.source_id
            WHERE m.lot_id = $1 AND m.source_type = 'sales_invoice'
           UNION ALL
           SELECT si.customer_id, 0, m.qty FROM stock_moves m JOIN sales_returns sr ON sr.id = m.source_id JOIN sales_invoices si ON si.id = sr.invoice_id
            WHERE m.lot_id = $1 AND m.source_type = 'sales_return')
         SELECT p.id, p.code, p.name_ar, p.phone, sum(x.sold) AS sold, sum(x.returned) AS returned, sum(x.sold) - sum(x.returned) AS net_in_market
           FROM x JOIN parties p ON p.id = x.customer_id GROUP BY p.id ORDER BY p.code`, [id])).rows;
      return { lot, moves, onHand, customers };
    });
  });

  app.get("/inventory/valuation-check", { schema: { ...T, summary: "Reconcile stock subledger value with GL inventory accounts" }, preHandler: can("inventory.stock.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => {
      const stock = (await db.query("SELECT coalesce(sum(b.value),0)::text AS v FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id JOIN branches br ON br.id = w.branch_id WHERE br.company_id = $1", [q.companyId])).rows[0].v;
      const gl = (await db.query(
        `SELECT coalesce(sum(l.debit - l.credit),0)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
          WHERE e.company_id = $1 AND e.status IN ('posted','reversed') AND a.role IN ('inventory_raw','inventory_packaging','inventory_wip','inventory_fg','inventory_van','inventory_quarantine','inventory_transit')`, [q.companyId])).rows[0].v;
      return { stockValue: stock, glValue: gl, reconciled: Number(stock) === Number(gl), difference: (Number(gl) - Number(stock)).toFixed(4) };
    });
  });

  app.get("/sales/ar-aging", { schema: { ...T, summary: "Receivables aging per customer (by due date)" }, preHandler: can("sales.reports.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, asOf: zDate.optional() }), req.query);
    return tdb(req, async (db) => {
      const rows = (await db.query(
        `WITH o AS (SELECT customer_id, total - amount_paid - amount_returned AS open, $2::date - coalesce(due_date, invoice_date) AS days
                      FROM sales_invoices WHERE company_id = $1 AND status = 'posted' AND invoice_date <= $2 AND total - amount_paid - amount_returned > 0)
         SELECT p.id, p.code, p.name_ar, p.credit_limit, sum(o.open) AS total,
                sum(o.open) FILTER (WHERE o.days <= 0) AS not_due, sum(o.open) FILTER (WHERE o.days BETWEEN 1 AND 30) AS d1_30,
                sum(o.open) FILTER (WHERE o.days BETWEEN 31 AND 60) AS d31_60, sum(o.open) FILTER (WHERE o.days BETWEEN 61 AND 90) AS d61_90,
                sum(o.open) FILTER (WHERE o.days > 90) AS d90_plus
           FROM o JOIN parties p ON p.id = o.customer_id GROUP BY p.id ORDER BY total DESC`, [q.companyId, q.asOf ?? new Date().toISOString().slice(0, 10)])).rows;
      return { asOf: q.asOf ?? new Date().toISOString().slice(0, 10), rows };
    });
  });

  app.get("/customers/:id/statement", { schema: { ...T, summary: "Customer statement with running balance" }, preHandler: can("sales.reports.view") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const q = parse(z.object({ from: zDate, to: zDate }), req.query);
    return tdb(req, async (db) => {
      const party = (await db.query("SELECT * FROM parties WHERE id = $1", [id])).rows[0];
      if (!party) throw E.notFound("customer");
      const tx = `SELECT invoice_date AS d, number, 'invoice' AS kind, total AS debit, CASE WHEN payment_type = 'cash' THEN total ELSE 0 END AS credit, id FROM sales_invoices WHERE customer_id = $1 AND status = 'posted'
        UNION ALL SELECT r.return_date, r.number, 'return', CASE WHEN i.payment_type = 'cash' THEN r.total ELSE 0 END, r.total, r.id FROM sales_returns r JOIN sales_invoices i ON i.id = r.invoice_id WHERE i.customer_id = $1 AND r.status = 'posted'
        UNION ALL SELECT payment_date, number, 'receipt', 0, amount, id FROM payments WHERE party_id = $1 AND direction = 'in' AND status = 'posted'`;
      const opening = (await db.query(`SELECT coalesce(sum(debit - credit),0)::text AS o FROM (${tx}) t WHERE d < $2`, [id, q.from])).rows[0].o;
      const lines = (await db.query(`SELECT *, $4::numeric + sum(debit - credit) OVER (ORDER BY d, number) AS balance FROM (${tx}) t WHERE d BETWEEN $2 AND $3 ORDER BY d, number`, [id, q.from, q.to, opening])).rows;
      return { party, from: q.from, to: q.to, opening, lines };
    });
  });

  app.get("/sales/analysis", { schema: { ...T, summary: "Sales by item and by customer: quantity, net revenue, cost, gross margin (net of returns)" }, preHandler: can("sales.reports.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, from: zDate, to: zDate }), req.query);
    return tdb(req, async (db) => {
      const base = `WITH s AS (
          SELECT l.item_id, i.customer_id, l.base_qty AS qty, l.net_amount AS revenue, coalesce(l.cost_amount,0) AS cost FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.doc_id
           WHERE i.company_id = $1 AND i.status = 'posted' AND i.invoice_date BETWEEN $2 AND $3
          UNION ALL
          SELECT il.item_id, i.customer_id, -rl.base_qty, -round(rl.amount * il.net_amount / nullif(il.line_total,0), 4), -coalesce(rl.cost_amount,0)
            FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.doc_id JOIN sales_invoice_lines il ON il.id = rl.invoice_line_id JOIN sales_invoices i ON i.id = r.invoice_id
           WHERE r.company_id = $1 AND r.status = 'posted' AND r.return_date BETWEEN $2 AND $3)`;
      const byItem = (await db.query(`${base} SELECT it.id, it.code, it.name_ar, sum(qty) AS qty, sum(revenue) AS revenue, sum(cost) AS cost, sum(revenue) - sum(cost) AS margin,
          CASE WHEN sum(revenue) <> 0 THEN round((sum(revenue) - sum(cost)) * 100 / sum(revenue), 2) END AS margin_pct
          FROM s JOIN items it ON it.id = s.item_id GROUP BY it.id ORDER BY revenue DESC`, [q.companyId, q.from, q.to])).rows;
      const byCustomer = (await db.query(`${base} SELECT p.id, p.code, p.name_ar, sum(revenue) AS revenue, sum(cost) AS cost, sum(revenue) - sum(cost) AS margin
          FROM s JOIN parties p ON p.id = s.customer_id GROUP BY p.id ORDER BY revenue DESC`, [q.companyId, q.from, q.to])).rows;
      return { from: q.from, to: q.to, byItem, byCustomer };
    });
  });
}
