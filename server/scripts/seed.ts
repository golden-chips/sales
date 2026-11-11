// First-run seed. Idempotent: skips what already exists.
//  1. platform super admin (from env)
//  2. the five commercial plans — PRICES ARE PLACEHOLDERS (0) pending owner approval
//  3. tenant #1: شركة الرقائق الذهبية — real configuration only, NO invented
//     products, balances, prices or transactions. CoA = template for review.
//  4. tenant "demo-foods" (is_demo = true) with clearly-labelled DEMO data.
import { randomUUID } from "node:crypto";
import { withPlatform, withPlatformInTenant, withTenant, pool } from "../src/db/pool.js";
import { hashPassword } from "../src/core/security.js";
import { provisionTenant } from "../src/modules/platform/platform.service.js";
import { loadUserCtx } from "../src/core/auth.js";
import { createFiscalYear, seedChartOfAccounts, createDraft, postEntry, postFromSource } from "../src/modules/accounting/accounting.service.js";

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required for seeding`); return v; };

const ALL = ["accounting", "sales", "purchasing", "inventory", "manufacturing", "quality", "distribution", "fleet", "hr", "payroll", "crm", "pos", "assets", "documents", "projects", "bi", "ai"];
const PLANS = [
  { code: "starter", ar: "المبتدئة", en: "Starter", users: 5, companies: 1, branches: 1, wh: 2, mb: 2048, rpm: 120, modules: ["accounting", "sales", "purchasing", "inventory"] },
  { code: "business", ar: "الأعمال", en: "Business", users: 20, companies: 1, branches: 3, wh: 5, mb: 10240, rpm: 300, modules: ["accounting", "sales", "purchasing", "inventory", "crm", "pos", "bi"] },
  { code: "professional", ar: "الاحترافية", en: "Professional", users: 50, companies: 2, branches: 10, wh: 20, mb: 51200, rpm: 600, modules: ["accounting", "sales", "purchasing", "inventory", "crm", "pos", "bi", "distribution", "fleet", "hr", "payroll", "documents", "projects"] },
  { code: "manufacturing", ar: "التصنيع", en: "Manufacturing", users: 100, companies: 3, branches: 15, wh: 40, mb: 102400, rpm: 900, modules: ALL.filter((m) => m !== "ai") },
  { code: "enterprise", ar: "المؤسسات", en: "Enterprise", users: 1000, companies: 20, branches: 200, wh: 500, mb: 1048576, rpm: 3000, modules: ALL },
];

async function main() {
  // 1. platform admin
  await withPlatform(async (db) => {
    const email = env("PLATFORM_ADMIN_EMAIL");
    const r = await db.query("INSERT INTO platform_users (email, full_name, password_hash) VALUES ($1,'Platform Super Admin',$2) ON CONFLICT (email) DO NOTHING RETURNING id",
      [email, await hashPassword(env("PLATFORM_ADMIN_PASSWORD"))]);
    console.log(r.rowCount ? `platform admin created: ${email}` : "platform admin exists");
    // 2. plans
    for (const p of PLANS) {
      const ins = await db.query(
        `INSERT INTO plans (code, name_ar, name_en, currency, price_monthly, price_yearly, trial_days, grace_days, max_users, max_companies, max_branches, max_warehouses, storage_mb, api_rpm)
         VALUES ($1,$2,$3,'LYD',0,0,14,7,$4,$5,$6,$7,$8,$9) ON CONFLICT (code) DO NOTHING RETURNING id`,
        [p.code, p.ar, p.en, p.users, p.companies, p.branches, p.wh, p.mb, p.rpm]);
      if (ins.rowCount) await db.query("INSERT INTO plan_modules (plan_id, module_code) SELECT $1, unnest($2::text[])", [ins.rows[0].id, ["core", ...p.modules]]);
    }
    console.log("plans ready (prices = 0 placeholders; set real prices after approval)");
  });

  // 3. Golden Chips — tenant #1
  const exists = await withPlatform(async (db) => (await db.query("SELECT id FROM tenants WHERE code = 'golden-chips'")).rows[0]);
  if (!exists) {
    const id = randomUUID();
    const r = await withPlatformInTenant(id, async (db) => {
      const out = await provisionTenant(db, id, {
        code: "golden-chips", legalName: "شركة الرقائق الذهبية لصناعة المواد الغذائية", nameEn: "Golden Chips Food Industries Co.",
        industry: "food_manufacturing_distribution", baseCurrency: "LYD", timezone: "Africa/Tripoli", defaultLocale: "ar", secondaryLocale: "en",
        planCode: "enterprise", billingCycle: "yearly",
        company: { code: "GC", nameAr: "شركة الرقائق الذهبية لصناعة المواد الغذائية", nameEn: "Golden Chips Food Industries Co." },
        owner: { email: env("GOLDEN_OWNER_EMAIL"), fullName: "مالك الحساب", password: env("GOLDEN_OWNER_PASSWORD") },
      }, null);
      // Golden Chips is the operator's own company: activate without trial
      await db.query("UPDATE subscriptions SET status = 'active', trial_ends_at = NULL, current_period_end = current_period_start + interval '1 year' WHERE id = $1", [out.subscriptionId]);
      await db.query("UPDATE tenants SET status = 'active', brand_color = '#7B3F00' WHERE id = $1", [id]);
      return out;
    });
    await withTenant(id, r.ownerUserId, async (db) => {
      const n = await seedChartOfAccounts(db, id, r.companyId);
      const ctx = (await loadUserCtx(db, r.ownerUserId, id))!;
      await createFiscalYear(db, ctx, { companyId: r.companyId, name: `FY${new Date().getUTCFullYear()}`, startDate: `${new Date().getUTCFullYear()}-01-01` });
      console.log(`golden-chips provisioned: ${n} template accounts (PENDING accountant review), fiscal year created, no transactions`);
    });
  } else console.log("golden-chips exists");

  // 4. DEMO tenant
  const demo = await withPlatform(async (db) => (await db.query("SELECT id FROM tenants WHERE code = 'demo-foods'")).rows[0]);
  if (!demo) {
    const id = randomUUID();
    const demoPw = `Demo!${randomUUID().slice(0, 12)}`;
    const r = await withPlatformInTenant(id, (db) => provisionTenant(db, id, {
      code: "demo-foods", legalName: "DEMO — شركة أغذية تجريبية", nameEn: "DEMO Foods Co.", industry: "food_manufacturing_distribution",
      baseCurrency: "LYD", timezone: "Africa/Tripoli", defaultLocale: "ar", secondaryLocale: "en", planCode: "manufacturing", billingCycle: "monthly", isDemo: true,
      company: { code: "DEMO", nameAr: "DEMO — شركة أغذية تجريبية", nameEn: "DEMO Foods Co." },
      owner: { email: "owner@demo-foods.example", fullName: "DEMO Owner", password: demoPw },
    }, null));
    await withTenant(id, r.ownerUserId, async (db) => {
      await seedChartOfAccounts(db, id, r.companyId, { isDemo: true });
      const ctx = (await loadUserCtx(db, r.ownerUserId, id))!;
      const y = new Date().getUTCFullYear();
      await createFiscalYear(db, ctx, { companyId: r.companyId, name: `FY${y}`, startDate: `${y}-01-01` });
      const acc = Object.fromEntries((await db.query("SELECT code, id FROM accounts")).rows.map((a) => [a.code, a.id]));
      const date = new Date().toISOString().slice(0, 10);
      await postFromSource(db, ctx, { companyId: r.companyId, entryDate: date, memo: "DEMO — رأس المال الافتتاحي", sourceType: "demo", sourceId: "DEMO-OPEN", isDemo: true,
        lines: [{ accountId: acc["1121"], debit: "50000" }, { accountId: acc["301"], credit: "50000" }] });
      await postFromSource(db, ctx, { companyId: r.companyId, entryDate: date, memo: "DEMO — مبيعات نقدية", sourceType: "demo", sourceId: "DEMO-SALE-1", isDemo: true,
        lines: [{ accountId: acc["1111"], debit: "1250.500" }, { accountId: acc["401"], credit: "1250.500" }] });
      const d = await createDraft(db, ctx, { companyId: r.companyId, entryDate: date, memo: "DEMO — قيد مسودة بانتظار الترحيل", isDemo: true,
        lines: [{ accountId: acc["5302"], debit: "85" }, { accountId: acc["1112"], credit: "85" }] });
      void d; void postEntry;
    });
    console.log(`demo-foods provisioned (is_demo). Owner: owner@demo-foods.example / ${demoPw}  (shown once — store it in your password manager)`);
  } else console.log("demo-foods exists");
}

main().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
