import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear() - 1;
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("point of sale", () => {
  let T: any, P: any, C: any, S: any;   // owner (config), poster (stock), cashier, supervisor
  let acc: Record<string, string>, wh: Record<string, string>, walkIn: any, cust: any, chips: any, R1: any, R2: any, shift1: any, shift2: any, sale1: any;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const gl = async (code: string) => {
    const tb = await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T));
    return tb.body.rows.find((r: any) => r.code === code)?.closing ?? "0";
  };
  const stock = async (w: string) => (await api("GET", `/api/v1/inventory/stock?companyId=${T.companyId}&itemId=${chips.id}&warehouseId=${w}`, undefined, as(T))).body[0]?.qty ?? "0";
  const sell = (who: any, shift: any, body: any) => api("POST", `/api/v1/pos/shifts/${shift.shift.id}/sales`, { clientId: randomUUID(), ...body }, as(who));

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "sales", "inventory", "pos"] });
    T = await provision(p, plan.code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    P = await createUser(T, [{ roleId: await roleId(T.token, "warehouse_manager") }]);
    C = await createUser(T, [{ roleId: await roleId(T.token, "cashier") }]);
    S = await createUser(T, [{ roleId: await roleId(T.token, "pos_supervisor") }]);
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    wh = {};
    for (const [code, kind] of [["SHOP", "finished_goods"], ["SHOP2", "finished_goods"], ["QC", "quarantine"]] as const)
      wh[code] = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code, nameAr: `مخزن ${code}`, kind }, as(T))).id;
    const bag = ok(await api("POST", "/api/v1/uoms", { code: "BAG", nameAr: "كيس" }, as(T))).id;
    const ctn = ok(await api("POST", "/api/v1/uoms", { code: "CTN", nameAr: "كرتونة" }, as(T))).id;
    chips = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "FG-CHIPS", nameAr: "رقائق (اختبار)", kind: "finished", baseUomId: bag, barcode: "2000000000011",
      trackLots: true, salesPrice: "1.250", units: [{ uomId: ctn, factor: "24", barcode: "2000000000028" }] }, as(T)));
    for (const w of [wh.SHOP, wh.SHOP2]) {
      const d = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: w, docDate: D(1, 2),
        lines: [{ itemId: chips.id, qtyDelta: "100", unitCost: "0.8", lotNo: `L-${w.slice(0, 4)}`, productionDate: D(1, 1), expiryDate: `${Y + 2}-12-31` }] }, as(T)));
      ok(await api("POST", `/api/v1/inventory/documents/${d.id}/post`, {}, as(P)), 200);
    }
    walkIn = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "WALKIN", nameAr: "عميل نقدي" }, as(T)));
    cust = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C001", nameAr: "مطعم اختبار", creditLimit: "50", paymentTermsDays: 30 }, as(T)));
    const reg = (code: string, w: string) => ({ companyId: T.companyId, branchId: branch, code, nameAr: `كاشير ${code}`, warehouseId: w, returnWarehouseId: wh.QC,
      walkInCustomerId: walkIn.id, cashAccountId: acc["1113"], safeAccountId: acc["1111"], cardAccountId: acc["1121"], varianceAccountId: acc["404"], maxDiscountPct: "5" });
    expect((await api("POST", "/api/v1/pos/registers", { ...reg("BAD", wh.QC) }, as(T))).body.error.code).toBe("WAREHOUSE_NOT_SELLABLE");
    expect((await api("POST", "/api/v1/pos/registers", { ...reg("BAD", wh.SHOP), returnWarehouseId: wh.SHOP2 }, as(T))).body.error.code).toBe("RETURN_MUST_GO_TO_QUARANTINE");
    expect((await api("POST", "/api/v1/pos/registers", { ...reg("BAD", wh.SHOP), cashAccountId: acc["1131"] }, as(T))).body.error.code).toBe("CONTROL_ACCOUNT");
    expect((await api("POST", "/api/v1/pos/registers", reg("R1", wh.SHOP), as(C))).status).toBe(403);
    R1 = ok(await api("POST", "/api/v1/pos/registers", reg("R1", wh.SHOP), as(T)));
    R2 = ok(await api("POST", "/api/v1/pos/registers", reg("R2", wh.SHOP2), as(T)));
  });

  it("opening a shift moves the float from the safe to the drawer; one open shift per cashier and per register", async () => {
    shift1 = ok(await api("POST", "/api/v1/pos/shifts", { registerId: R1.id, openingFloat: "100", businessDate: D(3, 1) }, as(C)));
    expect(shift1.shift.number).toMatch(/^PS-/);
    expect([await gl("1113"), await gl("1111")]).toEqual(["100.0000", "-100.0000"]);
    expect((await api("POST", "/api/v1/pos/shifts", { registerId: R2.id, businessDate: D(3, 1) }, as(C))).status).toBe(409);
    expect((await api("POST", "/api/v1/pos/shifts", { registerId: R1.id, businessDate: D(3, 1) }, as(S))).status).toBe(409);
    shift2 = ok(await api("POST", "/api/v1/pos/shifts", { registerId: R2.id, openingFloat: "50", businessDate: D(3, 1) }, as(S)));
    expect(ok(await api("GET", "/api/v1/pos/shifts/current", undefined, as(C)), 200).shift.id).toBe(shift1.shift.id);
  });

  it("sale by barcode (bag + carton unit), change, idempotent retry, FEFO stock, GL", async () => {
    const clientId = randomUUID();
    const body = { clientId, lines: [{ barcode: "2000000000011", qty: "2" }, { barcode: "2000000000028", qty: "1" }], cash: "32.5", tendered: "50" };
    const r = ok(await api("POST", `/api/v1/pos/shifts/${shift1.shift.id}/sales`, body, as(C)));
    sale1 = r.invoice;
    expect([r.invoice.total, r.change, r.replayed, r.customer_code, r.register_code]).toEqual(["32.5000", "17.5000", false, "WALKIN", "R1"]);
    expect(r.invoice.number).toMatch(/^SI-/);
    const again = ok(await api("POST", `/api/v1/pos/shifts/${shift1.shift.id}/sales`, body, as(C)), 200);
    expect([again.replayed, again.invoice.number]).toEqual([true, r.invoice.number]);
    expect(await stock(wh.SHOP)).toBe("74.0000");   // 100 − 2 − 24, sold once only
    expect(await gl("401")).toBe("-32.5000");
    expect(await gl("1113")).toBe("182.5000");      // 100 float (R1) + 50 float (R2) + 32.5
  });

  it("payment must equal the total (nothing posted otherwise); discount limit; credit needs permission and a named customer", async () => {
    const bad = await sell(C, shift1, { lines: [{ itemId: chips.id, qty: "4" }], cash: "4" });
    expect(bad.body.error.code).toBe("PAYMENT_MISMATCH");
    expect(await stock(wh.SHOP)).toBe("74.0000");
    expect((await sell(C, shift1, { lines: [{ itemId: chips.id, qty: "4", discountPct: "10" }], cash: "4.5" })).body.error.code).toBe("DISCOUNT_ABOVE_LIMIT");
    ok(await sell(C, shift1, { lines: [{ itemId: chips.id, qty: "4", discountPct: "5" }], cash: "4.75" }));   // 5 − 5%
    expect((await sell(C, shift1, { customerId: cust.id, lines: [{ itemId: chips.id, qty: "4" }], credit: "5" })).status).toBe(403);
    expect((await sell(S, shift2, { lines: [{ itemId: chips.id, qty: "4" }], credit: "5" })).body.error.code).toBe("CREDIT_NEEDS_CUSTOMER");
    expect((await sell(C, shift2, { lines: [{ itemId: chips.id, qty: "1" }], cash: "1.25" })).body.error.code).toBe("NOT_YOUR_SHIFT");
    // split: 10 on card, 20 on account (within the 50 limit)
    const split = ok(await sell(S, shift2, { customerId: cust.id, lines: [{ itemId: chips.id, qty: "24" }], card: "10", credit: "20" }));
    expect([split.invoice.payment_type, split.invoice.amount_paid]).toEqual(["credit", "10.0000"]);
    expect(await gl("1121")).toBe("10.0000");
    const aging = (await api("GET", `/api/v1/sales/ar-aging?companyId=${T.companyId}&asOf=${D(3, 1)}`, undefined, as(T))).body;
    expect(aging.rows.find((x: any) => x.code === "C001").total).toBe("20.0000");
    expect((await sell(S, shift2, { customerId: cust.id, lines: [{ itemId: chips.id, qty: "40" }], credit: "50" })).body.error.code).toBe("CREDIT_LIMIT_EXCEEDED");
  });

  it("returns: permission, goods to quarantine, refund from the drawer", async () => {
    const line = sale1.lines[0];
    expect((await api("POST", `/api/v1/pos/shifts/${shift1.shift.id}/returns`, { invoiceId: sale1.id, lines: [{ invoiceLineId: line.id, qty: "2" }], reason: "كيس مفتوح" }, as(C))).status).toBe(403);
    const r = ok(await api("POST", `/api/v1/pos/shifts/${shift2.shift.id}/returns`, { invoiceId: sale1.id, lines: [{ invoiceLineId: line.id, qty: "2" }], refundTender: "cash", reason: "كيس مفتوح" }, as(S)));
    expect([r.total, r.tender]).toEqual(["2.5000", "cash"]);
    expect(await stock(wh.QC)).toBe("2.0000");
    const tooMuch = await api("POST", `/api/v1/pos/shifts/${shift2.shift.id}/returns`, { invoiceId: sale1.id, lines: [{ invoiceLineId: line.id, qty: "1" }], reason: "مكرر" }, as(S));
    expect(tooMuch.body.error.code).toBe("RETURN_EXCEEDS_SOLD");
  });

  it("drops and close: expected vs counted, over/short posted, drawer nets to zero, closed shift frozen", async () => {
    expect((await api("POST", `/api/v1/pos/shifts/${shift1.shift.id}/drops`, { amount: "50" }, as(C))).status).toBe(403);
    ok(await api("POST", `/api/v1/pos/shifts/${shift1.shift.id}/drops`, { amount: "50", note: "إلى الخزينة" }, as(S)));
    const x = ok(await api("GET", `/api/v1/pos/shifts/${shift1.shift.id}`, undefined, as(C)), 200);
    expect(x.expectedCash).toBe("87.2500");   // 100 + 32.5 + 4.75 − 50
    const z = ok(await api("POST", `/api/v1/pos/shifts/${shift1.shift.id}/close`, { countedCash: "86.25", notes: "نقص دينار" }, as(C)), 200);
    expect([z.shift.status, z.shift.expected_cash, z.shift.variance, z.totals.invoices, z.totals.net]).toEqual(["closed", "87.2500", "-1.0000", 2, "37.2500"]);
    expect(await gl("404")).toBe("1.0000");        // shortage debited to over/short
    const z2 = ok(await api("POST", `/api/v1/pos/shifts/${shift2.shift.id}/close`, { countedCash: "47.5" }, as(S)), 200);   // 50 − 2.5 refund
    expect(z2.shift.variance).toBe("0.0000");
    expect(await gl("1113")).toBe("0.0000");       // every drawer emptied back to the safe
    expect(await gl("1111")).toBe("33.7500");      // −150 floats + 50 drop + 86.25 + 47.5
    expect((await sell(C, shift1, { lines: [{ itemId: chips.id, qty: "1" }], cash: "1.25" })).body.error.code).toBe("SHIFT_CLOSED");
    const tb = (await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body;
    expect(tb.totals.balanced).toBe(true);
    const mine = ok(await api("GET", `/api/v1/pos/shifts?companyId=${T.companyId}`, undefined, as(C)), 200);
    expect(mine.map((s: any) => s.id)).toEqual([shift1.shift.id]);
    expect((await api("GET", `/api/v1/pos/shifts/${shift2.shift.id}`, undefined, as(C))).status).toBe(403);
  });

  it("catalog shows sellable quantity and unit barcodes", async () => {
    const cat = ok(await api("GET", `/api/v1/pos/registers/${R1.id}/catalog`, undefined, as(C)), 200);
    const it = cat.find((x: any) => x.code === "FG-CHIPS");
    expect(it.available).toBe("70.0000");
    expect(it.units[0].barcode).toBe("2000000000028");
  });
});
