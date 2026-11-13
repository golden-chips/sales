import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { api, getApp, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear() - 1;
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("BI dashboards, exports, alerts and schedules", () => {
  let T: any, P: any, SM: any, acc: Record<string, string>, wh: string, item: any, cust: any;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const dash = async (area: string, who: any, extra = "") => api("GET", `/api/v1/bi/dashboards/${area}?companyId=${T.companyId}&from=${D(3, 1)}&to=${D(3, 31)}${extra}`, undefined, as(who));
  const kpi = (d: any, key: string) => d.kpis.find((k: any) => k.key === key);

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "sales", "inventory", "quality", "bi"] });
    T = await provision(p, plan.code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    P = await createUser(T, await Promise.all(["warehouse_manager", "finance_manager", "sales_manager"].map(async (c) => ({ roleId: await roleId(T.token, c) }))));
    SM = await createUser(T, [{ roleId: await roleId(T.token, "sales_manager") }]);
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    wh = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code: "FG", nameAr: "تام", kind: "finished_goods" }, as(T))).id;
    const bag = ok(await api("POST", "/api/v1/uoms", { code: "BAG", nameAr: "كيس" }, as(T))).id;
    item = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "FG-1", nameAr: "منتج (اختبار)", kind: "finished", baseUomId: bag, trackLots: true, salesPrice: "2", reorderLevel: "500" }, as(T)));
    const d = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh, docDate: D(1, 2), lines: [
      { itemId: item.id, qtyDelta: "100", unitCost: "1", lotNo: "SOON", productionDate: D(1, 1), expiryDate: D(4, 10) },
      { itemId: item.id, qtyDelta: "100", unitCost: "1", lotNo: "LATER", productionDate: D(1, 1), expiryDate: `${Y + 1}-12-31` }] }, as(T)));
    ok(await api("POST", `/api/v1/inventory/documents/${d.id}/post`, {}, as(P)), 200);
    cust = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C1", nameAr: "عميل" }, as(T)));
    const sell = async (date: string, qty: string) => {
      const inv = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh, customerId: cust.id, invoiceDate: date, paymentType: "cash", lines: [{ itemId: item.id, qty }] }, as(T)));
      ok(await api("POST", `/api/v1/sales/invoices/${inv.id}/post`, {}, as(P)), 200);
    };
    await sell(D(2, 10), "10");   // previous period (Feb)
    await sell(D(3, 5), "30");    // March
    await sell(D(3, 20), "20");
  });

  it("sales dashboard: live figures, comparison with the previous period, channels, drill-down", async () => {
    const d = ok(await dash("sales", SM), 200);
    expect(kpi(d, "net_sales")).toMatchObject({ value: "100.0000", previous: "20.0000", drill: "/sales/invoices" });   // 50 × 2 vs 10 × 2
    expect(kpi(d, "invoices")).toMatchObject({ value: 2, previous: 1 });
    expect(kpi(d, "gross_margin_pct").value).toBe(50);   // cost 1, price 2
    expect(d.tables.find((t: any) => t.key === "by_channel").rows).toEqual([{ channel: "office", invoices: 2, amount: "100.0000" }]);
    expect(d.series[0].points).toEqual([{ period: `${Y}-03`, value: "100.0000" }]);
    const py = ok(await dash("sales", SM, "&compare=previous_year"), 200);
    expect(kpi(py, "net_sales").previous).toBe("0.0000");
    expect(py.filters.prevFrom).toBe(`${Y - 1}-03-01`);
  });

  it("financial dashboard agrees with the general ledger; access follows plan and permissions", async () => {
    const f = ok(await dash("financial", T), 200);
    expect(kpi(f, "revenue").value).toBe("100.0000");
    expect(kpi(f, "net_profit").value).toBe("50.0000");     // revenue 100 − COGS 50
    expect(kpi(f, "cash").value).toBe("120.0000");          // all three sales are cash (as of 31 March)
    expect((await dash("financial", SM)).status).toBe(403);           // sales manager has no accounting reports
    expect((await dash("executive", SM)).status).toBe(403);           // executive is a sensitive permission
    expect((await dash("manufacturing", T)).status).toBe(402);        // not in this plan
    const mine = ok(await api("GET", "/api/v1/bi/dashboards", undefined, as(SM)), 200);
    expect(mine).toEqual(["sales", "inventory"]);   // sales manager also has stock view
    const ex = ok(await dash("executive", T), 200);
    expect(ex.kpis.map((k: any) => k.key)).toEqual(expect.arrayContaining(["net_sales", "net_profit", "stock_value", "open_ncr"]));
  });

  it("inventory dashboard: value, lots near expiry, below reorder level", async () => {
    const d = ok(await dash("inventory", P), 200);
    expect(kpi(d, "stock_value").value).toBe("140.0000");   // 200 − 60 sold at cost 1
    expect(kpi(d, "expiring_lots").value).toBe(1);           // SOON expires 10 April (≤ 30 days after 31 March)
    expect(d.tables.find((t: any) => t.key === "expiring").rows[0]).toMatchObject({ lot_no: "SOON", days_left: 10 });
    expect(kpi(d, "below_reorder").value).toBe(1);
  });

  it("exports to Excel and CSV with the same figures", async () => {
    const app = await getApp();
    const x = await app.inject({ method: "GET", url: `/api/v1/bi/dashboards/sales/export?companyId=${T.companyId}&from=${D(3, 1)}&to=${D(3, 31)}&format=xlsx`, headers: { authorization: `Bearer ${SM.token}` } });
    expect(x.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as any);
    const ws = wb.worksheets[0];
    expect(ws.getRow(3).values).toEqual([undefined, "صافي المبيعات", 100, 20, 400]);
    expect(wb.worksheets.length).toBeGreaterThanOrEqual(4);
    const c = await app.inject({ method: "GET", url: `/api/v1/bi/dashboards/sales/export?companyId=${T.companyId}&from=${D(3, 1)}&to=${D(3, 31)}&format=csv&lang=en`, headers: { authorization: `Bearer ${SM.token}` } });
    expect(c.headers["content-type"]).toContain("text/csv");
    expect(c.body.startsWith("﻿")).toBe(true);
    expect(c.body).toContain("Net sales,100.0000,20.0000,400");
  });

  it("alerts on thresholds (queued once per day) and scheduled reports through the outbox", async () => {
    ok(await api("POST", "/api/v1/bi/alert-rules", { companyId: T.companyId, nameAr: "مبيعات الشهر فوق 50", area: "sales", metric: "net_sales", operator: "gt", threshold: "50", recipient: "sales@example.test" }, as(T)));
    ok(await api("POST", "/api/v1/bi/alert-rules", { companyId: T.companyId, nameAr: "هامش أقل من 10%", area: "sales", metric: "gross_margin_pct", operator: "lt", threshold: "10" }, as(T)));
    expect((await api("POST", "/api/v1/bi/alert-rules", { companyId: T.companyId, nameAr: "x", area: "sales", metric: "net_sales", operator: "gt", threshold: "1" }, as(SM))).status).toBe(403);
    const ev = ok(await api("GET", `/api/v1/bi/alerts?companyId=${T.companyId}&asOf=${D(3, 31)}`, undefined, as(SM)), 200);
    expect(ev.map((a: any) => [a.metric, a.triggered])).toEqual([["net_sales", true], ["gross_margin_pct", false]]);
    expect(ok(await api("POST", "/api/v1/bi/alerts/notify", { companyId: T.companyId, asOf: D(3, 31) }, as(T)), 200)).toEqual({ evaluated: 2, triggered: 1, queued: 1 });
    expect(ok(await api("POST", "/api/v1/bi/alerts/notify", { companyId: T.companyId, asOf: D(3, 31) }, as(T)), 200).queued).toBe(0);

    ok(await api("POST", "/api/v1/bi/schedules", { companyId: T.companyId, area: "sales", frequency: "weekly", recipient: "ceo@example.test", firstRunOn: D(3, 31) }, as(T)));
    const run = ok(await api("POST", "/api/v1/bi/schedules/run-due", { companyId: T.companyId, asOf: D(3, 31) }, as(T)), 200);
    expect(run).toEqual([expect.objectContaining({ area: "sales", queued: true, nextRunOn: D(4, 7) })]);
    expect(ok(await api("POST", "/api/v1/bi/schedules/run-due", { companyId: T.companyId, asOf: D(3, 31) }, as(T)), 200)).toEqual([]);
  });
});
