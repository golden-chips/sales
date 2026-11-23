// POS rush-hour load test (DEMO tenant only).
// N cashiers on N registers sell back-to-back at the same time; ~10% of sales are sent twice at once
// (double click / network retry). Afterwards it checks that nothing was lost or duplicated:
// invoice count, stock movement and each drawer's expected cash must match what was sold.
//
//   node tools/loadtest/pos-rush.mjs http://localhost:4000 <gm-password> [cashiers=10] [salesEach=40] [thinkMs=0]
// The API must run with LOGIN_RATE_LIMIT_PER_MIN raised (it logs in N+2 users) — test servers only.
// The company's plan limit (api_rpm) also applies: to measure the server itself run it with TENANT_RATE_LIMIT=off.
const [base = "http://localhost:4000", pw, nArg = "10", mArg = "40", thinkArg = "0"] = process.argv.slice(2);
if (!pw) { console.error("usage: pos-rush.mjs <baseUrl> <gm-password> [cashiers] [salesEach]"); process.exit(1); }
const N = Number(nArg), M = Number(mArg), THINK = Number(thinkArg), TENANT = "demo-foods";   // THINK: ms a cashier spends scanning before the next sale (0 = flat out)
const run = Date.now().toString(36);

async function call(token, method, path, body) {
  const t0 = performance.now();
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ms = performance.now() - t0;
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j, ms };
}
const must = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 300)}`); return r.body; };
const login = async (email, password) => must(await call(null, "POST", "/auth/login", { tenant: TENANT, email, password }), `login ${email}`).accessToken;

const gm = await login("gm@demo-foods.example", pw);
const me = must(await call(gm, "GET", "/auth/me"), "me");
if (!me.tenant.is_demo) throw new Error("refusing: not a DEMO tenant");
const C = me.companies[0].id;
const acc = Object.fromEntries(must(await call(gm, "GET", `/accounting/accounts?companyId=${C}`), "accounts").map((a) => [a.code, a.id]));
const wh = Object.fromEntries(must(await call(gm, "GET", "/warehouses"), "warehouses").map((w) => [w.code, w]));
const items = must(await call(gm, "GET", `/items?companyId=${C}&pageSize=200`), "items").data;
const sellable = items.filter((i) => ["DEMO-CHIPS-40", "DEMO-CORN-25"].includes(i.code));
const walkIn = must(await call(gm, "GET", `/customers?companyId=${C}&pageSize=50`), "customers").data[0];
const branch = must(await call(gm, "GET", "/branches"), "branches")[0].id;
const cashierRole = must(await call(gm, "GET", "/roles"), "roles").find((r) => r.code === "cashier").id;

// stock for the rush: its own lots in its own warehouse so the check is exact
const shop = must(await call(gm, "POST", "/warehouses", { branchId: branch, code: `LOAD-${run}`.toUpperCase().slice(0, 20), nameAr: `اختبار الضغط ${run}`, kind: "finished_goods" }), "warehouse");
const opening = must(await call(gm, "POST", "/inventory/documents", { companyId: C, reason: "opening", warehouseId: shop.id, docDate: new Date().toISOString().slice(0, 10),
  lines: sellable.map((i, k) => ({ itemId: i.id, qtyDelta: "100000", unitCost: "0.5", lotNo: `LOAD-${run}-${k}`, productionDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10) })) }), "opening");
const wm = await login("warehouse@demo-foods.example", pw);
must(await call(wm, "POST", `/inventory/documents/${opening.id}/post`, {}), "post opening");

// N cashiers, N registers, N open shifts
const cashiers = [];
for (let k = 1; k <= N; k++) {
  const email = `load-${run}-${k}@demo-foods.example`;
  must(await call(gm, "POST", "/users", { email, fullName: `DEMO كاشير ضغط ${k}`, password: pw, roles: [{ roleId: cashierRole }] }), "user");
  const reg = must(await call(gm, "POST", "/pos/registers", { companyId: C, branchId: branch, code: `L${run}${k}`.toUpperCase().slice(0, 20), nameAr: `ضغط ${k}`, warehouseId: shop.id,
    returnWarehouseId: wh["DEMO-QC"].id, walkInCustomerId: walkIn.id, cashAccountId: acc["1113"], safeAccountId: acc["1111"], varianceAccountId: acc["404"], maxDiscountPct: "5" }), "register");
  const token = await login(email, pw);
  const shift = must(await call(token, "POST", "/pos/shifts", { registerId: reg.id, openingFloat: "0" }), "open shift");
  cashiers.push({ k, token, shiftId: shift.shift.id });
}
console.log(`set-up done: ${N} cashiers × ${M} sales each, ~10% sent twice at once`);

const lat = [], errors = [];
let sold = 0, dupSent = 0, replayed = 0;
const soldQty = Object.fromEntries(sellable.map((i) => [i.id, 0]));
let soldValue = 0;
const t0 = performance.now();
await Promise.all(cashiers.map(async (c) => {
  for (let s = 0; s < M; s++) {
    if (THINK) await new Promise((r) => setTimeout(r, THINK * (0.5 + Math.random())));
    const lines = sellable.slice(0, 1 + (s % sellable.length)).map((i, k) => ({ itemId: i.id, qty: String(1 + ((s + k) % 4)) }));
    const total = lines.reduce((a, l) => a + Number(sellable.find((i) => i.id === l.itemId).sales_price) * Number(l.qty), 0);
    const body = { clientId: `${run}-${c.k}-${s}`, lines, cash: total.toFixed(3), tendered: (Math.ceil(total / 5) * 5).toFixed(3) };
    const twice = s % 10 === 3;
    const reqs = twice ? [call(c.token, "POST", `/pos/shifts/${c.shiftId}/sales`, body), call(c.token, "POST", `/pos/shifts/${c.shiftId}/sales`, body)] : [call(c.token, "POST", `/pos/shifts/${c.shiftId}/sales`, body)];
    if (twice) dupSent++;
    const res = await Promise.all(reqs);
    for (const r of res) {
      lat.push(r.ms);
      if (r.status >= 300) errors.push(`${r.status} ${r.body?.error?.code}`);
      else if (r.body.replayed) replayed++;
    }
    if (res.some((r) => r.status < 300)) { sold++; soldValue += total; for (const l of lines) soldQty[l.itemId] += Number(l.qty); }
  }
}));
const secs = (performance.now() - t0) / 1000;

// correctness
const invoices = (await Promise.all(cashiers.map(async (c) => must(await call(c.token, "GET", `/pos/shifts/${c.shiftId}`), "z").totals.invoices))).reduce((a, n) => a + n, 0);
const expected = (await Promise.all(cashiers.map(async (c) => Number(must(await call(c.token, "GET", `/pos/shifts/${c.shiftId}`), "z").expectedCash)))).reduce((a, n) => a + n, 0);
const stock = must(await call(gm, "GET", `/inventory/stock?companyId=${C}&warehouseId=${shop.id}`), "stock");
const moved = Object.fromEntries(sellable.map((i) => [i.code, 100000 - Number(stock.filter((x) => x.item_id === i.id || x.itemId === i.id).reduce((a, x) => a + Number(x.qty), 0))]));
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(0);
const report = {
  cashiers: N, thinkMs: THINK, salesAttempted: N * M, doubleSubmits: dupSent, seconds: secs.toFixed(1), salesPerSecond: (sold / secs).toFixed(1),
  latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: lat[lat.length - 1].toFixed(0) },
  errors: errors.length, errorKinds: [...new Set(errors)],
  checks: {
    invoicesMatch: invoices === sold, invoices, sold, replayedDuplicates: replayed,
    stockMatches: sellable.every((i) => moved[i.code] === soldQty[i.id]), stockMoved: moved,
    cashMatches: Math.abs(expected - soldValue) < 0.001, expectedCash: expected.toFixed(3), soldValue: soldValue.toFixed(3),
  },
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.errors || !report.checks.invoicesMatch || !report.checks.stockMatches || !report.checks.cashMatches ? 1 : 0);
