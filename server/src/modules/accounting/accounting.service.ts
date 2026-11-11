import type { Db } from "../../db/pool.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import type { UserCtx } from "../../core/auth.js";
import { CONTRA_NORMAL, FOOD_MANUFACTURING_COA, NORMAL_BALANCE, type CoaNode } from "./coaTemplate.js";

export interface LineInput {
  accountId: string; debit?: string; credit?: string; description?: string; costCenterId?: string | null;
}
export interface EntryInput {
  companyId: string; branchId?: string | null; entryDate: string; memo: string; reference?: string | null;
  currency?: string; fxRate?: string; lines: LineInput[]; sourceType?: string; sourceId?: string | null; isDemo?: boolean;
}

// ------------------------------------------------------------------ CoA
export async function seedChartOfAccounts(db: Db, tenantId: string, companyId: string, opts: { isDemo?: boolean } = {}) {
  const existing = Number((await db.query("SELECT count(*) FROM accounts WHERE company_id = $1", [companyId])).rows[0].count);
  if (existing) throw E.conflict("دليل الحسابات موجود مسبقًا لهذه الشركة", "Chart of accounts already exists for this company");
  let n = 0;
  const walk = async (nodes: CoaNode[], parentId: string | null) => {
    for (const node of nodes) {
      const postable = node.postable ?? !node.children?.length;
      const r = (await db.query(
        `INSERT INTO accounts (tenant_id, company_id, code, name_ar, name_en, type, normal_balance, parent_id, is_postable, role, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [tenantId, companyId, node.code, node.ar, node.en, node.type, CONTRA_NORMAL[node.code] ?? NORMAL_BALANCE[node.type], parentId, postable, node.role ?? null, !!opts.isDemo])).rows[0];
      n++;
      if (node.children) await walk(node.children, r.id);
    }
  };
  await walk(FOOD_MANUFACTURING_COA, null);
  return n;
}

export async function createAccount(db: Db, u: UserCtx, b: { companyId: string; code: string; nameAr: string; nameEn?: string; type?: CoaNode["type"]; parentId?: string | null; isPostable: boolean; normalBalance?: "debit" | "credit"; currency?: string | null; requiresCostCenter?: boolean; role?: string | null }) {
  let type = b.type;
  if (b.parentId) {
    const p = (await db.query("SELECT * FROM accounts WHERE id = $1", [b.parentId])).rows[0];
    if (!p || p.company_id !== b.companyId) throw E.validation([{ path: "parentId", message: "parent not found in this company" }]);
    if (p.is_postable) {
      const used = (await db.query("SELECT 1 FROM journal_lines WHERE account_id = $1 LIMIT 1", [p.id])).rowCount;
      if (used) throw E.rule("PARENT_HAS_POSTINGS", "الحساب الأب عليه حركات ولا يمكن أن يصبح حسابًا تجميعيًا", "Parent account has postings and cannot become a header");
      await db.query("UPDATE accounts SET is_postable = false WHERE id = $1", [p.id]);
    }
    if (type && type !== p.type) throw E.validation([{ path: "type", message: "must match parent type" }]);
    type = p.type;
  }
  if (!type) throw E.validation([{ path: "type", message: "required for root accounts" }]);
  const r = (await db.query(
    `INSERT INTO accounts (tenant_id, company_id, code, name_ar, name_en, type, normal_balance, parent_id, is_postable, currency, requires_cost_center, role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [u.tenantId, b.companyId, b.code, b.nameAr, b.nameEn ?? null, type, b.normalBalance ?? NORMAL_BALANCE[type], b.parentId ?? null, b.isPostable, b.currency ?? null, !!b.requiresCostCenter, b.role ?? null])).rows[0];
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "account.created", entityType: "account", entityId: r.id, after: r });
  return r;
}

// ------------------------------------------------------------------ periods
export async function createFiscalYear(db: Db, u: UserCtx, b: { companyId: string; name: string; startDate: string }) {
  const start = new Date(`${b.startDate}T00:00:00Z`);
  if (start.getUTCDate() !== 1) throw E.validation([{ path: "startDate", message: "fiscal year must start on the 1st of a month" }]);
  const end = new Date(start); end.setUTCFullYear(end.getUTCFullYear() + 1); end.setUTCDate(0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const fy = (await db.query("INSERT INTO fiscal_years (tenant_id, company_id, name, start_date, end_date) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [u.tenantId, b.companyId, b.name, b.startDate, iso(end)])).rows[0];
  for (let i = 0; i < 12; i++) {
    const ps = new Date(start); ps.setUTCMonth(ps.getUTCMonth() + i);
    const pe = new Date(ps); pe.setUTCMonth(pe.getUTCMonth() + 1); pe.setUTCDate(0);
    await db.query("INSERT INTO fiscal_periods (tenant_id, company_id, fiscal_year_id, period_no, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6)",
      [u.tenantId, b.companyId, fy.id, i + 1, iso(ps), iso(pe)]);
  }
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "fiscal_year.created", entityType: "fiscal_year", entityId: fy.id, after: fy });
  return fy;
}

export async function setPeriodStatus(db: Db, u: UserCtx, periodId: string, status: "open" | "closed", reason?: string) {
  const p = (await db.query("SELECT p.*, y.status AS year_status FROM fiscal_periods p JOIN fiscal_years y ON y.id = p.fiscal_year_id WHERE p.id = $1 FOR UPDATE OF p", [periodId])).rows[0];
  if (!p) throw E.notFound("period");
  if (p.status === status) return p;
  if (status === "open" && p.year_status === "closed") throw E.rule("YEAR_CLOSED", "السنة المالية مقفلة", "Fiscal year is closed");
  if (status === "open" && !reason) throw E.validation([{ path: "reason", message: "reason is required to reopen a period" }]);
  const r = (await db.query("UPDATE fiscal_periods SET status = $2::period_status, closed_at = CASE WHEN $2::text = 'closed' THEN now() END, closed_by = CASE WHEN $2::text = 'closed' THEN $3::uuid END WHERE id = $1 RETURNING *",
    [periodId, status, u.userId])).rows[0];
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: status === "closed" ? "period.closed" : "period.reopened", entityType: "fiscal_period", entityId: periodId, before: { status: p.status }, after: { status, reason } });
  return r;
}

