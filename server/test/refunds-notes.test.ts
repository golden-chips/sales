import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear();
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("refunds on returns, customer credit notes, supplier debit notes (K15)", () => {
  let T: any, P: any, wh: Record<string, string>, item: any, cust: any, supp: any, acc: Record<string, string>;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const post = async (path: string, id: string) => ok(await api("POST", `/api/v1${path}/${id}/post`, {}, as(P)), 200);
  const gl = async (code: string) => (await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body.rows.find((r: any) => r.code === code)?.closing ?? "0";
  const invoice = async (qty: string) => post("/sales/invoices", ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.MAIN, customerId: cust.id,
    invoiceDate: D(3, 1), paymentType: "credit", lines: [{ itemId: item.id, qty, unitPrice: "2" }] }, as(T))).id);
  const receipt = async (invId: string, amount: string) => post("/sales/receipts", ok(await api("POST", "/api/v1/sales/receipts", { companyId: T.companyId, partyId: cust.id, method: "cash",
    paymentDate: D(3, 2), amount, salesInvoiceId: invId }, as(T))).id);
  const ret = (inv: any, qty: string, refundMethod?: string) => api("POST", "/api/v1/sales/returns", { invoiceId: inv.id, warehouseId: wh.QC, returnDate: D(3, 5), reason: "تلف تغليف",
    ...(refundMethod ? { refundMethod } : {}), lines: [{ invoiceLineId: inv.lines[0].id, qty }] }, as(T));
  const statementEnd = async () => { const s = ok(await api("GET", `/api/v1/customers/${cust.id}/statement?from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T)), 200); return s.lines.at(-1)?.balance; };
  const getInv = async (id: string) => ok(await api("GET", `/api/v1/sales/invoices/${id}`, undefined, as(T)), 200);

  beforeAll(async () => {
    const p = await platformToken();
    T = await provision(p, (await createPlan(p, { modules: ["accounting", "sales", "purchasing", "inventory"] })).code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    P = await createUser(T, await Promise.all(["finance_manager", "warehouse_manager", "sales_manager"].map(async (c) => ({ roleId: await roleId(T.token, c) }))));
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    wh = {};
    for (const [code, kind] of [["MAIN", "finished_goods"], ["QC", "quarantine"]] as const) wh[code] = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code, nameAr: code, kind }, as(T))).id;
    const bag = ok(await api("POST", "/api/v1/uoms", { code: "BAG", nameAr: "كيس" }, as(T))).id;
    item = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "FG-1", nameAr: "صنف اختبار", kind: "finished", baseUomId: bag, salesPrice: "2" }, as(T)));
    const d = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh.MAIN, docDate: D(1, 2), lines: [{ itemId: item.id, qtyDelta: "500", unitCost: "1" }] }, as(T)));
    await post("/inventory/documents", d.id);
    cust = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C1", nameAr: "عميل اختبار", paymentTermsDays: 30 }, as(T)));
    supp = ok(await api("POST", "/api/v1/suppliers", { companyId: T.companyId, code: "S1", nameAr: "مورد اختبار" }, as(T)));
  });

  it("return of a fully paid invoice refunds in cash; the statement shows it and stays equal to the GL", async () => {
    const inv = await invoice("10");                 // 20
    await receipt(inv.id, "20");
    const cash0 = Number(await gl("1111"));
    const noRefund = ok(await ret(inv, "4"));        // 8, nothing open → refund needed
    const r = await api("POST", `/api/v1/sales/returns/${noRefund.id}/post`, {}, as(P));
    expect([r.body.error.code, r.body.error.details.refund]).toEqual(["REFUND_METHOD_REQUIRED", "8.0000"]);
    ok(await api("DELETE", `/api/v1/sales/returns/${noRefund.id}`, undefined, as(T)), 200);
    const withCash = await post("/sales/returns", ok(await ret(inv, "4", "cash")).id);
    expect(withCash.refund_amount).toBe("8.0000");
    expect(Number(await gl("1111"))).toBeCloseTo(cash0 - 8, 4);
    const i = await getInv(inv.id);
    expect([i.amount_paid, i.amount_returned]).toEqual(["12.0000", "8.0000"]);
    expect(Number(await statementEnd())).toBeCloseTo(0, 4);
  });

  it("partly paid: the open part is credited, only the paid excess is refunded (bank)", async () => {
    const inv = await invoice("10");                 // 20, pay 15 → open 5
    await receipt(inv.id, "15");
    const bank0 = Number(await gl("1121"));
    const r = await post("/sales/returns", ok(await ret(inv, "5", "bank")).id);   // 10 → 5 against the open balance, 5 refunded
    expect(r.refund_amount).toBe("5.0000");
    expect(Number(await gl("1121"))).toBeCloseTo(bank0 - 5, 4);
    const i = await getInv(inv.id);
    expect([i.amount_paid, i.amount_returned]).toEqual(["10.0000", "10.0000"]);
    expect(Number(await statementEnd())).toBeCloseTo(0, 4);
  });

  it("customer credit note: discount after the sale reduces the invoice; cannot exceed what is open; segregation of duties", async () => {
    const inv = await invoice("10");                 // 20 open
    const big = await api("POST", "/api/v1/sales/credit-notes", { invoiceId: inv.id, noteDate: D(3, 6), amount: "25", reason: "خصم كمية" }, as(T));
    expect(big.body.error.code).toBe("NOTE_EXCEEDS_OPEN");
    const ctrl = await api("POST", "/api/v1/sales/credit-notes", { invoiceId: inv.id, noteDate: D(3, 6), amount: "3", reason: "خصم", accountId: acc["1131"] }, as(T));
    expect(ctrl.body.error.code).toBe("CONTROL_ACCOUNT");
    const n = ok(await api("POST", "/api/v1/sales/credit-notes", { invoiceId: inv.id, noteDate: D(3, 6), amount: "3", reason: "خصم كمية متفق عليه" }, as(T)));
    expect((await api("POST", `/api/v1/sales/credit-notes/${n.id}/post`, {}, as(T))).body.error.code).toBe("SEGREGATION_OF_DUTIES");
    const p = await post("/sales/credit-notes", n.id);
    expect(p.number).toMatch(/^CN-/);
    expect(await gl("403")).toBe("3.0000");          // sales discounts
    const i = await getInv(inv.id);
    expect(Number(i.total) - Number(i.amount_paid) - Number(i.amount_returned)).toBeCloseTo(17, 4);
    expect(Number(await statementEnd())).toBeCloseTo(17, 4);
  });

  it("supplier debit note reduces the supplier invoice; payments cannot exceed what is left", async () => {
    const rc = ok(await api("POST", "/api/v1/purchasing/receipts", { companyId: T.companyId, supplierId: supp.id, warehouseId: wh.MAIN, receiptDate: D(3, 1),
      lines: [{ itemId: item.id, qty: "50", unitCost: "2" }] }, as(T)));
    await post("/purchasing/receipts", rc.id);
    const si = await post("/purchasing/invoices", ok(await api("POST", "/api/v1/purchasing/invoices", { receiptId: rc.id, supplierInvoiceNo: "INV-1", invoiceDate: D(3, 2), total: "100" }, as(T))).id);
    expect((await api("POST", "/api/v1/purchasing/debit-notes", { invoiceId: si.id, noteDate: D(3, 3), amount: "10", reason: "خصم تعويض تلف" }, as(T))).status).toBe(422); // account required
    const dn = ok(await api("POST", "/api/v1/purchasing/debit-notes", { invoiceId: si.id, noteDate: D(3, 3), amount: "10", reason: "خصم تعويض تلف", accountId: acc["5104"] }, as(T)));
    const p = await post("/purchasing/debit-notes", dn.id);
    expect(p.number).toMatch(/^DN-/);
    const pay = ok(await api("POST", "/api/v1/purchasing/payments", { companyId: T.companyId, partyId: supp.id, method: "bank", paymentDate: D(3, 10), amount: "95", supplierInvoiceId: si.id }, as(T)));
    expect((await api("POST", `/api/v1/purchasing/payments/${pay.id}/post`, {}, as(P))).status).not.toBe(200);   // only 90 left
    const pay2 = ok(await api("POST", "/api/v1/purchasing/payments", { companyId: T.companyId, partyId: supp.id, method: "bank", paymentDate: D(3, 10), amount: "90", supplierInvoiceId: si.id }, as(T)));
    await post("/purchasing/payments", pay2.id);
  });

  it("subledgers agree with the GL after refunds and notes", async () => {
    const r = (await api("GET", `/api/v1/go-live/reconciliation?companyId=${T.companyId}&asOf=${Y}-12-31`, undefined, as(T))).body;
    expect(r.rows.filter((x: any) => !x.ok)).toEqual([]);
  });
});
