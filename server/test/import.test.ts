import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";
import { getApp } from "./helpers.js";

const Y = new Date().getUTCFullYear();
async function xlsx(headers: string[], rows: (string | number | Date | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("data");
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

describe("Excel import", () => {
  let T: any, P: any, RO: any;
  const imp = (kind: string, file: string, commit: boolean, who = T, extra: any = {}) => api("POST", `/api/v1/import/${kind}`, { companyId: T.companyId, fileBase64: file, commit, ...extra }, { token: who.token });

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "sales", "purchasing", "inventory"] });
    T = await provision(p, plan.code);
    await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, { token: T.token });
    await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, { token: T.token });
    P = await createUser(T, [{ roleId: await roleId(T.token, "finance_manager") }, { roleId: await roleId(T.token, "warehouse_manager") }]);
    RO = await createUser(T, [{ roleId: await roleId(T.token, "read_only") }]);
    const branch = (await api("GET", "/api/v1/branches", undefined, { token: T.token })).body[0].id;
    await api("POST", "/api/v1/warehouses", { branchId: branch, code: "MAIN", nameAr: "الرئيسي", kind: "finished_goods" }, { token: T.token });
  });

  it("downloads a real .xlsx template with keyed Arabic headers and an instructions sheet", async () => {
    const app = await getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/import/templates/customers", headers: { authorization: `Bearer ${T.token}` } });
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["العملاء", "تعليمات"]);
    expect(String(wb.worksheets[0].getCell("A1").value)).toBe("الرمز * (code)");
  });

  it("preview reports every bad row; nothing is written until the file is clean", async () => {
    const bad = await xlsx(["الرمز (code)", "الاسم بالعربية (name_ar)", "حد الائتمان (credit_limit)"], [
      ["C001", "محل 1", "500"], ["c 2", "محل 2", ""], ["C001", "مكرر", ""], ["C004", "", "abc"],
    ]);
    const r = (await imp("customers", bad, true)).body;
    expect(r.committed).toBe(false);
    expect(r.issues.map((i: any) => `${i.row}:${i.field}`)).toEqual(["3:code", "4:code", "5:name_ar", "5:credit_limit"]);
    expect((await api("GET", `/api/v1/customers?companyId=${T.companyId}`, undefined, { token: T.token })).body.total).toBe(0);
  });

  it("imports customers (any column order), then re-import updates instead of duplicating", async () => {
    const good = await xlsx(["الهاتف (phone)", "الرمز (code)", "الاسم بالعربية (name_ar)", "حد الائتمان (credit_limit)", "مدة السداد بالأيام (payment_terms_days)"], [
      ["+218910000001", "C001", "محل 1", "500", "30"], ["", "C002", "محل 2", "", ""]]);
    const pre = (await imp("customers", good, false)).body;
    expect([pre.creates, pre.updates, pre.issueCount, pre.committed]).toEqual([2, 0, 0, false]);
    const done = (await imp("customers", good, true)).body;
    expect(done.committed).toBe(true);
    const again = (await imp("customers", await xlsx(["الرمز (code)", "الاسم بالعربية (name_ar)"], [["C001", "محل 1 — اسم جديد"]]), true)).body;
    expect([again.creates, again.updates]).toEqual([0, 1]);
    const list = (await api("GET", `/api/v1/customers?companyId=${T.companyId}`, undefined, { token: T.token })).body.data;
    const c1 = list.find((c: any) => c.code === "C001");
    expect([list.length, c1.name_ar, c1.credit_limit, c1.phone]).toEqual([2, "محل 1 — اسم جديد", "500.000", "+218910000001"]); // untouched fields kept
  });

  it("items: Arabic kinds, units auto-created, alternative unit factor", async () => {
    const f = await xlsx(["رمز الصنف (code)", "الاسم بالعربية (name_ar)", "النوع (kind)", "الوحدة الأساسية (base_uom)", "وحدة بديلة (alt_uom)", "الوحدة البديلة = كم وحدة أساسية (alt_factor)",
      "تتبع التشغيلات (track_lots)", "مدة الصلاحية بالأيام (shelf_life_days)", "سعر البيع للوحدة الأساسية (sales_price)"], [
      ["FG-1", "رقائق", "منتج تام", "bag", "CTN", "24", "نعم", "180", "1.250"], ["RM-1", "دقيق", "مادة خام", "KG", "", "", "لا", "", ""], ["X-1", "؟", "شيء", "KG", "", "", "", "", ""]]);
    const pre = (await imp("items", f, true)).body;
    expect(pre.issues).toEqual([{ row: 4, field: "kind", message: "النوع غير معروف «شيء»" }]);
    const ok = (await imp("items", await xlsx(["رمز الصنف (code)", "الاسم بالعربية (name_ar)", "النوع (kind)", "الوحدة الأساسية (base_uom)", "وحدة بديلة (alt_uom)",
      "الوحدة البديلة = كم وحدة أساسية (alt_factor)", "تتبع التشغيلات (track_lots)", "مدة الصلاحية بالأيام (shelf_life_days)", "سعر البيع للوحدة الأساسية (sales_price)"], [
      ["FG-1", "رقائق", "منتج تام", "bag", "CTN", "24", "نعم", "180", "1.250"], ["RM-1", "دقيق", "مادة خام", "KG", "", "", "لا", "", ""]]), true)).body;
    expect(ok.committed).toBe(true);
    const items = (await api("GET", `/api/v1/items?companyId=${T.companyId}`, undefined, { token: T.token })).body.data;
    const fg = items.find((i: any) => i.code === "FG-1");
    expect([fg.kind, fg.base_uom_code, fg.track_lots, fg.units[0].code, Number(fg.units[0].factor)]).toEqual(["finished", "BAG", true, "CTN", 24]);
  });

  it("opening stock → draft document; a second user posts it (lot required for tracked items)", async () => {
    const H = ["رمز المخزن (warehouse_code)", "رمز الصنف (item_code)", "الكمية بالوحدة الأساسية (qty)", "تكلفة الوحدة (unit_cost)", "رقم التشغيلة (lot_no)", "تاريخ الإنتاج (production_date)"];
    const bad = (await imp("opening_stock", await xlsx(H, [["MAIN", "FG-1", "100", "0.8", "", ""], ["NOPE", "ZZZ", "1", "1", "", ""]]), true)).body;
    expect(bad.issues.map((i: any) => i.field)).toEqual(["lot_no", "warehouse_code", "item_code"]);
    const ok = (await imp("opening_stock", await xlsx(H, [["MAIN", "FG-1", "100", "0.8", "L-1", new Date().toISOString().slice(0, 10)], ["MAIN", "RM-1", "50", "1.2", "", ""]]), true, T, { date: `${Y}-01-01` })).body;
    expect(ok.committed).toBe(true);
    const docs = (await api("GET", `/api/v1/inventory/documents?companyId=${T.companyId}&status=draft`, undefined, { token: T.token })).body.data;
    expect(docs).toHaveLength(1);
    const posted = await api("POST", `/api/v1/inventory/documents/${docs[0].id}/post`, {}, { token: P.token });
    expect(posted.status).toBe(200);
    expect((await api("GET", `/api/v1/inventory/valuation-check?companyId=${T.companyId}`, undefined, { token: T.token })).body.stockValue).toBe("140.0000");
  });

  it("opening GL balances must balance; then a draft journal posted by someone else", async () => {
    const H = ["رقم الحساب (account_code)", "مدين (debit)", "دائن (credit)", "البيان (description)"];
    const un = (await imp("opening_balances", await xlsx(H, [["1121", "1000", "", "مصرف"], ["301", "", "900", "رأس المال"]]), true)).body;
    expect(un.issues[0].message).toMatch(/غير متوازن/);
    const hdr = (await imp("opening_balances", await xlsx(H, [["1", "10", "", ""], ["301", "", "10", ""]]), true)).body;
    expect(hdr.issues[0].message).toMatch(/تجميعي/);
    const ok = (await imp("opening_balances", await xlsx(H, [["1121", "1000", "", "مصرف"], ["301", "", "1000", "رأس المال"]]), true, T, { date: `${Y}-01-01` })).body;
    expect(ok.committed).toBe(true);
    const je = (await api("GET", `/api/v1/accounting/journal-entries?companyId=${T.companyId}&status=draft`, undefined, { token: T.token })).body.data.find((e: any) => e.reference === "IMPORT");
    expect((await api("POST", `/api/v1/accounting/journal-entries/${je.id}/post`, {}, { token: T.token })).body.error.code).toBe("SEGREGATION_OF_DUTIES");
    expect((await api("POST", `/api/v1/accounting/journal-entries/${je.id}/post`, {}, { token: P.token })).status).toBe(200);
  });

  it("guards: permissions, missing template columns, non-Excel files", async () => {
    const f = await xlsx(["الرمز (code)", "الاسم بالعربية (name_ar)"], [["C9", "x y"]]);
    expect((await imp("customers", f, true, RO)).status).toBe(403);
    expect((await imp("customers", await xlsx(["اسم فقط"], [["x"]]), false)).body.error.code).toBe("TEMPLATE_COLUMNS_MISSING");
    expect((await imp("customers", Buffer.from("not an excel file at all").toString("base64"), false)).body.error.code).toBe("INVALID_FILE");
  });
});
