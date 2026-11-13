// Converts the JSON export of the old Firebase systems (tools/old-system-export)
// into GOLDEN ERP's official Excel import files + a mapping file + an Arabic
// report. Nothing is written to the database: the files go through the normal
// import screen (preview, all-or-nothing, opening balances posted by another
// user), so a person reviews everything before it becomes real data.
//
//   npx tsx scripts/old-system/convert.ts --in ../tools/old-system-export/export --out ./migration-out
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { TEMPLATES, type Kind } from "../../src/modules/import/import.service.js";

type Doc = Record<string, any> & { id: string };
export interface OldExport { van: Record<string, Doc[]>; hr: Record<string, Doc[]> }
export interface Converted { files: Partial<Record<Kind, Record<string, string | number | null>[]>>; mapping: Record<string, Record<string, string>>; report: string[]; warnings: string[] }

const date = (v: unknown) => {
  if (!v) return null;
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  if (typeof v === "object" && v !== null && "_seconds" in v) return new Date((v as any)._seconds * 1000).toISOString().slice(0, 10);
  return null;
};
const money = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);
const UNIT: Record<string, string> = { "كيس": "BAG", "كرتونة": "CTN", "كرتون": "CTN", "كيلو": "KG", "كغ": "KG", "علبة": "BOX", "قطعة": "PCS" };
const pad = (n: number, w: number) => String(n).padStart(w, "0");
const byCreated = (a: Doc, b: Doc) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.id.localeCompare(b.id);

export function convert(x: OldExport): Converted {
  const out: Converted = { files: {}, mapping: { customers: {}, products: {}, employees: {}, departments: {} }, report: [], warnings: [] };
  const v = x.van ?? {}, h = x.hr ?? {};

  // ---------------- customers (code assigned in order of registration: C0001…)
  const customers = [...(v.customers ?? [])].sort(byCreated);
  out.files.customers = customers.map((c, i) => {
    const code = `C${pad(i + 1, 4)}`;
    out.mapping.customers[c.id] = code;
    if (!c.phone) out.warnings.push(`عميل بدون هاتف: ${c.name} (${code})`);
    return { code, name_ar: String(c.name ?? "").trim() || code, phone: c.phone ?? null, city: null, payment_terms_days: null,
      // a blacklisted shop gets a zero credit limit, so it can only buy cash
      credit_limit: c.status === "blacklisted" ? 0 : money(c.creditLimit) };
  });
  const phones = new Map<string, string[]>();
  for (const c of customers) if (c.phone) phones.set(c.phone, [...(phones.get(c.phone) ?? []), c.name]);
  for (const [p, names] of phones) if (names.length > 1) out.warnings.push(`هاتف مكرر ${p}: ${names.join("، ")} — راجع إن كانت نفس المحل`);
  const blacklisted = customers.filter((c) => c.status === "blacklisted").length;
  const special = customers.reduce((s, c) => s + Object.keys(c.specialPrices ?? {}).length, 0);
  out.report.push(`العملاء: ${customers.length}${blacklisted ? ` (منهم ${blacklisted} محظور → حد ائتمان صفر)` : ""}`);
  if (special) out.warnings.push(`${special} سعر خاص لعملاء لم يُنقل تلقائيًا — يُدخل من بطاقة العميل`);

  // ---------------- products → finished items (P0001…), unit mapped to a unit code
  const products = [...(v.products ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name), "ar") || a.id.localeCompare(b.id));
  out.files.items = products.map((p, i) => {
    const code = `P${pad(i + 1, 4)}`;
    out.mapping.products[p.id] = code;
    const unit = UNIT[String(p.unit ?? "").trim()] ?? "UNIT";
    if (unit === "UNIT") out.warnings.push(`وحدة غير معروفة «${p.unit ?? ""}» للصنف ${p.name} — عُيّنت UNIT، صحّحها قبل الاستيراد`);
    if (money(p.price) === null) out.warnings.push(`صنف بدون سعر: ${p.name}`);
    return { code, name_ar: p.name, name_en: null, kind: "منتج تام", base_uom: unit, alt_uom: null, alt_factor: null, barcode: p.barcode ?? null,
      track_lots: "نعم", shelf_life_days: null, sales_price: money(p.price), reorder_level: null, is_active: p.active === false ? "لا" : "نعم" };
  });
  out.report.push(`الأصناف: ${products.length} (منتجات تامة؛ مدة الصلاحية تُستكمل يدويًا)`);

  // ---------------- open credit invoices → opening customer balances (one row per unpaid invoice)
  const vehicles = new Map((v.vehicles ?? []).map((x) => [x.id, x]));
  const open = (v.invoices ?? []).filter((inv) => (money(inv.total) ?? 0) - (money(inv.amountPaid) ?? 0) > 0.0005 && inv.paymentMethod === "credit");
  let openTotal = 0;
  out.files.customer_balances = open.sort(byCreated).flatMap((inv) => {
    const code = out.mapping.customers[inv.customerId];
    const amount = Math.round(((money(inv.total) ?? 0) - (money(inv.amountPaid) ?? 0)) * 1000) / 1000;
    if (!code) { out.warnings.push(`فاتورة ${inv.id} لعميل غير موجود (${inv.customerId}) — مبلغ ${amount} لم يُنقل`); return []; }
    openTotal += amount;
    const veh = vehicles.get(inv.vehicleId);
    return [{ party_code: code, amount, document_date: date(inv.createdAt), due_date: date(inv.dueDate) ?? date(inv.createdAt), reference: `${veh?.plateNumber ?? veh?.name ?? "V"}-${inv.sequenceNumber ?? inv.id.slice(0, 6)}` }];
  });
  out.report.push(`ديون العملاء المفتوحة: ${open.length} فاتورة بإجمالي ${openTotal.toFixed(3)} — يجب أن يطابق تقرير الذمم في النظام القديم قبل الترحيل`);

  // ---------------- HR: departments + employees (+ salaries from employeePrivate)
  const depts = [...(h.departments ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name), "ar"));
  depts.forEach((d, i) => { out.mapping.departments[d.id] = `D${pad(i + 1, 2)}`; });
  const priv = new Map((h.employeePrivate ?? []).map((p) => [p.id, p]));
  const usedCodes = new Set<string>();
  const employees = (h.employees ?? []).filter((e) => e.active !== false && !(e.endDate && e.endDate < new Date().toISOString().slice(0, 10)));
  out.files.employees = employees.sort((a, b) => String(a.code).localeCompare(String(b.code))).map((e, i) => {
    let code = String(e.code ?? "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (!code || usedCodes.has(code)) { code = `E${pad(i + 1, 4)}`; out.warnings.push(`رقم موظف غير صالح أو مكرر «${e.code}» لـ ${e.name} → ${code}`); }
    usedCodes.add(code);
    out.mapping.employees[e.id] = code;
    if (!e.hireDate) out.warnings.push(`موظف بدون تاريخ تعيين: ${e.name} (${code}) — أكمله قبل الاستيراد`);
    const d = depts.find((x) => x.id === e.departmentId);
    return { code, full_name: e.name, phone: e.phone ?? null, national_id: null, job_title: e.jobTitle ?? null, department_code: d ? out.mapping.departments[d.id] : null,
      department_name: d?.name ?? null, hire_date: e.hireDate ?? null, basic_salary: money(priv.get(e.id)?.salary), device_pin: e.biometricId ?? null };
  });
  const skipped = (h.employees ?? []).length - employees.length;
  out.report.push(`الموظفون النشطون: ${employees.length}${skipped ? ` (استُبعد ${skipped} غير نشط/منتهية خدمته)` : ""}؛ الأقسام: ${depts.length}`);
  const multiSite = employees.filter((e) => (e.extraSiteIds ?? []).length).length;
  if (multiSite) out.warnings.push(`${multiSite} موظف يعمل في أكثر من موقع — المواقع المتعددة غير مدعومة بعد (K30)`);
  if ((h.schedules ?? []).length) out.warnings.push(`${h.schedules.length} دوام في «حضوري» — تُنشأ الدوامات يدويًا في GOLDEN ERP (الدوام الدوري/المفتوح غير مدعوم بعد، K30)`);

  // ---------------- what is NOT migrated (by design)
  const reps = v.reps ?? [];
  if (reps.length) out.report.push(`المناديب: ${reps.length} — يُنشأ لكل مندوب مستخدم وسيارة-مخزن يدويًا (لأسباب أمنية لا تُنقل أرقام الدخول PIN): ${reps.map((r) => r.name).join("، ")}`);
  if ((v.vehicles ?? []).length) out.report.push(`السيارات: ${v.vehicles.length} — تُسجل كمخازن للمناديب وكأصول ثابتة يدويًا`);
  out.report.push("لا تُنقل الفواتير المسددة ولا تاريخ الحركات: النظام القديم يبقى للرجوع إليه (قراءة فقط) بعد التحويل");
  return out;
}

