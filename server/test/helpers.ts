import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { withPlatform } from "../src/db/pool.js";
import { hashPassword } from "../src/core/security.js";

export const PW = "Str0ng!Passw0rd";
let app: FastifyInstance | null = null;

export async function getApp() {
  if (!app) { app = await buildApp({ logger: false }); await app.ready(); }
  return app;
}

type Opts = { token?: string; headers?: Record<string, string> };
export async function api(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, o: Opts = {}) {
  const a = await getApp();
  const res = await a.inject({ method, url, payload: body as any, headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) } });
  let json: any = null;
  try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, body: json, headers: res.headers };
}

const uniq = () => randomUUID().slice(0, 8);

export async function platformToken() {
  const email = `root-${uniq()}@platform.test`;
  await withPlatform(async (db) => db.query("INSERT INTO platform_users (email, full_name, password_hash) VALUES ($1,'Root',$2)", [email, await hashPassword(PW)]));
  const r = await api("POST", "/api/v1/platform/auth/login", { email, password: PW });
  if (r.status !== 200) throw new Error(`platform login failed ${JSON.stringify(r.body)}`);
  return r.body.accessToken as string;
}

let planCounter = 0;
export async function createPlan(ptoken: string, over: Record<string, unknown> = {}) {
  const code = `plan_${uniq().replace(/-/g, "")}_${planCounter++}`;
  const r = await api("POST", "/api/v1/platform/plans", {
    code, nameAr: "باقة اختبار", nameEn: "Test plan", currency: "LYD", priceMonthly: 100, priceYearly: 1000, trialDays: 0, graceDays: 3,
    maxUsers: 10, maxCompanies: 2, maxBranches: 5, maxWarehouses: 5, storageMb: 1024, apiRpm: 600, modules: ["accounting"], ...over,
  }, { token: ptoken });
  if (r.status !== 201) throw new Error(`plan create failed ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function provision(ptoken: string, planCode: string, over: Record<string, unknown> = {}) {
  const code = `t-${uniq()}`;
  const owner = { email: `owner@${code}.test`, fullName: "Owner", password: PW };
  const r = await api("POST", "/api/v1/platform/tenants", {
    code, legalName: `شركة ${code}`, planCode, company: { code: "MAIN", nameAr: "الشركة الرئيسية" }, owner, ...over,
  }, { token: ptoken });
  if (r.status !== 201) throw new Error(`provision failed ${JSON.stringify(r.body)}`);
  const login = await api("POST", "/api/v1/auth/login", { tenant: code, email: owner.email, password: PW });
  if (login.status !== 200) throw new Error(`owner login failed ${JSON.stringify(login.body)}`);
  return { ...r.body, code, owner, token: login.body.accessToken as string, refreshToken: login.body.refreshToken as string };
}

export async function roleId(token: string, code: string) {
  const r = await api("GET", "/api/v1/roles", undefined, { token });
  return r.body.find((x: any) => x.code === code).id as string;
}

export async function createUser(t: { token: string; code: string }, roles: { roleId: string; branchId?: string }[], email = `u-${uniq()}@x.test`) {
  const r = await api("POST", "/api/v1/users", { email, fullName: "User " + email, password: PW, roles }, { token: t.token });
  if (r.status !== 201) throw new Error(`user create failed ${JSON.stringify(r.body)}`);
  const login = await api("POST", "/api/v1/auth/login", { tenant: t.code, email, password: PW });
  return { id: r.body.id as string, email, token: login.body.accessToken as string };
}
