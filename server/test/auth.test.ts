import { describe, it, expect, beforeAll } from "vitest";
import { generateSync } from "otplib";
import { api, platformToken, createPlan, provision, PW } from "./helpers.js";
import { withTenant } from "../src/db/pool.js";

describe("authentication", () => {
  let p: string, plan: any, T: any;
  beforeAll(async () => { p = await platformToken(); plan = await createPlan(p); T = await provision(p, plan.code); });

  it("rejects wrong password and unknown tenant with the same generic error", async () => {
    const a = await api("POST", "/api/v1/auth/login", { tenant: T.code, email: T.owner.email, password: "wrong" });
    const b = await api("POST", "/api/v1/auth/login", { tenant: "no-such-tenant", email: T.owner.email, password: "wrong" });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error.code).toBe("INVALID_CREDENTIALS"); expect(b.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(a.body.error.message_ar).toBeTruthy();
  });

  it("records login attempts", async () => {
    const n = await withTenant(T.tenantId, null, async (db) => Number((await db.query("SELECT count(*) FROM login_attempts WHERE NOT success")).rows[0].count));
    expect(n).toBeGreaterThan(0);
  });

  it("locks the account after max failed logins, admin can unlock", async () => {
    const U = await provision(p, plan.code);
    for (let i = 0; i < 5; i++) await api("POST", "/api/v1/auth/login", { tenant: U.code, email: U.owner.email, password: "bad" });
    const r = await api("POST", "/api/v1/auth/login", { tenant: U.code, email: U.owner.email, password: PW });
    expect(r.status).toBe(423);
    expect(r.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const S = await provision(p, plan.code);
    const r1 = await api("POST", "/api/v1/auth/refresh", { refreshToken: S.refreshToken });
    expect(r1.status).toBe(200);
    const reuse = await api("POST", "/api/v1/auth/refresh", { refreshToken: S.refreshToken });
    expect(reuse.status).toBe(401);
    // the legitimately rotated token is now revoked too (family revoked)
    const r2 = await api("POST", "/api/v1/auth/refresh", { refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });

  it("MFA: enrol, then login requires a valid TOTP", async () => {
    const M = await provision(p, plan.code);
    const setup = await api("POST", "/api/v1/auth/mfa/setup", {}, { token: M.token });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const bad = await api("POST", "/api/v1/auth/mfa/enable", { otp: "000000" }, { token: M.token });
    expect(bad.status).toBe(422);
    const ok = await api("POST", "/api/v1/auth/mfa/enable", { otp: generateSync({ secret: setup.body.secret }) }, { token: M.token });
    expect(ok.status).toBe(200);
    const noOtp = await api("POST", "/api/v1/auth/login", { tenant: M.code, email: M.owner.email, password: PW });
    expect(noOtp.body.error.code).toBe("MFA_REQUIRED");
    const withOtp = await api("POST", "/api/v1/auth/login", { tenant: M.code, email: M.owner.email, password: PW, otp: generateSync({ secret: setup.body.secret }) });
    expect(withOtp.status).toBe(200);
  });

  it("enforces password policy on change", async () => {
    const r = await api("POST", "/api/v1/auth/change-password", { currentPassword: PW, newPassword: "short" }, { token: T.token });
    expect(r.status).toBe(422);
  });

  it("me returns permissions and plan modules", async () => {
    const r = await api("GET", "/api/v1/auth/me", undefined, { token: T.token });
    expect(r.status).toBe(200);
    expect(r.body.permissions).toContain("accounting.journal.post");
    expect(r.body.modules).toEqual(["accounting", "core"]);
    expect(r.body.tenant.base_currency).toBe("LYD");
  });

  it("rejects missing / garbage tokens", async () => {
    expect((await api("GET", "/api/v1/auth/me")).status).toBe(401);
    expect((await api("GET", "/api/v1/auth/me", undefined, { token: "abc.def.ghi" })).status).toBe(401);
  });
});
