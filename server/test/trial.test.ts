import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { api, platformToken, createPlan, PW } from "./helpers.js";
import { withPlatform } from "../src/db/pool.js";
import { sweepSubscriptions } from "../src/modules/platform/platform.service.js";

describe("self-service free trial", () => {
  let p: string, trialPlan: any, paid: any;
  const code = `trial-${randomUUID().slice(0, 6)}`;
  const body = (over: any = {}) => ({ companyName: "شركة تجربة للأغذية", code, ownerName: "مالك التجربة", email: `owner@${code}.test`, phone: "+218 91 000 0000", password: PW, acceptTerms: true, ...over });

  beforeAll(async () => {
    p = await platformToken();
    trialPlan = await createPlan(p, { trialDays: 14, graceDays: 3, modules: ["accounting", "sales", "inventory"] });
    paid = await createPlan(p, { trialDays: 0, modules: ["accounting", "sales", "inventory", "manufacturing"] });
  });

  it("is refused while no plan is marked as the trial plan", async () => {
    await withPlatform((db) => db.query("UPDATE plans SET is_trial_default = false"));
    expect((await api("POST", "/api/v1/public/signup", body())).body.error.code).toBe("TRIALS_DISABLED");
    expect((await api("POST", `/api/v1/platform/plans/${trialPlan.code}/trial-default`, {}, { token: p })).status).toBe(200);
  });

  it("public pricing and code availability need no login", async () => {
    expect((await api("GET", "/api/v1/public/plans")).body.some((x: any) => x.code === trialPlan.code && x.is_trial_default)).toBe(true);
    expect((await api("GET", `/api/v1/public/code-available?code=${code}`)).body.available).toBe(true);
  });

  it("signup validates terms, password and creates a ready-to-use trial company with the owner signed in", async () => {
    expect((await api("POST", "/api/v1/public/signup", body({ acceptTerms: false }))).status).toBe(422);
    expect((await api("POST", "/api/v1/public/signup", body({ password: "weak" }))).status).toBe(422);
    const r = await api("POST", "/api/v1/public/signup", body());
    expect(r.status).toBe(201);
    expect(r.body.trialDays).toBe(14);
    const me = await api("GET", "/api/v1/auth/me", undefined, { token: r.body.accessToken });
    expect([me.body.tenant.status, me.body.modules.sort()]).toEqual(["trial", ["accounting", "core", "inventory", "sales"]]);
    const sub = await api("GET", "/api/v1/subscription", undefined, { token: r.body.accessToken });
    expect([sub.body.subscription.status, sub.body.subscription.plan_code]).toEqual(["trialing", trialPlan.code]);
    const coa = await api("GET", `/api/v1/accounting/accounts?companyId=${me.body.companies[0].id}`, undefined, { token: r.body.accessToken });
    expect(coa.body.length).toBeGreaterThan(80);                  // chart of accounts ready
    expect((await api("POST", "/api/v1/auth/refresh", { refreshToken: r.body.refreshToken })).status).toBe(200);
    expect((await api("GET", `/api/v1/public/code-available?code=${code}`)).body.available).toBe(false);
    expect((await api("POST", "/api/v1/public/signup", body({ email: "other@x.test" }))).status).toBe(409);
    (globalThis as any).__trial = r.body;
  });

  it("upgrade request: one open at a time; the platform activates the paid plan", async () => {
    const t = (globalThis as any).__trial;
    const req = await api("POST", "/api/v1/subscription/upgrade-request", { planCode: paid.code, billingCycle: "yearly", note: "نريد التصنيع" }, { token: t.accessToken });
    expect(req.status).toBe(201);
    expect((await api("POST", "/api/v1/subscription/upgrade-request", { planCode: paid.code }, { token: t.accessToken })).status).toBe(409);
    const open = (await api("GET", "/api/v1/platform/upgrade-requests?status=open", undefined, { token: p })).body.find((x: any) => x.tenant_code === code);
    expect([open.plan_code, open.tenant_phone, open.signup_source]).toEqual([paid.code, "+218 91 000 0000", "self_signup"]);
    expect((await api("POST", `/api/v1/platform/upgrade-requests/${open.id}/complete`, {}, { token: p })).status).toBe(200);
    const me = await api("GET", "/api/v1/auth/me", undefined, { token: t.accessToken });
    expect([me.body.tenant.status, me.body.modules.includes("manufacturing")]).toEqual(["active", true]);
  });

  it("an unconverted trial ends: past due (grace) then suspended", async () => {
    const other = `trial-${randomUUID().slice(0, 6)}`;
    const r = await api("POST", "/api/v1/public/signup", body({ code: other, email: `o@${other}.test` }));
    const day = 86400_000;
    await withPlatform((db) => sweepSubscriptions(db, new Date(Date.now() + 15 * day)));
    const pastDue = await api("GET", "/api/v1/auth/me", undefined, { token: r.body.accessToken });
    expect(pastDue.body.tenant.status).toBe("past_due");          // still usable during grace, banner warns
    await withPlatform((db) => sweepSubscriptions(db, new Date(Date.now() + 19 * day)));
    expect((await api("GET", "/api/v1/auth/me", undefined, { token: r.body.accessToken })).body.error.code).toBe("TENANT_SUSPENDED");
  });
});
