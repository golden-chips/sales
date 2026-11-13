import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear() - 1;
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const AS_OF = D(6, 30);

describe("smart insights (advisory)", () => {
  let T: any, P: any, SM: any, acc: Record<string, string>, I: Record<string, any>, regular: any, fresh: any;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const insight = (kind: string, who: any) => api("GET", `/api/v1/bi/insights/${kind}?companyId=${T.companyId}&asOf=${AS_OF}`, undefined, as(who));

  beforeAll(async () => {
    const p = await platformToken();
    T = await provision(p, (await createPlan(p, { modules: ["accounting", "sales", "inventory", "bi"] })).code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    P = await createUser(T, await Promise.all(["finance_manager", "warehouse_manager", "sales_manager"].map(async (c) => ({ roleId: await roleId(T.token, c) }))));
    SM = await createUser(T, [{ roleId: await roleId(T.token, "sales_manager") }]);
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    const wh = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code: "FG", nameAr: "تام", kind: "finished_goods" }, as(T))).id;
    const u = ok(await api("POST", "/api/v1/uoms", { code: "PCS", nameAr: "قطعة" }, as(T))).id;
    I = {};
    for (const [code, kind] of [["FG-A", "finished"], ["FG-B", "finished"], ["PK-BOX", "packaging"]] as const)
      I[code] = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code, nameAr: code, kind, baseUomId: u, salesPrice: "3" }, as(T)));
    const d = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh, docDate: D(1, 2), lines: [
      { itemId: I["FG-A"].id, qtyDelta: "200", unitCost: "1" }, { itemId: I["FG-B"].id, qtyDelta: "50", unitCost: "2" }, { itemId: I["PK-BOX"].id, qtyDelta: "100", unitCost: "0.5" }] }, as(T)));
    ok(await api("POST", `/api/v1/inventory/documents/${d.id}/post`, {}, as(P)), 200);
    regular = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C-REG", nameAr: "عميل منتظم" }, as(T)));
    fresh = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C-NEW", nameAr: "عميل حديث" }, as(T)));
    const sell = async (cust: any, date: string, item: string, qty: string) => {
      const inv = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh, customerId: cust.id, invoiceDate: date, paymentType: "cash", lines: [{ itemId: I[item].id, qty }] }, as(T)));
      ok(await api("POST", `/api/v1/sales/invoices/${inv.id}/post`, {}, as(P)), 200);
    };
    await sell(regular, D(3, 15), "FG-A", "10");
    await sell(regular, D(4, 15), "FG-A", "20");
    await sell(regular, D(5, 15), "FG-A", "30");
    await sell(fresh, D(6, 1), "PK-BOX", "90");
    // 15 ordinary manual rent entries of 100 and one of 5000 on the same account
    const manual = async (amount: string, day: number, dr = "5402", cr = "1111") => {
      const je = ok(await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: D(6, day), memo: "إيجار",
        lines: [{ accountId: acc[dr], debit: amount }, { accountId: acc[cr], credit: amount }] }, as(T)));
      ok(await api("POST", `/api/v1/accounting/journal-entries/${je.id}/post`, {}, as(P)), 200);
    };
    for (let i = 1; i <= 15; i++) await manual("100", i);
    await manual("5000", 20);
    await manual("20000", 21, "5404", "1121");                     // large round amount (other accounts)
    for (let k = 0; k < 2; k++) {                                 // the same receipt entered twice
      const r = ok(await api("POST", "/api/v1/sales/receipts", { companyId: T.companyId, partyId: fresh.id, method: "cash", paymentDate: D(6, 25), amount: "45" }, as(T)));
      ok(await api("POST", `/api/v1/sales/receipts/${r.id}/post`, {}, as(P)), 200);
    }
  });

  it("slow stock: stock not consumed for 90 days", async () => {
    const r = ok(await insight("slow-stock", P), 200);
    expect(r.items.map((x: any) => x.code)).toEqual(["FG-B"]);   // FG-A and PK-BOX were sold recently
    expect(r.totalValue).toBe("100.0000");
    expect(r.method.ar).toContain("90");
  });

  it("demand forecast: weighted moving average with confidence and suggested production", async () => {
    const r = ok(await insight("demand-forecast", SM), 200);
    const a = r.items.find((x: any) => x.code === "FG-A");
    expect(a.history.map((h: any) => h.qty)).toEqual([0, 0, 0, 10, 20, 30]);
    expect([a.forecast_next_month, a.confidence, a.on_hand, a.suggested_production]).toEqual([23.33, "medium", 140, 0]);   // (10 + 40 + 90) / 6
  });

  it("purchase suggestions from 90-day consumption, lead time and safety stock", async () => {
    const r = ok(await insight("purchase-suggestions", P), 200);
    expect(r.items).toEqual([expect.objectContaining({ code: "PK-BOX", daily_use: "1.0000", on_hand: "10.0000", days_of_cover: "10", suggested_qty: "11" })]);   // 1 × (14 + 7) − 10
  });

  it("lapsed customers", async () => {
    const r = ok(await insight("lapsed-customers", SM), 200);
    expect(r.items.map((x: any) => [x.code, x.invoices_before])).toEqual([["C-REG", 3]]);
  });

  it("unusual entries for review: size outlier, round amount, duplicate payments; sensitive and gated", async () => {
    const r = ok(await insight("anomalies", P), 200);
    expect(r.unusual_size.map((x: any) => [x.account, x.amount])).toEqual(expect.arrayContaining([["5402", "5000.0000"]]));
    expect(r.round_amounts.map((x: any) => x.amount)).toEqual(["20000.0000"]);
    expect(r.duplicate_payments).toEqual([expect.objectContaining({ party: "C-NEW", amount: "45.0000", times: 2 })]);
    expect((await insight("anomalies", SM)).status).toBe(403);           // sales manager: no access to anomaly review
    expect((await insight("production-cost", P)).status).toBe(402);      // manufacturing not in this plan
    expect(ok(await api("GET", "/api/v1/bi/insights", undefined, as(SM)), 200)).toEqual(["slow-stock", "demand-forecast", "purchase-suggestions", "lapsed-customers"]);
  });
});
