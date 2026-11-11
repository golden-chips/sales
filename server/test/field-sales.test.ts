import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";
import { withTenant } from "../src/db/pool.js";
import { commissionFor } from "../src/modules/field/field.service.js";

const today = new Date().toISOString().slice(0, 10);
const Y = today.slice(0, 4);
const period = today.slice(0, 7);

describe("field sales & distribution: load → offline sync → custody → day settlement → commissions", () => {
  let T: any, W: any, S: any, C: any, F1: any, F2: any, R: any, R2: any, rep: any, rep2: any;
  let wh: Record<string, string>, chips: string, ctn: string, c1: any, c2: any, c3: any;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (u: any) => ({ token: u.token });
  const gl = async (code: string) => (await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body.rows.find((r: any) => r.code === code)?.closing ?? "0";
  const vanQty = async (w: string) => (await api("GET", `/api/v1/inventory/stock?companyId=${T.companyId}&warehouseId=${w}`, undefined, as(T))).body[0]?.qty ?? "0";
  const sync = (u: any, ops: any[]) => api("POST", "/api/v1/field/sync", { ops }, as(u));
  const inv = (clientId: string, customerId: string, paymentType: string, lines: any[]) => ({ clientId, type: "invoice", payload: { customerId, paymentType, invoiceDate: today, lines } });

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "sales", "purchasing", "inventory", "distribution", "quality"], maxUsers: 20 });
    T = await provision(p, plan.code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    const role = (c: string) => roleId(T.token, c);
    W = await createUser(T, [{ roleId: await role("warehouse_manager") }]);
    S = await createUser(T, [{ roleId: await role("sales_manager") }]);
    C = await createUser(T, [{ roleId: await role("accountant") }]);
    F1 = await createUser(T, [{ roleId: await role("finance_manager") }]);
    F2 = await createUser(T, [{ roleId: await role("finance_manager") }]);
    R = await createUser(T, [{ roleId: await role("sales_rep") }]);
    R2 = await createUser(T, [{ roleId: await role("sales_rep") }]);
    const branch = (await api("GET", "/api/v1/branches", undefined, as(T))).body[0].id;
    wh = {};
    for (const [code, kind] of [["MAIN", "finished_goods"], ["VAN1", "van"], ["VAN2", "van"]] as const)
      wh[code] = ok(await api("POST", "/api/v1/warehouses", { branchId: branch, code, nameAr: code, kind }, as(T))).id;
    const bag = ok(await api("POST", "/api/v1/uoms", { code: "BAG", nameAr: "كيس" }, as(T))).id;
    ctn = ok(await api("POST", "/api/v1/uoms", { code: "CTN", nameAr: "كرتونة" }, as(T))).id;
    chips = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "CHIPS", nameAr: "رقائق (اختبار)", kind: "finished", baseUomId: bag, trackLots: true, shelfLifeDays: 180,
      salesPrice: "1.250", units: [{ uomId: ctn, factor: "24" }] }, as(T))).id;
    const op = ok(await api("POST", "/api/v1/inventory/documents", { companyId: T.companyId, reason: "opening", warehouseId: wh.MAIN, docDate: `${Y}-01-02`,
      lines: [{ itemId: chips, qtyDelta: "1000", unitCost: "0.8", lotNo: "L1", productionDate: today }] }, as(T)));
    ok(await api("POST", `/api/v1/inventory/documents/${op.id}/post`, {}, as(W)), 200);
    const tr = ok(await api("POST", "/api/v1/distribution/territories", { companyId: T.companyId, code: "TR1", nameAr: "منطقة 1" }, as(S)));
    c1 = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C1", nameAr: "محل المسار", phone: "+218910000001" }, as(S)));
    c2 = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C2", nameAr: "محل المنطقة", creditLimit: "500" }, as(S)));
    c3 = ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code: "C3", nameAr: "محل غير مسند" }, as(S)));
    ok(await api("PUT", `/api/v1/distribution/customers/${c2.id}/territory`, { territoryId: tr.id }, as(S)), 200);
    (globalThis as any).__tr = tr.id;
  });

  it("registering reps: needs the sales_rep role and a van warehouse", async () => {
    const notRep = await api("POST", "/api/v1/distribution/reps", { companyId: T.companyId, userId: W.id, code: "X", vanWarehouseId: wh.VAN1 }, as(S));
    expect(notRep.body.error.code).toBe("USER_NOT_SALES_REP");
    const notVan = await api("POST", "/api/v1/distribution/reps", { companyId: T.companyId, userId: R.id, code: "R1", vanWarehouseId: wh.MAIN }, as(S));
    expect(notVan.body.error.code).toBe("NOT_A_VAN");
    rep = ok(await api("POST", "/api/v1/distribution/reps", { companyId: T.companyId, userId: R.id, code: "R1", vanWarehouseId: wh.VAN1, territoryId: (globalThis as any).__tr,
      commissionType: "flat", commissionRate: "2", maxDiscountPct: "5" }, as(S)));
    rep2 = ok(await api("POST", "/api/v1/distribution/reps", { companyId: T.companyId, userId: R2.id, code: "R2", vanWarehouseId: wh.VAN2,
      commissionType: "tiered", tiers: [{ upTo: "100", rate: "1" }, { upTo: null, rate: "3" }] }, as(S)));
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    ok(await api("PUT", `/api/v1/distribution/reps/${rep.id}/routes`, { weekday, name: "مسار اليوم", customerIds: [c1.id] }, as(S)), 200);
    ok(await api("PUT", `/api/v1/distribution/reps/${rep.id}/targets`, { period, salesTarget: "174", collectionTarget: "100", visitsTarget: 4 }, as(S)), 200);
  });

  it("van load: the rep requests, the warehouse posts (rep cannot post)", async () => {
    const d = ok(await api("POST", "/api/v1/field/load-requests", { fromWarehouseId: wh.MAIN, docDate: today, lines: [{ itemId: chips, qty: "240" }] }, as(R)));
    expect((await api("POST", `/api/v1/inventory/documents/${d.id}/post`, {}, as(R))).status).toBe(403);
    ok(await api("POST", `/api/v1/inventory/documents/${d.id}/post`, {}, as(W)), 200);
    expect(await vanQty(wh.VAN1)).toBe("240.0000");
    expect(await gl("1145")).toBe("192.0000"); // 240 × 0.8 moved to "goods in vans"
    const day = ok(await api("GET", "/api/v1/field/my-day", undefined, as(R)), 200);
    expect(day.route.map((s: any) => s.code)).toEqual(["C1"]);
    expect(day.van[0].qty).toBe("240.0000");
  });

  const batch = () => [
    inv("op-cash-0001", c1.id, "cash", [{ itemId: chips, uomId: ctn, qty: "1" }]),                       // 24 × 1.25 = 30
    inv("op-cred-0002", c2.id, "credit", [{ itemId: chips, qty: "48", discountPct: "5" }]),              // 60 − 3 = 57
    inv("op-unas-0003", c3.id, "cash", [{ itemId: chips, qty: "1" }]),                                    // not assigned
    inv("op-disc-0004", c1.id, "cash", [{ itemId: chips, qty: "1", discountPct: "10" }]),                 // above ceiling
    { clientId: "op-rcpt-0005", type: "receipt", payload: { customerId: c2.id, amount: "20", paymentDate: today } },
    { clientId: "op-vist-0006", type: "visit", payload: { customerId: c1.id, outcome: "sale", visitedAt: new Date().toISOString() } },
    { clientId: "op-pric-0007", type: "invoice", payload: { customerId: c1.id, paymentType: "cash", invoiceDate: today, lines: [{ itemId: chips, qty: "1", unitPrice: "0.01" }] } }, // price override
  ];

  it("offline sync: each op atomic; controls enforced; bad ops do not block good ones", async () => {
    const r = ok(await sync(R, batch()), 200);
    const by = Object.fromEntries(r.results.map((x: any) => [x.clientId, x]));
    expect([r.ok, r.failed]).toEqual([4, 3]);
    expect(by["op-cash-0001"].result.total).toBe("30.0000");
    expect(by["op-cred-0002"].result.total).toBe("57.0000");
    expect(by["op-unas-0003"].error.code).toBe("CUSTOMER_NOT_ASSIGNED");
    expect(by["op-disc-0004"].error.code).toBe("DISCOUNT_NOT_ALLOWED");
    expect(by["op-pric-0007"].error.code).toBe("VALIDATION_FAILED"); // reps cannot type prices
    expect(await vanQty(wh.VAN1)).toBe("168.0000");
  });

  it("re-sync of the same batch never duplicates invoices or receipts", async () => {
    const r = ok(await sync(R, batch()), 200);
    const replayed = r.results.filter((x: any) => x.ok).map((x: any) => x.result.replayed);
    expect(replayed).toEqual([true, true, true, true]);
    const invs = (await api("GET", `/api/v1/sales/invoices?companyId=${T.companyId}`, undefined, as(T))).body;
    expect(invs.total).toBe(2);
    expect(await vanQty(wh.VAN1)).toBe("168.0000");
  });

  it("cash custody: rep cash sales and collections accumulate in custody (subledger = GL 1112)", async () => {
    const day = ok(await api("GET", "/api/v1/field/my-day", undefined, as(R)), 200);
    expect(day.custody).toBe("50.0000");
    expect(day.today.sales).toBe("87.0000");
    expect(await gl("1112")).toBe("50.0000");
    expect(Number(await gl("1111"))).toBe(0); // nothing reached the main cash box yet
  });

  it("cash handover: cannot exceed custody; cashier confirms; shortage charged to the rep", async () => {
    expect((await api("POST", "/api/v1/field/handovers", { amount: "60", handoverDate: today }, as(R))).body.error.code).toBe("EXCEEDS_CUSTODY");
    const h = ok(await api("POST", "/api/v1/field/handovers", { amount: "50", handoverDate: today }, as(R)));
    expect((await api("POST", `/api/v1/distribution/handovers/${h.id}/confirm`, { countedAmount: "50" }, as(R))).status).toBe(403);
    expect((await api("POST", `/api/v1/distribution/handovers/${h.id}/confirm`, { countedAmount: "51" }, as(C))).body.error.code).toBe("COUNTED_EXCEEDS_DECLARED");
    const done = ok(await api("POST", `/api/v1/distribution/handovers/${h.id}/confirm`, { countedAmount: "48" }, as(C)), 200);
    expect(done.shortage).toBe("2.0000");
    expect(await gl("1112")).toBe("0.0000");
    expect(await gl("1111")).toBe("48.0000");
    expect(await gl("1132")).toBe("2.0000");
  });

  it("day settlement: full count required; supervisor approval charges shortages to the rep", async () => {
    expect((await api("POST", "/api/v1/field/settlements", { settlementDate: today, counts: [] }, as(R))).body.error.code).toBe("COUNT_INCOMPLETE");
    const s = ok(await api("POST", "/api/v1/field/settlements", { settlementDate: today, counts: [{ itemId: chips, countedQty: "165" }] }, as(R)));
    expect(s.lines[0].diff).toBe("-3.0000");
    expect((await api("POST", `/api/v1/distribution/settlements/${s.id}/approve`, {}, as(R))).status).toBe(403);
    const a = ok(await api("POST", `/api/v1/distribution/settlements/${s.id}/approve`, {}, as(S)), 200);
    expect(a.shortage_value).toBe("2.4000"); // 3 × 0.8
    expect(await vanQty(wh.VAN1)).toBe("165.0000");
    expect(await gl("1132")).toBe("4.4000");
  });

  it("commissions on collected money: flat and tiered; finance posts with SoD", async () => {
    const run = ok(await api("POST", "/api/v1/distribution/commission-runs", { companyId: T.companyId, period }, as(F1)));
    const l1 = run.lines.find((l: any) => l.rep_code === "R1");
    expect([l1.collected, l1.commission]).toEqual(["50.0000", "1.0000"]); // (30 cash + 20 collected) × 2%; the credit sale itself earns nothing until collected
    expect((await api("POST", `/api/v1/distribution/commission-runs/${run.id}/post`, {}, as(F1))).body.error.code).toBe("SEGREGATION_OF_DUTIES");
    expect((await api("POST", `/api/v1/distribution/commission-runs/${run.id}/post`, {}, as(S))).status).toBe(403); // sales manager cannot pay commissions
    ok(await api("POST", `/api/v1/distribution/commission-runs/${run.id}/post`, {}, as(F2)), 200);
    expect(await gl("5301")).toBe("1.0000");
    expect(await gl("2107")).toBe("-1.0000");
    const tiered = await withTenant(T.tenantId, null, async (db) => commissionFor(db, (await db.query("SELECT * FROM sales_reps WHERE id = $1", [rep2.id])).rows[0], "250", 3));
    expect(tiered).toBe("5.500"); // 100 × 1% + 150 × 3%
  });

  it("performance vs targets", async () => {
    const p = ok(await api("GET", `/api/v1/distribution/performance?companyId=${T.companyId}&period=${period}`, undefined, as(S)), 200);
    const r1 = p.reps.find((r: any) => r.code === "R1");
    expect([r1.sales, r1.collected, r1.visits]).toEqual(["87.0000", "50.0000", "1"]);
    expect(r1.achievement).toEqual({ sales: 50, collection: 50, visits: 25 });
  });

  it("isolation between reps and roles", async () => {
    const d2 = ok(await api("GET", "/api/v1/field/my-day", undefined, as(R2)), 200);
    expect([d2.route.length, d2.van.length, d2.custody]).toEqual([0, 0, "0.0000"]);
    const steal = ok(await sync(R2, [inv("op-r2-00001", c1.id, "cash", [{ itemId: chips, qty: "1" }])]), 200);
    expect(steal.results[0].error.code).toBe("CUSTOMER_NOT_ASSIGNED");
    expect((await api("GET", `/api/v1/distribution/reps?companyId=${T.companyId}`, undefined, as(R))).status).toBe(403);
    expect((await api("GET", "/api/v1/field/my-day", undefined, as(S))).body.error.code).toBe("FORBIDDEN");
  });

  it("GPS policy, when the company enables it", async () => {
    ok(await api("PATCH", "/api/v1/settings", { fieldGpsRequired: true }, as(T)), 200);
    const v = ok(await sync(R, [{ clientId: "op-gps-00001", type: "visit", payload: { customerId: c1.id, outcome: "no_order", visitedAt: new Date().toISOString() } }]), 200);
    expect(v.results[0].error.code).toBe("GPS_REQUIRED");
    const v2 = ok(await sync(R, [{ clientId: "op-gps-00001", type: "visit", payload: { customerId: c1.id, outcome: "no_order", visitedAt: new Date().toISOString(), lat: 32.88, lng: 13.19 } }]), 200);
    expect(v2.results[0].ok).toBe(true); // a failed op is not recorded, so the same clientId can be retried
  });

  it("recall queues a WhatsApp notice for affected customers with a phone number", async () => {
    const lot = (await api("GET", `/api/v1/inventory/lots?companyId=${T.companyId}&q=L1`, undefined, as(T))).body[0];
    const rc = ok(await api("POST", "/api/v1/quality/recalls", { companyId: T.companyId, lotId: lot.id, reason: "اختبار استدعاء" }, as(T)));
    expect(rc.notificationsQueued).toBe(1); // C1 has a phone; C2 has none
    const out = ok(await api("GET", "/api/v1/distribution/notifications?status=queued", undefined, as(S)), 200);
    expect(out[0]).toMatchObject({ channel: "whatsapp", recipient: "+218910000001", template: "product_recall", party_code: "C1" });
    const blocked = ok(await sync(R, [inv("op-rc-000001", c1.id, "cash", [{ itemId: chips, qty: "1" }])]), 200);
    expect(blocked.results[0].error.code).toBe("INSUFFICIENT_LOT_STOCK"); // recalled lot cannot be sold from the van
  });

  it("books reconcile", async () => {
    expect(ok(await api("GET", `/api/v1/inventory/valuation-check?companyId=${T.companyId}`, undefined, as(T)), 200).reconciled).toBe(true);
    expect((await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T))).body.totals.balanced).toBe(true);
  });
});
