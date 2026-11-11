import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision } from "./helpers.js";
import { pool, withTenant, tx } from "../src/db/pool.js";

describe("tenant isolation (RLS)", () => {
  let A: any, B: any;
  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p);
    A = await provision(p, plan.code);
    B = await provision(p, plan.code);
  });

  it("runtime DB role cannot bypass RLS", async () => {
    const r = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("queries without tenant context see no tenant rows", async () => {
    const r = await tx({}, (db) => db.query("SELECT count(*)::int AS n FROM users"));
    expect(r.rows[0].n).toBe(0);
    const t = await tx({}, (db) => db.query("SELECT count(*)::int AS n FROM tenants"));
    expect(t.rows[0].n).toBe(0);
  });

  it("a tenant context sees only its own rows even with no WHERE clause", async () => {
    const rows = await withTenant(A.tenantId, null, async (db) => (await db.query("SELECT DISTINCT tenant_id FROM users")).rows);
    expect(rows).toEqual([{ tenant_id: A.tenantId }]);
    const tenants = await withTenant(A.tenantId, null, async (db) => (await db.query("SELECT id FROM tenants")).rows);
    expect(tenants).toEqual([{ id: A.tenantId }]);
  });

  it("cannot insert rows into another tenant", async () => {
    await expect(withTenant(A.tenantId, null, (db) =>
      db.query("INSERT INTO roles (tenant_id, code, name_ar, name_en) VALUES ($1,'x','x','x')", [B.tenantId]))).rejects.toThrow(/row-level security/);
  });

  it("cannot reference another tenant's records (composite FK + RLS)", async () => {
    await expect(withTenant(A.tenantId, null, (db) =>
      db.query("INSERT INTO branches (tenant_id, company_id, code, name_ar) VALUES ($1,$2,'X1','x')", [A.tenantId, B.companyId]))).rejects.toThrow();
  });

  it("API: tenant A cannot read tenant B's company by id or list", async () => {
    const companies = await api("GET", "/api/v1/companies", undefined, { token: A.token });
    expect(companies.body.map((c: any) => c.id)).toEqual([A.companyId]);
    const accounts = await api("GET", `/api/v1/accounting/accounts?companyId=${B.companyId}`, undefined, { token: A.token });
    expect(accounts.status).toBe(200);
    expect(accounts.body).toEqual([]);
  });

  it("API: tenant A cannot create a branch under tenant B's company", async () => {
    const r = await api("POST", "/api/v1/branches", { companyId: B.companyId, code: "HACK", nameAr: "اختراق" }, { token: A.token });
    expect(r.status).toBe(422);
  });

  it("a token from tenant A forged with tenant B id is rejected (signature)", async () => {
    const [h, p, s] = A.token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    payload.tid = B.tenantId;
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString("base64url"), s].join(".");
    const r = await api("GET", "/api/v1/auth/me", undefined, { token: forged });
    expect(r.status).toBe(401);
  });

  it("platform context cannot read tenant business data, only metadata/usage", async () => {
    const r = await tx({ platform: true }, (db) => db.query("SELECT count(*)::int AS n FROM users"));
    expect(r.rows[0].n).toBe(0);
    const u = await tx({ platform: true }, (db) => db.query("SELECT * FROM platform_tenant_usage($1)", [A.tenantId]));
    expect(Number(u.rows[0].users)).toBe(1);
  });

  it("tenant cannot call usage function for another tenant", async () => {
    await expect(withTenant(A.tenantId, null, (db) => db.query("SELECT * FROM platform_tenant_usage($1)", [B.tenantId]))).rejects.toThrow(/not allowed/);
  });

  it("tenant tokens cannot access platform endpoints and vice versa", async () => {
    expect((await api("GET", "/api/v1/platform/tenants", undefined, { token: A.token })).status).toBe(401);
    const p = await platformToken();
    expect((await api("GET", "/api/v1/users", undefined, { token: p })).status).toBe(401);
  });
});
