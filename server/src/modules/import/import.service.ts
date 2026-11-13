// Excel import: customers, suppliers, items, opening stock, opening GL balances.
// * Columns are identified by the key in parentheses in the header ("رمز العميل (code)"),
//   so column order and Arabic wording can change freely.
// * preview = validate every row and report per-row errors; commit = same validation,
//   then write everything in ONE transaction (all or nothing).
// * Opening stock and opening balances are created as DRAFTS: a second person posts them (SoD).
import ExcelJS from "exceljs";
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { createStockDoc } from "../erp/inventory.service.js";
import { createDraft } from "../accounting/accounting.service.js";

export type Kind = "customers" | "suppliers" | "items" | "opening_stock" | "opening_balances" | "customer_balances" | "supplier_balances" | "employees";
type Col = { key: string; ar: string; en: string; required?: boolean; type?: "text" | "number" | "int" | "date" | "bool"; example?: string; hint?: string };

const PARTY: Col[] = [
  { key: "code", ar: "الرمز", en: "Code", required: true, example: "C001", hint: "حروف إنجليزية كبيرة وأرقام و - _" },
  { key: "name_ar", ar: "الاسم بالعربية", en: "Arabic name", required: true, example: "سوبرماركت النور" },
  { key: "name_en", ar: "الاسم بالإنجليزية", en: "English name" },
  { key: "phone", ar: "الهاتف", en: "Phone", example: "+218910000000" },
  { key: "city", ar: "المدينة", en: "City", example: "طرابلس" },
  { key: "tax_number", ar: "الرقم الضريبي", en: "Tax number" },
  { key: "payment_terms_days", ar: "مدة السداد بالأيام", en: "Payment terms (days)", type: "int", example: "30" },
];
const OPEN_ITEM: Col[] = [
  { key: "party_code", ar: "رمز العميل/المورد", en: "Customer/supplier code", required: true, example: "C001" },
  { key: "amount", ar: "المبلغ المستحق", en: "Amount outstanding", type: "number", required: true, example: "1250.500", hint: "رصيد مفتوح موجب لكل فاتورة قديمة غير مسددة (أو رصيد واحد للطرف)" },
  { key: "document_date", ar: "تاريخ الفاتورة الأصلية", en: "Original document date", type: "date", example: "2026-10-15" },
  { key: "due_date", ar: "تاريخ الاستحقاق", en: "Due date", type: "date", example: "2026-11-15" },
  { key: "reference", ar: "رقم الفاتورة في النظام القديم", en: "Reference in the old system", example: "INV-4512" },
];
export const TEMPLATES: Record<Kind, { titleAr: string; permission: string; cols: Col[] }> = {
  customers: { titleAr: "العملاء", permission: "sales.customers.manage", cols: [...PARTY, { key: "credit_limit", ar: "حد الائتمان", en: "Credit limit", type: "number", example: "2000", hint: "فارغ = بلا حد" }] },
  suppliers: { titleAr: "الموردون", permission: "purchasing.suppliers.manage", cols: PARTY },
  items: { titleAr: "الأصناف", permission: "inventory.items.manage", cols: [
    { key: "code", ar: "رمز الصنف", en: "Item code", required: true, example: "FG-CHIPS-40" },
    { key: "name_ar", ar: "الاسم بالعربية", en: "Arabic name", required: true, example: "رقائق بطاطس 40غ" },
    { key: "name_en", ar: "الاسم بالإنجليزية", en: "English name" },
    { key: "kind", ar: "النوع", en: "Kind", required: true, example: "منتج تام", hint: "مادة خام / تعبئة / نصف مصنع / منتج تام / خدمة" },
    { key: "base_uom", ar: "الوحدة الأساسية", en: "Base unit", required: true, example: "BAG", hint: "رمز الوحدة؛ تُنشأ تلقائيًا إن لم توجد" },
    { key: "alt_uom", ar: "وحدة بديلة", en: "Alternative unit", example: "CTN" },
    { key: "alt_factor", ar: "الوحدة البديلة = كم وحدة أساسية", en: "Alt. factor", type: "number", example: "24" },
    { key: "barcode", ar: "الباركود", en: "Barcode" },
    { key: "track_lots", ar: "تتبع التشغيلات", en: "Track lots", type: "bool", example: "نعم" },
    { key: "shelf_life_days", ar: "مدة الصلاحية بالأيام", en: "Shelf life (days)", type: "int", example: "180" },
    { key: "sales_price", ar: "سعر البيع للوحدة الأساسية", en: "Sales price", type: "number", example: "1.250" },
    { key: "reorder_level", ar: "حد إعادة الطلب", en: "Reorder level", type: "number" },
  ] },
  opening_stock: { titleAr: "أرصدة المخزون الافتتاحية", permission: "inventory.moves.create", cols: [
    { key: "warehouse_code", ar: "رمز المخزن", en: "Warehouse code", required: true, example: "MAIN" },
    { key: "item_code", ar: "رمز الصنف", en: "Item code", required: true, example: "FG-CHIPS-40" },
    { key: "qty", ar: "الكمية بالوحدة الأساسية", en: "Quantity (base unit)", required: true, type: "number", example: "480" },
    { key: "unit_cost", ar: "تكلفة الوحدة", en: "Unit cost", required: true, type: "number", example: "0.820" },
    { key: "lot_no", ar: "رقم التشغيلة", en: "Lot no.", hint: "إلزامي للأصناف المتتبعة" },
    { key: "production_date", ar: "تاريخ الإنتاج", en: "Production date", type: "date" },
    { key: "expiry_date", ar: "تاريخ الانتهاء", en: "Expiry date", type: "date" },
  ] },
  opening_balances: { titleAr: "الأرصدة الافتتاحية للحسابات", permission: "accounting.journal.create", cols: [
    { key: "account_code", ar: "رقم الحساب", en: "Account code", required: true, example: "1121" },
    { key: "debit", ar: "مدين", en: "Debit", type: "number", example: "50000" },
    { key: "credit", ar: "دائن", en: "Credit", type: "number" },
    { key: "description", ar: "البيان", en: "Description" },
  ] },
  // receivables / payables brought forward as open documents (not as a GL line), so ageing and statements agree with the GL
  customer_balances: { titleAr: "أرصدة العملاء الافتتاحية (ديون قائمة)", permission: "accounting.journal.create", cols: OPEN_ITEM },
  supplier_balances: { titleAr: "أرصدة الموردين الافتتاحية (مستحقات قائمة)", permission: "accounting.journal.create", cols: OPEN_ITEM },
  employees: { titleAr: "الموظفون", permission: "hr.employees.manage", cols: [
    { key: "code", ar: "رقم الموظف", en: "Employee code", required: true, example: "E001" },
    { key: "full_name", ar: "الاسم الكامل", en: "Full name", required: true, example: "محمد علي" },
    { key: "phone", ar: "الهاتف", en: "Phone" },
    { key: "national_id", ar: "الرقم الوطني", en: "National ID" },
    { key: "job_title", ar: "المسمى الوظيفي", en: "Job title", example: "مشغل خط" },
    { key: "department_code", ar: "رمز القسم", en: "Department code", example: "PROD", hint: "يُنشأ القسم تلقائيًا إن لم يوجد" },
    { key: "department_name", ar: "اسم القسم", en: "Department name", example: "الإنتاج" },
    { key: "hire_date", ar: "تاريخ التعيين", en: "Hire date", type: "date", required: true, example: "2024-03-01" },
    { key: "basic_salary", ar: "الراتب الأساسي", en: "Basic salary", type: "number", example: "1350", hint: "يتطلب صلاحية رؤية الرواتب" },
    { key: "device_pin", ar: "رقم البصمة في الجهاز", en: "Fingerprint device number", example: "17" },
  ] },
};

