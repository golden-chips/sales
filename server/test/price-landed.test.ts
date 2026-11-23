import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear();
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("purchase price variance and landed costs (K14)", () => {
  let T: any, P: any, raw: string, I: Record<string, any>, supp: any, acc: Record<string, string>;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const post = async (path: string, id: string) => ok(await api("POST", `/api/v1${path}/${id}/post`, {}, as(P)), 200);
  const gl = async (code: string) => Number((await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body.rows.find((r: any) => r.code === code)?.closing ?? "0");
  const stock = async (itemId: string) => (await api("GET", `/api/v1/inventory/stock?companyId=${T.companyId}&itemId=${itemId}&warehouseId=${raw}`, undefined, as(T))).body[0];
  const receive = async (lines: any[]) => post("/purchasing/receipts", ok(await api("POST", "/api/v1/purchasing/receipts", { companyId: T.companyId, supplierId: supp.id, warehouseId: raw, receiptDate: D(2, 1), lines }, as(T))).id);
  const sInv = (receiptId: string, total: string, isFinal?: boolean) => api("POST", "/api/v1/purchasing/invoices", { receiptId, supplierInvoiceNo: `INV-${Math.random()}`, invoiceDate: D(2, 5), total, ...(isFinal ? { isFinal } : {}) }, as(T));

  beforeAll(async () => {
    const p = await platformToken();
    T = await provision(p, (await createPlan(p, { modules: ["accounting", "sales", "purchasing", "inventory"] })).code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    P = await createUser(T, await Promise.all(["finance_manager", "warehouse_manager"].map(async (c) => ({ roleId: await roleId(T.token, c) }))));
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    raw = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code: "RAW", nameAr: "خامات", kind: "raw_materials" }, as(T))).id;
    const kg = ok(await api("POST", "/api/v1/uoms", { code: "KG", nameAr: "كيلو" }, as(T))).id;
    I = {};
    for (const c of ["OIL", "SALT", "FLOUR"]) I[c] = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: c, nameAr: c, kind: "raw", baseUomId: kg }, as(T)));
    supp = ok(await api("POST", "/api/v1/suppliers", { companyId: T.companyId, code: "S1", nameAr: "مورد" }, as(T)));
  });

  it("final invoice above the receipt: the variance goes to stock still on hand, the used share to stock differences", async () => {
    const rc = await receive([{ itemId: I.OIL.id, qty: "100", unitCost: "2" }]);      // 200
    const use = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "damage", warehouseId: raw, docDate: D(2, 2), lines: [{ itemId: I.OIL.id, qtyDelta: "-40" }] }, as(T)));
    await post("/inventory/documents", use.id);                                          // 60 left
    const over = ok(await sInv(rc.id, "220"));
    expect((await api("POST", `/api/v1/purchasing/invoices/${over.id}/post`, {}, as(P))).body.error.code).toBe("INVOICE_EXCEEDS_RECEIPT");
    ok(await api("DELETE", `/api/v1/purchasing/invoices/${over.id}`, undefined, as(T)), 200);
    const diff0 = await gl("5104");
    const fin = await post("/purchasing/invoices", ok(await sInv(rc.id, "220", true)).id);
    expect(fin.price_variance).toBe("20.0000");
    const s = await stock(I.OIL.id);
    expect([s.qty, s.value]).toEqual(["60.0000", "132.0000"]);                            // 120 + 60% of 20
    expect(await gl("5104") - diff0).toBeCloseTo(8, 4);                                   // 40% of the variance: goods already used
    expect(await gl("2102")).toBeCloseTo(0, 4);                                           // GRNI cleared
    const again = ok(await sInv(rc.id, "5", true));
    expect((await api("POST", `/api/v1/purchasing/invoices/${again.id}/post`, {}, as(P))).body.error.code).toBe("RECEIPT_FULLY_INVOICED");
  });

  it("final invoice below the receipt lowers the stock value", async () => {
    const rc = await receive([{ itemId: I.SALT.id, qty: "50", unitCost: "1" }]);          // 50, all on hand
    const fin = await post("/purchasing/invoices", ok(await sInv(rc.id, "45", true)).id);
    expect(fin.price_variance).toBe("-5.0000");
    expect((await stock(I.SALT.id)).value).toBe("45.0000");
  });

  it("landed cost split by quantity; paid from the bank; control accounts refused; segregation of duties", async () => {
    const rc = await receive([{ itemId: I.FLOUR.id, qty: "10", unitCost: "10" }, { itemId: I.OIL.id, qty: "30", unitCost: "2" }]);
    const oil0 = Number((await stock(I.OIL.id)).value), bank0 = await gl("1121");
    expect((await api("POST", "/api/v1/purchasing/landed-costs", { receiptId: rc.id, costDate: D(2, 6), description: "شحن", amount: "40", split: "qty", creditAccountId: acc["2101"] }, as(T))).body.error.code)
      .toBe("CONTROL_ACCOUNT");
    const lc = ok(await api("POST", "/api/v1/purchasing/landed-costs", { receiptId: rc.id, costDate: D(2, 6), description: "شحن وتفريغ", amount: "40", split: "qty", creditAccountId: acc["1121"] }, as(T)));
    expect((await api("POST", `/api/v1/purchasing/landed-costs/${lc.id}/post`, {}, as(T))).body.error.code).toBe("SEGREGATION_OF_DUTIES");
    const p = await post("/purchasing/landed-costs", lc.id);
    expect([p.number.slice(0, 3), p.capitalized, p.expensed]).toEqual(["LC-", "40.0000", "0.0000"]);
    expect((await stock(I.FLOUR.id)).value).toBe("110.0000");                            // 100 + 10 (10 of 40 kg)
    expect(Number((await stock(I.OIL.id)).value) - oil0).toBeCloseTo(30, 4);              // 30 of 40 kg of the landed cost
    expect(await gl("1121") - bank0).toBeCloseTo(-40, 4);
  });

  it("subledgers agree with the GL", async () => {
    const r = (await api("GET", `/api/v1/go-live/reconciliation?companyId=${T.companyId}&asOf=${Y}-12-31`, undefined, as(T))).body;
    expect(r.rows.filter((x: any) => !x.ok)).toEqual([]);
  });
});
