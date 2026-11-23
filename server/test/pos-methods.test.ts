import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear() - 1;
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("POS payment methods (cards, wallets) per cashier", () => {
  let T: any, P: any, C: any, S: any, acc: Record<string, string>, chips: any, R: any, shiftC: any, shiftS: any, card: any, wallet: any;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const gl = async (code: string) => (await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body.rows.find((r: any) => r.code === code)?.closing ?? "0";

  beforeAll(async () => {
    const p = await platformToken();
    T = await provision(p, (await createPlan(p, { modules: ["accounting", "sales", "inventory", "pos"] })).code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    P = await createUser(T, [{ roleId: await roleId(T.token, "warehouse_manager") }]);
    C = await createUser(T, [{ roleId: await roleId(T.token, "cashier") }]);
    S = await createUser(T, [{ roleId: await roleId(T.token, "pos_supervisor") }]);
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    const wh = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code: "SHOP", nameAr: "الصالة", kind: "finished_goods" }, as(T))).id;
    const qc = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code: "QC", nameAr: "فحص", kind: "quarantine" }, as(T))).id;
    const bag = ok(await api("POST", "/api/v1/uoms", { code: "BAG", nameAr: "كيس" }, as(T))).id;
    chips = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "FG-C", nameAr: "رقائق (اختبار)", kind: "finished", baseUomId: bag, salesPrice: "2.000" }, as(T)));
    const d = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh, docDate: D(1, 2), lines: [{ itemId: chips.id, qtyDelta: "100", unitCost: "1" }] }, as(T)));
    ok(await api("POST", `/api/v1/inventory/documents/${d.id}/post`, {}, as(P)), 200);
    const walkIn = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "WALKIN", nameAr: "عميل نقدي" }, as(T)));
    R = ok(await api("POST", "/api/v1/pos/registers", { companyId: T.companyId, branchId: branch, code: "R1", nameAr: "كاشير 1", warehouseId: wh, returnWarehouseId: qc,
      walkInCustomerId: walkIn.id, cashAccountId: acc["1113"], safeAccountId: acc["1111"], varianceAccountId: acc["404"], maxDiscountPct: "5" }, as(T)));
    const R2 = ok(await api("POST", "/api/v1/pos/registers", { companyId: T.companyId, branchId: branch, code: "R2", nameAr: "كاشير 2", warehouseId: wh, returnWarehouseId: qc,
      walkInCustomerId: walkIn.id, cashAccountId: acc["1113"], safeAccountId: acc["1111"], varianceAccountId: acc["404"] }, as(T)));
    shiftC = ok(await api("POST", "/api/v1/pos/shifts", { registerId: R.id, businessDate: D(3, 1) }, as(C)));
    shiftS = ok(await api("POST", "/api/v1/pos/shifts", { registerId: R2.id, businessDate: D(3, 1) }, as(S)));
  });

  it("methods post to their own account; control accounts refused; a method can be limited to named users", async () => {
    expect((await api("POST", "/api/v1/pos/payment-methods", { companyId: T.companyId, nameAr: "خطأ", accountId: acc["1131"] }, as(T))).body.error.code).toBe("CONTROL_ACCOUNT");
    expect((await api("POST", "/api/v1/pos/payment-methods", { companyId: T.companyId, nameAr: "بطاقة", accountId: acc["1121"] }, as(C))).status).toBe(403);
    card = ok(await api("POST", "/api/v1/pos/payment-methods", { companyId: T.companyId, nameAr: "بطاقة المصرف", kind: "card", accountId: acc["1121"] }, as(T)));
    wallet = ok(await api("POST", "/api/v1/pos/payment-methods", { companyId: T.companyId, nameAr: "محفظة", kind: "wallet", accountId: acc["1112"], userIds: [S.id] }, as(T)));
    const mine = ok(await api("GET", "/api/v1/pos/shifts/current", undefined, as(C)), 200).paymentMethods.map((m: any) => m.name_ar);
    expect(mine).toEqual(["بطاقة المصرف"]);
    const sup = ok(await api("GET", "/api/v1/pos/shifts/current", undefined, as(S)), 200).paymentMethods.map((m: any) => m.name_ar).sort();
    expect(sup).toEqual(["بطاقة المصرف", "محفظة"].sort());
  });

  it("split sale: cash + card method; a method not allowed to the cashier is refused and nothing is posted", async () => {
    const sale = (who: any, shift: any, body: any) => api("POST", `/api/v1/pos/shifts/${shift.shift.id}/sales`, { clientId: randomUUID(), lines: [{ itemId: chips.id, qty: "5" }], ...body }, as(who));
    const no = await sale(C, shiftC, { cash: "5", payments: [{ methodId: wallet.id, amount: "5" }] });
    expect(no.body.error.code).toBe("PAYMENT_METHOD_NOT_ALLOWED");
    expect(await gl("1112")).toBe("0");
    const r = ok(await sale(C, shiftC, { cash: "4", tendered: "5", payments: [{ methodId: card.id, amount: "6" }] }));
    expect([r.invoice.total, r.change]).toEqual(["10.0000", "1.0000"]);
    expect(r.payments.map((p: any) => [p.tender, p.method ?? null, p.amount])).toEqual([["cash", null, "4.0000"], ["card", "بطاقة المصرف", "6.0000"]]);
    expect([await gl("1113"), await gl("1121")]).toEqual(["4.0000", "6.0000"]);
    const mismatch = await sale(C, shiftC, { cash: "4", payments: [{ methodId: card.id, amount: "5" }] });
    expect([mismatch.body.error.code, mismatch.body.error.details.total]).toEqual(["PAYMENT_MISMATCH", "10.0000"]);
    ok(await sale(S, shiftS, { payments: [{ methodId: wallet.id, amount: "10" }] }));
    expect(await gl("1112")).toBe("10.0000");
    const z = ok(await api("GET", `/api/v1/pos/shifts/${shiftC.shift.id}`, undefined, as(C)), 200);
    expect(z.byMethod).toEqual([{ method: "بطاقة المصرف", n: 1, amount: "6.0000" }]);
    // a deactivated method disappears from the cashier's screen and is refused
    ok(await api("PUT", `/api/v1/pos/payment-methods/${card.id}`, { companyId: T.companyId, nameAr: "بطاقة المصرف", kind: "card", accountId: acc["1121"], isActive: false }, as(T)), 200);
    expect(ok(await api("GET", "/api/v1/pos/shifts/current", undefined, as(C)), 200).paymentMethods).toEqual([]);
    expect((await sale(C, shiftC, { payments: [{ methodId: card.id, amount: "10" }] })).body.error.code).toBe("PAYMENT_METHOD_NOT_ALLOWED");
  });
});
