// 0.9 security hardening: refresh cookie + CSRF (K1), per-company request budget (K2),
// MFA secrets encrypted at rest (K3), fingerprint device address allow-list (K26).
import { describe, it, expect, beforeAll } from "vitest";
import { generateSecret, generateSync } from "otplib";
import { api, platformToken, createPlan, provision, PW, getApp } from "./helpers.js";
import { withTenant } from "../src/db/pool.js";
import { decryptSecret, encryptSecret } from "../src/core/security.js";
import { tenantBudget } from "../src/core/auth.js";

const ok = (r: any, s = 200) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const cookies = (h: any): Record<string, string> => {
  const list: string[] = Array.isArray(h["set-cookie"]) ? h["set-cookie"] : h["set-cookie"] ? [h["set-cookie"]] : [];
  return Object.fromEntries(list.map((c) => { const [kv] = c.split(";"); const i = kv.indexOf("="); return [kv.slice(0, i), c]; }));
};
const value = (c: string) => decodeURIComponent(c.split(";")[0].split("=").slice(1).join("="));

describe("security hardening (0.9)", () => {
  let p: string, T: any;
  beforeAll(async () => {
    p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "hr"] });
    T = await provision(p, plan.code);
  });

  it("K1: browser login keeps the refresh token in an httpOnly cookie; refresh needs the CSRF token; a second tab's race is not treated as theft", async () => {
    const login = await api("POST", "/api/v1/auth/login", { tenant: T.code, login: T.owner.email, password: PW }, { headers: { "x-session-mode": "cookie" } });
    ok(login);
    expect(login.body.refreshToken).toBeUndefined();
    expect(login.body.accessToken).toBeTruthy();
    const c = cookies(login.headers);
    expect(c.ge_rt).toMatch(/HttpOnly/);
    expect(c.ge_rt).toMatch(/SameSite=Strict/);
    expect(c.ge_rt).toMatch(/Path=\/api\/v1\/auth/);
    expect(c.ge_csrf).not.toMatch(/HttpOnly/);
    const jar = `ge_rt=${encodeURIComponent(value(c.ge_rt))}; ge_csrf=${encodeURIComponent(value(c.ge_csrf))}`;

    // the cookie alone is not enough (a forged cross-site request cannot read the CSRF cookie)
    expect((await api("POST", "/api/v1/auth/refresh", {}, { headers: { cookie: jar } })).status).toBe(403);
    expect((await api("POST", "/api/v1/auth/refresh", {}, { headers: { cookie: jar, "x-csrf-token": "wrong" } })).status).toBe(403);
    const r1 = await api("POST", "/api/v1/auth/refresh", {}, { headers: { cookie: jar, "x-csrf-token": value(c.ge_csrf), "x-session-mode": "cookie" } });
    ok(r1);
    expect(r1.body.refreshToken).toBeUndefined();
    const c1 = cookies(r1.headers);
    expect(value(c1.ge_rt)).not.toBe(value(c.ge_rt));   // rotated

    // another tab sends the old cookie a moment later: told to retry, the session survives
    const race = await api("POST", "/api/v1/auth/refresh", {}, { headers: { cookie: jar, "x-csrf-token": value(c.ge_csrf), "x-session-mode": "cookie" } });
    expect(race.status).toBe(422);
    expect(race.body.error.code).toBe("REFRESH_RACE");
    const jar1 = `ge_rt=${encodeURIComponent(value(c1.ge_rt))}; ge_csrf=${encodeURIComponent(value(c1.ge_csrf))}`;
    const r2 = await api("POST", "/api/v1/auth/refresh", {}, { headers: { cookie: jar1, "x-csrf-token": value(c1.ge_csrf), "x-session-mode": "cookie" } });
    ok(r2);

    // logout clears the cookies
    const out = await api("POST", "/api/v1/auth/logout", {}, { token: r2.body.accessToken });
    ok(out);
    expect(cookies(out.headers).ge_rt).toMatch(/Max-Age=0/);

    // the Android app (no cookie mode) still gets the token in the body
    const nat = ok(await api("POST", "/api/v1/auth/login", { tenant: T.code, login: T.owner.email, password: PW }));
    expect(nat.refreshToken).toMatch(/\./);
    expect(cookies((await api("POST", "/api/v1/auth/refresh", { refreshToken: nat.refreshToken })).headers).ge_rt).toBeUndefined();
  });

  it("K3: MFA secrets are stored encrypted; secrets saved in plain text before 0.9 still work and get encrypted on use", async () => {
    const enc = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(enc).toMatch(/^enc1:/);
    expect(decryptSecret(enc)).toBe("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(enc.slice(0, -2) + "AA")).toBeNull();   // tampered

    const M = await provision(p, (await createPlan(p, { modules: ["accounting"] })).code);
    const setup = ok(await api("POST", "/api/v1/auth/mfa/setup", {}, { token: M.token }));
    const stored = await withTenant(M.tenantId, null, async (db) => (await db.query("SELECT mfa_secret FROM users WHERE email = $1", [M.owner.email])).rows[0].mfa_secret);
    expect(stored).toMatch(/^enc1:/);
    expect(stored).not.toContain(setup.secret);
    ok(await api("POST", "/api/v1/auth/mfa/enable", { otp: generateSync({ secret: setup.secret }) }, { token: M.token }));
    ok(await api("POST", "/api/v1/auth/login", { tenant: M.code, login: M.owner.email, password: PW, otp: generateSync({ secret: setup.secret }) }));

    // a legacy plain-text secret
    const legacy = generateSecret();
    await withTenant(M.tenantId, null, (db) => db.query("UPDATE users SET mfa_secret = $2 WHERE email = $1", [M.owner.email, legacy]));
    ok(await api("POST", "/api/v1/auth/login", { tenant: M.code, login: M.owner.email, password: PW, otp: generateSync({ secret: legacy }) }));
    const after = await withTenant(M.tenantId, null, async (db) => (await db.query("SELECT mfa_secret FROM users WHERE email = $1", [M.owner.email])).rows[0].mfa_secret);
    expect(after).toMatch(/^enc1:/);
    expect(decryptSecret(after)).toBe(legacy);
  });

  it("K2: a company cannot exceed its plan's requests per minute (all its users together)", async () => {
    expect(tenantBudget("x-tenant", 2, 0)).toBe(0);
    expect(tenantBudget("x-tenant", 2, 1000)).toBe(0);
    expect(tenantBudget("x-tenant", 2, 2000)).toBe(58);       // seconds until the minute ends
    expect(tenantBudget("x-tenant", 2, 60_000)).toBe(0);      // a new minute

    const S = await provision(p, (await createPlan(p, { modules: ["accounting"], apiRpm: 5 })).code);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await api("GET", "/api/v1/auth/me", undefined, { token: S.token })).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    const last = await api("GET", "/api/v1/auth/me", undefined, { token: S.token });
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("TENANT_RATE_LIMITED");
    expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
    // another company is not affected
    ok(await api("GET", "/api/v1/auth/me", undefined, { token: T.token }));
  });

  it("K26: a fingerprint device limited to the factory's address rejects pushes from anywhere else (forwarded headers cannot be faked)", async () => {
    const app = await getApp();
    const sn = `SEC-${Date.now().toString(36).toUpperCase()}`;
    const bad = await api("POST", "/api/v1/hr/devices", { companyId: T.companyId, serialNumber: sn, name: "بصمة", allowedIps: ["not-an-ip"] }, { token: T.token });
    expect(bad.status).toBe(422);
    const d = ok(await api("POST", "/api/v1/hr/devices", { companyId: T.companyId, serialNumber: sn, name: "بصمة المصنع", allowedIps: ["41.208.10.0/24"] }, { token: T.token }), 201);
    const push = (xff?: string) => app.inject({ method: "GET", url: `/iclock/cdata?SN=${sn}&options=all`, headers: xff ? { "x-forwarded-for": xff } : {} });
    expect((await push("41.208.10.7")).statusCode).toBe(200);
    expect((await push("8.8.8.8")).statusCode).toBe(404);
    expect((await push("41.208.10.7, 8.8.8.8")).statusCode).toBe(404);   // the proxy appended the real address; the forged one is ignored
    // lifting the limit
    ok(await api("PATCH", `/api/v1/hr/devices/${d.id}`, { allowedIps: [] }, { token: T.token }));
    expect((await push("8.8.8.8")).statusCode).toBe(200);
    ok(await api("PATCH", `/api/v1/hr/devices/${d.id}`, { isActive: false }, { token: T.token }));
    expect((await push("8.8.8.8")).statusCode).toBe(404);
  });
});
