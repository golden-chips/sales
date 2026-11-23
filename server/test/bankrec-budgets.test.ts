import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear();
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("bank reconciliation and budgets (K5)", () => {
  let T: any, A: any, acc: Record<string, string>, fy: any, prev: any;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const entry = async (date: string, lines: any[]) => {
    const d = ok(await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: date, memo: "حركة", lines }, as(T)));
    return ok(await api("POST", `/api/v1/accounting/journal-entries/${d.id}/post`, {}, as(A)), 200);
  };
  beforeAll(async () => {
    const p = await platformToken();
    T = await provision(p, (await createPlan(p, { modules: ["accounting"] })).code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    prev = ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y - 1}`, startDate: `${Y - 1}-01-01` }, as(T)));
    fy = ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    A = await createUser(T, [{ roleId: await roleId(T.token, "finance_manager") }]);
    // ledger: bank receives 500 (Mar 2), pays 120 (Mar 5), pays 80 by cheque not yet cashed (Mar 30)
    await entry(D(3, 2), [{ accountId: acc["1121"], debit: "500" }, { accountId: acc["401"], credit: "500" }]);
    await entry(D(3, 5), [{ accountId: acc["5302"], debit: "120" }, { accountId: acc["1121"], credit: "120" }]);
    await entry(D(3, 30), [{ accountId: acc["5302"], debit: "80" }, { accountId: acc["1121"], credit: "80" }]);
    // last year's actuals for the budget copy
    await entry(`${Y - 1}-02-10`, [{ accountId: acc["1111"], debit: "1000" }, { accountId: acc["401"], credit: "1000" }]);
  });

  it("statement auto-matches by amount and date; bank fee becomes a draft entry; reconciles with an uncleared cheque", async () => {
    const bad = await api("POST", "/api/v1/accounting/bank-statements", { companyId: T.companyId, accountId: acc["1121"], statementDate: D(3, 31), openingBalance: "0", closingBalance: "999",
      lines: [{ txnDate: D(3, 3), description: "إيداع", amount: "500" }] }, as(A));
    expect(bad.body.error.code).toBe("STATEMENT_UNBALANCED");
    const s = ok(await api("POST", "/api/v1/accounting/bank-statements", { companyId: T.companyId, accountId: acc["1121"], statementDate: D(3, 31), openingBalance: "0", closingBalance: "375",
      lines: [{ txnDate: D(3, 3), description: "إيداع نقدي", amount: "500" }, { txnDate: D(3, 6), description: "صرف شيك", amount: "-120" }, { txnDate: D(3, 31), description: "عمولة مصرف", amount: "-5" }] }, as(A)));
    expect(s.lines.map((l: any) => !!l.journal_line_id)).toEqual([true, true, false]);
    expect([s.unmatched, s.canReconcile]).toEqual([1, false]);
    expect((await api("POST", `/api/v1/accounting/bank-statements/${s.id}/reconcile`, {}, as(A))).body.error.code).toBe("UNMATCHED_LINES");
    // the fee: draft entry by the reconciler, posted by someone else (SoD), then matched automatically
    const fee = s.lines[2];
    const withDraft = ok(await api("POST", `/api/v1/accounting/bank-statement-lines/${fee.id}/adjust`, { accountId: acc["5302"], memo: "عمولة مصرفية مارس" }, as(A)), 200);
    const draftId = withDraft.lines[2].draft_entry_id;
    ok(await api("POST", `/api/v1/accounting/journal-entries/${draftId}/post`, {}, as(T)), 200);
    const m = ok(await api("POST", `/api/v1/accounting/bank-statements/${s.id}/auto-match`, {}, as(A)), 200);
    expect(m.matched).toBe(1);
    // ledger 500 − 120 − 80 − 5 = 295; the uncashed cheque (−80) explains the difference to the bank's 375
    expect([m.statement.glBalance, m.statement.unclearedTotal, m.statement.difference, m.statement.canReconcile]).toEqual(["295.0000", "-80.0000", "0.0000", true]);
    const done = ok(await api("POST", `/api/v1/accounting/bank-statements/${s.id}/reconcile`, {}, as(A)), 200);
    expect(done.status).toBe("reconciled");
    expect((await api("POST", `/api/v1/accounting/bank-statement-lines/${fee.id}/match`, { journalLineId: null }, as(A))).body.error.code).toBe("STATEMENT_RECONCILED");
  });

  it("a ledger line can be matched only once and only with the same amount", async () => {
    const s = ok(await api("POST", "/api/v1/accounting/bank-statements", { companyId: T.companyId, accountId: acc["1121"], statementDate: D(4, 30), openingBalance: "375", closingBalance: "295",
      lines: [{ txnDate: D(4, 2), description: "صرف شيك متأخر", amount: "-80" }] }, as(A)));
    expect(s.lines[0].journal_line_id).toBeTruthy();                   // the March cheque, cleared in April
    const other = (await api("GET", `/api/v1/accounting/bank-statements/${s.id}`, undefined, as(A))).body;
    expect(other.canReconcile).toBe(true);
  });

  it("first statement of an account with older history: older ledger items sit in the opening balance, not in 'uncleared'", async () => {
    await entry(D(5, 10), [{ accountId: acc["1111"], debit: "200" }, { accountId: acc["401"], credit: "200" }]);
    const s = ok(await api("POST", "/api/v1/accounting/bank-statements", { companyId: T.companyId, accountId: acc["1111"], statementDate: D(5, 31), openingBalance: "1000", closingBalance: "1200",
      lines: [{ txnDate: D(5, 11), description: "إيداع", amount: "200" }] }, as(A)));
    expect([s.reconciliationStart.slice(0, 10), s.uncleared.length, s.difference, s.canReconcile]).toEqual([D(5, 11), 0, "0.0000", true]);   // matched to the 10 May deposit; the older 1000 is in the opening balance
    const m = await api("POST", `/api/v1/accounting/bank-statement-lines/${s.lines[0].id}/match`, { journalLineId: null }, as(A));
    expect(m.status).toBe(200);
  });

  it("budget from last year's actuals + 10%, approved by someone else, compared with actuals", async () => {
    const b = ok(await api("POST", "/api/v1/accounting/budgets", { companyId: T.companyId, fiscalYearId: fy.id, name: "الموازنة الأساسية", copyActualFromYearId: prev.id, growthPct: 10 }, as(T)));
    const rev = b.lines.find((l: any) => l.code === "401");
    expect(rev.amounts[1]).toBe("1100.0000");                          // Feb last year 1000 → +10%
    // add an expense budget of 50 / month
    const lines = b.lines.map((l: any) => ({ accountId: l.account_id, amounts: l.amounts }));
    lines.push({ accountId: acc["5302"], amounts: Array(12).fill("50") });
    ok(await api("PUT", `/api/v1/accounting/budgets/${b.id}/lines`, { lines }, as(T)), 200);
    expect((await api("POST", `/api/v1/accounting/budgets/${b.id}/approve`, {}, as(T))).body.error.code).toBe("SEGREGATION_OF_DUTIES");
    ok(await api("POST", `/api/v1/accounting/budgets/${b.id}/approve`, {}, as(A)), 200);
    expect((await api("PUT", `/api/v1/accounting/budgets/${b.id}/lines`, { lines }, as(T))).body.error.code).toBe("BUDGET_APPROVED");
    const r = ok(await api("GET", `/api/v1/accounting/budgets/${b.id}/vs-actual?asOf=${D(3, 31)}`, undefined, as(T)), 200);
    const exp = r.rows.find((x: any) => x.code === "5302");
    expect([exp.budget_ytd, exp.actual_ytd, exp.favourable]).toEqual(["150.0000", "205.0000", false]);   // 3 months × 50 vs 120 + 80 + 5
    const sales = r.rows.find((x: any) => x.code === "401");
    expect([sales.budget_ytd, sales.actual_ytd, sales.favourable]).toEqual(["1100.0000", "500.0000", false]);
    expect(exp.actual_months[2]).toBe("205.0000");
  });
});
