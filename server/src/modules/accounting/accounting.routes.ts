import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb, assertBranchAccess } from "../../core/auth.js";
import { parse, zPage, pageSql, paged, zUuid, zMoney, zDate, idempotent, orderBy } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import * as svc from "./accounting.service.js";

const T = { tags: ["Accounting"] };
const zLine = z.object({
  accountId: zUuid, debit: zMoney.optional(), credit: zMoney.optional(), description: z.string().max(500).optional(), costCenterId: zUuid.nullable().optional(),
});
const zEntry = z.object({
  companyId: zUuid, branchId: zUuid.nullable().optional(), entryDate: zDate, memo: z.string().min(2).max(1000), reference: z.string().max(100).nullable().optional(),
  currency: z.string().length(3).optional(), fxRate: z.string().regex(/^\d{1,10}(\.\d{1,10})?$/).optional(), lines: z.array(zLine).min(2).max(500),
});

export async function accountingRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ accounts
  app.get("/accounts", { schema: { ...T, summary: "Chart of accounts (flat, ordered by code; includes parent_id for tree)" }, preHandler: can("accounting.accounts.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, postableOnly: z.enum(["true", "false"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT a.*, EXISTS(SELECT 1 FROM journal_lines l WHERE l.account_id = a.id) AS has_postings FROM accounts a
        WHERE company_id = $1 AND ($2::boolean IS NOT TRUE OR (is_postable AND is_active)) ORDER BY code`, [q.companyId, q.postableOnly === "true"])).rows);
  });

  app.post("/accounts/seed-template", { schema: { ...T, summary: "Seed the food manufacturing & distribution CoA template (for accountant review)" }, preHandler: can("accounting.accounts.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid }), req.body);
    const u = req.user!;
    const n = await tdb(req, async (db) => {
      const count = await svc.seedChartOfAccounts(db, u.tenantId, b.companyId);
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "coa.template_seeded", entityType: "company", entityId: b.companyId, after: { accounts: count } });
      return count;
    });
    return reply.code(201).send({ created: n });
  });

  app.post("/accounts", { schema: { ...T, summary: "Create account" }, preHandler: can("accounting.accounts.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, code: z.string().regex(/^[0-9]{1,12}$/), nameAr: z.string().min(2), nameEn: z.string().optional(),
      type: z.enum(["asset", "liability", "equity", "revenue", "expense"]).optional(), parentId: zUuid.nullable().optional(), isPostable: z.boolean().default(true),
      normalBalance: z.enum(["debit", "credit"]).optional(), currency: z.string().length(3).nullable().optional(), requiresCostCenter: z.boolean().optional(),
      role: z.string().regex(/^[a-z_]+$/).nullable().optional() }), req.body);
    return reply.code(201).send(await tdb(req, (db) => svc.createAccount(db, req.user!, b)));
  });

  app.patch("/accounts/:id", { schema: { ...T, summary: "Rename / (de)activate account" }, preHandler: can("accounting.accounts.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ nameAr: z.string().min(2).optional(), nameEn: z.string().nullable().optional(), isActive: z.boolean().optional(), requiresCostCenter: z.boolean().optional() }), req.body);
    const u = req.user!;
    return tdb(req, async (db) => {
      const before = (await db.query("SELECT * FROM accounts WHERE id = $1", [id])).rows[0];
      if (!before) throw E.notFound("account");
      if (b.isActive === false) {
        const bal = (await db.query("SELECT coalesce(sum(debit - credit),0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.status <> 'draft'", [id])).rows[0].b;
        if (Number(bal) !== 0) throw E.rule("ACCOUNT_HAS_BALANCE", "لا يمكن إيقاف حساب له رصيد", "Cannot deactivate an account with a non-zero balance", { balance: bal });
      }
      const r = (await db.query("UPDATE accounts SET name_ar = coalesce($2,name_ar), name_en = coalesce($3,name_en), is_active = coalesce($4,is_active), requires_cost_center = coalesce($5, requires_cost_center) WHERE id = $1 RETURNING *",
        [id, b.nameAr ?? null, b.nameEn ?? null, b.isActive ?? null, b.requiresCostCenter ?? null])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "account.updated", entityType: "account", entityId: id, before, after: r, ip: req.ip, requestId: req.id });
      return r;
    });
  });

  // ------------------------------------------------------------ cost centers & FX
  app.get("/cost-centers", { schema: { ...T, summary: "Cost centers" }, preHandler: can("accounting.accounts.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT * FROM cost_centers WHERE company_id = $1 ORDER BY code", [q.companyId])).rows);
  });
  app.post("/cost-centers", { schema: { ...T, summary: "Create cost center" }, preHandler: can("accounting.cost_centers.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, code: z.string().min(1).max(20), nameAr: z.string().min(2), nameEn: z.string().optional(), parentId: zUuid.nullable().optional() }), req.body);
    const u = req.user!;
    return reply.code(201).send(await tdb(req, async (db) => {
      const r = (await db.query("INSERT INTO cost_centers (tenant_id, company_id, code, name_ar, name_en, parent_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [u.tenantId, b.companyId, b.code, b.nameAr, b.nameEn ?? null, b.parentId ?? null])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "cost_center.created", entityType: "cost_center", entityId: r.id, after: r });
      return r;
    }));
  });
  app.get("/exchange-rates", { schema: { ...T, summary: "Exchange rates" }, preHandler: can("accounting.accounts.view") }, async (req) =>
    tdb(req, async (db) => (await db.query("SELECT * FROM exchange_rates ORDER BY rate_date DESC, from_currency LIMIT 500")).rows));
  app.post("/exchange-rates", { schema: { ...T, summary: "Add / update exchange rate for a date" }, preHandler: can("accounting.fx.manage") }, async (req, reply) => {
    const b = parse(z.object({ fromCurrency: z.string().length(3), toCurrency: z.string().length(3), rateDate: zDate, rate: z.string().regex(/^\d{1,10}(\.\d{1,10})?$/), source: z.string().optional() }), req.body);
    const u = req.user!;
    return reply.code(201).send(await tdb(req, async (db) => {
      const r = (await db.query(`INSERT INTO exchange_rates (tenant_id, from_currency, to_currency, rate_date, rate, source) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id, from_currency, to_currency, rate_date) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source RETURNING *`,
        [u.tenantId, b.fromCurrency, b.toCurrency, b.rateDate, b.rate, b.source ?? null])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "fx_rate.set", entityType: "exchange_rate", entityId: r.id, after: r });
      return r;
    }));
  });

  // ------------------------------------------------------------ fiscal years / periods
  app.get("/fiscal-years", { schema: { ...T, summary: "Fiscal years with periods" }, preHandler: can("accounting.journal.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT y.*, coalesce((SELECT json_agg(p ORDER BY p.period_no) FROM fiscal_periods p WHERE p.fiscal_year_id = y.id), '[]') AS periods
         FROM fiscal_years y WHERE company_id = $1 ORDER BY start_date DESC`, [q.companyId])).rows);
  });
  app.post("/fiscal-years", { schema: { ...T, summary: "Create fiscal year (12 monthly periods)" }, preHandler: can("accounting.periods.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, name: z.string().min(2).max(40), startDate: zDate }), req.body);
    return reply.code(201).send(await tdb(req, (db) => svc.createFiscalYear(db, req.user!, b)));
  });
  app.post("/periods/:id/close", { schema: { ...T, summary: "Close fiscal period (blocked while drafts exist)" }, preHandler: can("accounting.periods.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return tdb(req, (db) => svc.setPeriodStatus(db, req.user!, id, "closed"));
  });
  app.post("/periods/:id/reopen", { schema: { ...T, summary: "Reopen fiscal period (reason required, audited)" }, preHandler: can("accounting.periods.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(5) }), req.body);
    return tdb(req, (db) => svc.setPeriodStatus(db, req.user!, id, "open", b.reason));
  });

  // ------------------------------------------------------------ journal entries
  app.get("/journal-entries", { schema: { ...T, summary: "Journal entries (filters, pagination, sorting)" }, preHandler: can("accounting.journal.view") }, async (req) => {
    const q = parse(zPage.extend({ companyId: zUuid, status: z.enum(["draft", "posted", "reversed"]).optional(), from: zDate.optional(), to: zDate.optional(),
      q: z.string().optional(), sourceType: z.string().optional(), sort: z.string().optional() }), req.query);
    const { limit, offset } = pageSql(q);
    const u = req.user!;
    return tdb(req, async (db) => {
      const where = `WHERE e.company_id = $1 AND ($2::journal_status IS NULL OR e.status = $2) AND ($3::date IS NULL OR e.entry_date >= $3) AND ($4::date IS NULL OR e.entry_date <= $4)
        AND ($5::text IS NULL OR e.memo ILIKE '%'||$5||'%' OR e.number ILIKE '%'||$5||'%' OR e.reference ILIKE '%'||$5||'%') AND ($6::text IS NULL OR e.source_type = $6)
        AND ($7::uuid[] IS NULL OR e.branch_id IS NULL OR e.branch_id = ANY($7))`;
      const args = [q.companyId, q.status ?? null, q.from ?? null, q.to ?? null, q.q ?? null, q.sourceType ?? null, u.branchIds];
      const total = Number((await db.query(`SELECT count(*) FROM journal_entries e ${where}`, args)).rows[0].count);
      const ob = orderBy(q.sort, { date: "e.entry_date", number: "e.number", created: "e.created_at" }, "e.entry_date DESC, e.created_at DESC");
      const rows = (await db.query(
        `SELECT e.id, e.number, e.entry_date, e.status, e.memo, e.reference, e.currency, e.source_type, e.source_id, e.reversal_of, e.reversed_by, e.is_demo,
                e.created_at, e.posted_at, cu.full_name AS created_by_name,
                (SELECT sum(debit) FROM journal_lines l WHERE l.entry_id = e.id) AS total
           FROM journal_entries e JOIN users cu ON cu.id = e.created_by ${where} ORDER BY ${ob} LIMIT $8 OFFSET $9`, [...args, limit, offset])).rows;
      return paged(rows, total, q);
    });
  });

  app.get("/journal-entries/:id", { schema: { ...T, summary: "Journal entry with lines" }, preHandler: can("accounting.journal.view") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return tdb(req, (db) => svc.getEntry(db, id));
  });

  app.post("/journal-entries", { schema: { ...T, summary: "Create draft journal entry (Idempotency-Key supported)" }, preHandler: can("accounting.journal.create") }, async (req, reply) => {
    const b = parse(zEntry, req.body);
    assertBranchAccess(req.user!, b.branchId);
    return tdb(req, (db) => idempotent(req, reply, db, req.user!.tenantId, async () => ({ status: 201, body: await svc.createDraft(db, req.user!, b) })));
  });

  app.put("/journal-entries/:id", { schema: { ...T, summary: "Replace a draft entry" }, preHandler: can("accounting.journal.create") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(zEntry, req.body);
    assertBranchAccess(req.user!, b.branchId);
    return tdb(req, (db) => svc.updateDraft(db, req.user!, id, b));
  });

  app.delete("/journal-entries/:id", { schema: { ...T, summary: "Delete a draft entry" }, preHandler: can("accounting.journal.create") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await tdb(req, (db) => svc.deleteDraft(db, req.user!, id));
    return { ok: true };
  });

  app.post("/journal-entries/:id/post", { schema: { ...T, summary: "Post a draft (balanced, open period, SoD enforced)" }, preHandler: can("accounting.journal.post") }, async (req, reply) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return tdb(req, (db) => idempotent(req, reply, db, req.user!.tenantId, async () => ({ status: 200, body: await svc.postEntry(db, req.user!, id) })));
  });

  app.post("/journal-entries/:id/reverse", { schema: { ...T, summary: "Reverse a posted entry with a documented reversal" }, preHandler: can("accounting.journal.reverse") }, async (req, reply) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ reason: z.string().min(5).max(500), reversalDate: zDate.optional() }), req.body);
    return tdb(req, (db) => idempotent(req, reply, db, req.user!.tenantId, async () => ({ status: 201, body: await svc.reverseEntry(db, req.user!, id, b) })));
  });

  // ------------------------------------------------------------ reports
  const zRange = z.object({ companyId: zUuid, from: zDate, to: zDate }).refine((r) => r.from <= r.to, "from must be <= to");
  app.get("/reports/trial-balance", { schema: { ...T, summary: "Trial balance (opening, period movement, closing)" }, preHandler: can("accounting.reports.view") }, async (req) => {
    const q = parse(zRange, req.query);
    return tdb(req, (db) => svc.trialBalance(db, q.companyId, q.from, q.to));
  });
  app.get("/reports/ledger/:accountId", { schema: { ...T, summary: "Account ledger with running balance and drill-down to source" }, preHandler: can("accounting.reports.view") }, async (req) => {
    const { accountId } = parse(z.object({ accountId: zUuid }), req.params);
    const q = parse(z.object({ from: zDate, to: zDate }), req.query);
    return tdb(req, (db) => svc.accountLedger(db, accountId, q.from, q.to));
  });
  app.get("/reports/financial-statements", { schema: { ...T, summary: "Income statement & balance sheet summary" }, preHandler: can("accounting.reports.view") }, async (req) => {
    const q = parse(zRange, req.query);
    return tdb(req, (db) => svc.financialStatements(db, q.companyId, q.from, q.to));
  });
}
