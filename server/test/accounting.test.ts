import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { api, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";
import { withTenant } from "../src/db/pool.js";
import { loadUserCtx } from "../src/core/auth.js";
import { postFromSource } from "../src/modules/accounting/accounting.service.js";

const Y = new Date().getUTCFullYear();
const D = (m: number, d: number) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("general ledger", () => {
  let T: any, acc: Record<string, string>, accountant: any, accountant2: any;

  const draft = (token: string, lines: any[], over: any = {}) =>
    api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: D(3, 10), memo: "قيد اختبار", lines, ...over }, { token });
  const cashSale = (amt: string) => [{ accountId: acc["1111"], debit: amt }, { accountId: acc["401"], credit: amt }];

  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p);
    T = await provision(p, plan.code);
    const seed = await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, { token: T.token });
    expect(seed.status).toBe(201);
    const list = await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, { token: T.token });
    acc = Object.fromEntries(list.body.map((a: any) => [a.code, a.id]));
    const fy = await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, { token: T.token });
    expect(fy.status).toBe(201);
    const r = await roleId(T.token, "accountant");
    accountant = await createUser(T, [{ roleId: r }]);
    accountant2 = await createUser(T, [{ roleId: r }]);
  });

  it("seeded CoA has headers, leaves, contra accounts and roles", async () => {
    const list = (await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, { token: T.token })).body;
    const byCode = Object.fromEntries(list.map((a: any) => [a.code, a]));
    expect(byCode["1"].is_postable).toBe(false);
    expect(byCode["1131"].role).toBe("ar");
    expect(byCode["402"].normal_balance).toBe("debit");
    expect(byCode["1221"].normal_balance).toBe("credit");
    expect(list.filter((a: any) => a.role).length).toBeGreaterThan(30);
  });

  it("fiscal year generates 12 contiguous monthly periods", async () => {
    const r = await api("GET", `/api/v1/accounting/fiscal-years?companyId=${T.companyId}`, undefined, { token: T.token });
    const periods = r.body[0].periods;
    expect(periods.length).toBe(12);
    expect(periods[1].start_date).toBe(`${Y}-02-01`);
    expect(periods[1].end_date).toBe(`${Y}-02-${new Date(Date.UTC(Y, 2, 0)).getUTCDate()}`);
  });

  it("overlapping fiscal year is rejected", async () => {
    const r = await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: "dup", startDate: `${Y}-06-01` }, { token: T.token });
    expect(r.status).toBe(409);
  });

  it("rejects a line with both debit and credit", async () => {
    const r = await draft(accountant.token, [{ accountId: acc["1111"], debit: "10", credit: "10" }, { accountId: acc["401"], credit: "10" }]);
    expect(r.status).toBe(422);
  });

  it("an unbalanced draft can be saved but never posted", async () => {
    const d = await draft(accountant.token, [{ accountId: acc["1111"], debit: "100" }, { accountId: acc["401"], credit: "90" }]);
    expect(d.status).toBe(201);
    const p = await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/post`, {}, { token: accountant2.token });
    expect(p.status).toBe(422);
    expect(p.body.error.code).toBe("UNBALANCED_ENTRY");
  });

  it("database rejects posting an unbalanced entry even if the service check is bypassed", async () => {
    const d = await draft(accountant.token, [{ accountId: acc["1111"], debit: "50" }, { accountId: acc["401"], credit: "40" }]);
    const fp = (await withTenant(T.tenantId, null, (db) => db.query("SELECT id FROM fiscal_periods WHERE $1::date BETWEEN start_date AND end_date", [D(3, 10)]))).rows[0].id;
    await expect(withTenant(T.tenantId, null, (db) =>
      db.query("UPDATE journal_entries SET status='posted', number='HACK-1', period_id=$2, posted_by=created_by, posted_at=now() WHERE id=$1", [d.body.id, fp]))).rejects.toThrow(/unbalanced/);
  });

  it("segregation of duties: creator cannot post own entry; another accountant can", async () => {
    const d = await draft(accountant.token, cashSale("250.125"));
    const self = await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/post`, {}, { token: accountant.token });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("SEGREGATION_OF_DUTIES");
    const other = await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/post`, {}, { token: accountant2.token });
    expect(other.status).toBe(200);
    expect(other.body.status).toBe("posted");
    expect(other.body.number).toMatch(new RegExp(`^JV-${Y}-\\d{6}$`));
    expect(other.body.lines[0].debit).toBe("250.1250");
  });

  it("posted entries and their lines are immutable at the database level", async () => {
    const d = await draft(accountant.token, cashSale("10"));
    const posted = await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/post`, {}, { token: accountant2.token });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    // read-your-writes: the reply is sent only after COMMIT (K12 root cause — see KNOWN_ISSUES)
    const seen = await withTenant(T.tenantId, null, async (db) => (await db.query("SELECT status FROM journal_entries WHERE id = $1", [d.body.id])).rows[0]);
    expect(seen.status).toBe("posted");
    const upd = await withTenant(T.tenantId, null, (db) => db.query("UPDATE journal_lines SET debit = 999 WHERE entry_id = $1 AND debit > 0", [d.body.id])).then((r) => r, (e) => e);
    expect(upd).toBeInstanceOf(Error);
    expect((upd as Error).message).toMatch(/immutable/);
    await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE journal_entries SET memo = 'changed' WHERE id = $1", [d.body.id]))).rejects.toThrow(/immutable/);
    await expect(withTenant(T.tenantId, null, (db) => db.query("DELETE FROM journal_entries WHERE id = $1", [d.body.id]))).rejects.toThrow(/cannot be deleted/);
    const api1 = await api("PUT", `/api/v1/accounting/journal-entries/${d.body.id}`, { companyId: T.companyId, entryDate: D(3, 10), memo: "x", lines: cashSale("1") }, { token: accountant.token });
    expect(api1.status).toBe(422);
  });

  it("reversal creates a mirrored posted entry and nets to zero; cannot reverse twice", async () => {
    const d = await draft(accountant.token, cashSale("77.5"));
    await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/post`, {}, { token: accountant2.token });
    const ownerReverse = await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/reverse`, { reason: "خطأ في المبلغ" }, { token: T.token });
    expect(ownerReverse.status).toBe(201);
    expect(ownerReverse.body.number).toMatch(/^JR-/);
    expect(ownerReverse.body.lines[0].credit).toBe("77.5000");
    const orig = await api("GET", `/api/v1/accounting/journal-entries/${d.body.id}`, undefined, { token: T.token });
    expect(orig.body.status).toBe("reversed");
    expect(orig.body.reversed_by).toBe(ownerReverse.body.id);
    const again = await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/reverse`, { reason: "مرة ثانية" }, { token: T.token });
    expect(again.status).toBe(422);
    const revOfRev = await api("POST", `/api/v1/accounting/journal-entries/${ownerReverse.body.id}/reverse`, { reason: "عكس العكس" }, { token: T.token });
    expect(revOfRev.status).toBe(422);
  });

  it("accountant (without reverse permission) cannot reverse", async () => {
    const d = await draft(accountant.token, cashSale("5"));
    await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/post`, {}, { token: accountant2.token });
    expect((await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/reverse`, { reason: "محاولة" }, { token: accountant.token })).status).toBe(403);
  });

  it("header (non-postable) accounts cannot be posted to", async () => {
    const d = await draft(accountant.token, [{ accountId: acc["111"], debit: "5" }, { accountId: acc["401"], credit: "5" }]);
    const p = await api("POST", `/api/v1/accounting/journal-entries/${d.body.id}/post`, {}, { token: accountant2.token });
    expect(p.body.error.code).toBe("ACCOUNT_NOT_POSTABLE");
  });

  it("period close is blocked by drafts; posting into a closed period is rejected", async () => {
    const fy = (await api("GET", `/api/v1/accounting/fiscal-years?companyId=${T.companyId}`, undefined, { token: T.token })).body[0];
    const jan = fy.periods[0];
    const d = await draft(accountant.token, cashSale("20"), { entryDate: D(1, 15) });
    const blocked = await api("POST", `/api/v1/accounting/periods/${jan.id}/close`, {}, { token: T.token });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/draft/);
    await api("DELETE", `/api/v1/accounting/journal-entries/${d.body.id}`, undefined, { token: accountant.token });
    expect((await api("POST", `/api/v1/accounting/periods/${jan.id}/close`, {}, { token: T.token })).status).toBe(200);
    const late = await draft(accountant.token, cashSale("20"), { entryDate: D(1, 20) });
    const p = await api("POST", `/api/v1/accounting/journal-entries/${late.body.id}/post`, {}, { token: accountant2.token });
    expect(p.body.error.code).toBe("PERIOD_CLOSED");
    expect((await api("POST", `/api/v1/accounting/periods/${jan.id}/reopen`, {}, { token: T.token })).status).toBe(422); // reason required
    expect((await api("POST", `/api/v1/accounting/periods/${jan.id}/reopen`, { reason: "تسوية متأخرة معتمدة" }, { token: T.token })).status).toBe(200);
  });

  it("foreign currency: USD entry converted to LYD at 3 decimals using the dated rate", async () => {
    await api("POST", "/api/v1/accounting/exchange-rates", { fromCurrency: "USD", toCurrency: "LYD", rateDate: D(3, 1), rate: "4.8765" }, { token: accountant.token });
    const d = await draft(accountant.token, [{ accountId: acc["1121"], debit: "100.33" }, { accountId: acc["2101"], credit: "100.33" }], { currency: "USD" });
    expect(d.status).toBe(201);
    expect(d.body.lines[0].debit).toBe("489.2590"); // 100.33 * 4.8765 = 489.259245 → round to LYD 3 dp = 489.259
    expect(d.body.lines[0].amount_fc).toBe("100.3300");
    const missing = await draft(accountant.token, cashSale("1"), { currency: "EUR" });
    expect(missing.body.error.code).toBe("FX_RATE_MISSING");
  });

  it("Idempotency-Key replays the same response and rejects a different payload", async () => {
    const key = `k-${randomUUID()}`;
    const a = await draft(accountant.token, cashSale("33"));
    const r1 = await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: D(3, 11), memo: "idem", lines: cashSale("33") }, { token: accountant.token, headers: { "idempotency-key": key } });
    const r2 = await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: D(3, 11), memo: "idem", lines: cashSale("33") }, { token: accountant.token, headers: { "idempotency-key": key } });
    expect(r1.status).toBe(201); expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.headers["idempotent-replayed"]).toBe("true");
    const r3 = await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: D(3, 11), memo: "other", lines: cashSale("34") }, { token: accountant.token, headers: { "idempotency-key": key } });
    expect(r3.status).toBe(422);
    expect(a.status).toBe(201);
  });

  it("source documents post exactly once (integration contract)", async () => {
    const ctx = (await withTenant(T.tenantId, T.ownerUserId, (db) => loadUserCtx(db, T.ownerUserId, T.tenantId)))!;
    const e = { companyId: T.companyId, entryDate: D(3, 12), memo: "فاتورة مبيعات SI-1", sourceType: "sales_invoice", sourceId: "SI-1",
      lines: [{ accountId: acc["1131"], debit: "150" }, { accountId: acc["401"], credit: "150" }] };
    const first = await withTenant(T.tenantId, T.ownerUserId, (db) => postFromSource(db, ctx, e));
    const second = await withTenant(T.tenantId, T.ownerUserId, (db) => postFromSource(db, ctx, e));
    expect(first.replayed).toBe(false); expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    await expect(withTenant(T.tenantId, T.ownerUserId, (db) =>
      db.query("INSERT INTO journal_entries (tenant_id, company_id, entry_date, currency, memo, source_type, source_id, created_by) VALUES ($1,$2,$3,'LYD','dup','sales_invoice','SI-1',$4)",
        [T.tenantId, T.companyId, D(3, 12), T.ownerUserId]))).rejects.toThrow(/uq_journal_source/);
  });

  it("trial balance balances, ledger drills down, statements reconcile", async () => {
    const tb = await api("GET", `/api/v1/accounting/reports/trial-balance?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, { token: accountant.token });
    expect(tb.status).toBe(200);
    expect(tb.body.totals.balanced).toBe(true);
    const cash = tb.body.rows.find((r: any) => r.code === "1111");
    // only posted, non-reversed cash movements remain net: 250.125 + 10 + 5 (77.5 reversed nets 0)
    expect(cash.closing).toBe("265.1250");
    const ledger = await api("GET", `/api/v1/accounting/reports/ledger/${acc["1111"]}?from=${Y}-01-01&to=${Y}-12-31`, undefined, { token: accountant.token });
    expect(ledger.body.lines.at(-1).running_balance).toBe("265.1250");
    expect(ledger.body.lines[0].entry_id).toBeTruthy();
    const fs = await api("GET", `/api/v1/accounting/reports/financial-statements?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, { token: accountant.token });
    expect(fs.body.balanceSheet.balanced).toBe(true);
    expect(fs.body.incomeStatement.revenue).toBe(415.125);
  });

  it("account with a balance cannot be deactivated", async () => {
    const r = await api("PATCH", `/api/v1/accounting/accounts/${acc["1111"]}`, { isActive: false }, { token: T.token });
    expect(r.body.error.code).toBe("ACCOUNT_HAS_BALANCE");
  });

  it("every posting is in the audit trail, and the audit log is append-only", async () => {
    const log = await api("GET", "/api/v1/audit-log?action=journal.posted", undefined, { token: T.token });
    expect(log.body.total).toBeGreaterThanOrEqual(3);
    await expect(withTenant(T.tenantId, null, (db) => db.query("DELETE FROM audit_log"))).rejects.toThrow();
    await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE audit_log SET action = 'x'"))).rejects.toThrow();
  });
});
