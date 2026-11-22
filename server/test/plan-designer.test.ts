import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision } from "./helpers.js";

describe("plan designer (platform)", () => {
  let p: string;
  const base = { nameAr: "باقة", nameEn: "Plan", currency: "LYD", priceMonthly: 100, priceYearly: 1000, trialDays: 14, graceDays: 7,
    maxUsers: 5, maxCompanies: 1, maxBranches: 1, maxWarehouses: 2, storageMb: 1024, apiRpm: 300 };
  beforeAll(async () => { p = await platformToken(); });

  it("module catalogue carries the dependency rules", async () => {
    const r = await api("GET", "/api/v1/platform/modules", undefined, { token: p });
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.map((m: any) => [m.code, m.rule]));
    expect(by.payroll.requires).toEqual(["hr"]);
    expect(by.pos.requires).toEqual(["sales", "inventory"]);
    expect(by.fleet.notBuilt).toBe(true);
  });

  it("refuses impossible plans and explains why; warns about weak ones", async () => {
    const bad = await api("POST", "/api/v1/platform/plans", { ...base, code: `pd_bad_${Date.now()}`, modules: ["accounting", "payroll", "pos"] }, { token: p });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("PLAN_MODULES_INCOMPLETE");
    expect(bad.body.error.details.map((e: any) => e.module).sort()).toEqual(["payroll", "pos"]);
    expect(bad.body.error.message_ar).toContain("الموارد البشرية");
    const noAcc = await api("POST", "/api/v1/platform/plans", { ...base, code: `pd_noacc_${Date.now()}`, modules: ["documents"] }, { token: p });
    expect(noAcc.body.error.details.map((e: any) => e.module)).toEqual(["accounting"]);
    const ok = await api("POST", "/api/v1/platform/plans", { ...base, code: `pd_ok_${Date.now()}`, modules: ["accounting", "inventory", "manufacturing", "fleet"] }, { token: p });
    expect(ok.status).toBe(201);
    const w = ok.body.warnings.map((x: any) => x.module);
    expect(w).toContain("manufacturing");   // purchasing / quality recommended
    expect(w).toContain("fleet");           // not built yet
    expect(ok.body.modules).toContain("core");
  });

  it("editing a plan changes prices, limits and modules for every tenant on it", async () => {
    const plan = await createPlan(p, { modules: ["accounting", "sales", "inventory"] });
    const T = await provision(p, plan.code);
    const list = (await api("GET", "/api/v1/platform/plans", undefined, { token: p })).body;
    expect(list.find((x: any) => x.code === plan.code).tenants).toBe(1);
    const up = await api("PUT", `/api/v1/platform/plans/${plan.code}`, { ...base, nameAr: "باقة معدلة", priceMonthly: 250, maxUsers: 12, modules: ["accounting", "inventory"] }, { token: p });
    expect(up.status).toBe(200);
    expect([up.body.price_monthly, up.body.max_users, up.body.removedModules]).toEqual(["250.000", 12, ["sales"]]);
    // the tenant lost sales at once
    const r = await api("GET", `/api/v1/sales/invoices?companyId=${T.companyId}`, undefined, { token: T.token });
    expect(r.body.error.code).toBe("MODULE_NOT_IN_PLAN");
    const bad = await api("PUT", `/api/v1/platform/plans/${plan.code}`, { ...base, modules: ["accounting", "sales"] }, { token: p });
    expect(bad.body.error.code).toBe("PLAN_MODULES_INCOMPLETE");
    expect((await api("PUT", `/api/v1/platform/plans/${plan.code}`, { ...base, modules: ["accounting"] }, { token: T.token })).status).toBe(401);
  });
});