// ------------------------------------------------------------------ journal
async function companyCurrency(db: Db, companyId: string) {
  const c = (await db.query("SELECT c.base_currency, cur.minor_units FROM companies c JOIN currencies cur ON cur.code = c.base_currency WHERE c.id = $1", [companyId])).rows[0];
  if (!c) throw E.validation([{ path: "companyId", message: "company not found" }]);
  return c as { base_currency: string; minor_units: number };
}

async function resolveRate(db: Db, from: string, to: string, date: string, given?: string) {
  if (from === to) return "1";
  if (given) return given;
  const r = (await db.query("SELECT rate FROM exchange_rates WHERE from_currency = $1 AND to_currency = $2 AND rate_date <= $3 ORDER BY rate_date DESC LIMIT 1", [from, to, date])).rows[0];
  if (!r) throw E.rule("FX_RATE_MISSING", `لا يوجد سعر صرف ${from}→${to} بتاريخ ${date}`, `No exchange rate ${from}->${to} on or before ${date}`);
  return r.rate as string;
}

function validateLinesShape(lines: LineInput[]) {
  if (lines.length < 2) throw E.validation([{ path: "lines", message: "at least two lines" }]);
  lines.forEach((l, i) => {
    const d = Number(l.debit ?? 0), c = Number(l.credit ?? 0);
    if ((d > 0) === (c > 0)) throw E.validation([{ path: `lines.${i}`, message: "each line must have either a debit or a credit amount" }]);
  });
}

async function insertLines(db: Db, tenantId: string, entryId: string, e: EntryInput, currency: string, rate: string, minor: number) {
  let i = 0;
  for (const l of e.lines) {
    i++;
    const fc = (l.debit && Number(l.debit) > 0 ? l.debit : l.credit)!;
    const isDebit = !!(l.debit && Number(l.debit) > 0);
    await db.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, cost_center_id, description, currency, fx_rate, amount_fc, debit, credit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,
               CASE WHEN $10 THEN round($9::numeric * $8::numeric, $11) ELSE 0 END,
               CASE WHEN $10 THEN 0 ELSE round($9::numeric * $8::numeric, $11) END)`,
      [tenantId, entryId, i, l.accountId, l.costCenterId ?? null, l.description ?? null, currency, rate, fc, isDebit, minor]);
  }
}

export async function createDraft(db: Db, u: UserCtx, e: EntryInput) {
  validateLinesShape(e.lines);
  const cc = await companyCurrency(db, e.companyId);
  const currency = e.currency ?? cc.base_currency;
  const rate = await resolveRate(db, currency, cc.base_currency, e.entryDate, e.fxRate);
  const entry = (await db.query(
    `INSERT INTO journal_entries (tenant_id, company_id, branch_id, entry_date, currency, memo, reference, source_type, source_id, created_by, is_demo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [u.tenantId, e.companyId, e.branchId ?? null, e.entryDate, currency, e.memo, e.reference ?? null, e.sourceType ?? "manual", e.sourceId ?? null, u.userId, !!e.isDemo])).rows[0];
  await insertLines(db, u.tenantId, entry.id, e, currency, rate, cc.minor_units);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "journal.draft_created", entityType: "journal_entry", entityId: entry.id, after: e });
  return getEntry(db, entry.id);
}

