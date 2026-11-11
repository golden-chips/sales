import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear() - 1;   // a closed-past year keeps every date valid whatever today is
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("fixed assets & maintenance", () => {
  let T: any, P: any; // T creates, P (finance + warehouse) posts → segregation of duties
  let acc: Record<string, string>, cat: any, ddbCat: any, wh: string, part: any, branch: string;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const gl = async (code: string) => {
    const tb = await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T));
    return tb.body.rows.find((r: any) => r.code === code)?.closing ?? "0";
  };
  const asset = async (over: Record<string, unknown>) => ok(await api("POST", "/api/v1/assets", { companyId: T.companyId, categoryId: cat.id, kind: "machine", acquisitionDate: D(1, 10),
    inServiceDate: D(1, 15), fundingAccountId: acc["1121"], ...over }, as(T)));
  const capitalize = async (id: string, body = {}) => ok(await api("POST", `/api/v1/assets/${id}/capitalize`, body, as(P)), 200);
  const run = async (m: number) => ok(await api("POST", "/api/v1/assets/depreciation-runs", { companyId: T.companyId, period: D(m, 1) }, as(T)));
  const postRun = async (id: string) => ok(await api("POST", `/api/v1/assets/depreciation-runs/${id}/post`, {}, as(P)), 200);

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "inventory", "purchasing", "assets", "manufacturing"] });
    T = await provision(p, plan.code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    P = await createUser(T, await Promise.all(["finance_manager", "warehouse_manager"].map(async (c) => ({ roleId: await roleId(T.token, c) }))));
    branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    wh = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code: "SPARE", nameAr: "مخزن قطع الغيار", kind: "raw_materials" }, as(T))).id;
    const uom = ok(await api("POST", "/api/v1/uoms", { code: "PCS", nameAr: "قطعة" }, as(T))).id;
    part = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "SP-BELT", nameAr: "سير ناقل (اختبار)", kind: "raw", baseUomId: uom }, as(T)));
    const d = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh, docDate: D(1, 2),
      lines: [{ itemId: part.id, qtyDelta: "10", unitCost: "25" }] }, as(T)));
    ok(await api("POST", `/api/v1/inventory/documents/${d.id}/post`, {}, as(P)), 200);
  });

  it("categories validate their GL accounts", async () => {
    const bad = await api("POST", "/api/v1/assets/categories", { companyId: T.companyId, code: "BAD", nameAr: "خطأ", usefulLifeMonths: 60,
      assetAccountId: acc["5204"], accumAccountId: acc["1222"], expenseAccountId: acc["5204"] }, as(T));
    expect(bad.status).toBe(422);
    cat = ok(await api("POST", "/api/v1/assets/categories", { companyId: T.companyId, code: "MACH", nameAr: "آلات وخطوط إنتاج", usefulLifeMonths: 12,
      assetAccountId: acc["1212"], accumAccountId: acc["1222"], expenseAccountId: acc["5204"], maintenanceAccountId: acc["5203"] }, as(T)));
    ddbCat = ok(await api("POST", "/api/v1/assets/categories", { companyId: T.companyId, code: "IT", nameAr: "أجهزة", method: "declining_balance", usefulLifeMonths: 12,
      assetAccountId: acc["1214"], accumAccountId: acc["1224"], expenseAccountId: acc["5405"] }, as(T)));
  });

  it("capitalization: SoD, control accounts refused, GL Dr asset / Cr funding; opening accumulated brought forward", async () => {
    const a = await asset({ code: "FRYER-1", nameAr: "قلاية خط 1", cost: "12000" });
    expect(a.residual_value).toBe("0.0000");
    const self = await api("POST", `/api/v1/assets/${a.id}/capitalize`, {}, as(T));
    expect(self.body.error.code).toBe("SEGREGATION_OF_DUTIES");
    const ap = await api("POST", `/api/v1/assets/${a.id}/capitalize`, { fundingAccountId: acc["2101"] }, as(P));
    expect(ap.body.error.code).toBe("CONTROL_ACCOUNT");
    const c = await capitalize(a.id);
    expect([c.status, c.book_value]).toEqual(["active", "12000.0000"]);
    expect(await gl("1212")).toBe("12000.0000");
    expect(await gl("1121")).toBe("-12000.0000");
    // frozen once capitalized
    expect((await api("DELETE", `/api/v1/assets/${a.id}`, undefined, as(T))).body).toEqual({ deleted: false });

    // an old van already 30/60 months used: cost 60000, accumulated 30000 brought forward against opening balance equity
    const van = await asset({ code: "VAN-OLD", nameAr: "سيارة توزيع قديمة", kind: "vehicle", cost: "60000", usefulLifeMonths: 60, openingAccumulated: "30000", openingMonthsUsed: 30,
      acquisitionDate: `${Y - 3}-07-01`, inServiceDate: `${Y - 3}-07-01`, fundingAccountId: acc["304"] });
    const cv = await capitalize(van.id, { postingDate: D(1, 1) });
    expect([cv.accumulated_depreciation, cv.months_depreciated, cv.book_value]).toEqual(["30000.0000", 30, "30000.0000"]);
    expect(await gl("1222")).toBe("-30000.0000");
  });

  it("depreciation: starts after the in-service month, sequential months, exact final month, DDB, preparer ≠ poster", async () => {
    const small = await asset({ code: "SEALER", nameAr: "ماكينة لحام أكياس", cost: "1000", usefulLifeMonths: 3 });
    await capitalize(small.id);
    const laptop = ok(await api("POST", "/api/v1/assets", { companyId: T.companyId, categoryId: ddbCat.id, code: "LAPTOP-1", nameAr: "حاسوب", kind: "it", cost: "1200",
      acquisitionDate: D(1, 5), fundingAccountId: acc["1121"] }, as(T)));
    await capitalize(laptop.id);

    const jan = await run(1);                       // everything entered service in January → nothing yet (except the old van)
    expect(jan.lines.map((l: any) => l.code)).toEqual(["VAN-OLD"]);
    expect(jan.lines[0].amount).toBe("1000.0000");  // (60000 − 30000) / 30 remaining months
    const selfPost = await api("POST", `/api/v1/assets/depreciation-runs/${jan.id}/post`, {}, as(T));
    expect(selfPost.body.error.code).toBe("SEGREGATION_OF_DUTIES");
    await postRun(jan.id);
    expect((await api("POST", "/api/v1/assets/depreciation-runs", { companyId: T.companyId, period: D(1, 1) }, as(T))).body.error.code).toBe("PERIOD_ALREADY_DEPRECIATED");
    expect((await api("POST", "/api/v1/assets/depreciation-runs", { companyId: T.companyId, period: D(3, 1) }, as(T))).body.error.code).toBe("DEPRECIATION_GAP");

    const feb = await run(2);
    const by = Object.fromEntries(feb.lines.map((l: any) => [l.code, l.amount]));
    expect(by).toEqual({ "FRYER-1": "1000.0000", SEALER: "333.3330", "LAPTOP-1": "200.0000", "VAN-OLD": "1000.0000" }); // DDB: 1200 × 2/12
    await postRun(feb.id);
    expect(await gl("5204")).toBe("3333.3330");   // machinery depreciation: Jan van 1000 + Feb van 1000 + fryer 1000 + sealer 333.333
    expect(await gl("5405")).toBe("200.0000");

    await postRun((await run(3)).id);
    const apr = await run(4);
    expect(apr.lines.find((l: any) => l.code === "SEALER").amount).toBe("333.3330");
    await postRun(apr.id);
    const sealer = (await api("GET", `/api/v1/assets/${small.id}`, undefined, as(T))).body;
    expect([sealer.asset.book_value, sealer.depreciation.length]).toEqual(["0.0000", 3]);   // fully depreciated exactly, no residue
    const may = await run(5);
    expect(may.lines.map((l: any) => l.code)).not.toContain("SEALER");
    await api("DELETE", `/api/v1/assets/depreciation-runs/${may.id}`, undefined, as(T));
    const tb = (await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body;
    expect(tb.totals.balanced).toBe(true);
  });

  it("disposal: blocked by a pending draft run and by depreciation in the disposal month; loss posted; asset then frozen", async () => {
    const fryer = (await api("GET", `/api/v1/assets?companyId=${T.companyId}&q=FRYER`, undefined, as(T))).body[0];
    expect(fryer.accumulated_depreciation).toBe("3000.0000");   // Feb, Mar, Apr
    const may = await run(5);
    const pending = await api("POST", `/api/v1/assets/${fryer.id}/dispose`, { date: D(5, 20), proceeds: "8000", proceedsAccountId: acc["1121"], gainLossAccountId: acc["404"], reason: "بيع" }, as(P));
    expect(pending.body.error.code).toBe("DRAFT_DEPRECIATION_PENDING");
    await api("DELETE", `/api/v1/assets/depreciation-runs/${may.id}`, undefined, as(T));
    const tooEarly = await api("POST", `/api/v1/assets/${fryer.id}/dispose`, { date: D(4, 20), proceeds: "8000", proceedsAccountId: acc["1121"], gainLossAccountId: acc["404"], reason: "بيع" }, as(P));
    expect(tooEarly.body.error.code).toBe("DEPRECIATED_AFTER_DISPOSAL");
    const noGl = await api("POST", `/api/v1/assets/${fryer.id}/dispose`, { date: D(5, 20), proceeds: "8000", proceedsAccountId: acc["1121"], reason: "بيع" }, as(P));
    expect(noGl.status).toBe(422);
    const before404 = await gl("404");
    const d = ok(await api("POST", `/api/v1/assets/${fryer.id}/dispose`, { date: D(5, 20), proceeds: "8000", proceedsAccountId: acc["1121"], gainLossAccountId: acc["404"], reason: "بيع لمصنع آخر" }, as(P)), 200);
    expect(d.status).toBe("disposed");
    expect(Number(await gl("404")) - Number(before404)).toBeCloseTo(1000, 4);   // book 9000 − proceeds 8000 = loss 1000 (debit)
    expect((await api("PATCH", `/api/v1/assets/${fryer.id}`, { branchId: branch }, as(T))).status).toBe(422);
    expect(ok(await api("PATCH", `/api/v1/assets/${fryer.id}`, { location: "مستودع الخردة" }, as(T)), 200).location).toBe("مستودع الخردة");
    const again = await api("POST", `/api/v1/assets/${fryer.id}/dispose`, { date: D(5, 21), proceeds: "0", reason: "مكرر" }, as(P));
    expect(again.body.error.code).toBe("ASSET_NOT_ACTIVE");
    const mayRun = await run(5);
    expect(mayRun.lines.map((l: any) => l.code)).not.toContain("FRYER-1");
    await api("DELETE", `/api/v1/assets/depreciation-runs/${mayRun.id}`, undefined, as(T));
  });

  it("maintenance: preventive plan → idempotent orders, parts issued at average cost, cost posted, plan advanced; failed completion rolls back", async () => {
    const press = await asset({ code: "PRESS-1", nameAr: "مكبس تعبئة", cost: "5000" });
    await capitalize(press.id);
    const plan = ok(await api("POST", "/api/v1/maintenance/plans", { assetId: press.id, nameAr: "تغيير السيور وتشحيم", intervalDays: 30, firstDueDate: D(2, 1), checklist: "سيور، تشحيم، معايرة" }, as(T)));
    const gen = ok(await api("POST", "/api/v1/maintenance/plans/generate", { companyId: T.companyId, asOf: D(2, 5) }, as(T)), 200);
    expect(gen.length).toBe(1);
    expect(ok(await api("POST", "/api/v1/maintenance/plans/generate", { companyId: T.companyId, asOf: D(2, 5) }, as(T)), 200).length).toBe(0);
    const wo = gen[0];
    expect(wo.number).toMatch(/^WO-/);
    ok(await api("PUT", `/api/v1/maintenance/orders/${wo.id}/parts`, { warehouseId: wh, parts: [{ itemId: part.id, qty: "2" }] }, as(T)), 200);
    ok(await api("POST", `/api/v1/maintenance/orders/${wo.id}/start`, {}, as(T)), 200);
    const done = ok(await api("POST", `/api/v1/maintenance/orders/${wo.id}/complete`, { completionDate: D(2, 6), downtimeMinutes: 90, externalCost: "50", externalAccountId: acc["1121"],
      resolution: "تم تغيير سيرين" }, as(T)), 200);
    expect([done.status, done.parts_cost, done.total_cost]).toEqual(["completed", "50.0000", "100.0000"]);
    expect(await gl("5203")).toBe("100.0000");
    expect(await gl("1141")).toBe("200.0000");   // 10 × 25 − 2 × 25
    const plans = (await api("GET", `/api/v1/maintenance/plans?companyId=${T.companyId}`, undefined, as(T))).body;
    expect(String(plans.find((x: any) => x.id === plan.id).next_due_date).slice(0, 10)).toBe(new Date(Date.UTC(Y, 1, 6 + 30)).toISOString().slice(0, 10));
    expect((await api("POST", `/api/v1/maintenance/orders/${wo.id}/cancel`, { reason: "late" }, as(T))).status).toBe(422);

    // breakdown needing more belts than in stock → nothing is posted, the order stays open
    const br = ok(await api("POST", "/api/v1/maintenance/orders", { assetId: press.id, priority: "critical", description: "توقف المكبس — انقطاع سير", failureCode: "BELT",
      warehouseId: wh, parts: [{ itemId: part.id, qty: "50" }] }, as(T)));
    const fail = await api("POST", `/api/v1/maintenance/orders/${br.id}/complete`, { completionDate: D(2, 10), downtimeMinutes: 240, resolution: "x x x" }, as(T));
    expect(fail.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect((await api("GET", `/api/v1/maintenance/orders/${br.id}`, undefined, as(T))).body.status).toBe("open");
    ok(await api("PUT", `/api/v1/maintenance/orders/${br.id}/parts`, { warehouseId: wh, parts: [{ itemId: part.id, qty: "1" }] }, as(T)), 200);
    ok(await api("POST", `/api/v1/maintenance/orders/${br.id}/complete`, { completionDate: D(2, 10), downtimeMinutes: 240, resolution: "تبديل السير" }, as(T)), 200);

    const sum = (await api("GET", `/api/v1/maintenance/summary?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body;
    const row = sum.find((x: any) => x.code === "PRESS-1");
    expect([row.breakdowns, row.preventive_done, row.downtime_minutes, row.maintenance_cost]).toEqual([1, 1, 330, "125.0000"]);
    const h = (await api("GET", `/api/v1/assets/${press.id}`, undefined, as(T))).body;
    expect(h.maintenance.length).toBe(2);
    expect(h.totals).toEqual({ breakdowns: 1, downtime_minutes: 330, maintenance_cost: "125.0000" });
  });

  it("module gating and permissions: a maintenance technician cannot capitalize or depreciate", async () => {
    const tech = await createUser(T, [{ roleId: await roleId(T.token, "maintenance_technician") }]);
    expect((await api("GET", `/api/v1/maintenance/orders?companyId=${T.companyId}`, undefined, as(tech))).status).toBe(200);
    expect((await api("POST", "/api/v1/assets/depreciation-runs", { companyId: T.companyId, period: D(5, 1) }, as(tech))).status).toBe(403);
    const p = await platformToken();
    const other = await provision(p, (await createPlan(p, { modules: ["accounting"] })).code);
    expect((await api("GET", `/api/v1/assets?companyId=${other.companyId}`, undefined, as(other))).status).toBe(402);
  });
});
