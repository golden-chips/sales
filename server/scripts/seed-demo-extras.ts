// DEMO data for every module of the trial tenant "demo-foods" (v0.8).
// Runs after scripts/seed.ts and only on the DEMO tenant. Idempotent: skipped
// when its marker user already exists. Everything goes through the real API
// (same validation, segregation of duties and postings as real use) and every
// name carries "DEMO" — none of it is real company data.
//
// It also creates one DEMO user per role so each screen can be tried as that
// role. Their password is DEMO_USERS_PASSWORD (or DEMO_OWNER_PASSWORD), else a
// random one printed once at the end.
import { randomUUID } from "node:crypto";
import { withPlatform, withPlatformInTenant, withTenant, pool } from "../src/db/pool.js";
import { hashPassword } from "../src/core/security.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { roleIdByCode } from "../src/modules/iam/roles.service.js";

const TENANT = "demo-foods";
const USERS = [   // email prefix, Arabic name, role
  ["gm", "DEMO المدير العام", "tenant_owner"], ["accountant", "DEMO المحاسب", "accountant"], ["finance", "DEMO المدير المالي", "finance_manager"],
  ["sales", "DEMO مدير المبيعات", "sales_manager"], ["warehouse", "DEMO أمين المخزن", "warehouse_manager"], ["production", "DEMO مدير الإنتاج", "production_manager"],
  ["quality", "DEMO مدير الجودة", "quality_manager"], ["hr", "DEMO مدير الموارد البشرية", "hr_manager"], ["cashier", "DEMO كاشير الصالة", "cashier"],
  ["possup", "DEMO مشرف الصالة", "pos_supervisor"], ["maintenance", "DEMO مدير الصيانة", "maintenance_manager"], ["service", "DEMO خدمة العملاء", "customer_service"],
  ["projects", "DEMO مدير المشاريع", "project_manager"],
] as const;

type Tok = Record<string, string>;
const day = (n: number) => {   // n days ago, never before 1 January (the DEMO fiscal year)
  const d = new Date(Date.now() - n * 86400_000);
  const jan1 = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  return (d < jan1 ? jan1 : d).toISOString().slice(0, 10);
};

