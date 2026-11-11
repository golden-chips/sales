import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";
import { withTenant } from "../src/db/pool.js";

const Y = new Date().getUTCFullYear();
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("manufacturing & quality: formula → order → issue → cost → QC → release → sale → trace → recall", () => {
  let T: any, P: any, O: any, wh: Record<string, string>, I: Record<string, string>, cust: any, supp: any, wc: any, bom: any, order: any, chipsLot: string, potatoLot: string;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (who: any) => ({ token: who.token });
  const gl = async (code: string) => (await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body.rows.find((r: any) => r.code === code)?.closing ?? "0";
  const stock = async (item: string, w: string) => (await api("GET", `/api/v1/inventory/stock?companyId=${T.companyId}&itemId=${item}&warehouseId=${w}`, undefined, as(T))).body[0];
  const postDoc = async (path: string, id: string) => ok(await api("POST", `/api/v1${path}/${id}/post`, {}, as(P)), 200);

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "sales", "purchasing", "inventory", "manufacturing", "quality"] });
    T = await provision(p, plan.code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    P = await createUser(T, await Promise.all(["production_manager", "quality_manager", "sales_manager", "warehouse_manager", "finance_manager"].map(async (c) => ({ roleId: await roleId(T.token, c) }))));
    O = await createUser(T, [{ roleId: await roleId(T.token, "production_operator") }]);
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    wh = {};
    for (const [code, kind] of [["RAW", "raw_materials"], ["QC", "quarantine"], ["FG", "finished_goods"]] as const)
      wh[code] = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code, nameAr: code, kind }, as(T))).id;
    const u: Record<string, string> = {};
    for (const c of ["KG", "PCS", "BAG"]) u[c] = ok(await api("POST", "/api/v1/uoms", { code: c, nameAr: c }, as(T))).id;
    I = {};
    const mk = async (code: string, kind: string, uom: string, lots: boolean, extra: any = {}) =>
      (I[code] = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code, nameAr: code, kind, baseUomId: u[uom], trackLots: lots, ...extra }, as(T))).id);
    await mk("POTATO", "raw", "KG", true); await mk("OIL", "raw", "KG", true); await mk("OIL-ALT", "raw", "KG", true); await mk("SALT", "raw", "KG", false);
    await mk("FILM40", "packaging", "PCS", false); await mk("CHIPS40", "finished", "BAG", true, { shelfLifeDays: 180, salesPrice: "1.250" });
    supp = ok(await api("POST", "/api/v1/suppliers", { companyId: T.companyId, code: "S-FARM", nameAr: "مزرعة البطاطس (اختبار)" }, as(T)));
    cust = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C-1", nameAr: "عميل اختبار" }, as(T)));
    // potato bought from a supplier (origin of the trace); other materials as opening stock
    const gr = ok(await api("POST", "/api/v1/purchasing/receipts", { companyId: T.companyId, supplierId: supp.id, warehouseId: wh.RAW, receiptDate: D(1, 10),
      lines: [{ itemId: I.POTATO, qty: "1000", unitCost: "0.5", lotNo: "POT-01", expiryDate: `${Y}-12-31` }] }, as(T)));
    await postDoc("/purchasing/receipts", gr.id);
    const op = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh.RAW, docDate: D(1, 2), lines: [
      { itemId: I.OIL, qtyDelta: "200", unitCost: "4", lotNo: "OIL-OK", expiryDate: `${Y + 1}-12-31` },
      { itemId: I.OIL, qtyDelta: "50", unitCost: "3.5", lotNo: "OIL-EXP", expiryDate: `${Y - 1}-12-31` },   // expired, must never enter food
      { itemId: I.SALT, qtyDelta: "100", unitCost: "1" }, { itemId: I.FILM40, qtyDelta: "5000", unitCost: "0.05" } ] }, as(T)));
    await postDoc("/inventory/documents", op.id);
    wc = ok(await api("POST", "/api/v1/manufacturing/work-centers", { companyId: T.companyId, code: "LINE1", nameAr: "خط القلي 1", capacityPerHour: "600", ratePerHour: "50" }, as(T)));
  });

  it("formula: versioned, approval with SoD, frozen after approval, standard cost roll-up", async () => {
    const draft = ok(await api("POST", "/api/v1/manufacturing/boms", { companyId: T.companyId, itemId: I.CHIPS40, batchQty: "1000", stdScrapPct: "2", stdHours: "2", lines: [
      { itemId: I.POTATO, qty: "160", scrapPct: "5" }, { itemId: I.OIL, qty: "12", substituteItemId: I["OIL-ALT"] }, { itemId: I.SALT, qty: "0.8" }, { itemId: I.FILM40, qty: "1000", scrapPct: "2" } ] }, as(T)));
    expect(draft.version).toBe(1);
    expect((await api("POST", `/api/v1/manufacturing/boms/${draft.id}/approve`, {}, as(T))).body.error.code).toBe("SEGREGATION_OF_DUTIES");
    bom = ok(await api("POST", `/api/v1/manufacturing/boms/${draft.id}/approve`, {}, as(P)), 200);
    expect(bom.status).toBe("approved");
    await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE bom_lines SET qty = 1 WHERE bom_id = $1", [bom.id]))).rejects.toThrow(/frozen/);
    const full = ok(await api("GET", `/api/v1/manufacturing/boms/${bom.id}?workCenterId=${wc.id}`, undefined, as(P)), 200);
    // potato 168×0.5=84 · oil 12×3.9 (avg incl. both lots)=46.8 · salt 0.8 · film 1020×0.05=51 → 182.6; conversion 2h×50=100 → 282.6 / 1000
    expect(full.standardCost.material).toBe("182.6000");
    expect(full.standardCost.unitCost).toBe("0.282600");
    const self = await api("POST", "/api/v1/manufacturing/boms", { companyId: T.companyId, itemId: I.CHIPS40, batchQty: "1", lines: [{ itemId: I.CHIPS40, qty: "1" }] }, as(T));
    expect(self.body.error.code).toBe("BOM_SELF_REFERENCE");
  });

  it("production order: output must go to quarantine; release freezes standard cost", async () => {
    const bad = await api("POST", "/api/v1/manufacturing/orders", { companyId: T.companyId, itemId: I.CHIPS40, workCenterId: wc.id, plannedQty: "1000", materialWarehouseId: wh.RAW, outputWarehouseId: wh.FG, plannedDate: D(2, 1) }, as(T));
    expect(bad.body.error.code).toBe("OUTPUT_MUST_BE_QUARANTINE");
    order = ok(await api("POST", "/api/v1/manufacturing/orders", { companyId: T.companyId, itemId: I.CHIPS40, workCenterId: wc.id, plannedQty: "1000", materialWarehouseId: wh.RAW, outputWarehouseId: wh.QC, plannedDate: D(2, 1) }, as(T)));
    expect((await api("POST", `/api/v1/manufacturing/orders/${order.id}/issue`, { itemId: I.SALT, qty: "1", entryDate: D(2, 1) }, as(O))).body.error.code).toBe("ORDER_STATUS"); // not released
    const rel = ok(await api("POST", `/api/v1/manufacturing/orders/${order.id}/release`, {}, as(P)), 200);
    expect(rel.number).toMatch(/^MO-/);
    expect(rel.std_unit_cost).toBe("0.282600");
    const req = ok(await api("GET", `/api/v1/manufacturing/orders/${order.id}`, undefined, as(O)), 200).requirements;
    const oil = req.find((r: any) => r.code === "OIL");
    expect(oil.available).toBe("200.0000"); // the expired lot is not counted as available
  });

  it("shop floor: FEFO skips expired material; only formula items; returns at issue cost; line hours", async () => {
    const o = (body: any) => api("POST", `/api/v1/manufacturing/orders/${order.id}/issue`, { entryDate: D(2, 1), ...body }, as(O));
    const oil = ok(await o({ itemId: I.OIL, qty: "12" }));
    // weighted average: lots share one cost (12 × 3.9); FEFO must have skipped the expired lot
    expect(oil.value).toBe("46.8000");
    const oilLots = (await stock(I.OIL, wh.RAW)).lots;
    expect(Number(oilLots.find((l: any) => l.lotNo === "OIL-EXP").qty)).toBe(50);
    expect(Number(oilLots.find((l: any) => l.lotNo === "OIL-OK").qty)).toBe(188);
    const pot = ok(await o({ itemId: I.POTATO, qty: "170" }));
    potatoLot = pot.allocations[0].lotId;
    ok(await o({ itemId: I.SALT, qty: "0.8" }));
    ok(await o({ itemId: I.FILM40, qty: "1020" }));
    expect((await o({ itemId: I.CHIPS40, qty: "1" })).body.error.code).toBe("NOT_IN_BOM");
    const back = ok(await o({ itemId: I.POTATO, qty: "2", lotId: potatoLot, kind: "return" }));
    expect(back.value).toBe("1.0000");
    expect((await o({ itemId: I.POTATO, qty: "500", lotId: potatoLot, kind: "return" })).body.error.code).toBe("RETURN_EXCEEDS_ISSUED");
    ok(await api("POST", `/api/v1/manufacturing/orders/${order.id}/time`, { hours: "2.5", entryDate: D(2, 1) }, as(O)));
    // WIP = potato 84 + oil 46.8 + salt 0.8 + film 51 + conversion 125 = 307.6
    expect(await gl("1143")).toBe("307.6000");
    expect(await gl("5205")).toBe("-125.0000");
  });

  it("completion: output lot into quarantine at actual cost, WIP cleared, cost report vs standard", async () => {
    expect((await api("POST", `/api/v1/manufacturing/orders/${order.id}/complete`, { producedQty: "980", lotNo: "CH-001", productionDate: D(2, 1), entryDate: D(2, 1) }, as(O))).status).toBe(403); // operator cannot close
    const done = ok(await api("POST", `/api/v1/manufacturing/orders/${order.id}/complete`, { producedQty: "980", scrapQty: "20", lotNo: "CH-001", productionDate: D(2, 1), entryDate: D(2, 1) }, as(P)), 200);
    expect(done.status).toBe("completed");
    expect(done.actual_cost).toBe("307.6000");
    expect(done.output_expiry).not.toBeNull(); // from shelf life
    chipsLot = done.output_lot_id;
    expect(await gl("1143")).toBe("0.0000");
    expect(await gl("1146")).toBe("307.6000");
    const s = await stock(I.CHIPS40, wh.QC);
    expect([s.qty, s.value, s.is_sellable]).toEqual(["980.0000", "307.6000", false]);
    const cost = ok(await api("GET", `/api/v1/manufacturing/orders/${order.id}/cost`, undefined, as(P)), 200);
    expect(cost.yieldPct).toBe("98.00");
    expect(cost.actualUnitCost).toBe("0.313878");
    const potato = cost.components.find((c: any) => c.code === "POTATO");
    expect([potato.stdQty, potato.actualQty]).toEqual(["164.6400", "168.0000"]); // 160 × 980/1000 × 1.05
    expect(cost.costVariance).toBe("30.6520"); // 307.6 − 0.2826 × 980
    await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE production_orders SET actual_cost = 1 WHERE id = $1", [order.id]))).rejects.toThrow(/immutable/);
  });

  it("quality: system judges results; a failed CCP holds the lot and opens an NCR; release needs a pass", async () => {
    await api("PUT", "/api/v1/quality/specs", { itemId: I.CHIPS40, stage: "final", specs: [
      { parameter: "frying_temp", unit: "°C", min: "170", max: "180", isCcp: true }, { parameter: "moisture", unit: "%", max: "2" }, { parameter: "salt", unit: "%", min: "1", max: "2" } ] }, as(P));
    const missing = await api("POST", "/api/v1/quality/checks", { companyId: T.companyId, lotId: chipsLot, stage: "final", results: [{ parameter: "moisture", value: "1.5" }] }, as(P));
    expect(missing.body.error.code).toBe("QC_RESULTS_MISSING");
    const fail = ok(await api("POST", "/api/v1/quality/checks", { companyId: T.companyId, lotId: chipsLot, stage: "final", productionOrderId: order.id,
      results: [{ parameter: "frying_temp", value: "190" }, { parameter: "moisture", value: "1.5" }, { parameter: "salt", value: "1.4" }] }, as(P)));
    expect(fail.result).toBe("fail");
    expect(fail.ncr.description).toMatch(/CCP/);
    const rel = (await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "quarantine_release", warehouseId: wh.QC, toWarehouseId: wh.FG, docDate: D(2, 2), lines: [{ itemId: I.CHIPS40, qtyDelta: "980" }] }, as(T))).body;
    expect((await api("POST", `/api/v1/inventory/documents/${rel.id}/post`, {}, as(P))).body.error.code).toBe("INSUFFICIENT_LOT_STOCK"); // lot on hold
    // a passing re-test does not lift the hold while the NCR is open
    ok(await api("POST", "/api/v1/quality/checks", { companyId: T.companyId, lotId: chipsLot, stage: "final", results: [{ parameter: "frying_temp", value: "175" }, { parameter: "moisture", value: "1.5" }, { parameter: "salt", value: "1.4" }] }, as(P)));
    expect((await api("POST", `/api/v1/inventory/documents/${rel.id}/post`, {}, as(P))).body.error.code).toBe("INSUFFICIENT_LOT_STOCK");
    ok(await api("POST", `/api/v1/quality/ncrs/${fail.ncr.id}/close`, { disposition: "use_as_is", rootCause: "خطأ في معايرة حساس الحرارة", correctiveAction: "إعادة معايرة الحساس وإعادة فحص العينات" }, as(P)), 200);
    ok(await api("POST", "/api/v1/quality/checks", { companyId: T.companyId, lotId: chipsLot, stage: "final", results: [{ parameter: "frying_temp", value: "176" }, { parameter: "moisture", value: "1.2" }, { parameter: "salt", value: "1.5" }] }, as(P)));
    const posted = await postDoc("/inventory/documents", rel.id);
    expect(posted.status).toBe("posted");
    expect((await stock(I.CHIPS40, wh.FG)).value).toBe("307.6000");
    expect(await gl("1146")).toBe("0.0000");
    expect(await gl("1144")).toBe("307.6000");
  });

  it("sale of the released lot, then full genealogy backward to the farm and forward to the customer", async () => {
    const inv = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.FG, customerId: cust.id, invoiceDate: D(2, 3), paymentType: "credit", lines: [{ itemId: I.CHIPS40, qty: "100" }] }, as(T)));
    const p = await postDoc("/sales/invoices", inv.id);
    expect(p.cogs_total).toBe("31.3880"); // 307.6 × 100/980 = 31.38775… → LYD 3 dp, identical to the GL
    const back = ok(await api("GET", `/api/v1/quality/trace/${chipsLot}`, undefined, as(P)), 200).backward;
    const pot = back.find((n: any) => n.item_code === "POTATO");
    expect(pot.supplier_code).toBe("S-FARM");
    expect(back.find((n: any) => n.item_code === "OIL").lot_no).toBe("OIL-OK");
    const fwd = ok(await api("GET", `/api/v1/quality/trace/${potatoLot}`, undefined, as(P)), 200).forward;
    expect(fwd.lots.map((l: any) => l.lot_no).sort()).toEqual(["CH-001", "POT-01"]);
    expect(fwd.customers).toHaveLength(1);
    expect([fwd.customers[0].code, fwd.customers[0].in_market]).toEqual(["C-1", "100.0000"]);
  });

  it("recall of a raw-material lot holds every derived lot and blocks sale and production use", async () => {
    const rc = ok(await api("POST", "/api/v1/quality/recalls", { companyId: T.companyId, lotId: potatoLot, reason: "إخطار من المورد بتلوث محتمل" }, as(P)));
    expect(rc.number).toMatch(/^RC-/);
    expect(rc.forward.customers[0].code).toBe("C-1");
    const sale = ok(await api("POST", "/api/v1/sales/invoices", { companyId: T.companyId, warehouseId: wh.FG, customerId: cust.id, invoiceDate: D(2, 4), paymentType: "cash", lines: [{ itemId: I.CHIPS40, qty: "10", unitPrice: "1" }] }, as(T)));
    expect((await api("POST", `/api/v1/sales/invoices/${sale.id}/post`, {}, as(P))).body.error.code).toBe("INSUFFICIENT_LOT_STOCK");
    const o2 = ok(await api("POST", "/api/v1/manufacturing/orders", { companyId: T.companyId, itemId: I.CHIPS40, workCenterId: wc.id, plannedQty: "500", materialWarehouseId: wh.RAW, outputWarehouseId: wh.QC, plannedDate: D(2, 5) }, as(T)));
    await api("POST", `/api/v1/manufacturing/orders/${o2.id}/release`, {}, as(P));
    expect((await api("POST", `/api/v1/manufacturing/orders/${o2.id}/issue`, { itemId: I.POTATO, qty: "10", lotId: potatoLot, entryDate: D(2, 5) }, as(O))).body.error.code).toBe("LOT_ON_HOLD");
    // a later passing check never lifts a recall hold
    await api("PUT", "/api/v1/quality/specs", { itemId: I.POTATO, stage: "receiving", specs: [] }, as(P));
    ok(await api("POST", "/api/v1/quality/checks", { companyId: T.companyId, lotId: potatoLot, stage: "receiving", results: [{ parameter: "visual", passed: true }] }, as(P)));
    expect((await api("POST", `/api/v1/manufacturing/orders/${o2.id}/issue`, { itemId: I.POTATO, qty: "10", lotId: potatoLot, entryDate: D(2, 5) }, as(O))).body.error.code).toBe("LOT_ON_HOLD");
  });

  it("MRP nets open orders against stock and suggests purchases", async () => {
    ok(await api("POST", "/api/v1/manufacturing/orders", { companyId: T.companyId, itemId: I.CHIPS40, workCenterId: wc.id, plannedQty: "10000", materialWarehouseId: wh.RAW, outputWarehouseId: wh.QC, plannedDate: D(3, 1) }, as(T)));
    const m = ok(await api("GET", `/api/v1/manufacturing/mrp?companyId=${T.companyId}`, undefined, as(P)), 200);
    const film = m.lines.find((l: any) => l.code === "FILM40");
    expect(Number(film.required)).toBeGreaterThan(Number(film.on_hand));
    expect(Number(film.suggestedPurchase)).toBeGreaterThan(0);
  });

  it("books reconcile: stock subledger = GL, trial balance balanced", async () => {
    const v = ok(await api("GET", `/api/v1/inventory/valuation-check?companyId=${T.companyId}`, undefined, as(P)), 200);
    expect(v.reconciled, JSON.stringify(v)).toBe(true);
    expect((await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body.totals.balanced).toBe(true);
  });
});
