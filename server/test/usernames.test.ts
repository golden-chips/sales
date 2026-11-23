import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, PW } from "./helpers.js";

describe("sign in with a username", () => {
  let T: any;
  beforeAll(async () => { const p = await platformToken(); T = await provision(p, (await createPlan(p)).code); });
  const login = (login: string, password = PW) => api("POST", "/api/v1/auth/login", { tenant: T.code, login, password });

  it("a user without e-mail signs in by username (case-insensitive); e-mail still works; wrong ones are refused alike", async () => {
    const c = await api("POST", "/api/v1/users", { username: "Ali.Cashier", fullName: "علي الكاشير", password: PW }, { token: T.token });
    expect([c.status, c.body.username, c.body.email]).toEqual([201, "ali.cashier", null]);
    expect((await login("ali.cashier")).status).toBe(200);
    expect((await login("ALI.CASHIER")).status).toBe(200);
    expect((await login("ali.cashier", "wrong-Passw0rd!")).body.error.code).toBe("INVALID_CREDENTIALS");
    expect((await login("nobody")).body.error.code).toBe("INVALID_CREDENTIALS");
    // users created with an e-mail get its local part as username automatically
    const e = await api("POST", "/api/v1/users", { email: "sara.k@x.test", fullName: "سارة", password: PW }, { token: T.token });
    expect(e.body.username).toBe("sara.k");
    expect((await login("sara.k")).status).toBe(200);
    expect((await login("sara.k@x.test")).status).toBe(200);
    // the old "email" field keeps working for existing apps
    expect((await api("POST", "/api/v1/auth/login", { tenant: T.code, email: "sara.k@x.test", password: PW })).status).toBe(200);
  });

  it("usernames are unique per company and validated; at least a username or an e-mail is required", async () => {
    expect((await api("POST", "/api/v1/users", { username: "ali.cashier", fullName: "مكرر", password: PW }, { token: T.token })).status).toBe(409);
    expect((await api("POST", "/api/v1/users", { username: "a b", fullName: "خطأ", password: PW }, { token: T.token })).status).toBe(422);
    expect((await api("POST", "/api/v1/users", { fullName: "بدون", password: PW }, { token: T.token })).status).toBe(422);
    const list = (await api("GET", "/api/v1/users?q=ali", undefined, { token: T.token })).body.data;
    expect(list.map((u: any) => u.username)).toContain("ali.cashier");
  });
});