export async function updateDraft(db: Db, u: UserCtx, id: string, e: EntryInput) {
  const cur = (await db.query("SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!cur) throw E.notFound("journal entry");
  if (cur.status !== "draft") throw E.rule("ENTRY_NOT_DRAFT", "لا يمكن تعديل قيد مرحّل — استخدم القيد العكسي", "Only draft entries can be edited; reverse posted entries");
  if (cur.company_id !== e.companyId) throw E.validation([{ path: "companyId", message: "cannot move a draft to another company" }]);
  validateLinesShape(e.lines);
  const before = await getEntry(db, id);
  const cc = await companyCurrency(db, e.companyId);
  const currency = e.currency ?? cc.base_currency;
  const rate = await resolveRate(db, currency, cc.base_currency, e.entryDate, e.fxRate);
  await db.query("DELETE FROM journal_lines WHERE entry_id = $1", [id]);
  await db.query("UPDATE journal_entries SET branch_id = $2, entry_date = $3, currency = $4, memo = $5, reference = $6 WHERE id = $1",
    [id, e.branchId ?? null, e.entryDate, currency, e.memo, e.reference ?? null]);
  await insertLines(db, u.tenantId, id, e, currency, rate, cc.minor_units);
  const after = await getEntry(db, id);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "journal.draft_updated", entityType: "journal_entry", entityId: id, before, after });
  return after;
}

export async function deleteDraft(db: Db, u: UserCtx, id: string) {
  const before = await getEntry(db, id);
  if (before.status !== "draft") throw E.rule("ENTRY_NOT_DRAFT", "لا يمكن حذف قيد مرحّل", "Posted entries cannot be deleted");
  await db.query("DELETE FROM journal_entries WHERE id = $1", [id]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "journal.draft_deleted", entityType: "journal_entry", entityId: id, before });
}

