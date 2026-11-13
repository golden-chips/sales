import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";
import { withTenant } from "../src/db/pool.js";

const Y = new Date().getUTCFullYear();
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("core ERP: inventory, purchasing, sales, returns, receipts — with GL integration", () => {
  let T: any, P: any; // T = owner (creates), P = poster (posts) → segregation of duties
  let wh: Record<string, string>, I: Record<string, any>, uom: Record<string, string>, cust: any, cust2: any, supp: any, acc: Record<string, string>;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (who: any) => ({ token: who.token });
  const post = async (path: string, id: string) => ok(await api("POST", `/api/v1${path}/${id}/post`, {}, as(P)), 200);
  const glBalance = async (code: string) => {
    const tb = await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T));
    return tb.body.rows.find((r: any) => r.code === code)?.closing ?? "0";
  };
  const stockOf = async (itemId: string, whId: string) => {
    const r = await api("GET", `/api/v1/inventory/stock?companyId=${T.companyId}&itemId=${itemId}&warehouseId=${whId}`, undefined, as(T));
    return r.body[0];
  };

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "sales", "purchasing", "inventory", "quality"] });
    T = await provision(p, plan.code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    P = await createUser(T, await Promise.all(["finance_manager", "warehouse_manager", "sales_manager", "quality_manager"].map(async (c) => ({ roleId: await roleId(T.token, c) }))));
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    wh = {};
    for (const [code, kind] of [["MAIN", "finished_goods"], ["QC", "quarantine"], ["RAW", "raw_materials"]] as const)
      wh[code] = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code, nameAr: `مخزن ${code}`, kind }, as(T))).id;
    uom = {};
    for (const code of ["BAG", "CTN", "KG", "SACK"]) uom[code] = ok(await api("POST", "/api/v1/uoms", { code, nameAr: code }, as(T))).id;
    I = {};
    I.CHIPS = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "FG-CHIPS-40", nameAr: "رقائق 40غ (اختبار)", kind: "finished", baseUomId: uom.BAG,
      trackLots: true, shelfLifeDays: 180, salesPrice: "1.250", units: [{ uomId: uom.CTN, factor: "24" }] }, as(T)));
    I.FLOUR = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "RM-FLOUR", nameAr: "دقيق (اختبار)", kind: "raw", baseUomId: uom.KG,
      trackLots: true, units: [{ uomId: uom.SACK, factor: "50" }] }, as(T)));
    cust = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C001", nameAr: "محل اختبار 1", creditLimit: "100", paymentTermsDays: 30 }, as(T)));
    cust2 = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C002", nameAr: "محل اختبار 2" }, as(T)));
    supp = ok(await api("POST", "/api/v1/suppliers", { companyId: T.companyId, code: "S001", nameAr: "مورد اختبار", paymentTermsDays: 15 }, as(T)));
  });

  it("opening stock: two lots at different costs → weighted average, GL inventory = opening equity", async () => {
    const d = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh.MAIN, docDate: D(1, 2), lines: [
      { itemId: I.CHIPS.id, qtyDelta: "100", unitCost: "0.8", lotNo: "A-EARLY", productionDate: D(1, 1) },            // expiry = +180 days
      { itemId: I.CHIPS.id, qtyDelta: "100", unitCost: "1.0", lotNo: "B-LATE", productionDate: D(1, 1), expiryDate: `${Y + 1}-06-30` },
    ] }, as(T)));
    expect(d.lines[0].expiry_date).not.toBeNull(); // derived from shelf life
    const p = await post("/inventory/documents", d.id);
    expect(p.number).toMatch(/^ST-/);
    const s = await stockOf(I.CHIPS.id, wh.MAIN);
    expect(s.qty).toBe("200.0000"); expect(s.value).toBe("180.0000"); expect(s.avg_cost).toBe("0.9000");
    expect(s.lots.map((l: any) => l.lotNo)).toEqual(["A-EARLY", "B-LATE"]); // FEFO order
    expect(await glBalance("1144")).toBe("180.0000");
    expect(await glBalance("304")).toBe("-180.0000");
  });

  it("segregation of duties applies to operational documents too", async () => {
    const d = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "count", warehouseId: wh.MAIN, docDate: D(1, 3),
      lines: [{ itemId: I.CHIPS.id, qtyDelta: "-1" }] }, as(T)));
    const self = await api("POST", `/api/v1/inventory/documents/${d.id}/post`, {}, as(T));
    expect(self.body.error.code).toBe("SEGREGATION_OF_DUTIES");
    ok(await api("DELETE", `/api/v1/inventory/documents/${d.id}`, undefined, as(T)), 200);
  });

  it("purchasing: goods receipt in sacks → kg stock with lot & supplier, GRNI; supplier invoice → AP; payment", async () => {
    const r = ok(await api("POST", "/api/v1/purchasing/receipts", { companyId: T.companyId, supplierId: supp.id, warehouseId: wh.RAW, receiptDate: D(2, 1), supplierRef: "DN-77",
      lines: [{ itemId: I.FLOUR.id, uomId: uom.SACK, qty: "10", unitCost: "45.500", lotNo: "F-2401", expiryDate: `${Y + 1}-01-31` }] }, as(T)));
    expect(r.total).toBe("455.0000");
    const pr = await post("/purchasing/receipts", r.id);
    expect(pr.number).toMatch(/^GR-/);
    const s = await stockOf(I.FLOUR.id, wh.RAW);
    expect(s.qty).toBe("500.0000"); expect(s.avg_cost).toBe("0.9100"); // 455 / 500 kg
    expect(await glBalance("1141")).toBe("455.0000");
    expect(await glBalance("2102")).toBe("-455.0000");

    const over = ok(await api("POST", "/api/v1/purchasing/invoices", { receiptId: r.id, supplierInvoiceNo: "INV-9", invoiceDate: D(2, 2), total: "500" }, as(T)));
    expect((await api("POST", `/api/v1/purchasing/invoices/${over.id}/post`, {}, as(P))).body.error.code).toBe("INVOICE_EXCEEDS_RECEIPT");
    await api("DELETE", `/api/v1/purchasing/invoices/${over.id}`, undefined, as(T));
    const si = ok(await api("POST", "/api/v1/purchasing/invoices", { receiptId: r.id, supplierInvoiceNo: "INV-10", invoiceDate: D(2, 2), total: "455" }, as(T)));
    const sip = await post("/purchasing/invoices", si.id);
    expect(sip.due_date).toBe(D(2, 17));
    expect(await glBalance("2102")).toBe("0.0000");
    expect(await glBalance("2101")).toBe("-455.0000");
    const dup = await api("POST", "/api/v1/purchasing/invoices", { receiptId: r.id, supplierInvoiceNo: "INV-10", invoiceDate: D(2, 2), total: "1" }, as(T));
    expect(dup.status).toBe(409); // same supplier invoice number twice

    const pay = ok(await api("POST", "/api/v1/purchasing/payments", { companyId: T.companyId, partyId: supp.id, method: "bank", paymentDate: D(2, 20), amount: "200", supplierInvoiceId: si.id }, as(T)));
    await post("/purchasing/payments", pay.id);
    expect(await glBalance("2101")).toBe("-255.0000");
    const tooMuch = ok(await api("POST", "/api/v1/purchasing/payments", { companyId: T.companyId, partyId: supp.id, method: "bank", paymentDate: D(2, 21), amount: "300", supplierInvoiceId: si.id }, as(T)));
    expect((await api("POST", `/api/v1/purchasing/payments/${tooMuch.id}/post`, {}, as(P))).body.error.code).toBe("PAYMENT_EXCEEDS_INVOICE");
  });

  let invoice: any;
  it("credit sale in cartons: list price × factor, discount, FEFO lot, COGS at average, AR journal", async () => {
    const d = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.MAIN, customerId: cust.id, invoiceDate: D(3, 1), paymentType: "credit",
      lines: [{ itemId: I.CHIPS.id, uomId: uom.CTN, qty: "2", discountPct: "10" }] }, as(T)));
    expect(d.lines[0].unit_price).toBe("30.0000");  // 1.250 × 24
    expect(d.lines[0].base_qty).toBe("48.0000");
    expect([d.subtotal, d.discount_total, d.total]).toEqual(["60.0000", "6.0000", "54.0000"]);
    invoice = await post("/sales/invoices", d.id);
    expect(invoice.number).toMatch(/^SI-/);
    expect(invoice.cogs_total).toBe("43.2000");      // 48 × 0.9
    expect(invoice.lines[0].lot_no).toBe("A-EARLY"); // earliest expiry first
    expect(invoice.due_date).toBe(D(3, 31));
    const je = (await api("GET", `/api/v1/accounting/journal-entries/${invoice.journal_entry_id}`, undefined, as(T))).body;
    const by = Object.fromEntries(je.lines.map((l: any) => [l.account_code, Number(l.debit) - Number(l.credit)]));
    expect(by).toEqual({ "1131": 54, "401": -60, "403": 6, "5101": 43.2, "1144": -43.2 });
    expect((await stockOf(I.CHIPS.id, wh.MAIN)).qty).toBe("152.0000");
  });

  it("credit limit is enforced at posting", async () => {
    const d = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.MAIN, customerId: cust.id, invoiceDate: D(3, 2), paymentType: "credit",
      lines: [{ itemId: I.CHIPS.id, qty: "40" }] }, as(T)));  // 50 + open 54 > 100
    const r = await api("POST", `/api/v1/sales/invoices/${d.id}/post`, {}, as(P));
    expect(r.body.error.code).toBe("CREDIT_LIMIT_EXCEEDED");
    await api("DELETE", `/api/v1/sales/invoices/${d.id}`, undefined, as(T));
  });

  it("insufficient stock rolls back the whole document (no partial stock or journal)", async () => {
    const before = await stockOf(I.CHIPS.id, wh.MAIN);
    const d = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.MAIN, customerId: cust2.id, invoiceDate: D(3, 3), paymentType: "cash",
      lines: [{ itemId: I.CHIPS.id, qty: "10" }, { itemId: I.CHIPS.id, qty: "1000" }] }, as(T)));
    const r = await api("POST", `/api/v1/sales/invoices/${d.id}/post`, {}, as(P));
    expect(r.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(await stockOf(I.CHIPS.id, wh.MAIN)).toEqual(before);
    expect((await api("GET", `/api/v1/sales/invoices/${d.id}`, undefined, as(T))).body.status).toBe("draft");
  });

  it("cannot sell from a quarantine / raw-materials warehouse", async () => {
    const r = await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.QC, customerId: cust.id, invoiceDate: D(3, 3), paymentType: "cash",
      lines: [{ itemId: I.CHIPS.id, qty: "1" }] }, as(T));
    expect(r.body.error.code).toBe("WAREHOUSE_NOT_SELLABLE");
  });

  it("customer return must go to quarantine; returns to the same lot at original cost; cannot exceed sold", async () => {
    const line = invoice.lines[0].id;
    const wrong = await api("POST", "/api/v1/sales/returns", { invoiceId: invoice.id, warehouseId: wh.MAIN, returnDate: D(3, 5), reason: "تلف تغليف", lines: [{ invoiceLineId: line, qty: "12" }] }, as(T));
    expect(wrong.body.error.code).toBe("RETURN_MUST_GO_TO_QUARANTINE");
    const d = ok(await api("POST", "/api/v1/sales/returns", { invoiceId: invoice.id, warehouseId: wh.QC, returnDate: D(3, 5), reason: "تلف تغليف", lines: [{ invoiceLineId: line, qty: "12" }] }, as(T)));
    expect(d.total).toBe("13.5000"); // 54 × 12/48
    const p = await post("/sales/returns", d.id);
    expect(p.cost_total).toBe("10.8000");
    const qc = await stockOf(I.CHIPS.id, wh.QC);
    expect(qc.qty).toBe("12.0000"); expect(qc.lots[0].lotNo).toBe("A-EARLY"); expect(qc.is_sellable).toBe(false);
    expect(await glBalance("1146")).toBe("10.8000");
    expect(await glBalance("402")).toBe("13.5000");
    const over = ok(await api("POST", "/api/v1/sales/returns", { invoiceId: invoice.id, warehouseId: wh.QC, returnDate: D(3, 6), reason: "أكثر من المباع", lines: [{ invoiceLineId: line, qty: "40" }] }, as(T)));
    expect((await api("POST", `/api/v1/sales/returns/${over.id}/post`, {}, as(P))).body.error.code).toBe("RETURN_EXCEEDS_SOLD");
  });

  it("quarantine stock leaves only through a release (permissioned), never a plain transfer", async () => {
    const t = await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "transfer", warehouseId: wh.QC, toWarehouseId: wh.MAIN, docDate: D(3, 7), lines: [{ itemId: I.CHIPS.id, qtyDelta: "12" }] }, as(T));
    expect(t.body.error.code).toBe("USE_QUARANTINE_RELEASE");
    const pending = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "quarantine_release", warehouseId: wh.QC, toWarehouseId: wh.MAIN, docDate: D(3, 7),
      lines: [{ itemId: I.CHIPS.id, qtyDelta: "10" }] }, as(T)));
    expect((await api("POST", `/api/v1/inventory/documents/${pending.id}/post`, {}, as(P))).body.error.code).toBe("QC_PASS_REQUIRED"); // no inspection yet
    await api("DELETE", `/api/v1/inventory/documents/${pending.id}`, undefined, as(T));
    const lotA = (await stockOf(I.CHIPS.id, wh.QC)).lots[0].lotId;
    const qc = await api("POST", "/api/v1/quality/checks", { companyId: T.companyId, lotId: lotA, stage: "return", results: [{ parameter: "فحص بصري للتغليف", passed: true }] }, as(P));
    expect(qc.status).toBe(201);
    const rel = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "quarantine_release", warehouseId: wh.QC, toWarehouseId: wh.MAIN, docDate: D(3, 7),
      notes: "فحص الجودة: سليم", lines: [{ itemId: I.CHIPS.id, qtyDelta: "10" }] }, as(T)));
    const clerk = await createUser(T, [{ roleId: await roleId(T.token, "warehouse_manager") }]); // can post stock documents, but release is a Quality decision
    expect((await api("POST", `/api/v1/inventory/documents/${rel.id}/post`, {}, { token: clerk.token })).body.error.details.permission).toBe("inventory.quarantine.release");
    await post("/inventory/documents", rel.id);
    expect((await stockOf(I.CHIPS.id, wh.QC)).qty).toBe("2.0000");
    expect(await glBalance("1146")).toBe("1.8000");
    // write off the rest as damaged
    const dmg = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "damage", warehouseId: wh.QC, docDate: D(3, 8), lines: [{ itemId: I.CHIPS.id, qtyDelta: "-2" }] }, as(T)));
    await post("/inventory/documents", dmg.id);
    expect(await glBalance("1146")).toBe("0.0000");
    expect(await glBalance("5103")).toBe("1.8000");
  });

  it("customer receipts allocate FIFO; any excess becomes a customer advance", async () => {
    const r1 = ok(await api("POST", "/api/v1/sales/receipts", { companyId: T.companyId, partyId: cust.id, method: "cash", paymentDate: D(3, 10), amount: "30" }, as(T)));
    const p1 = await post("/sales/receipts", r1.id);
    expect(p1.number).toMatch(/^RV-/);
    expect(p1.allocations).toHaveLength(1);
    const r2 = ok(await api("POST", "/api/v1/sales/receipts", { companyId: T.companyId, partyId: cust.id, method: "bank", paymentDate: D(3, 11), amount: "100" }, as(T)));
    await post("/sales/receipts", r2.id);
    const inv = (await api("GET", `/api/v1/sales/invoices/${invoice.id}`, undefined, as(T))).body;
    expect([inv.amount_paid, inv.amount_returned]).toEqual(["40.5000", "13.5000"]); // fully settled: 54 = 40.5 + 13.5
    expect(await glBalance("1131")).toBe("0.0000");
    expect(await glBalance("2106")).toBe("-89.5000"); // 130 received − 40.5 applied
  });

  it("cash sale debits the cash box and is fully paid", async () => {
    const d = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.MAIN, customerId: cust2.id, invoiceDate: D(3, 12), paymentType: "cash",
      lines: [{ itemId: I.CHIPS.id, qty: "4", unitPrice: "1.5", taxPct: "0" }] }, as(T)));
    const p = await post("/sales/invoices", d.id);
    expect(p.amount_paid).toBe(p.total);
    expect(await glBalance("1111")).toBe("36.0000"); // 30 cash receipt + 6 cash sale
  });

  it("subledgers reconcile with the GL and the trial balance balances", async () => {
    const v = (await api("GET", `/api/v1/inventory/valuation-check?companyId=${T.companyId}`, undefined, as(T))).body;
    expect(v.reconciled).toBe(true);
    const tb = (await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body;
    expect(tb.totals.balanced).toBe(true);
  });

  it("lot trace: from supplier/opening to every customer who received the lot", async () => {
    const lot = (await stockOf(I.CHIPS.id, wh.MAIN)).lots.find((l: any) => l.lotNo === "A-EARLY");
    const t = (await api("GET", `/api/v1/inventory/lots/${lot.lotId}/trace`, undefined, as(T))).body;
    expect(t.customers.map((c: any) => c.code).sort()).toEqual(["C001", "C002"]);
    const c1 = t.customers.find((c: any) => c.code === "C001");
    expect([c1.sold, c1.returned]).toEqual(["48.0000", "12.0000"]);
    expect(t.moves.map((m: any) => m.source_type)).toEqual(expect.arrayContaining(["stock_document", "sales_invoice", "sales_return"]));
  });

  it("reports: AR aging, customer statement, sales margin, item card", async () => {
    const aging = (await api("GET", `/api/v1/sales/ar-aging?companyId=${T.companyId}&asOf=${D(3, 31)}`, undefined, as(T))).body;
    expect(aging.rows).toEqual([]); // everything settled
    const st = (await api("GET", `/api/v1/customers/${cust.id}/statement?from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body;
    expect(st.lines.map((l: any) => l.kind)).toEqual(["invoice", "return", "receipt", "receipt"]);
    expect(st.lines.at(-1).balance).toBe("-89.5000"); // customer credit
    const an = (await api("GET", `/api/v1/sales/analysis?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body;
    const chips = an.byItem.find((x: any) => x.code === "FG-CHIPS-40");
    expect(chips.qty).toBe("40.0000"); // 48 − 12 + 4
    const card = (await api("GET", `/api/v1/inventory/items/${I.CHIPS.id}/card`, undefined, as(T))).body;
    expect(card.moves.at(-1).running_qty).toBe("158.0000"); // 200 − 48 + 12 (returned) − 2 (damaged) − 4 ; the QC→MAIN release nets 0
  });

  it("posted documents and the stock ledger are immutable at the DB level", async () => {
    await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE sales_invoices SET total = 1 WHERE id = $1", [invoice.id]))).rejects.toThrow(/immutable/);
    await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE sales_invoice_lines SET qty = 1 WHERE doc_id = $1", [invoice.id]))).rejects.toThrow(/immutable/);
    await expect(withTenant(T.tenantId, null, (db) => db.query("DELETE FROM stock_moves"))).rejects.toThrow();
    await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE stock_balances SET qty = -1"))).rejects.toThrow(/check/);
    expect((await api("DELETE", `/api/v1/sales/invoices/${invoice.id}`, undefined, as(T))).status).toBe(422);
  });

  it("food safety: expired lots are skipped by FEFO and can never be sold explicitly", async () => {
    const old = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh.MAIN, docDate: D(1, 2),
      lines: [{ itemId: I.CHIPS.id, qtyDelta: "5", unitCost: "0.9", lotNo: "EXPIRED-1", productionDate: `${Y - 1}-01-01`, expiryDate: `${Y - 1}-12-31` }] }, as(T)));
    await post("/inventory/documents", old.id);
    const stock = await stockOf(I.CHIPS.id, wh.MAIN);
    const expired = stock.lots.find((l: any) => l.lotNo === "EXPIRED-1");
    expect(stock.lots[0].lotNo).toBe("EXPIRED-1"); // earliest expiry first in the stock view …
    const auto = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.MAIN, customerId: cust2.id, invoiceDate: D(3, 20), paymentType: "cash",
      lines: [{ itemId: I.CHIPS.id, qty: "3", unitPrice: "1" }] }, as(T)));
    const pa = await post("/sales/invoices", auto.id);
    expect(pa.lines[0].lot_no).not.toBe("EXPIRED-1"); // … but FEFO for a sale skips it
    const manual = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.MAIN, customerId: cust2.id, invoiceDate: D(3, 20), paymentType: "cash",
      lines: [{ itemId: I.CHIPS.id, qty: "1", unitPrice: "1", lotId: expired.lotId }] }, as(T)));
    expect((await api("POST", `/api/v1/sales/invoices/${manual.id}/post`, {}, as(P))).body.error.code).toBe("LOT_EXPIRED");
    // expired stock can still be written off
    const wo = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "damage", warehouseId: wh.MAIN, docDate: D(3, 21),
      lines: [{ itemId: I.CHIPS.id, qtyDelta: "-5", lotId: expired.lotId }] }, as(T)));
    await post("/inventory/documents", wo.id);
    expect((await api("GET", `/api/v1/inventory/valuation-check?companyId=${T.companyId}`, undefined, as(T))).body.reconciled).toBe(true);
  });

  it("module gating: a plan without inventory cannot use items", async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting"] });
    const X = await provision(p, plan.code);
    expect((await api("GET", `/api/v1/items?companyId=${X.companyId}`, undefined, { token: X.token })).status).toBe(402);
  });

  it("subledgers agree with the GL after the whole scenario (go-live reconciliation)", async () => {
    const r = (await api("GET", `/api/v1/go-live/reconciliation?companyId=${T.companyId}&asOf=${Y + 1}-12-31`, undefined, { token: T.token })).body;
    expect(r.rows.filter((x: any) => !x.ok)).toEqual([]);
  });
});
