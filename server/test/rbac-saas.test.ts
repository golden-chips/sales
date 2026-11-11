import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser, PW } from "./helpers.js";
import { withPlatform } from "../src/db/pool.js";
import { sweepSubscriptions } from "../src/modules/platform/platform.service.js";

describe("RBAC", () => {
  let p: string, T: any;
  beforeAll(async () => { p = await platformToken(); const plan = await createPlan(p); T = await provision(p, plan.code); });

  it("seeds all 18 tenant system roles", async () => {
    const r = await api("GET", "/api/v1/roles", undefined, { token: T.token });
    expect(r.body.filter((x: any) => x.is_system).length).toBe(18);
  });

  it("read-only user can view but not create", async () => {
    const u = await createUser(T, [{ roleId: await roleId(T.token, "read_only") }]);
    expect((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, { token: u.token })).status).toBe(200);
    const w = await api("POST", "/api/v1/accounting/accounts", { companyId: T.companyId, code: "9", nameAr: "حساب", type: "asset" }, { token: u.token });
    expect(w.status).toBe(403);
    expect(w.body.error.details.permission).toBe("accounting.accounts.manage");
  });

  it("permission revocation is effective immediately (no re-login)", async () => {
    const u = await createUser(T, [{ roleId: await roleId(T.token, "auditor") }]);
    expect((await api("GET", "/api/v1/audit-log", undefined, { token: u.token })).status).toBe(200);
    await api("PUT", `/api/v1/users/${u.id}/roles`, { roles: [{ roleId: await roleId(T.token, "read_only") }] }, { token: T.token });
    expect((await api("GET", "/api/v1/audit-log", undefined, { token: u.token })).status).toBe(403);
  });

  it("deactivated user is rejected on next request", async () => {
    const u = await createUser(T, [{ roleId: await roleId(T.token, "read_only") }]);
    await api("PATCH", `/api/v1/users/${u.id}`, { isActive: false }, { token: T.token });
    expect((await api("GET", "/api/v1/auth/me", undefined, { token: u.token })).status).toBe(401);
  });

  it("prevents privilege escalation: a company admin cannot assign finance roles they don't hold", async () => {
    const admin = await createUser(T, [{ roleId: await roleId(T.token, "company_admin") }]);
    const r = await api("POST", "/api/v1/users", { email: "esc@x.test", fullName: "Esc", password: PW, roles: [{ roleId: await roleId(T.token, "finance_manager") }] }, { token: admin.token });
    expect(r.status).toBe(403);
    const own = await api("POST", "/api/v1/users", { email: "own@x.test", fullName: "Own", password: PW, roles: [{ roleId: await roleId(T.token, "tenant_owner") }] }, { token: admin.token });
    expect(own.status).toBe(403);
  });

  it("branch-scoped user sees only their branch", async () => {
    const b2 = await api("POST", "/api/v1/branches", { companyId: T.companyId, code: "FAC1", nameAr: "المصنع", kind: "factory" }, { token: T.token });
    expect(b2.status).toBe(201);
    const u = await createUser(T, [{ roleId: await roleId(T.token, "branch_manager"), branchId: b2.body.id }]);
    const list = await api("GET", "/api/v1/branches", undefined, { token: u.token });
    expect(list.body.map((b: any) => b.id)).toEqual([b2.body.id]);
  });

  it("module not in plan returns 402", async () => {
    const plan = await createPlan(p, { modules: ["core"] });
    const X = await provision(p, plan.code);
    const r = await api("GET", `/api/v1/accounting/accounts?companyId=${X.companyId}`, undefined, { token: X.token });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("MODULE_NOT_IN_PLAN");
  });

  it("quarantine warehouses can never be sellable (DB constraint)", async () => {
    const branches = await api("GET", "/api/v1/branches", undefined, { token: T.token });
    const r = await api("POST", "/api/v1/warehouses", { branchId: branches.body[0].id, code: "QC1", nameAr: "حجر", kind: "quarantine", isSellable: true }, { token: T.token });
    expect(r.status).toBe(422);
    const ok = await api("POST", "/api/v1/warehouses", { branchId: branches.body[0].id, code: "QC2", nameAr: "حجر", kind: "quarantine" }, { token: T.token });
    expect(ok.status).toBe(201);
    expect(ok.body.is_sellable).toBe(false);
  });
});

