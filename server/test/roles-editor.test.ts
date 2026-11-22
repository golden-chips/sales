import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

describe("custom roles", () => {
  let T: any, ADM: any;
  beforeAll(async () => {
    const p = await platformToken();
    T = await provision(p, (await createPlan(p, { modules: ["accounting", "sales", "inventory"] })).code);
    ADM = await createUser(T, [{ roleId: await roleId(T.token, "company_admin") }]);   // core.* + *.view
  });
  const roles = async () => (await api("GET", "/api/v1/roles", undefined, { token: T.token })).body;

  it("built-in roles are templates: their permissions cannot be edited (copy them instead)", async () => {
    const acc = (await roles()).find((r: any) => r.code === "accountant");
    const r = await api("PUT", `/api/v1/roles/${acc.id}/permissions`, { permissions: ["accounting.journal.view"] }, { token: T.token });
    expect(r.body.error.code).toBe("SYSTEM_ROLE_LOCKED");
    expect((await api("DELETE", `/api/v1/roles/${acc.id}`, undefined, { token: T.token })).body.error.code).toBe("SYSTEM_ROLE_LOCKED");
  });

  it("copy, edit, rename and delete a custom role; nobody grants what they do not hold", async () => {
    const acc = (await roles()).find((r: any) => r.code === "accountant");
    const copy = await api("POST", "/api/v1/roles", { code: "accountant_branch", nameAr: "محاسب فرع", nameEn: "Branch accountant", permissions: acc.permissions }, { token: T.token });
    expect(copy.status).toBe(201);
    expect((await api("POST", "/api/v1/roles", { code: "accountant_branch", nameAr: "x x", nameEn: "x x" }, { token: T.token })).status).toBe(409);
    const ed = await api("PUT", `/api/v1/roles/${copy.body.id}/permissions`, { permissions: ["accounting.journal.view", "accounting.reports.view"] }, { token: T.token });
    expect(ed.status).toBe(200);
    expect((await roles()).find((r: any) => r.id === copy.body.id).permissions).toEqual(["accounting.journal.view", "accounting.reports.view"]);
    expect((await api("PATCH", `/api/v1/roles/${copy.body.id}`, { nameAr: "محاسب الفرع", nameEn: "Branch accountant" }, { token: T.token })).body.name_ar).toBe("محاسب الفرع");
    // escalation: the company admin (view + core only) cannot create or widen a role with posting rights
    const esc = await api("POST", "/api/v1/roles", { code: "sneaky", nameAr: "دور", nameEn: "role", permissions: ["sales.invoices.post"] }, { token: ADM.token });
    expect([esc.status, esc.body.error.details.permission]).toEqual([403, "sales.invoices.post"]);
    expect((await api("PUT", `/api/v1/roles/${copy.body.id}/permissions`, { permissions: ["accounting.journal.post"] }, { token: ADM.token })).status).toBe(403);
    // in use → cannot delete
    await createUser(T, [{ roleId: copy.body.id }]);
    expect((await api("DELETE", `/api/v1/roles/${copy.body.id}`, undefined, { token: T.token })).body.error.code).toBe("ROLE_IN_USE");
    const unused = await api("POST", "/api/v1/roles", { code: "temp_role", nameAr: "مؤقت", nameEn: "Temp", permissions: [] }, { token: T.token });
    expect((await api("DELETE", `/api/v1/roles/${unused.body.id}`, undefined, { token: T.token })).status).toBe(200);
  });
});