const KIND_ALIASES: Record<string, string> = {
  raw: "raw", "مادة خام": "raw", "خام": "raw", packaging: "packaging", "تعبئة": "packaging", "تغليف": "packaging", "مواد تعبئة": "packaging",
  semi_finished: "semi_finished", "نصف مصنع": "semi_finished", finished: "finished", "منتج تام": "finished", "تام": "finished", service: "service", "خدمة": "service",
};
const YES = new Set(["نعم", "yes", "y", "true", "1", "✔", "x"]);
const NO = new Set(["لا", "no", "n", "false", "0", ""]);

// ------------------------------------------------------------------ template
export async function buildTemplate(kind: Kind) {
  const t = TEMPLATES[kind];
  const wb = new ExcelJS.Workbook();
  wb.creator = "GOLDEN ERP";
  const ws = wb.addWorksheet(t.titleAr, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  ws.columns = t.cols.map((c) => ({ header: `${c.ar}${c.required ? " *" : ""} (${c.key})`, key: c.key, width: Math.max(16, c.ar.length + 10) }));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7B3F00" } };
  const help = wb.addWorksheet("تعليمات", { views: [{ rightToLeft: true }] });
  help.columns = [{ header: "العمود", width: 34 }, { header: "إلزامي", width: 10 }, { header: "مثال", width: 22 }, { header: "ملاحظة", width: 50 }];
  help.getRow(1).font = { bold: true };
  for (const c of t.cols) help.addRow([`${c.ar} (${c.key})`, c.required ? "نعم" : "", c.example ?? "", c.hint ?? ""]);
  help.addRow([]);
  help.addRow(["• املأ الورقة الأولى فقط، صفًا لكل سجل. لا تحذف الرمز الموجود بين القوسين في العناوين."]);
  help.addRow(["• يمكن تغيير ترتيب الأعمدة. الصفوف الفارغة تُتجاهل."]);
  help.addRow(["• ارفع الملف في «استيراد البيانات» واضغط «معاينة» أولًا: لن يُحفظ شيء حتى تصبح كل الصفوف سليمة."]);
  if (kind === "opening_stock" || kind === "opening_balances") help.addRow(["• يُنشأ مستند مسودة، ويرحّله مستخدم آخر بعد المراجعة (فصل المهام)."]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ------------------------------------------------------------------ parsing
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as any;
    if (o.result !== undefined) return cellText(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join("");
    if (o.text !== undefined) return cellText(o.text);
    return "";
  }
  return String(v).trim();
}

export async function parseWorkbook(kind: Kind, base64: string) {
  const buf = Buffer.from(base64, "base64");
  if (buf.length > 5 * 1024 * 1024) throw E.validation([{ path: "file", message: "file larger than 5 MB" }]);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw E.rule("INVALID_FILE", "الملف ليس ملف Excel صالحًا (xlsx)", "Not a valid .xlsx file"); }
  const ws = wb.worksheets[0];
  if (!ws) throw E.rule("INVALID_FILE", "الملف لا يحتوي أوراق عمل", "Workbook has no sheets");
  const cols = TEMPLATES[kind].cols;
  const keyAt = new Map<number, string>();
  ws.getRow(1).eachCell((cell, col) => {
    const m = /\(([a-z_]+)\)\s*$/.exec(cellText(cell.value));
    if (m && cols.some((c) => c.key === m[1])) keyAt.set(col, m[1]);
  });
  const missing = cols.filter((c) => c.required && ![...keyAt.values()].includes(c.key)).map((c) => `${c.ar} (${c.key})`);
  if (missing.length) throw E.rule("TEMPLATE_COLUMNS_MISSING", `أعمدة إلزامية مفقودة: ${missing.join("، ")} — استخدم القالب الرسمي`, `Required columns missing: ${missing.join(", ")}`, { missing });
  const rows: { row: number; data: Record<string, string> }[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const data: Record<string, string> = {};
    keyAt.forEach((key, col) => { data[key] = cellText(r.getCell(col).value); });
    if (Object.values(data).some((v) => v !== "")) rows.push({ row: n, data });
  });
  if (rows.length > 5000) throw E.rule("TOO_MANY_ROWS", "الحد الأقصى 5000 صف للملف الواحد", "Maximum 5000 rows per file");
  return rows;
}