describe("SaaS plans, limits and lifecycle", () => {
  let p: string;
  beforeAll(async () => { p = await platformToken(); });

  it("enforces the plan user limit", async () => {
    const plan = await createPlan(p, { maxUsers: 2 });
    const T = await provision(p, plan.code);
    const ro = await roleId(T.token, "read_only");
    await createUser(T, [{ roleId: ro }]);
    const r = await api("POST", "/api/v1/users", { email: "third@x.test", fullName: "Third", password: PW, roles: [] }, { token: T.token });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("PLAN_LIMIT_REACHED");
  });

  it("enforces branch limit", async () => {
    const plan = await createPlan(p, { maxBranches: 1 });
    const T = await provision(p, plan.code);
    const r = await api("POST", "/api/v1/branches", { companyId: T.companyId, code: "B2", nameAr: "فرع" }, { token: T.token });
    expect(r.status).toBe(402);
  });

  it("blocks a downgrade that exceeds the target plan's limits, allows upgrade", async () => {
    const big = await createPlan(p, { maxUsers: 10 });
    const small = await createPlan(p, { maxUsers: 1 });
    const T = await provision(p, big.code);
    await createUser(T, [{ roleId: await roleId(T.token, "read_only") }]);
    const down = await api("POST", `/api/v1/platform/tenants/${T.tenantId}/change-plan`, { planCode: small.code }, { token: p });
    expect(down.status).toBe(422);
    expect(down.body.error.code).toBe("DOWNGRADE_EXCEEDS_LIMITS");
    const bigger = await createPlan(p, { maxUsers: 50 });
    const up = await api("POST", `/api/v1/platform/tenants/${T.tenantId}/change-plan`, { planCode: bigger.code, billingCycle: "yearly" }, { token: p });
    expect(up.status).toBe(200);
    expect(up.body.invoice.number).toMatch(/^PINV-\d{4}-\d{6}$/);
  });

  it("suspension blocks login and API immediately; reactivation restores", async () => {
    const plan = await createPlan(p);
    const T = await provision(p, plan.code);
    expect((await api("POST", `/api/v1/platform/tenants/${T.tenantId}/suspend`, { reason: "unpaid invoice" }, { token: p })).status).toBe(200);
    expect((await api("GET", "/api/v1/auth/me", undefined, { token: T.token })).body.error.code).toBe("TENANT_SUSPENDED");
    expect((await api("POST", "/api/v1/auth/login", { tenant: T.code, email: T.owner.email, password: PW })).status).toBe(403);
    expect((await api("POST", "/api/v1/auth/refresh", { refreshToken: T.refreshToken })).status).toBe(401);
    expect((await api("POST", `/api/v1/platform/tenants/${T.tenantId}/reactivate`, { reason: "paid" }, { token: p })).status).toBe(200);
    expect((await api("GET", "/api/v1/auth/me", undefined, { token: T.token })).status).toBe(200);
  });

  it("lifecycle sweep: trial end → past_due (still usable) → suspended after grace", async () => {
    const plan = await createPlan(p, { trialDays: 14, graceDays: 3 });
    const T = await provision(p, plan.code);
    const day = 86400_000;
    const r1 = await withPlatform((db) => sweepSubscriptions(db, new Date(Date.now() + 15 * day)));
    expect(r1.pastDue).toBeGreaterThanOrEqual(1);
    expect((await api("GET", "/api/v1/auth/me", undefined, { token: T.token })).status).toBe(200);
    const r2 = await withPlatform((db) => sweepSubscriptions(db, new Date(Date.now() + 19 * day)));
    expect(r2.suspended).toBeGreaterThanOrEqual(1);
    expect((await api("GET", "/api/v1/auth/me", undefined, { token: T.token })).status).toBe(403);
    const detail = await api("GET", `/api/v1/platform/tenants/${T.tenantId}`, undefined, { token: p });
    expect(detail.body.tenant.status).toBe("suspended");
    expect(detail.body.events.map((e: any) => e.event_type)).toEqual(expect.arrayContaining(["created", "past_due", "suspended"]));
  });

  it("tenant sees its own subscription, limits and usage", async () => {
    const plan = await createPlan(p, { maxUsers: 7 });
    const T = await provision(p, plan.code);
    const r = await api("GET", "/api/v1/subscription", undefined, { token: T.token });
    expect(r.body.subscription.max_users).toBe(7);
    expect(Number(r.body.usage.users)).toBe(1);
    expect(r.body.invoices.length).toBe(1);
  });

  it("tenant code must be unique", async () => {
    const plan = await createPlan(p);
    const T = await provision(p, plan.code);
    const r = await api("POST", "/api/v1/platform/tenants", { code: T.code, legalName: "dup", planCode: plan.code, company: { code: "M", nameAr: "شركة مكررة" }, owner: { email: "a@b.test", fullName: "Another Owner", password: PW } }, { token: p });
    expect(r.status).toBe(409);
  });
});
