// Bank reconciliation and budgets (K5).
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import { createDraft } from "./accounting.service.js";

const one = async (db: Db, sql: string, args: unknown[]) => (await db.query(sql, args)).rows[0];
const POSTED = "e.status IN ('posted','reversed')";
const ev = (db: Db, u: UserCtx, action: string, type: string, id: string, after?: unknown) =>
  audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action, entityType: type, entityId: id, after });

// ------------------------------------------------------------------ bank reconciliation
export async function createStatement(db: Db, u: UserCtx, b: { companyId: string; accountId: string; statementDate: string; reference?: string; openingBalance: string; closingBalance: string;
  lines: { txnDate: string; description: string; reference?: string; amount: string }[] }) {
  const a = await one(db, "SELECT * FROM accounts WHERE id = $1 AND company_id = $2", [b.accountId, b.companyId]);
  if (!a || a.type !== "asset" || !a.is_postable) throw E.validation([{ path: "accountId", message: "choose a postable bank or cash account" }]);
  const sum = b.lines.reduce((x, l) => x + Math.round(Number(l.amount) * 10000), 0);
  if (Math.round(Number(b.openingBalance) * 10000) + sum !== Math.round(Number(b.closingBalance) * 10000))
    throw E.rule("STATEMENT_UNBALANCED", `الرصيد الافتتاحي + الحركات (${(sum / 10000).toFixed(3)}) لا يساوي الرصيد الختامي في كشف المصرف`, "Opening + lines does not equal the closing balance");
  const s = await one(db, `INSERT INTO bank_statements (tenant_id, company_id, account_id, statement_date, reference, opening_balance, closing_balance, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [u.tenantId, b.companyId, b.accountId, b.statementDate, b.reference ?? null, b.openingBalance, b.closingBalance, u.userId]);
  let i = 0;
  for (const l of b.lines)
    await db.query("INSERT INTO bank_statement_lines (tenant_id, statement_id, line_no, txn_date, description, reference, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [u.tenantId, s.id, ++i, l.txnDate, l.description, l.reference ?? null, l.amount]);
  await ev(db, u, "bank_statement.created", "bank_statement", s.id, { account: a.code, date: b.statementDate, lines: b.lines.length });
  await autoMatch(db, u, s.id);
  return getStatement(db, s.id);
}

/** ledger lines of the account up to the statement date that no statement has matched yet (amount: + money in) */
const unclearedSql = `SELECT l.id, e.entry_date, e.number, coalesce(l.description, e.memo) AS description, (l.debit - l.credit)::numeric(20,4) AS amount
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE l.account_id = $1 AND ${POSTED} AND e.entry_date <= $2 AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.journal_line_id = l.id)
   ORDER BY e.entry_date, e.number`;

/** matches each unmatched statement line to an unmatched ledger line with the same amount, nearest date within ±7 days */
export async function autoMatch(db: Db, u: UserCtx, statementId: string) {
  const s = await one(db, "SELECT * FROM bank_statements WHERE id = $1 FOR UPDATE", [statementId]);
  if (!s) throw E.notFound("bank_statements");
  if (s.status === "reconciled") throw E.rule("STATEMENT_RECONCILED", "الكشف مسوّى ومقفل", "The statement is reconciled");
  const open = (await db.query("SELECT * FROM bank_statement_lines WHERE statement_id = $1 AND journal_line_id IS NULL ORDER BY line_no", [statementId])).rows;
  let matched = 0;
  for (const l of open) {
    const m = await one(db,
      `SELECT l.id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = $1 AND ${POSTED} AND (l.debit - l.credit) = $2::numeric AND abs(e.entry_date - $3::date) <= 7
          AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.journal_line_id = l.id)
        ORDER BY abs(e.entry_date - $3::date), e.entry_date LIMIT 1`, [s.account_id, l.amount, l.txn_date]);
    if (m) { await db.query("UPDATE bank_statement_lines SET journal_line_id = $2, matched_by = $3, matched_at = now() WHERE id = $1", [l.id, m.id, u.userId]); matched++; }
  }
  return { matched };
}

export async function matchLine(db: Db, u: UserCtx, lineId: string, journalLineId: string | null) {
  const l = await one(db, "SELECT b.*, s.account_id, s.status FROM bank_statement_lines b JOIN bank_statements s ON s.id = b.statement_id WHERE b.id = $1 FOR UPDATE OF b", [lineId]);
  if (!l) throw E.notFound("bank_statement_lines");
  if (l.status === "reconciled") throw E.rule("STATEMENT_RECONCILED", "الكشف مسوّى ومقفل", "The statement is reconciled");
  if (journalLineId) {
    const j = await one(db, `SELECT l.*, (l.debit - l.credit)::numeric(20,4)::text AS amount FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.id = $1 AND ${POSTED}`, [journalLineId]);
    if (!j || j.account_id !== l.account_id) throw E.validation([{ path: "journalLineId", message: "posted ledger line of this bank account required" }]);
    if (Number(j.amount) !== Number(l.amount)) throw E.rule("AMOUNT_MISMATCH", `المبلغ في الدفتر ${j.amount} لا يساوي مبلغ الكشف ${l.amount}`, "Ledger amount differs from the statement line");
    if ((await db.query("SELECT 1 FROM bank_statement_lines WHERE journal_line_id = $1", [journalLineId])).rowCount) throw E.conflict("قيد الدفتر مطابق مسبقًا مع سطر آخر", "Ledger line already matched");
  }
  await db.query("UPDATE bank_statement_lines SET journal_line_id = $2, matched_by = $3, matched_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END WHERE id = $1", [lineId, journalLineId, u.userId]);
  await ev(db, u, journalLineId ? "bank_line.matched" : "bank_line.unmatched", "bank_statement_line", lineId, { journalLineId });
  return getStatement(db, l.statement_id);
}

/** a bank-only item (fee, interest…): a DRAFT entry against the given account; once someone else posts it, auto-match picks it up */
export async function adjustingEntry(db: Db, u: UserCtx, lineId: string, b: { accountId: string; memo?: string }) {
  const l = await one(db, "SELECT b.*, s.account_id AS bank_account, s.company_id, s.status FROM bank_statement_lines b JOIN bank_statements s ON s.id = b.statement_id WHERE b.id = $1 FOR UPDATE OF b", [lineId]);
  if (!l) throw E.notFound("bank_statement_lines");
  if (l.journal_line_id) throw E.rule("ALREADY_MATCHED", "السطر مطابق مسبقًا", "Line already matched");
  const amt = Math.abs(Number(l.amount)).toFixed(4);
  const inflow = Number(l.amount) > 0;
  const d = await createDraft(db, u, { companyId: l.company_id, entryDate: String(l.txn_date).slice(0, 10), memo: b.memo ?? `تسوية بنكية: ${l.description}`, reference: l.reference ?? undefined,
    lines: inflow ? [{ accountId: l.bank_account, debit: amt }, { accountId: b.accountId, credit: amt }] : [{ accountId: b.accountId, debit: amt }, { accountId: l.bank_account, credit: amt }] } as any);
  await db.query("UPDATE bank_statement_lines SET draft_entry_id = $2 WHERE id = $1", [lineId, d.id]);
  await ev(db, u, "bank_line.adjusting_entry", "bank_statement_line", lineId, { entryId: d.id });
  return getStatement(db, l.statement_id);
}

export async function getStatement(db: Db, id: string) {
  const s = await one(db, `SELECT s.*, a.code AS account_code, a.name_ar AS account_name FROM bank_statements s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1`, [id]);
  if (!s) throw E.notFound("bank_statements");
  const lines = (await db.query(
    `SELECT b.*, e.number AS matched_entry, je.status AS draft_status, je.number AS draft_number FROM bank_statement_lines b
       LEFT JOIN journal_lines l ON l.id = b.journal_line_id LEFT JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN journal_entries je ON je.id = b.draft_entry_id
      WHERE b.statement_id = $1 ORDER BY b.line_no`, [id])).rows;
  const date = String(s.statement_date).slice(0, 10);
  // reconciliation starts at the first line of the account's first statement: older ledger movements are already
  // inside that statement's opening balance, so they are neither "uncleared" nor counted twice
  const base = await one(db, `SELECT s0.opening_balance::text AS opening, (SELECT min(b.txn_date) FROM bank_statement_lines b WHERE b.statement_id = s0.id)::text AS cutoff
      FROM bank_statements s0 WHERE s0.account_id = $1 ORDER BY s0.statement_date, s0.created_at LIMIT 1`, [s.account_id]);
  const cutoff = base.cutoff as string;
  const g = await one(db, `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(20,4)::text AS close,
        coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < $3), 0)::numeric(20,4)::text AS before,
        coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < $3 AND EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.journal_line_id = l.id)), 0)::numeric(20,4)::text AS matched_before
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND ${POSTED} AND e.entry_date <= $2`, [s.account_id, date, cutoff]);
  const gl = g.close as string;
  const uncleared = (await db.query(unclearedSql.replace("AND e.entry_date <= $2", "AND e.entry_date <= $2 AND e.entry_date >= $3"), [s.account_id, date, cutoff])).rows;
  const unclearedSum = uncleared.reduce((x, r) => x + Math.round(Number(r.amount) * 10000), 0) / 10000;
  // bank closing should be: opening at the start + ledger movements since the start (+ earlier ledger items the bank only
  // processed after the start, i.e. matched) − ledger items the bank has not processed yet
  const explained = Math.round((Number(base.opening) + Number(gl) - Number(g.before) + Number(g.matched_before) - unclearedSum) * 10000) / 10000;
  const difference = Math.round((Number(s.closing_balance) - explained) * 10000) / 10000;
  const unmatched = lines.filter((l) => !l.journal_line_id).length;
  return { ...s, lines, glBalance: gl, reconciliationStart: cutoff, uncleared, unclearedTotal: unclearedSum.toFixed(4), expectedClosing: explained.toFixed(4), difference: difference.toFixed(4), unmatched, canReconcile: unmatched === 0 && difference === 0 };
}

export async function reconcile(db: Db, u: UserCtx, id: string) {
  const s = await getStatement(db, id);
  if (s.status === "reconciled") return s;
  if (s.unmatched) throw E.rule("UNMATCHED_LINES", `${s.unmatched} سطر في الكشف غير مطابق مع الدفتر`, `${s.unmatched} statement lines are not matched`);
  if (Number(s.difference) !== 0) throw E.rule("RECONCILIATION_DIFFERENCE", `يوجد فرق ${s.difference} بين الدفتر والكشف`, `Difference of ${s.difference} between ledger and statement`);
  await db.query("UPDATE bank_statements SET status = 'reconciled', reconciled_by = $2, reconciled_at = now() WHERE id = $1", [id, u.userId]);
  await ev(db, u, "bank_statement.reconciled", "bank_statement", id, { glBalance: s.glBalance, closing: s.closing_balance });
  return getStatement(db, id);
}

// ------------------------------------------------------------------ budgets
export async function createBudget(db: Db, u: UserCtx, b: { companyId: string; fiscalYearId: string; name: string; copyActualFromYearId?: string; growthPct?: number }) {
  const fy = await one(db, "SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2", [b.fiscalYearId, b.companyId]);
  if (!fy) throw E.validation([{ path: "fiscalYearId", message: "fiscal year not found" }]);
  const r = await one(db, "INSERT INTO budgets (tenant_id, company_id, fiscal_year_id, name, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id", [u.tenantId, b.companyId, fy.id, b.name, u.userId]);
  if (b.copyActualFromYearId) {
    // start from last year's actual revenue & expenses by account and month, adjusted by a growth percentage
    const src = await one(db, "SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2", [b.copyActualFromYearId, b.companyId]);
    if (!src) throw E.validation([{ path: "copyActualFromYearId", message: "fiscal year not found" }]);
    await db.query(
      `INSERT INTO budget_lines (tenant_id, budget_id, account_id, period_no, amount)
       SELECT $1, $2, l.account_id, p.period_no, round(abs(sum(l.debit - l.credit)) * (1 + $5::numeric / 100), 3)
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
         JOIN fiscal_periods p ON p.fiscal_year_id = $3 AND e.entry_date BETWEEN p.start_date AND p.end_date
        WHERE e.company_id = $4 AND ${POSTED} AND a.type IN ('revenue', 'expense') AND e.source_type <> 'year_end_close'
        GROUP BY l.account_id, p.period_no HAVING sum(l.debit - l.credit) <> 0`, [u.tenantId, r.id, src.id, b.companyId, b.growthPct ?? 0]);
  }
  await ev(db, u, "budget.created", "budget", r.id, b);
  return getBudget(db, r.id);
}

export async function setBudgetLines(db: Db, u: UserCtx, id: string, lines: { accountId: string; costCenterId?: string | null; amounts: string[] }[]) {
  const bd = await one(db, "SELECT * FROM budgets WHERE id = $1 FOR UPDATE", [id]);
  if (!bd) throw E.notFound("budgets");
  if (bd.status !== "draft") throw E.rule("BUDGET_APPROVED", "الموازنة معتمدة — لا تُعدّل", "The budget is approved");
  await db.query("DELETE FROM budget_lines WHERE budget_id = $1", [id]);
  for (const l of lines) {
    const a = await one(db, "SELECT type FROM accounts WHERE id = $1 AND company_id = $2", [l.accountId, bd.company_id]);
    if (!a || !["revenue", "expense"].includes(a.type)) throw E.validation([{ path: "lines.accountId", message: "budget lines are revenue or expense accounts" }]);
    for (let p = 0; p < 12; p++) if (Number(l.amounts[p] ?? 0) > 0)
      await db.query("INSERT INTO budget_lines (tenant_id, budget_id, account_id, cost_center_id, period_no, amount) VALUES ($1,$2,$3,$4,$5,$6)",
        [u.tenantId, id, l.accountId, l.costCenterId ?? null, p + 1, l.amounts[p]]);
  }
  await ev(db, u, "budget.lines_replaced", "budget", id, { lines: lines.length });
  return getBudget(db, id);
}

export async function approveBudget(db: Db, u: UserCtx, id: string) {
  const bd = await one(db, "SELECT * FROM budgets WHERE id = $1 FOR UPDATE", [id]);
  if (!bd) throw E.notFound("budgets");
  if (bd.status === "approved") return getBudget(db, id);
  if (u.enforceSod && bd.created_by === u.userId) throw E.sod();
  await db.query("UPDATE budgets SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1", [id, u.userId]);
  await ev(db, u, "budget.approved", "budget", id);
  return getBudget(db, id);
}

export async function getBudget(db: Db, id: string) {
  const bd = await one(db, "SELECT b.*, y.name AS year_name, y.start_date, y.end_date FROM budgets b JOIN fiscal_years y ON y.id = b.fiscal_year_id WHERE b.id = $1", [id]);
  if (!bd) throw E.notFound("budgets");
  const lines = (await db.query(
    `SELECT bl.account_id, bl.cost_center_id, a.code, a.name_ar, a.type, cc.code AS cost_center_code,
            array_agg(bl.amount::text ORDER BY bl.period_no) FILTER (WHERE true) AS amounts_raw, array_agg(bl.period_no ORDER BY bl.period_no) AS periods
       FROM budget_lines bl JOIN accounts a ON a.id = bl.account_id LEFT JOIN cost_centers cc ON cc.id = bl.cost_center_id
      WHERE bl.budget_id = $1 GROUP BY bl.account_id, bl.cost_center_id, a.code, a.name_ar, a.type, cc.code ORDER BY a.code`, [id])).rows
    .map((r: any) => { const amounts = Array(12).fill("0"); r.periods.forEach((p: number, i: number) => { amounts[p - 1] = r.amounts_raw[i]; }); const { amounts_raw, periods, ...rest } = r; void amounts_raw; void periods; return { ...rest, amounts }; });
  return { ...bd, lines };
}

/** budget vs actual up to a date: per account (and cost centre), year-to-date and for each month */
export async function budgetVsActual(db: Db, id: string, asOf?: string) {
  const bd = await getBudget(db, id);
  const end = asOf ?? String(bd.end_date).slice(0, 10);
  const rows = (await db.query(
    `WITH b AS (SELECT bl.account_id, bl.cost_center_id, bl.period_no, bl.amount FROM budget_lines bl WHERE bl.budget_id = $1),
          per AS (SELECT period_no, start_date, end_date FROM fiscal_periods WHERE fiscal_year_id = $2),
          act AS (SELECT l.account_id, l.cost_center_id, p.period_no,
                         sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE l.debit - l.credit END) AS amount
                    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                    JOIN per p ON e.entry_date BETWEEN p.start_date AND p.end_date
                   WHERE e.company_id = $3 AND ${POSTED} AND e.entry_date <= $4 AND a.type IN ('revenue', 'expense') AND e.source_type <> 'year_end_close'
                     AND NOT (e.source_type = 'reversal' AND EXISTS (SELECT 1 FROM journal_entries c WHERE c.id = e.reversal_of AND c.source_type = 'year_end_close'))
                   GROUP BY 1, 2, 3),
          keys AS (SELECT DISTINCT account_id, cost_center_id FROM b)
     SELECT k.account_id, k.cost_center_id, a.code, a.name_ar, a.type, cc.code AS cost_center_code,
            coalesce((SELECT sum(amount) FROM b WHERE b.account_id = k.account_id AND b.cost_center_id IS NOT DISTINCT FROM k.cost_center_id
                        AND b.period_no IN (SELECT period_no FROM per WHERE start_date <= $4)), 0)::numeric(20,4)::text AS budget_ytd,
            coalesce((SELECT sum(amount) FROM act WHERE act.account_id = k.account_id AND (k.cost_center_id IS NULL OR act.cost_center_id = k.cost_center_id)), 0)::numeric(20,4)::text AS actual_ytd,
            coalesce((SELECT sum(amount) FROM b WHERE b.account_id = k.account_id AND b.cost_center_id IS NOT DISTINCT FROM k.cost_center_id), 0)::numeric(20,4)::text AS budget_year,
            ARRAY(SELECT coalesce((SELECT sum(amount) FROM b WHERE b.account_id = k.account_id AND b.cost_center_id IS NOT DISTINCT FROM k.cost_center_id AND b.period_no = g), 0)::text FROM generate_series(1, 12) g) AS budget_months,
            ARRAY(SELECT coalesce((SELECT sum(amount) FROM act WHERE act.account_id = k.account_id AND (k.cost_center_id IS NULL OR act.cost_center_id = k.cost_center_id) AND act.period_no = g), 0)::text FROM generate_series(1, 12) g) AS actual_months
       FROM keys k JOIN accounts a ON a.id = k.account_id LEFT JOIN cost_centers cc ON cc.id = k.cost_center_id ORDER BY a.type DESC, a.code`,
    [id, bd.fiscal_year_id, bd.company_id, end])).rows.map((r: any) => {
      const variance = Math.round((Number(r.actual_ytd) - Number(r.budget_ytd)) * 10000) / 10000;
      // over budget is good for revenue, bad for an expense
      const favourable = r.type === "revenue" ? variance >= 0 : variance <= 0;
      return { ...r, variance: variance.toFixed(4), variance_pct: Number(r.budget_ytd) ? Math.round((variance / Number(r.budget_ytd)) * 1000) / 10 : null, favourable };
    });
  return { budget: { id: bd.id, name: bd.name, status: bd.status, year: bd.year_name }, asOf: end, rows };
}