// ------------------------------------------------------------------ validation + commit
type Issue = { row: number; field: string; message: string };

function typed(col: Col, raw: string, row: number, issues: Issue[]): string | null {
  if (raw === "") { if (col.required) issues.push({ row, field: col.key, message: `${col.ar}: مطلوب` }); return null; }
  switch (col.type) {
    case "number": { const s = raw.replace(/,/g, ""); if (!/^-?\d+(\.\d{1,6})?$/.test(s)) { issues.push({ row, field: col.key, message: `${col.ar}: رقم غير صالح «${raw}»` }); return null; } return s; }
    case "int": if (!/^\d+$/.test(raw)) { issues.push({ row, field: col.key, message: `${col.ar}: عدد صحيح مطلوب` }); return null; } return raw;
    case "date": if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) { issues.push({ row, field: col.key, message: `${col.ar}: التاريخ بصيغة YYYY-MM-DD` }); return null; } return raw;
    case "bool": { const v = raw.toLowerCase(); if (YES.has(v)) return "true"; if (NO.has(v)) return "false"; issues.push({ row, field: col.key, message: `${col.ar}: «نعم» أو «لا»` }); return null; }
    default: return raw;
  }
}

export async function runImport(db: Db, u: UserCtx, kind: Kind, companyId: string, rows: { row: number; data: Record<string, string> }[], commit: boolean, opts: { date?: string } = {}) {
  const t = TEMPLATES[kind];
  const issues: Issue[] = [];
  const clean = rows.map(({ row, data }) => {
    const out: Record<string, string | null> = {};
    for (const c of t.cols) out[c.key] = typed(c, data[c.key] ?? "", row, issues);
    return { row, v: out };
  });
  const dup = (key: string) => {
    const seen = new Map<string, number>();
    for (const r of clean) { const k = r.v[key]; if (!k) continue; if (seen.has(k)) issues.push({ row: r.row, field: key, message: `مكرر في الملف (الصف ${seen.get(k)})` }); else seen.set(k, r.row); }
  };
  const hasCol = (key: string) => rows.length > 0 && key in rows[0].data;
  let creates = 0, updates = 0;
  const plan: (() => Promise<void>)[] = [];

  if (kind === "customers" || kind === "suppliers") {
    dup("code");
    const pkind = kind === "customers" ? "customer" : "supplier";
    for (const r of clean) {
      if (r.v.code && !/^[A-Z0-9_-]{1,30}$/.test(r.v.code)) issues.push({ row: r.row, field: "code", message: "الرمز: حروف إنجليزية كبيرة وأرقام و - _ فقط" });
      const ex = r.v.code ? (await db.query("SELECT id, kind FROM parties WHERE company_id = $1 AND code = $2", [companyId, r.v.code])).rows[0] : null;
      if (ex && ex.kind !== pkind && ex.kind !== "both") issues.push({ row: r.row, field: "code", message: "الرمز مستخدم لطرف من نوع آخر" });
      ex ? updates++ : creates++;
      plan.push(async () => {
        await db.query(`INSERT INTO parties (tenant_id, company_id, kind, code, name_ar, name_en, phone, city, tax_number, payment_terms_days, credit_limit)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::int,0),$11)
          ON CONFLICT (company_id, code) DO UPDATE SET name_ar = EXCLUDED.name_ar, name_en = coalesce(EXCLUDED.name_en, parties.name_en), phone = coalesce(EXCLUDED.phone, parties.phone),
            city = coalesce(EXCLUDED.city, parties.city), tax_number = coalesce(EXCLUDED.tax_number, parties.tax_number),
            payment_terms_days = CASE WHEN $10::int IS NULL THEN parties.payment_terms_days ELSE EXCLUDED.payment_terms_days END,
            credit_limit = CASE WHEN $12 THEN EXCLUDED.credit_limit ELSE parties.credit_limit END`,
          // credit limit is only touched when the column is in the file (an empty cell there means "no limit")
          [u.tenantId, companyId, pkind, r.v.code, r.v.name_ar, r.v.name_en, r.v.phone, r.v.city, r.v.tax_number, r.v.payment_terms_days, r.v.credit_limit ?? null, kind === "customers" && hasCol("credit_limit")]);
      });
    }
  }

  if (kind === "items") {
    dup("code");
    const uomIds = new Map<string, string>((await db.query("SELECT code, id FROM uoms")).rows.map((x) => [x.code, x.id]));
    const ensureUom = async (code: string) => {
      if (!uomIds.has(code)) uomIds.set(code, (await db.query("INSERT INTO uoms (tenant_id, code, name_ar) VALUES ($1,$2,$2) ON CONFLICT (tenant_id, code) DO UPDATE SET code = EXCLUDED.code RETURNING id", [u.tenantId, code])).rows[0].id);
      return uomIds.get(code)!;
    };
    for (const r of clean) {
      const k = r.v.kind ? KIND_ALIASES[r.v.kind.toLowerCase()] ?? KIND_ALIASES[r.v.kind] : null;
      if (r.v.kind && !k) issues.push({ row: r.row, field: "kind", message: `النوع غير معروف «${r.v.kind}»` });
      if (r.v.code && !/^[A-Z0-9_.-]{1,30}$/.test(r.v.code)) issues.push({ row: r.row, field: "code", message: "الرمز: حروف إنجليزية كبيرة وأرقام و . - _ فقط" });
      for (const f of ["base_uom", "alt_uom"]) if (r.v[f] && !/^[A-Z0-9_]{1,12}$/.test(r.v[f]!.toUpperCase())) issues.push({ row: r.row, field: f, message: "رمز الوحدة: حروف إنجليزية وأرقام" });
      if ((r.v.alt_uom && !r.v.alt_factor) || (!r.v.alt_uom && r.v.alt_factor)) issues.push({ row: r.row, field: "alt_factor", message: "الوحدة البديلة ومعاملها يُكتبان معًا" });
      const ex = r.v.code ? (await db.query("SELECT id FROM items WHERE company_id = $1 AND code = $2", [companyId, r.v.code])).rows[0] : null;
      ex ? updates++ : creates++;
      plan.push(async () => {
        const base = await ensureUom(r.v.base_uom!.toUpperCase());
        // existing items: only descriptive / commercial fields change (never kind, unit or lot tracking under existing stock)
        const it = (await db.query(`INSERT INTO items (tenant_id, company_id, code, name_ar, name_en, kind, base_uom_id, barcode, track_lots, shelf_life_days, sales_price, reorder_level)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::boolean,false),$10,$11,$12)
          ON CONFLICT (company_id, code) DO UPDATE SET name_ar = EXCLUDED.name_ar, name_en = coalesce(EXCLUDED.name_en, items.name_en), barcode = coalesce(EXCLUDED.barcode, items.barcode),
            sales_price = coalesce(EXCLUDED.sales_price, items.sales_price), reorder_level = coalesce(EXCLUDED.reorder_level, items.reorder_level),
            shelf_life_days = coalesce(EXCLUDED.shelf_life_days, items.shelf_life_days) RETURNING id, base_uom_id`,
          [u.tenantId, companyId, r.v.code, r.v.name_ar, r.v.name_en, k, base, r.v.barcode, r.v.track_lots, r.v.shelf_life_days, r.v.sales_price, r.v.reorder_level])).rows[0];
        if (r.v.alt_uom) {
          const alt = await ensureUom(r.v.alt_uom.toUpperCase());
          if (alt !== it.base_uom_id) await db.query("INSERT INTO item_uoms (tenant_id, item_id, uom_id, factor) VALUES ($1,$2,$3,$4) ON CONFLICT (item_id, uom_id) DO UPDATE SET factor = EXCLUDED.factor", [u.tenantId, it.id, alt, r.v.alt_factor]);
        }
      });
    }
  }

  if (kind === "opening_stock") {
    const whs = new Map<string, any>((await db.query("SELECT w.id, w.code, b.company_id FROM warehouses w JOIN branches b ON b.id = w.branch_id")).rows.filter((w) => w.company_id === companyId).map((w) => [w.code, w]));
    const items = new Map<string, any>((await db.query("SELECT id, code, kind, track_lots, shelf_life_days FROM items WHERE company_id = $1", [companyId])).rows.map((i) => [i.code, i]));
    const byWh = new Map<string, any[]>();
    for (const r of clean) {
      const w = r.v.warehouse_code ? whs.get(r.v.warehouse_code) : null;
      const it = r.v.item_code ? items.get(r.v.item_code) : null;
      if (r.v.warehouse_code && !w) issues.push({ row: r.row, field: "warehouse_code", message: `مخزن غير موجود «${r.v.warehouse_code}»` });
      if (r.v.item_code && !it) issues.push({ row: r.row, field: "item_code", message: `صنف غير موجود «${r.v.item_code}» — استورد الأصناف أولًا` });
      if (it?.kind === "service") issues.push({ row: r.row, field: "item_code", message: "الخدمات لا رصيد لها" });
      if (it?.track_lots && !r.v.lot_no) issues.push({ row: r.row, field: "lot_no", message: "رقم التشغيلة إلزامي لهذا الصنف" });
      if (r.v.qty && Number(r.v.qty) <= 0) issues.push({ row: r.row, field: "qty", message: "الكمية يجب أن تكون موجبة" });
      if (r.v.unit_cost && Number(r.v.unit_cost) < 0) issues.push({ row: r.row, field: "unit_cost", message: "التكلفة لا تكون سالبة" });
      if (w && it) {
        if (!byWh.has(w.id)) byWh.set(w.id, []);
        byWh.get(w.id)!.push({ itemId: it.id, qtyDelta: r.v.qty, unitCost: r.v.unit_cost, lotNo: r.v.lot_no ?? undefined, productionDate: r.v.production_date ?? undefined, expiryDate: r.v.expiry_date ?? undefined });
      }
    }
    creates = byWh.size;
    for (const [warehouseId, lines] of byWh)
      plan.push(async () => { await createStockDoc(db, u, { companyId, reason: "opening", warehouseId, docDate: opts.date ?? new Date().toISOString().slice(0, 10), notes: "استيراد Excel — رصيد افتتاحي", lines }); });
  }

  if (kind === "opening_balances") {
    const accs = new Map<string, any>((await db.query("SELECT id, code, role, is_postable, is_active FROM accounts WHERE company_id = $1", [companyId])).rows.map((a) => [a.code, a]));
    const lines: any[] = [];
    let dr = 0, cr = 0;
    for (const r of clean) {
      const a = r.v.account_code ? accs.get(r.v.account_code) : null;
      if (r.v.account_code && !a) issues.push({ row: r.row, field: "account_code", message: `حساب غير موجود «${r.v.account_code}»` });
      if (a && (!a.is_postable || !a.is_active)) issues.push({ row: r.row, field: "account_code", message: "حساب تجميعي أو موقوف — استخدم حسابًا تفصيليًا" });
      if (a && ["ar", "ap"].includes(a.role)) issues.push({ row: r.row, field: "account_code", message: "حساب ذمم: استخدم قالب «أرصدة العملاء/الموردين الافتتاحية» حتى تظهر الديون في كشوف الحسابات وأعمار الديون" });
      const d = Number(r.v.debit ?? 0), c = Number(r.v.credit ?? 0);
      if ((d > 0) === (c > 0)) issues.push({ row: r.row, field: "debit", message: "اكتب مدينًا أو دائنًا (واحدًا فقط)" });
      dr += d; cr += c;
      if (a) lines.push({ accountId: a.id, ...(d > 0 ? { debit: r.v.debit } : { credit: r.v.credit }), description: r.v.description ?? undefined });
    }
    if (Math.round(dr * 10000) !== Math.round(cr * 10000)) issues.push({ row: 0, field: "total", message: `غير متوازن: مدين ${dr.toFixed(3)} ≠ دائن ${cr.toFixed(3)}. أضف الفرق على حساب «أرصدة افتتاحية» (304)` });
    creates = 1;
    plan.push(async () => { await createDraft(db, u, { companyId, entryDate: opts.date ?? new Date().toISOString().slice(0, 10), memo: "استيراد Excel — أرصدة افتتاحية", reference: "IMPORT", lines }); });
  }

  if (kind === "customer_balances" || kind === "supplier_balances") {
    const isCust = kind === "customer_balances";
    const parties = new Map<string, any>((await db.query(`SELECT id, code, payment_terms_days FROM parties WHERE company_id = $1 AND kind IN ($2::party_kind, 'both')`,
      [companyId, isCust ? "customer" : "supplier"])).rows.map((x) => [x.code, x]));
    const cur = (await db.query("SELECT base_currency FROM companies WHERE id = $1", [companyId])).rows[0].base_currency;
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    for (const r of clean) {
      const p = r.v.party_code ? parties.get(r.v.party_code) : null;
      if (r.v.party_code && !p) issues.push({ row: r.row, field: "party_code", message: `${isCust ? "عميل" : "مورد"} غير موجود «${r.v.party_code}» — استورد ${isCust ? "العملاء" : "الموردين"} أولًا` });
      if (r.v.amount !== null && Number(r.v.amount) <= 0) issues.push({ row: r.row, field: "amount", message: "المبلغ يجب أن يكون موجبًا (رصيد دائن للعميل يُسجل كسند قبض)" });
      if (r.v.document_date && r.v.document_date > date) issues.push({ row: r.row, field: "document_date", message: "بعد تاريخ الافتتاح" });
      if (!p || r.v.amount === null) continue;
      creates++;
      const v = r.v, docDate = v.document_date ?? date;
      plan.push(async () => {
        if (isCust) await db.query(
          `INSERT INTO sales_invoices (tenant_id, company_id, customer_id, invoice_date, due_date, payment_type, currency, subtotal, total, is_opening, opening_reference, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,'credit',$6,$7,$7,true,$8,'رصيد افتتاحي — استيراد',$9)`,
          [u.tenantId, companyId, p.id, docDate, v.due_date ?? docDate, cur, v.amount, v.reference ?? null, u.userId]);
        else await db.query(
          `INSERT INTO supplier_invoices (tenant_id, company_id, supplier_id, supplier_invoice_no, invoice_date, due_date, total, is_opening, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
          [u.tenantId, companyId, p.id, v.reference ?? `OPENING-${r.row}`, docDate, v.due_date ?? docDate, v.amount, u.userId]);
      });
    }
  }

  if (kind === "employees") {
    dup("code"); dup("device_pin");
    if (clean.some((r) => r.v.basic_salary !== null) && !u.permissions.has("hr.salaries.view"))
      issues.push({ row: 0, field: "basic_salary", message: "عمود الراتب يتطلب صلاحية رؤية الرواتب — احذف العمود أو استورد بمستخدم مخوّل" });
    const existing = new Map<string, any>((await db.query("SELECT id, code FROM employees WHERE company_id = $1", [companyId])).rows.map((x) => [x.code, x]));
    const depts = new Map<string, string>((await db.query("SELECT id, code FROM departments WHERE company_id = $1", [companyId])).rows.map((x) => [x.code, x.id]));
    for (const r of clean) {
      if (r.v.code && !/^[A-Z0-9_-]{1,20}$/.test(r.v.code)) issues.push({ row: r.row, field: "code", message: "رقم الموظف: حروف إنجليزية كبيرة وأرقام فقط" });
      if (r.v.department_code && !/^[A-Z0-9_-]{1,20}$/.test(r.v.department_code)) issues.push({ row: r.row, field: "department_code", message: "رمز القسم: حروف إنجليزية كبيرة وأرقام فقط" });
      if (!r.v.code) continue;
      if (existing.has(r.v.code)) updates++; else creates++;
      const v = r.v;
      plan.push(async () => {
        let dep: string | null = null;
        if (v.department_code) {
          dep = depts.get(v.department_code) ?? null;
          if (!dep) {
            dep = (await db.query("INSERT INTO departments (tenant_id, company_id, code, name_ar) VALUES ($1,$2,$3,$4) RETURNING id", [u.tenantId, companyId, v.department_code, v.department_name ?? v.department_code])).rows[0].id as string;
            depts.set(v.department_code, dep);
          }
        }
        // re-import updates only the columns present in the file (an absent salary column never wipes salaries)
        await db.query(
          `INSERT INTO employees (tenant_id, company_id, code, full_name, phone, national_id, job_title, department_id, hire_date, basic_salary, device_pin)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::numeric, 0),$11)
           ON CONFLICT (company_id, code) DO UPDATE SET full_name = EXCLUDED.full_name,
             phone = CASE WHEN $12 THEN EXCLUDED.phone ELSE employees.phone END, national_id = CASE WHEN $13 THEN EXCLUDED.national_id ELSE employees.national_id END,
             job_title = CASE WHEN $14 THEN EXCLUDED.job_title ELSE employees.job_title END, department_id = coalesce(EXCLUDED.department_id, employees.department_id),
             hire_date = EXCLUDED.hire_date, basic_salary = CASE WHEN $15 THEN EXCLUDED.basic_salary ELSE employees.basic_salary END,
             device_pin = CASE WHEN $16 THEN EXCLUDED.device_pin ELSE employees.device_pin END`,
          [u.tenantId, companyId, v.code, v.full_name, v.phone, v.national_id, v.job_title, dep, v.hire_date, v.basic_salary, v.device_pin,
            hasCol("phone"), hasCol("national_id"), hasCol("job_title"), hasCol("basic_salary"), hasCol("device_pin")]);
      });
    }
  }

  const summary = { kind, rows: rows.length, creates, updates, issues: issues.sort((a, b) => a.row - b.row).slice(0, 500), issueCount: issues.length, committed: false };
  if (!commit || issues.length) return summary;
  for (const step of plan) await step();
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: `import.${kind}`, entityType: "import", entityId: companyId, after: { rows: rows.length, creates, updates } });
  return { ...summary, committed: true };
}
