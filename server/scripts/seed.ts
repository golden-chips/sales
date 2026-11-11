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
import { createStockDoc, postStockDoc } from "../src/modules/erp/inventory.service.js";
import { syncSystemRoles } from "../src/modules/iam/roles.service.js";
import { approveBom, createBom } from "../src/modules/mfg/mfg.service.js";
import { replaceSpecs } from "../src/modules/mfg/quality.service.js";
import { createRep, setRoute } from "../src/modules/field/field.service.js";
import { roleIdByCode } from "../src/modules/iam/roles.service.js";

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
    // self-service trials start on the Manufacturing plan for 14 days (a commercial choice the owner can change in the platform console)
    await db.query("UPDATE plans SET is_trial_default = (code = 'manufacturing') WHERE NOT EXISTS (SELECT 1 FROM plans WHERE is_trial_default AND code <> 'manufacturing')");
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
    const demoPw = process.env.DEMO_OWNER_PASSWORD || `Demo!${randomUUID().slice(0, 12)}`;
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

      // DEMO master data + opening stock (every record prefixed DEMO / is_demo)
      const branch = (await db.query("SELECT id FROM branches LIMIT 1")).rows[0].id;
      const wh: Record<string, string> = {};
      for (const [code, kind, ar] of [["DEMO-FG", "finished_goods", "DEMO مخزن المنتج التام"], ["DEMO-QC", "quarantine", "DEMO مخزن الحجر/الفحص"], ["DEMO-RM", "raw_materials", "DEMO مخزن الخامات"]])
        wh[code] = (await db.query("INSERT INTO warehouses (tenant_id, branch_id, code, name_ar, kind, is_sellable) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [id, branch, code, ar, kind, kind === "finished_goods"])).rows[0].id;
      const u: Record<string, string> = {};
      for (const [code, ar] of [["BAG", "كيس"], ["CTN", "كرتونة"], ["KG", "كيلو"]]) u[code] = (await db.query("INSERT INTO uoms (tenant_id, code, name_ar) VALUES ($1,$2,$3) RETURNING id", [id, code, ar])).rows[0].id;
      const item = async (code: string, ar: string, kind: string, uom: string, price: string | null, alt?: [string, string]) => {
        const row = (await db.query(`INSERT INTO items (tenant_id, company_id, code, name_ar, kind, base_uom_id, track_lots, shelf_life_days, sales_price, reorder_level, is_demo)
          VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,true) RETURNING id`, [id, r.companyId, code, ar, kind, u[uom], kind === "finished" ? 180 : 365, price, kind === "finished" ? "100" : null])).rows[0];
        if (alt) await db.query("INSERT INTO item_uoms (tenant_id, item_id, uom_id, factor) VALUES ($1,$2,$3,$4)", [id, row.id, u[alt[0]], alt[1]]);
        return row.id as string;
      };
      const chips = await item("DEMO-CHIPS-40", "DEMO رقائق بطاطس 40غ", "finished", "BAG", "1.250", ["CTN", "24"]);
      const corn = await item("DEMO-CORN-25", "DEMO رقائق ذرة 25غ", "finished", "BAG", "0.750", ["CTN", "36"]);
      const oil = await item("DEMO-OIL", "DEMO زيت نباتي", "raw", "KG", null);
      for (const [code, ar, limit] of [["DEMO-C001", "DEMO سوبرماركت النور", "2000"], ["DEMO-C002", "DEMO بقالة الأمل", "500"], ["DEMO-C003", "DEMO موزع الجنوب", null]])
        await db.query("INSERT INTO parties (tenant_id, company_id, kind, code, name_ar, credit_limit, payment_terms_days, is_demo) VALUES ($1,$2,'customer',$3,$4,$5,30,true)", [id, r.companyId, code, ar, limit]);
      await db.query("INSERT INTO parties (tenant_id, company_id, kind, code, name_ar, payment_terms_days, is_demo) VALUES ($1,$2,'supplier','DEMO-S001','DEMO مورد الزيوت',15,true)", [id, r.companyId]);
      await syncSystemRoles(db, id);
      const seedCtx = { ...ctx, enforceSod: false }; // seeding only: the system posts its own opening document
      const y0 = `${y}-01-01`;
      // production dates relative to today so DEMO stock is within shelf life whenever the seed runs
      const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
      const op = await createStockDoc(db, seedCtx, { companyId: r.companyId, reason: "opening", warehouseId: wh["DEMO-FG"], docDate: y0, notes: "DEMO رصيد افتتاحي", lines: [
        { itemId: chips, qtyDelta: "480", unitCost: "0.82", lotNo: "DEMO-L01", productionDate: daysAgo(40) },
        { itemId: chips, qtyDelta: "240", unitCost: "0.90", lotNo: "DEMO-L02", productionDate: daysAgo(10) },
        { itemId: corn, qtyDelta: "360", unitCost: "0.45", lotNo: "DEMO-L03", productionDate: daysAgo(20) } ] });
      await postStockDoc(db, seedCtx, op.id);
      const op2 = await createStockDoc(db, seedCtx, { companyId: r.companyId, reason: "opening", warehouseId: wh["DEMO-RM"], docDate: y0, notes: "DEMO رصيد افتتاحي خامات",
        lines: [{ itemId: oil, qtyDelta: "500", unitCost: "4.2", lotNo: "DEMO-OIL-01", expiryDate: `${y + 1}-06-30` }] });
      await postStockDoc(db, seedCtx, op2.id);

      // DEMO manufacturing: raw materials, packaging, an approved formula, a line, HACCP specs
      const potato = await item("DEMO-POTATO", "DEMO بطاطس طازجة", "raw", "KG", null);
      const salt = await item("DEMO-SALT", "DEMO ملح طعام", "raw", "KG", null);
      const film = (await db.query(`INSERT INTO items (tenant_id, company_id, code, name_ar, kind, base_uom_id, track_lots, is_demo) VALUES ($1,$2,'DEMO-FILM40','DEMO فيلم تغليف 40غ','packaging',$3,false,true) RETURNING id`,
        [id, r.companyId, u.BAG])).rows[0].id;
      const op3 = await createStockDoc(db, seedCtx, { companyId: r.companyId, reason: "opening", warehouseId: wh["DEMO-RM"], docDate: y0, notes: "DEMO خامات ومواد تعبئة", lines: [
        { itemId: potato, qtyDelta: "3000", unitCost: "0.55", lotNo: "DEMO-POT-01", expiryDate: `${y + 1}-03-31` },
        { itemId: salt, qtyDelta: "200", unitCost: "0.9", lotNo: "DEMO-SALT-01", expiryDate: `${y + 2}-12-31` },
        { itemId: film, qtyDelta: "20000", unitCost: "0.04" } ] });
      await postStockDoc(db, seedCtx, op3.id);
      await db.query("INSERT INTO work_centers (tenant_id, company_id, code, name_ar, capacity_per_hour, rate_per_hour) VALUES ($1,$2,'DEMO-LINE1','DEMO خط القلي 1',600,45)", [id, r.companyId]);
      const bomDraft = await createBom(db, seedCtx, { companyId: r.companyId, itemId: chips, batchQty: "1000", stdScrapPct: "2", stdHours: "2", notes: "DEMO وصفة تجريبية — ليست وصفة حقيقية",
        lines: [{ itemId: potato, qty: "160", scrapPct: "5" }, { itemId: oil, qty: "12" }, { itemId: salt, qty: "0.8" }, { itemId: film, qty: "1000", scrapPct: "2" }] });
      await approveBom(db, seedCtx, bomDraft.id);
      await replaceSpecs(db, seedCtx, chips, "final", [
        { parameter: "درجة حرارة القلي", unit: "°C", min: "170", max: "180", isCcp: true },
        { parameter: "الرطوبة", unit: "%", max: "2" }, { parameter: "نسبة الملح", unit: "%", min: "1", max: "2" }, { parameter: "سلامة التغليف" } ]);

      // DEMO field sales: a rep user, a loaded van, a territory and a route on every weekday
      const repPw = process.env.DEMO_REP_PASSWORD || demoPw;
      const repUser = (await db.query("INSERT INTO users (tenant_id, email, full_name, password_hash, locale) VALUES ($1,'rep@demo-foods.example','DEMO مندوب 1',$2,'ar') RETURNING id",
        [id, await hashPassword(repPw)])).rows[0].id;
      await db.query("INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [id, repUser, await roleIdByCode(db, "sales_rep")]);
      const van = (await db.query("INSERT INTO warehouses (tenant_id, branch_id, code, name_ar, kind, is_sellable) VALUES ($1,$2,'DEMO-VAN1','DEMO سيارة توزيع 1','van',true) RETURNING id", [id, branch])).rows[0].id;
      const terr = (await db.query("INSERT INTO territories (tenant_id, company_id, code, name_ar) VALUES ($1,$2,'DEMO-TRP','DEMO طرابلس — وسط') RETURNING id", [id, r.companyId])).rows[0].id;
      const rep = await createRep(db, seedCtx, { companyId: r.companyId, userId: repUser, code: "DEMO-R1", vanWarehouseId: van, territoryId: terr, commissionType: "flat", commissionRate: "1.5", maxDiscountPct: "5" });
      const custs = (await db.query("SELECT id FROM parties WHERE kind = 'customer' ORDER BY code")).rows.map((x) => x.id);
      await db.query("UPDATE parties SET phone = '+218910000000' WHERE code = 'DEMO-C001'");
      for (let wd = 0; wd < 7; wd++) await setRoute(db, seedCtx, rep.id, { weekday: wd, name: "DEMO مسار يومي", customerIds: custs });
      const load = await createStockDoc(db, seedCtx, { companyId: r.companyId, reason: "transfer", warehouseId: wh["DEMO-FG"], toWarehouseId: van, docDate: new Date().toISOString().slice(0, 10),
        notes: "DEMO تحميل السيارة", lines: [{ itemId: chips, qtyDelta: "240" }, { itemId: corn, qtyDelta: "144" }] });
      await postStockDoc(db, seedCtx, load.id);
      console.log(`demo rep: rep@demo-foods.example / ${repPw}`);
    });
    console.log(`demo-foods provisioned (is_demo). Owner: owner@demo-foods.example / ${demoPw}  (shown once — store it in your password manager)`);
  } else console.log("demo-foods exists");
}

main().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
