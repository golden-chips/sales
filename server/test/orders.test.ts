import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear() - 1;
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("quotations, sales orders and purchase orders", () => {
  let T: any, SM: any, W: any, F: any;   // owner, sales manager, warehouse manager, finance manager
  let wh: string, cust: any, small: any, chips: any, oil: any, supplier: any, ctn: string;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const stock = async (itemId: string) => (await api("GET", `/api/v1/inventory/stock?companyId=${T.companyId}&itemId=${itemId}&warehouseId=${wh}`, undefined, as(T))).body[0]?.qty ?? "0";

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "sales", "inventory", "purchasing"] });
    T = await provision(p, plan.code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    SM = await createUser(T, [{ roleId: await roleId(T.token, "sales_manager") }]);
    W = await createUser(T, [{ roleId: await roleId(T.token, "warehouse_manager") }]);
    F = await createUser(T, [{ roleId: await roleId(T.token, "finance_manager") }]);
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    wh = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code: "FG", nameAr: "مخزن تام", kind: "finished_goods" }, as(T))).id;
    const bag = ok(await api("POST", "/api/v1/uoms", { code: "BAG", nameAr: "كيس" }, as(T))).id;
    ctn = ok(await api("POST", "/api/v1/uoms", { code: "CTN", nameAr: "كرتونة" }, as(T))).id;
    chips = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "FG-CHIPS", nameAr: "رقائق (اختبار)", kind: "finished", baseUomId: bag, salesPrice: "1.000",
      units: [{ uomId: ctn, factor: "24" }] }, as(T)));
    oil = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "RM-OIL", nameAr: "زيت (اختبار)", kind: "raw", baseUomId: bag }, as(T)));
    const d = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh, docDate: D(1, 2),
      lines: [{ itemId: chips.id, qtyDelta: "100", unitCost: "0.6" }] }, as(T)));
    ok(await api("POST", `/api/v1/inventory/documents/${d.id}/post`, {}, as(W)), 200);
    cust = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C001", nameAr: "سوق اختبار", paymentTermsDays: 30 }, as(T)));
    small = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C002", nameAr: "بقالة اختبار", creditLimit: "30", paymentTermsDays: 30 }, as(T)));
    supplier = ok(await api("POST", "/api/v1/suppliers", { companyId: T.companyId, code: "S001", nameAr: "مورد اختبار" }, as(T)));
  });

  it("quotation → sent → converted to a draft order with the same prices; cannot convert twice", async () => {
    const q = ok(await api("POST", "/api/v1/sales-quotations", { companyId: T.companyId, customerId: cust.id, quoteDate: D(3, 1),
      lines: [{ itemId: chips.id, uomId: ctn, qty: "2", discountPct: "10" }] }, as(SM)));
    expect(q.number).toMatch(/^QT-/);
    expect([q.lines[0].unit_price, q.lines[0].base_qty, q.subtotal, q.total, q.valid_until.slice(0, 10)]).toEqual(["24.0000", "48.0000", "48.0000", "43.2000", D(3, 16)]);
    ok(await api("POST", `/api/v1/sales-quotations/${q.id}/send`, {}, as(SM)), 200);
    expect((await api("POST", `/api/v1/sales-quotations/${q.id}/convert`, { warehouseId: wh, orderDate: D(4, 1) }, as(SM))).body.error.code).toBe("QUOTATION_EXPIRED");
    const o = ok(await api("POST", `/api/v1/sales-quotations/${q.id}/convert`, { warehouseId: wh, orderDate: D(3, 5) }, as(SM)));
    expect([o.status, o.total, o.quotation_number, o.lines[0].unit_price, o.lines[0].discount_pct]).toEqual(["draft", "43.2000", q.number, "24.0000", "10.0000"]);
    expect(ok(await api("GET", `/api/v1/sales-quotations/${q.id}`, undefined, as(SM)), 200).status).toBe("converted");
    expect((await api("POST", `/api/v1/sales-quotations/${q.id}/convert`, { warehouseId: wh, orderDate: D(3, 5) }, as(SM))).body.error.code).toBe("QUOTATION_CLOSED");
    expect((await api("GET", `/api/v1/sales-quotations?companyId=${T.companyId}`, undefined, as(W))).status).toBe(403);
  });

  it("confirming reserves stock: a second order cannot promise the same bags; backorder is explicit", async () => {
    const mk = async (qty: string) => ok(await api("POST", "/api/v1/sales-orders", { companyId: T.companyId, warehouseId: wh, customerId: cust.id, orderDate: D(3, 6),
      lines: [{ itemId: chips.id, qty }] }, as(SM)));
    const a = await mk("70");
    expect(ok(await api("POST", `/api/v1/sales-orders/${a.id}/confirm`, {}, as(SM)), 200).status).toBe("confirmed");
    expect(ok(await api("GET", `/api/v1/sales-orders/availability?warehouseId=${wh}&itemId=${chips.id}`, undefined, as(SM)), 200).availableToPromise).toBe("30.0000");
    const b = await mk("40");
    const r = await api("POST", `/api/v1/sales-orders/${b.id}/confirm`, {}, as(SM));
    expect([r.body.error.code, r.body.error.details[0].available]).toEqual(["INSUFFICIENT_AVAILABLE", 30]);
    expect(ok(await api("POST", `/api/v1/sales-orders/${b.id}/confirm`, { allowBackorder: true }, as(SM)), 200).status).toBe("confirmed");
    // the backorder is cancelled; the first order keeps its reservation
    expect(ok(await api("POST", `/api/v1/sales-orders/${b.id}/close`, { reason: "اختبار" }, as(SM)), 200).status).toBe("cancelled");
    expect(ok(await api("GET", `/api/v1/sales-orders/availability?warehouseId=${wh}&itemId=${chips.id}`, undefined, as(SM)), 200).availableToPromise).toBe("30.0000");

    // partial invoice → posted → partially delivered; no over-invoicing; one draft at a time
    const line = a.lines[0].id;
    expect((await api("POST", `/api/v1/sales-orders/${a.id}/invoice`, { invoiceDate: D(3, 7), lines: [{ orderLineId: line, qty: "71" }] }, as(SM))).body.error.code).toBe("EXCEEDS_ORDER");
    const inv1 = ok(await api("POST", `/api/v1/sales-orders/${a.id}/invoice`, { invoiceDate: D(3, 7), lines: [{ orderLineId: line, qty: "30" }] }, as(SM)));
    expect([inv1.status, inv1.total, inv1.sales_order_id]).toEqual(["draft", "30.0000", a.id]);
    expect((await api("POST", `/api/v1/sales-orders/${a.id}/invoice`, { invoiceDate: D(3, 7) }, as(SM))).body.error.code).toBe("DRAFT_INVOICE_EXISTS");
    ok(await api("POST", `/api/v1/sales/invoices/${inv1.id}/post`, {}, as(T)), 200);
    let so = ok(await api("GET", `/api/v1/sales-orders/${a.id}`, undefined, as(SM)), 200);
    expect([so.status, so.lines[0].delivered_base_qty, so.lines[0].remaining_base_qty, so.invoices.length]).toEqual(["partially_delivered", "30.0000", "40.0000", 1]);
    expect(await stock(chips.id)).toBe("70.0000");
    // the 40 still reserved + 70 on hand → still 30 available
    expect(ok(await api("GET", `/api/v1/sales-orders/availability?warehouseId=${wh}&itemId=${chips.id}`, undefined, as(SM)), 200).availableToPromise).toBe("30.0000");
    const inv2 = ok(await api("POST", `/api/v1/sales-orders/${a.id}/invoice`, { invoiceDate: D(3, 8) }, as(SM)));
    expect(inv2.total).toBe("40.0000");
    ok(await api("POST", `/api/v1/sales/invoices/${inv2.id}/post`, {}, as(T)), 200);
    so = ok(await api("GET", `/api/v1/sales-orders/${a.id}`, undefined, as(SM)), 200);
    expect([so.status, so.lines[0].remaining_base_qty]).toEqual(["delivered", "0.0000"]);
    expect((await api("POST", `/api/v1/sales-orders/${a.id}/invoice`, { invoiceDate: D(3, 9) }, as(SM))).body.error.code).toBe("ORDER_NOT_OPEN");
    expect((await api("POST", `/api/v1/sales-orders/${a.id}/close`, { reason: "x1" }, as(SM))).body.error.code).toBe("ORDER_CLOSED");
  });

  it("credit limit counts open invoices and open orders; cash orders are not limited", async () => {
    const mk = (qty: string, paymentType = "credit") => api("POST", "/api/v1/sales-orders", { companyId: T.companyId, warehouseId: wh, customerId: small.id, orderDate: D(3, 10), paymentType,
      lines: [{ itemId: chips.id, qty }] }, as(SM)).then((r) => ok(r));
    const a = await mk("20");
    ok(await api("POST", `/api/v1/sales-orders/${a.id}/confirm`, {}, as(SM)), 200);
    const b = await mk("11");
    const r = await api("POST", `/api/v1/sales-orders/${b.id}/confirm`, {}, as(SM));
    expect([r.body.error.code, r.body.error.details.open]).toEqual(["CREDIT_LIMIT_EXCEEDED", "20.0000"]);
    const c = await mk("5", "cash");
    expect(ok(await api("POST", `/api/v1/sales-orders/${c.id}/confirm`, {}, as(SM)), 200).status).toBe("confirmed");
    // the trigger keeps confirmed lines frozen except the delivered counter
    expect((await api("GET", `/api/v1/sales-orders/${c.id}`, undefined, as(W))).status).toBe(403);
  });

  it("purchase orders: auto-approve at or below the threshold, otherwise an approver ≠ creator; receipts cannot exceed the order", async () => {
    expect((await api("PUT", "/api/v1/order-settings", { companyId: T.companyId, poApprovalThreshold: "1000" }, as(W))).status).toBe(403);
    ok(await api("PUT", "/api/v1/order-settings", { companyId: T.companyId, poApprovalThreshold: "1000" }, as(T)), 200);
    const mk = (who: any, qty: string, cost: string) => api("POST", "/api/v1/purchase-orders", { companyId: T.companyId, supplierId: supplier.id, warehouseId: wh, orderDate: D(3, 1),
      lines: [{ itemId: oil.id, qty, unitCost: cost }] }, as(who)).then((r) => ok(r));
    const cheap = await mk(W, "100", "5");
    expect(cheap.number).toMatch(/^PO-/);
    expect(ok(await api("POST", `/api/v1/purchase-orders/${cheap.id}/submit`, {}, as(W)), 200).status).toBe("approved");

    const big = await mk(W, "400", "5");
    expect(ok(await api("POST", `/api/v1/purchase-orders/${big.id}/submit`, {}, as(W)), 200).status).toBe("pending_approval");
    expect((await api("POST", `/api/v1/purchase-orders/${big.id}/receive`, { receiptDate: D(3, 2), lines: [{ orderLineId: big.lines[0].id, qty: "1" }] }, as(W))).body.error.code).toBe("ORDER_NOT_APPROVED");
    expect((await api("POST", `/api/v1/purchase-orders/${big.id}/decide`, { decision: "approved" }, as(W))).status).toBe(403);
    expect((await api("POST", `/api/v1/purchase-orders/${big.id}/decide`, { decision: "rejected" }, as(F))).status).toBe(422);
    const own = await mk(F, "300", "5");
    ok(await api("POST", `/api/v1/purchase-orders/${own.id}/submit`, {}, as(F)), 200);
    expect((await api("POST", `/api/v1/purchase-orders/${own.id}/decide`, { decision: "approved" }, as(F))).body.error.code).toBe("SEGREGATION_OF_DUTIES");
    const ap = ok(await api("POST", `/api/v1/purchase-orders/${big.id}/decide`, { decision: "approved" }, as(F)), 200);
    expect([ap.status, ap.approved_by]).toEqual(["approved", F.id]);

    // receive 150 then 250; never more than ordered
    const L = big.lines[0].id;
    expect((await api("POST", `/api/v1/purchase-orders/${big.id}/receive`, { receiptDate: D(3, 3), lines: [{ orderLineId: L, qty: "401" }] }, as(W))).body.error.code).toBe("EXCEEDS_ORDER");
    const r1 = ok(await api("POST", `/api/v1/purchase-orders/${big.id}/receive`, { receiptDate: D(3, 3), lines: [{ orderLineId: L, qty: "150" }] }, as(W)));
    expect([r1.status, r1.total]).toEqual(["draft", "750.0000"]);
    ok(await api("POST", `/api/v1/purchasing/receipts/${r1.id}/post`, {}, as(T)), 200);
    let po = ok(await api("GET", `/api/v1/purchase-orders/${big.id}`, undefined, as(W)), 200);
    expect([po.status, po.lines[0].received_base_qty, po.receipts.length]).toEqual(["partially_received", "150.0000", 1]);
    expect((await api("POST", `/api/v1/purchase-orders/${big.id}/receive`, { receiptDate: D(3, 4), lines: [{ orderLineId: L, qty: "251" }] }, as(W))).body.error.code).toBe("EXCEEDS_ORDER");
    const r2 = ok(await api("POST", `/api/v1/purchase-orders/${big.id}/receive`, { receiptDate: D(3, 4), lines: [{ orderLineId: L, qty: "250" }] }, as(W)));
    ok(await api("POST", `/api/v1/purchasing/receipts/${r2.id}/post`, {}, as(T)), 200);
    po = ok(await api("GET", `/api/v1/purchase-orders/${big.id}`, undefined, as(F)), 200);
    expect(po.status).toBe("received");
    expect(await stock(oil.id)).toBe("400.0000");

    // a part-received order can be closed; an untouched one is cancelled
    const r3 = ok(await api("POST", `/api/v1/purchase-orders/${cheap.id}/receive`, { receiptDate: D(3, 5), lines: [{ orderLineId: cheap.lines[0].id, qty: "10" }] }, as(W)));
    ok(await api("POST", `/api/v1/purchasing/receipts/${r3.id}/post`, {}, as(T)), 200);
    expect(ok(await api("POST", `/api/v1/purchase-orders/${cheap.id}/close`, { reason: "المورد لا يملك الباقي" }, as(W)), 200).status).toBe("closed");
    expect(ok(await api("POST", `/api/v1/purchase-orders/${own.id}/close`, { reason: "ألغي" }, as(F)), 200).status).toBe("cancelled");
  });
});
