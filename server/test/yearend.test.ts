import { describe, it, expect, beforeAll } from "vitest";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";

const Y = new Date().getUTCFullYear() - 2;   // a past year, closed while the next one is in use
describe("year-end close (K5)", () => {
  let T: any, A: any, acc: Record<string, string>, fy: any;
  const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const as = (w: any) => ({ token: w.token });
  const entry = async (date: string, lines: any[]) => {
    const d = ok(await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: date, memo: "قيد اختبار", lines }, as(T)));
    return ok(await api("POST", `/api/v1/accounting/journal-entries/${d.id}/post`, {}, as(A)), 200);
  };
  const tb = async (from: string, to: string) => ok(await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${from}&to=${to}`, undefined, as(T)), 200);
  const bal = (t: any, code: string) => t.rows.find((r: any) => r.code === code)?.closing ?? "0";
  const fs = async () => ok(await api("GET", `/api/v1/accounting/reports/financial-statements?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(T)), 200);

  beforeAll(async () => {
    const p = await platformToken();
    T = await provision(p, (await createPlan(p, { modules: ["accounting"] })).code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    fy = ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y + 1}`, startDate: `${Y + 1}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    A = await createUser(T, [{ roleId: await roleId(T.token, "finance_manager") }]);
    await entry(`${Y}-03-10`, [{ accountId: acc["1111"], debit: "1000" }, { accountId: acc["401"], credit: "1000" }]);   // sales
    await entry(`${Y}-06-10`, [{ accountId: acc["5302"], debit: "300" }, { accountId: acc["1111"], credit: "300" }]);    // expense
  });

  it("refuses while drafts exist; closes into retained earnings; the year's income statement still shows", async () => {
    const d = ok(await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: `${Y}-12-01`, memo: "مسودة",
      lines: [{ accountId: acc["5302"], debit: "5" }, { accountId: acc["1111"], credit: "5" }] }, as(T)));
    expect((await api("POST", `/api/v1/accounting/fiscal-years/${fy.id}/close`, {}, as(A))).body.error.code).toBe("DRAFTS_EXIST");
    ok(await api("DELETE", `/api/v1/accounting/journal-entries/${d.id}`, undefined, as(T)), 200);
    expect((await api("POST", `/api/v1/accounting/fiscal-years/${fy.id}/close`, {}, as(createUserless()))).status).toBe(401);
    const r = ok(await api("POST", `/api/v1/accounting/fiscal-years/${fy.id}/close`, {}, as(A)), 200);
    expect(r.year.status).toBe("closed");
    const t = await tb(`${Y}-01-01`, `${Y}-12-31`);
    expect([bal(t, "401"), bal(t, "5302")]).toEqual(["0.0000", "0.0000"]);               // P&L zeroed
    const re = t.rows.find((x: any) => x.code === "302" || x.name_en?.toLowerCase().includes("retained"));
    expect(Number(re.closing)).toBe(-700);                                                  // profit 700 credited
    const s = await fs();
    expect([s.incomeStatement.revenue, s.incomeStatement.netIncome, s.balanceSheet.unclosedEarnings, s.balanceSheet.balanced]).toEqual([1000, 700, 0, true]);
    // nothing can be posted into the closed year
    const late = ok(await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: `${Y}-11-01`, memo: "متأخر",
      lines: [{ accountId: acc["5302"], debit: "1" }, { accountId: acc["1111"], credit: "1" }] }, as(T)));
    expect((await api("POST", `/api/v1/accounting/journal-entries/${late.id}/post`, {}, as(A))).status).not.toBe(200);
    ok(await api("DELETE", `/api/v1/accounting/journal-entries/${late.id}`, undefined, as(T)), 200);
  });

  it("reopen reverses the closing entry (reason required); closing again works", async () => {
    expect((await api("POST", `/api/v1/accounting/fiscal-years/${fy.id}/reopen`, {}, as(A))).status).toBe(422);
    ok(await api("POST", `/api/v1/accounting/fiscal-years/${fy.id}/reopen`, { reason: "تصحيح مصروف منسي" }, as(A)), 200);
    expect(bal(await tb(`${Y}-01-01`, `${Y}-12-31`), "401")).toBe("-1000.0000");
    await entry(`${Y}-12-31`, [{ accountId: acc["5302"], debit: "50" }, { accountId: acc["1111"], credit: "50" }]);
    ok(await api("POST", `/api/v1/accounting/fiscal-years/${fy.id}/close`, {}, as(A)), 200);
    const s = await fs();
    expect([s.incomeStatement.netIncome, s.balanceSheet.unclosedEarnings, s.balanceSheet.balanced]).toEqual([650, 0, true]);
  });
});
function createUserless() { return { token: "invalid" }; }