async function main() {
  const t = await withPlatform(async (db) => (await db.query("SELECT id, is_demo FROM tenants WHERE code = $1", [TENANT])).rows[0]);
  if (!t) { console.log("demo tenant not found — run scripts/seed.ts first"); return; }
  if (!t.is_demo) throw new Error("refusing to seed DEMO data into a tenant that is not flagged is_demo");
  const owner = await withPlatformInTenant(t.id, async (db) => (await db.query("SELECT id FROM users WHERE tenant_id = $1 AND is_owner LIMIT 1", [t.id])).rows[0]);
  const already = await withTenant(t.id, owner.id, async (db) => (await db.query("SELECT 1 FROM users WHERE email = 'gm@demo-foods.example'")).rowCount);
  if (already) { console.log("demo extras exist"); return; }

  const pw = process.env.DEMO_USERS_PASSWORD || process.env.DEMO_OWNER_PASSWORD || `Demo!${randomUUID().slice(0, 12)}`;
  const hash = await hashPassword(pw);
  await withTenant(t.id, owner.id, async (db) => {
    for (const [p, name, role] of USERS) {
      const u = (await db.query("INSERT INTO users (tenant_id, email, full_name, password_hash, locale) VALUES ($1,$2,$3,$4,'ar') RETURNING id", [t.id, `${p}@demo-foods.example`, name, hash])).rows[0].id;
      await db.query("INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [t.id, u, await roleIdByCode(db, role)]);
    }
  });

  // in-process app used only by this script: its own rate limits must not throttle the seeding logins
  Object.assign(config, { loginRateLimitPerMin: 100000, userRateLimitPerMin: 100000, globalRateLimitPerMin: 100000 });
  const app = await buildApp({ logger: false });
  await app.ready();
  const call = async (tok: string, method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as any, url: `/api/v1${url}`, payload: body as any, headers: { authorization: `Bearer ${tok}` } });
    const j = r.body ? r.json() : null;
    if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${JSON.stringify(j?.error ?? j).slice(0, 400)}`);
    return j;
  };
  const tok: Tok = {};
  for (const [p] of USERS) {
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { tenant: TENANT, email: `${p}@demo-foods.example`, password: pw } });
    if (r.statusCode !== 200) throw new Error(`login ${p} failed: ${r.body}`);
    tok[p] = r.json().accessToken;
  }
  const as = (who: string) => ({
    get: (url: string) => call(tok[who], "GET", url), post: (url: string, b: unknown = {}) => call(tok[who], "POST", url, b), put: (url: string, b: unknown) => call(tok[who], "PUT", url, b),
  });
  const GM = as("gm");
  const me = await GM.get("/auth/me");
  const C = me.companies[0].id as string;
  const acc: Record<string, string> = Object.fromEntries((await GM.get(`/accounting/accounts?companyId=${C}`)).map((a: any) => [a.code, a.id]));
  const whs: Record<string, any> = Object.fromEntries((await GM.get("/warehouses")).map((w: any) => [w.code, w]));
  const items: Record<string, any> = Object.fromEntries((await GM.get(`/items?companyId=${C}&pageSize=200`)).data.map((i: any) => [i.code, i]));
  const customers = (await GM.get(`/customers?companyId=${C}&pageSize=50`)).data;
  const supplier = (await GM.get(`/suppliers?companyId=${C}&pageSize=50`)).data[0];
  const branch = (await GM.get("/branches"))[0].id;
  const FG = whs["DEMO-FG"].id, RM = whs["DEMO-RM"].id, QC = whs["DEMO-QC"].id;
  const chips = items["DEMO-CHIPS-40"].id, corn = items["DEMO-CORN-25"].id;

  const done: string[] = [];
  const failed: string[] = [];
  const section = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); done.push(name); console.log(`  ✓ ${name}`); }
    catch (e) { failed.push(`${name}: ${(e as Error).message}`); console.error(`  ✗ ${name}: ${(e as Error).message}`); }
  };

  await section("sales invoices & receipts (last 45 days)", async () => {
    const S = as("sales");
    for (let i = 0; i < 14; i++) {
      const c = customers[i % customers.length];
      const credit = c.credit_limit !== null && i % 3 !== 0;
      const inv = await S.post("/sales/invoices", { companyId: C, warehouseId: FG, customerId: c.id, invoiceDate: day(45 - i * 3), paymentType: credit ? "credit" : "cash",
        lines: [{ itemId: chips, qty: String(10 + (i % 4) * 5) }, ...(i % 2 ? [{ itemId: corn, qty: String(12 + i) }] : [])] });
      await GM.post(`/sales/invoices/${inv.id}/post`);
    }
    const r = await S.post("/sales/receipts", { companyId: C, partyId: customers[1].id, method: "cash", paymentDate: day(5), amount: "20" });
    await GM.post(`/sales/receipts/${r.id}/post`);
  });

  await section("quotation, sales order, purchase orders", async () => {
    const S = as("sales"), W = as("warehouse"), F = as("finance");
    const q = await S.post("/sales-quotations", { companyId: C, customerId: customers[0].id, quoteDate: day(2), notes: "DEMO عرض شهري", lines: [{ itemId: chips, uomId: null, qty: "120" }, { itemId: corn, qty: "72", discountPct: "5" }] });
    await S.post(`/sales-quotations/${q.id}/send`);
    const q2 = await S.post("/sales-quotations", { companyId: C, customerId: customers[2].id, quoteDate: day(6), lines: [{ itemId: chips, qty: "96" }] });
    const so = await S.post(`/sales-quotations/${q2.id}/convert`, { warehouseId: FG, orderDate: day(4), deliveryDate: day(-3) });
    await S.post(`/sales-orders/${so.id}/confirm`);
    const inv = await S.post(`/sales-orders/${so.id}/invoice`, { invoiceDate: day(1), lines: [{ orderLineId: so.lines[0].id, qty: "48" }] });
    await GM.post(`/sales/invoices/${inv.id}/post`);
    await S.post("/sales-orders", { companyId: C, warehouseId: FG, customerId: customers[1].id, orderDate: day(0), lines: [{ itemId: corn, qty: "48" }] });   // draft, to try "confirm"
    await GM.put("/order-settings", { companyId: C, poApprovalThreshold: "2000" });
    const oil = items["DEMO-OIL"].id, potato = items["DEMO-POTATO"].id;
    const po1 = await W.post("/purchase-orders", { companyId: C, supplierId: supplier.id, warehouseId: RM, orderDate: day(8), expectedDate: day(1), lines: [{ itemId: oil, qty: "200", unitCost: "4.2" }] });
    await W.post(`/purchase-orders/${po1.id}/submit`);   // 840 ≤ 2000 → approved automatically
    const rc = await W.post(`/purchase-orders/${po1.id}/receive`, { receiptDate: day(2), supplierRef: "DEMO-INV-1", lines: [{ orderLineId: po1.lines[0].id, qty: "120", lotNo: "DEMO-OIL-02", expiryDate: day(-300) }] });
    await GM.post(`/purchasing/receipts/${rc.id}/post`);
    const po2 = await W.post("/purchase-orders", { companyId: C, supplierId: supplier.id, warehouseId: RM, orderDate: day(1), lines: [{ itemId: potato, qty: "5000", unitCost: "0.55" }] });
    await W.post(`/purchase-orders/${po2.id}/submit`);   // 2750 > 2000 → waits for the finance manager
    void F;
  });

  await section("point of sale (register, open shift with sales)", async () => {
    const reg = await as("finance").post("/pos/registers", { companyId: C, branchId: branch, code: "DEMO-POS1", nameAr: "DEMO كاشير الصالة 1", warehouseId: FG, returnWarehouseId: QC,
      walkInCustomerId: customers[2].id, cashAccountId: acc["1113"], safeAccountId: acc["1111"], cardAccountId: acc["1121"], varianceAccountId: acc["404"], maxDiscountPct: "5" });
    const K = as("cashier");
    const shift = await K.post("/pos/shifts", { registerId: reg.id, openingFloat: "100", businessDate: day(0) });
    const sales: { itemId: string; qty: string; uomId?: string }[][] = [[{ itemId: chips, qty: "4" }], [{ itemId: corn, qty: "6" }, { itemId: chips, qty: "2" }], [{ itemId: chips, uomId: items["DEMO-CHIPS-40"].units?.[0]?.uomId, qty: "1" }]];
    for (const lines of sales) {
      const cat = await K.get(`/pos/registers/${reg.id}/catalog`);
      const price = (l: any) => Number(cat.find((c: any) => c.id === l.itemId)?.sales_price ?? 0) * Number(l.qty) * (l.uomId ? 24 : 1);
      const total = lines.reduce((s, l) => s + price(l), 0).toFixed(3);
      await K.post(`/pos/shifts/${shift.shift.id}/sales`, { clientId: randomUUID(), lines: lines.map((l) => (l.uomId ? l : { itemId: l.itemId, qty: l.qty })), cash: total });
    }
  });

  await section("production order completed + quality check", async () => {
    const P = as("production"), Q = as("quality");
    const wc = (await P.get(`/manufacturing/work-centers?companyId=${C}`))[0];
    const o = await P.post("/manufacturing/orders", { companyId: C, itemId: chips, workCenterId: wc.id, plannedQty: "1000", materialWarehouseId: RM, outputWarehouseId: QC, plannedDate: day(3) });
    await GM.post(`/manufacturing/orders/${o.id}/release`);
    const full = await P.get(`/manufacturing/orders/${o.id}`);
    for (const r of full.requirements) await P.post(`/manufacturing/orders/${o.id}/issue`, { itemId: r.itemId, qty: r.required, entryDate: day(3) });
    await P.post(`/manufacturing/orders/${o.id}/time`, { hours: "2", entryDate: day(3) });
    const doneOrder = await P.post(`/manufacturing/orders/${o.id}/complete`, { producedQty: "980", scrapQty: "20", lotNo: "DEMO-L04", productionDate: day(3), entryDate: day(3) });
    const lotId = doneOrder.output_lot_id;
    await Q.post("/quality/checks", { companyId: C, lotId, stage: "final", results: [{ parameter: "درجة حرارة القلي", value: "175" }, { parameter: "الرطوبة", value: "1.4" },
      { parameter: "نسبة الملح", value: "1.5" }, { parameter: "سلامة التغليف", passed: true }] });
    // a second order planned for tomorrow, to try release/issue
    await P.post("/manufacturing/orders", { companyId: C, itemId: chips, workCenterId: wc.id, plannedQty: "500", materialWarehouseId: RM, outputWarehouseId: QC, plannedDate: day(-1) });
  });

  await section("fixed assets & maintenance", async () => {
    const F = as("finance"), M = as("maintenance");
    // the owner adds capital to the bank first, so buying the machines does not overdraw it
    const je = await as("accountant").post("/accounting/journal-entries", { companyId: C, entryDate: day(301), memo: "DEMO — زيادة رأس المال لتمويل الآلات",
      lines: [{ accountId: acc["1121"], debit: "150000" }, { accountId: acc["301"], credit: "150000" }] });
    await GM.post(`/accounting/journal-entries/${je.id}/post`);
    const cat = await F.post("/assets/categories", { companyId: C, code: "DEMO-MACH", nameAr: "DEMO آلات وخطوط إنتاج", usefulLifeMonths: 120,
      assetAccountId: acc["1212"], accumAccountId: acc["1222"], expenseAccountId: acc["5204"], maintenanceAccountId: acc["5203"] });
    const assets = [];
    for (const [code, name, cost] of [["DEMO-FRYER1", "DEMO مقلاة مستمرة — خط 1", "85000"], ["DEMO-PACK1", "DEMO ماكينة تعبئة 40غ", "42000"]]) {
      const a = await F.post("/assets", { companyId: C, categoryId: cat.id, code, nameAr: name, kind: "machine", acquisitionDate: day(300), inServiceDate: day(290), cost, fundingAccountId: acc["1121"], location: "DEMO المصنع" });
      await GM.post(`/assets/${a.id}/capitalize`);
      assets.push(a);
    }
    await M.post("/maintenance/plans", { assetId: assets[0].id, nameAr: "DEMO تنظيف وتغيير زيت المقلاة", intervalDays: 30, firstDueDate: day(2), checklist: "تفريغ الزيت، تنظيف، فحص الحساسات" });
    await M.post("/maintenance/plans/generate", { companyId: C, asOf: day(0) });
    await M.post("/maintenance/orders", { assetId: assets[1].id, priority: "high", description: "DEMO توقف التعبئة — خلل في حساس الفيلم", failureCode: "SENSOR" });
  });

  await section("CRM: campaign, leads, pipeline, follow-ups, tickets", async () => {
    const S = as("sales"), CS = as("service");
    const camp = await S.post("/crm/campaigns", { companyId: C, name: "DEMO حملة المدارس", channel: "field", startDate: day(20) });
    const leads = [];
    for (const [n, b, ph] of [["DEMO أحمد", "DEMO بقالة الزهراء", "+218910000001"], ["DEMO سالم", "DEMO مقهى الواحة", "+218910000002"], ["DEMO منى", "DEMO مقصف مدرسة", "+218910000003"]])
      leads.push(await S.post("/crm/leads", { companyId: C, name: n, businessName: b, phone: ph, source: "campaign", campaignId: camp.id }));
    const opp = await S.post("/crm/opportunities", { companyId: C, title: "DEMO توريد أسبوعي للمقاصف", leadId: leads[2].id, expectedValue: "1800" });
    await S.post(`/crm/opportunities/${opp.id}/stage`, { stage: "negotiation" });
    await S.post("/crm/opportunities", { companyId: C, title: "DEMO طلبية رمضان", leadId: leads[1].id, expectedValue: "950" });
    await S.post("/crm/activities", { companyId: C, kind: "call", subject: "DEMO متابعة عرض السعر", customerId: customers[0].id, dueAt: new Date(Date.now() + 86400_000).toISOString() });
    await CS.post("/crm/tickets", { companyId: C, customerId: customers[1].id, kind: "complaint", priority: "normal", subject: "DEMO تأخر التوصيل" });
    const t2 = await CS.post("/crm/tickets", { companyId: C, customerId: customers[0].id, kind: "inquiry", priority: "low", subject: "DEMO استفسار عن الأسعار الجديدة" });
    await CS.post(`/crm/tickets/${t2.id}/status`, { status: "resolved", resolution: "DEMO أُرسلت قائمة الأسعار للعميل" });
  });

  await section("documents", async () => {
    const file = (name: string, text: string) => ({ fileName: name, mimeType: "text/plain", contentBase64: Buffer.from(text).toString("base64") });
    await GM.post("/documents", { companyId: C, title: "DEMO شهادة صحية للمصنع", category: "certificate", tags: ["DEMO", "جودة"], expiresOn: day(-20), file: file("demo-cert.txt", "DEMO — ليست وثيقة حقيقية") });
    await GM.post("/documents", { companyId: C, title: "DEMO عقد توريد زيت", category: "contract", tags: ["DEMO"], file: file("demo-contract.txt", "DEMO — ليست وثيقة حقيقية") });
  });

  await section("projects & tasks", async () => {
    const PM = as("projects");
    const p = await PM.post("/projects", { companyId: C, code: "DEMO-LINE3", nameAr: "DEMO تركيب خط إنتاج 3", startDate: day(30), endDate: day(-60), budget: "120000" });
    for (const [title, h] of [["DEMO تجهيز الأرضية والكهرباء", 40], ["DEMO توريد المقلاة", 16], ["DEMO التركيب والتشغيل التجريبي", 60], ["DEMO تدريب المشغلين", 12]] as const)
      await PM.post(`/projects/${p.id}/tasks`, { title, estimateHours: h, dueDate: day(-10) });
  });

  await section("HR: departments, employees, attendance, payroll (last month)", async () => {
    const H = as("hr"), F = as("finance");
    const adm = await H.post("/hr/departments", { companyId: C, code: "DEMO-ADM", nameAr: "DEMO الإدارة" });
    const prod = await H.post("/hr/departments", { companyId: C, code: "DEMO-PROD", nameAr: "DEMO الإنتاج", expenseRole: "direct_labour" });
    const sales = await H.post("/hr/departments", { companyId: C, code: "DEMO-SALES", nameAr: "DEMO المبيعات" });
    const sch = await H.post("/hr/schedules", { companyId: C, code: "DEMO-DAY", nameAr: "DEMO صباحي", start: "08:00", end: "16:00" });
    await H.post("/hr/leave-types", { companyId: C, code: "DEMO-ANNUAL", nameAr: "DEMO سنوية", paid: true, annualDays: "21" });
    await H.post("/payroll/components", { companyId: C, code: "DEMO-HOUSE", nameAr: "DEMO بدل سكن", kind: "earning", method: "fixed", defaultValue: "150" });
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const period = first.toISOString().slice(0, 7);
    const emps = [];
    for (const [code, name, dep, sal] of [["DEMO-E1", "DEMO موظف إداري", adm.id, "1400"], ["DEMO-E2", "DEMO مشغل خط", prod.id, "1100"], ["DEMO-E3", "DEMO عامل تعبئة", prod.id, "950"], ["DEMO-E4", "DEMO مندوب مبيعات", sales.id, "1200"]] as const)
      emps.push(await H.post("/hr/employees", { companyId: C, code, fullName: name, departmentId: dep, scheduleId: sch.id, hireDate: `${now.getUTCFullYear() - 1}-01-01`, basicSalary: sal }));
    // punches on every working day of last month (Tripoli is UTC+2: 08:00 → 06:00Z), one employee late twice
    if (period.slice(0, 4) === String(now.getUTCFullYear())) {
      for (let d = new Date(first); d.getUTCMonth() === first.getUTCMonth(); d.setUTCDate(d.getUTCDate() + 1)) {
        if (d.getUTCDay() === 5) continue;   // Friday
        const ds = d.toISOString().slice(0, 10);
        for (const [i, e] of emps.entries()) {
          const late = i === 2 && (d.getUTCDate() === 6 || d.getUTCDate() === 13);
          await H.post("/hr/punches", { employeeId: e.id, punchedAt: `${ds}T${late ? "06:40" : "05:55"}:00Z`, note: "DEMO" });
          await H.post("/hr/punches", { employeeId: e.id, punchedAt: `${ds}T14:05:00Z`, note: "DEMO" });
        }
      }
      const run = await H.post("/payroll/runs", { companyId: C, period });
      await F.post(`/payroll/runs/${run.id}/approve`);
    }
  });

  await section("BI alert rule", async () => {
    await GM.post("/bi/alert-rules", { companyId: C, nameAr: "DEMO مبيعات الشهر أقل من 500", area: "sales", metric: "net_sales", operator: "lt", threshold: "500", recipient: "demo@demo-foods.example" });
  });

  await app.close();
  console.log(`\nDEMO extras: ${done.length} sections done, ${failed.length} failed`);
  if (failed.length) { console.log(failed.map((f) => `  - ${f}`).join("\n")); process.exitCode = 1; }
  console.log(`DEMO users (password ${process.env.DEMO_USERS_PASSWORD || process.env.DEMO_OWNER_PASSWORD ? "from env" : pw}): ${USERS.map(([p, , r]) => `${p}@demo-foods.example (${r})`).join(", ")}`);
}

main().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