export async function writeXlsx(kind: Kind, rows: Record<string, unknown>[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(TEMPLATES[kind].titleAr, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  const cols = TEMPLATES[kind].cols;
  ws.addRow(cols.map((c) => `${c.ar}${c.required ? " *" : ""} (${c.key})`)).font = { bold: true };
  for (const r of rows) ws.addRow(cols.map((c) => (r[c.key] ?? null) as any));
  ws.columns.forEach((c) => { c.width = 22; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function load(dir: string): OldExport {
  const read = (app: string) => {
    const d = path.join(dir, app);
    const out: Record<string, Doc[]> = {};
    if (!existsSync(d)) return out;
    for (const c of ["customers", "products", "reps", "vehicles", "invoices", "payments", "returns", "employees", "employeePrivate", "departments", "schedules"]) {
      const f = path.join(d, `${c}.json`);
      if (existsSync(f)) out[c] = JSON.parse(readFileSync(f, "utf8"));
    }
    return out;
  };
  return { van: read("van"), hr: read("hr") };
}

if (process.argv[1]?.endsWith("convert.ts")) {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const inDir = arg("in"), outDir = arg("out") ?? "./migration-out";
  if (!inDir) { console.error("usage: tsx scripts/old-system/convert.ts --in <export dir> [--out ./migration-out]"); process.exit(1); }
  const r = convert(load(inDir));
  mkdirSync(outDir, { recursive: true });
  const order: Kind[] = ["customers", "items", "employees", "customer_balances"];
  for (const [i, k] of order.entries()) {
    const rows = r.files[k];
    if (rows?.length) writeFileSync(path.join(outDir, `${i + 1}-${k}.xlsx`), await writeXlsx(k, rows));
  }
  writeFileSync(path.join(outDir, "mapping.json"), JSON.stringify(r.mapping, null, 1));
  const md = ["# تقرير تحويل بيانات النظام القديم", "", ...r.report.map((x) => `* ${x}`), "", "## تنبيهات تحتاج مراجعة", "", ...(r.warnings.length ? r.warnings.map((x) => `* ${x}`) : ["* لا توجد"]), "",
    "## ترتيب الاستيراد", "", "1. العملاء  2. الأصناف  3. الموظفون  4. ديون العملاء (مسودات) ← ترحيلها من «جاهزية التشغيل» بمستخدم آخر بتاريخ التحويل", ""];
  writeFileSync(path.join(outDir, "REPORT.md"), md.join("\n"));
  console.log(md.join("\n"));
}
