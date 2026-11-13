import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
async function xlsx(headers: string[], rows: (string | number | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("data");
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

describe("go-live: opening balances, reconciliation, readiness, sign-offs, UAT", () => {
  let T: any, ACC: any, FIN: any, CASHIER: any, acc: Record<string, string>;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const imp = (kind: string, file: string, who: any) => api("POST", `/api/v1/import/${kind}`, { companyId: T.companyId, fileBase64: file, commit: true, date: `${Y}-01-01` }, as(who));
  const check = (r: any, key: string) => r.checks.find((c: any) => c.key === key);

  beforeAll(async () => {
    const p = await platformToken();
    T = await provision(p, (await createPlan(p, { modules: ["accounting", "sales", "purchasing", "inventory", "pos"] })).code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    ACC = await createUser(T, [{ roleId: await roleId(T.token, "accountant") }]);
    FIN = await createUser(T, [{ roleId: await roleId(T.token, "finance_manager") }]);
    CASHIER = await createUser(T, [{ roleId: await roleId(T.token, "cashier") }]);
    for (const [code, name] of [["C001", "سوبرماركت النور"], ["C002", "بقالة الأمل"]]) ok(await api("POST", "/api/v1/customers", { companyId: T.companyId, code, nameAr: name }, as(T)));
    ok(await api("POST", "/api/v1/suppliers", { companyId: T.companyId, code: "S001", nameAr: "مطاحن" }, as(T)));
  });

  it("readiness starts not ready, pointing at what is missing", async () => {
    const r = ok(await api("GET", `/api/v1/go-live/readiness?companyId=${T.companyId}`, undefined, as(ACC)), 200);
    expect(r.ready).toBe(false);
    expect([check(r, "coa").status, check(r, "coa_roles").status, check(r, "fiscal").status]).toEqual(["ok", "ok", "ok"]);
    expect([check(r, "coa_approved").status, check(r, "warehouses").status, check(r, "items").status]).toEqual(["fail", "fail", "fail"]);
  });

  it("opening receivables/payables become open documents: drafts → posted by another user; ageing and reconciliation agree", async () => {
    // AR/AP control accounts are refused in the plain GL opening import
    const gl = ok(await imp("opening_balances", await xlsx(["(account_code)", "(debit)", "(credit)"], [["1131", "500", null], ["304", null, "500"]]), ACC), 200);
    expect(gl.issueCount).toBe(1);
    expect(gl.issues[0].message).toContain("أرصدة العملاء/الموردين");
    const c = ok(await imp("customer_balances", await xlsx(["(party_code)", "(amount)", "(document_date)", "(due_date)", "(reference)"],
      [["C001", "1200.5", `${Y - 1}-12-10`, `${Y}-01-09`, "OLD-77"], ["C001", "300", `${Y - 1}-12-20`, `${Y}-01-19`, "OLD-81"], ["C002", "75", null, null, null], ["C999", "10", null, null, null]]), ACC), 200);
    expect([c.committed, c.issues[0].message]).toEqual([false, expect.stringContaining("C999")]);   // all or nothing
    ok(await imp("customer_balances", await xlsx(["(party_code)", "(amount)", "(document_date)", "(due_date)", "(reference)"],
      [["C001", "1200.5", `${Y - 1}-12-10`, `${Y}-01-09`, "OLD-77"], ["C001", "300", `${Y - 1}-12-20`, `${Y}-01-19`, "OLD-81"], ["C002", "75", null, null, null]]), ACC), 200);
    ok(await imp("supplier_balances", await xlsx(["(party_code)", "(amount)", "(reference)"], [["S001", "4000", "MILL-9"]]), ACC), 200);
    expect((await api("POST", "/api/v1/go-live/opening-documents/post", { companyId: T.companyId }, as(ACC))).body.error.code).toBe("SEGREGATION_OF_DUTIES");
    const posted = ok(await api("POST", "/api/v1/go-live/opening-documents/post", { companyId: T.companyId, cutoverDate: `${Y}-01-01` }, as(FIN)), 200);
    expect(posted).toEqual({ receivables: 3, payables: 1, receivablesTotal: "1575.5000" });
    const aging = ok(await api("GET", `/api/v1/sales/ar-aging?companyId=${T.companyId}&asOf=${Y}-01-31`, undefined, as(FIN)), 200);
    expect(aging.rows.find((x: any) => x.code === "C001").total).toBe("1500.5000");
    const rec = ok(await api("GET", `/api/v1/go-live/reconciliation?companyId=${T.companyId}`, undefined, as(ACC)), 200);
    expect(rec.balanced).toBe(true);
    expect(rec.rows.filter((r: any) => ["ar", "ap"].includes(r.key)).map((r: any) => [r.key, r.gl, r.subledger])).toEqual([["ar", "1575.5000", "1575.5000"], ["ap", "-4000.0000", "-4000.0000"]]);
    // a receipt is allocated to the oldest opening document
    const cust = (await api("GET", `/api/v1/customers?companyId=${T.companyId}&q=C001`, undefined, as(FIN))).body.data[0];
    const rc = ok(await api("POST", "/api/v1/sales/receipts", { companyId: T.companyId, partyId: cust.id, method: "cash", paymentDate: `${Y}-01-15`, amount: "1300" }, as(ACC)));
    ok(await api("POST", `/api/v1/sales/receipts/${rc.id}/post`, {}, as(FIN)), 200);
    const st = ok(await api("GET", `/api/v1/customers/${cust.id}/statement?from=${Y - 1}-01-01&to=${Y}-12-31`, undefined, as(FIN)), 200);
    expect(st.lines.map((l: any) => l.kind)).toEqual(["opening", "opening", "receipt"]);
    expect(st.lines.at(-1).balance).toBe("200.5000");
    expect(ok(await api("GET", `/api/v1/go-live/reconciliation?companyId=${T.companyId}`, undefined, as(ACC)), 200).balanced).toBe(true);
  });

  it("a GL-only change to a control account is caught by the reconciliation and blocks the opening sign-off", async () => {
    const je = ok(await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: `${Y}-01-20`, memo: "تسوية خاطئة على حساب الذمم",
      lines: [{ accountId: acc["1131"], debit: "50" }, { accountId: acc["304"], credit: "50" }] }, as(ACC)));
    ok(await api("POST", `/api/v1/accounting/journal-entries/${je.id}/post`, {}, as(FIN)), 200);
    const rec = ok(await api("GET", `/api/v1/go-live/reconciliation?companyId=${T.companyId}`, undefined, as(ACC)), 200);
    expect(rec.rows.find((r: any) => r.key === "ar")).toMatchObject({ ok: false, difference: "50.0000" });
    expect((await api("POST", "/api/v1/go-live/signoffs", { companyId: T.companyId, item: "opening_balances" }, as(FIN))).body.error.code).toBe("RECONCILIATION_FAILED");
    ok(await api("POST", `/api/v1/accounting/journal-entries/${je.id}/reverse`, { reason: "تصحيح" }, as(FIN)), 201);
    const s = ok(await api("POST", "/api/v1/go-live/signoffs", { companyId: T.companyId, item: "opening_balances", note: "مطابقة مع النظام القديم" }, as(FIN)));
    expect(s.evidence.balanced).toBe(true);
  });

  it("sign-offs need the right permission; go-live is refused while items are not ready", async () => {
    expect((await api("POST", "/api/v1/go-live/signoffs", { companyId: T.companyId, item: "chart_of_accounts" }, as(ACC))).status).toBe(403);   // accountant cannot manage accounts in the template
    ok(await api("POST", "/api/v1/go-live/signoffs", { companyId: T.companyId, item: "chart_of_accounts", note: "راجعه المحاسب القانوني" }, as(T)));
    expect((await api("POST", "/api/v1/go-live/signoffs", { companyId: T.companyId, item: "chart_of_accounts" }, as(T))).status).toBe(409);       // already signed
    const r = ok(await api("GET", `/api/v1/go-live/readiness?companyId=${T.companyId}`, undefined, as(T)), 200);
    expect([check(r, "coa_approved").status, check(r, "signoff_opening_balances").status, check(r, "reconciliation").status]).toEqual(["ok", "ok", "ok"]);
    const gl = await api("POST", "/api/v1/go-live/signoffs", { companyId: T.companyId, item: "go_live" }, as(T));
    expect(gl.body.error.code).toBe("NOT_READY");
    expect(gl.body.error.details).toEqual(expect.arrayContaining(["warehouses", "items", "signoff_uat"]));
    ok(await api("POST", "/api/v1/go-live/signoffs/revoke", { companyId: T.companyId, item: "chart_of_accounts", reason: "تعديل حسابات" }, as(T)), 200);
    expect(check(ok(await api("GET", `/api/v1/go-live/readiness?companyId=${T.companyId}`, undefined, as(T)), 200), "coa_approved").status).toBe("fail");
  });

  it("UAT: scenarios filtered by plan, failures need a description, latest result wins", async () => {
    const s = ok(await api("GET", `/api/v1/uat/scenarios?companyId=${T.companyId}`, undefined, as(CASHIER)), 200);
    expect(s.scenarios.map((x: any) => x.key)).toContain("pos.shift");
    expect(s.scenarios.map((x: any) => x.key)).not.toContain("mfg.order");      // manufacturing not in the plan
    expect((await api("POST", "/api/v1/uat/results", { companyId: T.companyId, scenarioKey: "pos.shift", status: "fail" }, as(CASHIER))).status).toBe(422);
    ok(await api("POST", "/api/v1/uat/results", { companyId: T.companyId, scenarioKey: "pos.shift", status: "fail", notes: "الإيصال لم يُطبع على طابعة البلوتوث" }, as(CASHIER)));
    ok(await api("POST", "/api/v1/uat/results", { companyId: T.companyId, scenarioKey: "pos.shift", status: "pass" }, as(CASHIER)));
    const after = ok(await api("GET", `/api/v1/uat/scenarios?companyId=${T.companyId}`, undefined, as(CASHIER)), 200);
    expect(after.scenarios.find((x: any) => x.key === "pos.shift").latest.status).toBe("pass");
    expect([after.summary.pass, after.summary.fail]).toEqual([1, 0]);
    expect(ok(await api("GET", `/api/v1/uat/results/pos.shift?companyId=${T.companyId}`, undefined, as(CASHIER)), 200).length).toBe(2);
    expect(TODAY.length).toBe(10);
  });
});