export async function nextNumber(db: Db, tenantId: string, companyId: string, docType: string, prefix: string, year: string) {
  const key = `${docType}-${year}`;
  await db.query("INSERT INTO document_sequences (tenant_id, company_id, doc_type, prefix) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [tenantId, companyId, key, `${prefix}-${year}-`]);
  const r = (await db.query("UPDATE document_sequences SET next_value = next_value + 1 WHERE company_id = $1 AND doc_type = $2 RETURNING prefix, next_value - 1 AS v, padding", [companyId, key])).rows[0];
  return `${r.prefix}${String(r.v).padStart(r.padding, "0")}`;
}

async function openPeriodFor(db: Db, companyId: string, date: string) {
  const p = (await db.query("SELECT id, status FROM fiscal_periods WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date", [companyId, date])).rows[0];
  if (!p) throw E.rule("NO_FISCAL_PERIOD", `لا توجد فترة مالية تغطي التاريخ ${date}`, `No fiscal period covers ${date}`);
  if (p.status !== "open") throw E.rule("PERIOD_CLOSED", "الفترة المالية مقفلة", "Fiscal period is closed");
  return p.id as string;
}

async function preCheck(db: Db, id: string) {
  const s = (await db.query(
    `SELECT coalesce(sum(debit),0) = coalesce(sum(credit),0) AS balanced, sum(debit) AS dr, sum(credit) AS cr,
            count(*) FILTER (WHERE NOT a.is_postable OR NOT a.is_active) AS bad_acc,
            count(*) FILTER (WHERE a.requires_cost_center AND l.cost_center_id IS NULL) AS missing_cc
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1`, [id])).rows[0];
  if (!s.balanced) throw E.rule("UNBALANCED_ENTRY", `القيد غير متوازن: مدين ${s.dr} ≠ دائن ${s.cr}`, `Unbalanced entry: debit ${s.dr} <> credit ${s.cr}`, { debit: s.dr, credit: s.cr });
  if (Number(s.bad_acc)) throw E.rule("ACCOUNT_NOT_POSTABLE", "القيد يستخدم حسابًا تجميعيًا أو غير نشط", "Entry uses a header or inactive account");
  if (Number(s.missing_cc)) throw E.rule("COST_CENTER_REQUIRED", "مركز التكلفة إلزامي لبعض الحسابات في القيد", "Cost center is required for some accounts in this entry");
}

/** Posts a draft. Enforces segregation of duties when the tenant requires it. */
export async function postEntry(db: Db, u: UserCtx, id: string, opts: { system?: boolean } = {}) {
  const e = (await db.query("SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!e) throw E.notFound("journal entry");
  if (e.status !== "draft") throw E.rule("ALREADY_POSTED", "القيد مرحّل مسبقًا", "Entry is already posted");
  if (!opts.system && u.enforceSod && e.created_by === u.userId) throw E.sod();
  await preCheck(db, id);
  const periodId = await openPeriodFor(db, e.company_id, e.entry_date);
  const number = await nextNumber(db, u.tenantId, e.company_id, e.source_type === "reversal" ? "JR" : "JV", e.source_type === "reversal" ? "JR" : "JV", String(e.entry_date).slice(0, 4));
  await db.query("UPDATE journal_entries SET status = 'posted', number = $2, period_id = $3, posted_by = $4, posted_at = now() WHERE id = $1", [id, number, periodId, u.userId]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "journal.posted", entityType: "journal_entry", entityId: id, after: { number, periodId } });
  return getEntry(db, id);
}

/**
 * Integration contract for other modules (sales, purchasing, inventory,
 * manufacturing, payroll): create + post in one step for an APPROVED source
 * document. Idempotent: the same (sourceType, sourceId) returns the existing
 * entry instead of posting twice.
 */
export async function postFromSource(db: Db, u: UserCtx, e: EntryInput & { sourceType: string; sourceId: string }) {
  const prev = (await db.query("SELECT id FROM journal_entries WHERE company_id = $1 AND source_type = $2 AND source_id = $3 AND reversal_of IS NULL", [e.companyId, e.sourceType, e.sourceId])).rows[0];
  if (prev) return { entry: await getEntry(db, prev.id), replayed: true };
  const d = await createDraft(db, u, e);
  return { entry: await postEntry(db, u, d.id, { system: true }), replayed: false };
}

export async function reverseEntry(db: Db, u: UserCtx, id: string, b: { reason: string; reversalDate?: string }) {
  const e = (await db.query("SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!e) throw E.notFound("journal entry");
  if (e.status !== "posted") throw E.rule("NOT_REVERSIBLE", e.status === "reversed" ? "القيد معكوس مسبقًا" : "لا يمكن عكس قيد غير مرحّل", e.status === "reversed" ? "Entry already reversed" : "Only posted entries can be reversed");
  if (e.reversal_of) throw E.rule("NOT_REVERSIBLE", "لا يمكن عكس قيد عكسي — أنشئ قيدًا جديدًا", "A reversal entry cannot itself be reversed; create a new entry");
  const date = b.reversalDate ?? e.entry_date;
  const periodId = await openPeriodFor(db, e.company_id, date);
  const number = await nextNumber(db, u.tenantId, e.company_id, "JR", "JR", String(date).slice(0, 4));
  const rev = (await db.query(
    `INSERT INTO journal_entries (tenant_id, company_id, branch_id, entry_date, currency, memo, reference, source_type, source_id, reversal_of, created_by, is_demo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'reversal',$8::text,$9::uuid,$10,$11) RETURNING id`,
    [u.tenantId, e.company_id, e.branch_id, date, e.currency, `عكس القيد ${e.number}: ${b.reason}`, e.number, e.id, e.id, u.userId, e.is_demo])).rows[0];
  await db.query(
    `INSERT INTO journal_lines (tenant_id, entry_id, line_no, account_id, cost_center_id, description, currency, fx_rate, amount_fc, debit, credit)
     SELECT tenant_id, $2, line_no, account_id, cost_center_id, description, currency, fx_rate, amount_fc, credit, debit FROM journal_lines WHERE entry_id = $1`, [id, rev.id]);
  await db.query("UPDATE journal_entries SET status = 'posted', number = $2, period_id = $3, posted_by = $4, posted_at = now() WHERE id = $1", [rev.id, number, periodId, u.userId]);
  await db.query("UPDATE journal_entries SET status = 'reversed', reversed_by = $2 WHERE id = $1", [id, rev.id]);
  await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "journal.reversed", entityType: "journal_entry", entityId: id, after: { reversalId: rev.id, number, reason: b.reason } });
  return getEntry(db, rev.id);
}

export async function getEntry(db: Db, id: string) {
  const e = (await db.query(
    `SELECT e.*, cu.full_name AS created_by_name, pu.full_name AS posted_by_name FROM journal_entries e
       JOIN users cu ON cu.id = e.created_by LEFT JOIN users pu ON pu.id = e.posted_by WHERE e.id = $1`, [id])).rows[0];
  if (!e) throw E.notFound("journal entry");
  const lines = (await db.query(
    `SELECT l.*, a.code AS account_code, a.name_ar AS account_name_ar, a.name_en AS account_name_en FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY line_no`, [id])).rows;
  const totals = lines.reduce((t, l) => ({ debit: t.debit + Number(l.debit), credit: t.credit + Number(l.credit) }), { debit: 0, credit: 0 });
  return { ...e, lines, totals };
}

// ------------------------------------------------------------------ reports
const POSTED = "e.status IN ('posted','reversed')";

export async function trialBalance(db: Db, companyId: string, from: string, to: string) {
  const rows = (await db.query(
    `WITH mv AS (
       SELECT l.account_id,
              sum(CASE WHEN e.entry_date < $2 THEN l.debit - l.credit ELSE 0 END) AS opening,
              sum(CASE WHEN e.entry_date BETWEEN $2 AND $3 THEN l.debit ELSE 0 END) AS period_debit,
              sum(CASE WHEN e.entry_date BETWEEN $2 AND $3 THEN l.credit ELSE 0 END) AS period_credit
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.company_id = $1 AND ${POSTED} AND e.entry_date <= $3
        GROUP BY l.account_id)
     SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.normal_balance,
            coalesce(mv.opening,0) AS opening, coalesce(mv.period_debit,0) AS period_debit, coalesce(mv.period_credit,0) AS period_credit,
            coalesce(mv.opening,0) + coalesce(mv.period_debit,0) - coalesce(mv.period_credit,0) AS closing
       FROM accounts a JOIN mv ON mv.account_id = a.id
      WHERE a.company_id = $1 ORDER BY a.code`, [companyId, from, to])).rows;
  const totals = (await db.query(
    `SELECT coalesce(sum(l.debit),0) AS debit, coalesce(sum(l.credit),0) AS credit FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND ${POSTED} AND e.entry_date BETWEEN $2 AND $3`, [companyId, from, to])).rows[0];
  return { from, to, rows, totals: { ...totals, balanced: totals.debit === totals.credit } };
}

export async function accountLedger(db: Db, accountId: string, from: string, to: string) {
  const acc = (await db.query("SELECT * FROM accounts WHERE id = $1", [accountId])).rows[0];
  if (!acc) throw E.notFound("account");
  const opening = (await db.query(
    `SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = $1 AND ${POSTED} AND e.entry_date < $2`, [accountId, from])).rows[0].v;
  const lines = (await db.query(
    `SELECT e.id AS entry_id, e.number, e.entry_date, e.memo, e.source_type, e.source_id, l.line_no, l.description, l.debit, l.credit,
            $3::numeric + sum(l.debit - l.credit) OVER (ORDER BY e.entry_date, e.number, l.line_no) AS running_balance
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = $1 AND ${POSTED} AND e.entry_date BETWEEN $2 AND $4
      ORDER BY e.entry_date, e.number, l.line_no`, [accountId, from, opening, to])).rows;
  return { account: acc, from, to, opening, lines };
}

/** Income statement and balance sheet derived from the ledger (same source of truth as the trial balance). */
export async function financialStatements(db: Db, companyId: string, from: string, to: string) {
  const r = (await db.query(
    `SELECT a.type,
            sum(CASE WHEN e.entry_date BETWEEN $2 AND $3 THEN l.credit - l.debit ELSE 0 END) AS period_credit_net,
            sum(l.debit - l.credit) AS cumulative_debit_net
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = $1 AND ${POSTED} AND e.entry_date <= $3 GROUP BY a.type`, [companyId, from, to])).rows;
  const by = Object.fromEntries(r.map((x) => [x.type, x]));
  const n = (v: unknown) => Number(v ?? 0);
  const revenue = n(by.revenue?.period_credit_net), expenses = -n(by.expense?.period_credit_net);
  const assets = n(by.asset?.cumulative_debit_net), liabilities = -n(by.liability?.cumulative_debit_net), equity = -n(by.equity?.cumulative_debit_net);
  const unclosedEarnings = -n(by.revenue?.cumulative_debit_net) - n(by.expense?.cumulative_debit_net);
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return {
    from, to,
    incomeStatement: { revenue: round(revenue), expenses: round(expenses), netIncome: round(revenue - expenses) },
    balanceSheet: { assets: round(assets), liabilities: round(liabilities), equity: round(equity), unclosedEarnings: round(unclosedEarnings),
      balanced: Math.abs(assets - (liabilities + equity + unclosedEarnings)) < 0.00005 },
  };
}
