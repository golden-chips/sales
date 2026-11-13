// CRM (Phase 6d): campaigns, leads → customers, opportunity pipeline, activities
// (calls, meetings, visits, tasks), customer service tickets with SLA and
// satisfaction; a product complaint about a lot opens a quality non-conformance.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zMoney, zDate } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";
import { docNumber } from "../erp/common.js";

const C = { tags: ["CRM"] };
const id$ = z.object({ id: zUuid });
const ev = (db: Db, u: UserCtx, action: string, type: string, id: string, after?: unknown) => audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action, entityType: type, entityId: id, after });
/** response time promised to the customer, by priority */
const SLA_HOURS: Record<string, number> = { critical: 4, high: 24, normal: 72, low: 168 };
const PROBABILITY: Record<string, number> = { prospecting: 10, proposal: 40, negotiation: 70, won: 100, lost: 0 };

export async function crmRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- campaigns
  app.get("/crm/campaigns", { schema: { ...C, summary: "Campaigns with lead counts and conversion" }, preHandler: can("crm.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT c.*, count(l.id)::int AS leads, count(l.id) FILTER (WHERE l.status = 'converted')::int AS converted
         FROM crm_campaigns c LEFT JOIN crm_leads l ON l.campaign_id = c.id WHERE c.company_id = $1 GROUP BY c.id ORDER BY c.start_date DESC`, [q.companyId])).rows);
  });
  app.post("/crm/campaigns", { schema: { ...C, summary: "Create campaign" }, preHandler: can("crm.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, name: z.string().min(2), channel: z.enum(["field", "social", "whatsapp", "sms", "radio_tv", "exhibition", "other"]),
      startDate: zDate, endDate: zDate.optional(), budget: zMoney.default("0"), notes: z.string().max(2000).optional() }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query(
      `INSERT INTO crm_campaigns (tenant_id, company_id, name, channel, start_date, end_date, budget, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user!.tenantId, b.companyId, b.name, b.channel, b.startDate, b.endDate ?? null, b.budget, b.notes ?? null, req.user!.userId])).rows[0]));
  });

  // ---------------------------------------------------------------- leads
  app.get("/crm/leads", { schema: { ...C, summary: "Leads" }, preHandler: can("crm.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["new", "contacted", "qualified", "converted", "lost"]).optional(), q: z.string().max(100).optional(), mine: z.enum(["true", "false"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT l.*, u.full_name AS owner_name, c.name AS campaign_name FROM crm_leads l LEFT JOIN users u ON u.id = l.owner_id LEFT JOIN crm_campaigns c ON c.id = l.campaign_id
        WHERE l.company_id = $1 AND ($2::lead_status IS NULL OR l.status = $2) AND ($3::text IS NULL OR l.name ILIKE '%'||$3||'%' OR l.business_name ILIKE '%'||$3||'%' OR l.phone ILIKE '%'||$3||'%')
          AND ($4::uuid IS NULL OR l.owner_id = $4) ORDER BY l.created_at DESC LIMIT 500`,
      [q.companyId, q.status ?? null, q.q ?? null, q.mine === "true" ? req.user!.userId : null])).rows);
  });
  app.post("/crm/leads", { schema: { ...C, summary: "Create lead" }, preHandler: can("crm.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, name: z.string().min(2), businessName: z.string().max(200).optional(), phone: z.string().max(30).optional(), email: z.string().email().optional(),
      city: z.string().max(100).optional(), source: z.enum(["rep_visit", "referral", "campaign", "website", "phone", "exhibition", "other"]).default("other"),
      campaignId: zUuid.nullable().optional(), ownerId: zUuid.nullable().optional(), notes: z.string().max(2000).optional() }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => {
      if (b.phone) {
        // the same shop is often reported twice (rep + campaign): point to the existing record instead of duplicating it
        const dup = (await db.query("SELECT id, name, status FROM crm_leads WHERE company_id = $1 AND phone = $2 AND status <> 'lost' LIMIT 1", [b.companyId, b.phone])).rows[0];
        if (dup) throw E.conflict(`يوجد عميل محتمل بنفس الهاتف: ${dup.name}`, `A lead with this phone already exists: ${dup.name}`);
      }
      const r = (await db.query(`INSERT INTO crm_leads (tenant_id, company_id, name, business_name, phone, email, city, source, campaign_id, owner_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.user!.tenantId, b.companyId, b.name, b.businessName ?? null, b.phone ?? null, b.email ?? null, b.city ?? null, b.source, b.campaignId ?? null,
          b.ownerId ?? req.user!.userId, b.notes ?? null, req.user!.userId])).rows[0];
      await ev(db, req.user!, "crm.lead_created", "crm_lead", r.id, { name: r.name });
      return r;
    }));
  });
  app.post("/crm/leads/:id/status", { schema: { ...C, summary: "Move a lead (contacted, qualified, lost with reason)" }, preHandler: can("crm.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ status: z.enum(["new", "contacted", "qualified", "lost"]), lostReason: z.string().min(3).max(500).optional() }), req.body);
    if (b.status === "lost" && !b.lostReason) throw E.validation([{ path: "lostReason", message: "required when lost" }]);
    return tdb(req, async (db) => {
      const r = (await db.query("UPDATE crm_leads SET status = $2, lost_reason = $3 WHERE id = $1 AND status <> 'converted' RETURNING *", [id, b.status, b.status === "lost" ? b.lostReason : null])).rows[0];
      if (!r) throw E.rule("LEAD_CONVERTED", "العميل المحتمل تم تحويله لعميل بالفعل", "Lead already converted");
      return r;
    });
  });
  app.post("/crm/leads/:id/convert", { schema: { ...C, summary: "Convert a lead into a customer (creates the customer record)" }, preHandler: can("crm.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ customerCode: z.string().regex(/^[A-Z0-9_.-]{1,30}$/), creditLimit: zMoney.optional(), paymentTermsDays: z.number().int().min(0).max(365).default(0) }), req.body);
    if (!req.user!.permissions.has("sales.customers.manage")) throw E.forbidden("sales.customers.manage");
    return reply.code(201).send(await tdb(req, async (db) => {
      const l = (await db.query("SELECT * FROM crm_leads WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!l) throw E.notFound("crm_leads");
      if (l.status === "converted") throw E.rule("LEAD_CONVERTED", "العميل المحتمل تم تحويله لعميل بالفعل", "Lead already converted");
      const p = (await db.query(`INSERT INTO parties (tenant_id, company_id, kind, code, name_ar, phone, city, credit_limit, payment_terms_days) VALUES ($1,$2,'customer',$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user!.tenantId, l.company_id, b.customerCode, l.business_name ?? l.name, l.phone, l.city, b.creditLimit ?? null, b.paymentTermsDays])).rows[0];
      await db.query("UPDATE crm_leads SET status = 'converted', customer_id = $2 WHERE id = $1", [id, p.id]);
      await db.query("UPDATE crm_opportunities SET customer_id = $2 WHERE lead_id = $1 AND customer_id IS NULL", [id, p.id]);
      await ev(db, req.user!, "crm.lead_converted", "crm_lead", id, { customer: p.code });
      return { lead: id, customer: p };
    }));
  });

  // ---------------------------------------------------------------- opportunities
  app.get("/crm/opportunities", { schema: { ...C, summary: "Opportunities" }, preHandler: can("crm.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, stage: z.enum(["prospecting", "proposal", "negotiation", "won", "lost"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT o.*, coalesce(p.name_ar, l.business_name, l.name) AS party_name, u.full_name AS owner_name FROM crm_opportunities o LEFT JOIN parties p ON p.id = o.customer_id
         LEFT JOIN crm_leads l ON l.id = o.lead_id LEFT JOIN users u ON u.id = o.owner_id WHERE o.company_id = $1 AND ($2::opp_stage IS NULL OR o.stage = $2)
        ORDER BY o.stage, o.expected_close NULLS LAST LIMIT 500`, [q.companyId, q.stage ?? null])).rows);
  });
  app.post("/crm/opportunities", { schema: { ...C, summary: "Create opportunity (for a lead or a customer)" }, preHandler: can("crm.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, title: z.string().min(2), leadId: zUuid.optional(), customerId: zUuid.optional(), expectedValue: zMoney.default("0"),
      expectedClose: zDate.optional(), ownerId: zUuid.optional() }).refine((x) => x.leadId || x.customerId, "leadId or customerId"), req.body);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query(
      `INSERT INTO crm_opportunities (tenant_id, company_id, title, lead_id, customer_id, expected_value, expected_close, owner_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user!.tenantId, b.companyId, b.title, b.leadId ?? null, b.customerId ?? null, b.expectedValue, b.expectedClose ?? null, b.ownerId ?? req.user!.userId, req.user!.userId])).rows[0]));
  });
  app.post("/crm/opportunities/:id/stage", { schema: { ...C, summary: "Move through the pipeline (probability follows the stage unless given)" }, preHandler: can("crm.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ stage: z.enum(["prospecting", "proposal", "negotiation", "won", "lost"]), probability: z.number().int().min(0).max(100).optional(),
      expectedValue: zMoney.optional(), lostReason: z.string().min(3).max(500).optional() }), req.body);
    if (b.stage === "lost" && !b.lostReason) throw E.validation([{ path: "lostReason", message: "required when lost" }]);
    return tdb(req, async (db) => {
      const closed = ["won", "lost"].includes(b.stage);
      const r = (await db.query(
        `UPDATE crm_opportunities SET stage = $2, probability = $3, expected_value = coalesce($4, expected_value), lost_reason = $5, closed_at = CASE WHEN $6 THEN now() END
          WHERE id = $1 AND stage NOT IN ('won', 'lost') RETURNING *`,
        [id, b.stage, closed ? PROBABILITY[b.stage] : b.probability ?? PROBABILITY[b.stage], b.expectedValue ?? null, b.lostReason ?? null, closed])).rows[0];
      if (!r) throw E.rule("OPPORTUNITY_CLOSED", "الفرصة مغلقة (ربح/خسارة)", "Opportunity is closed");
      await ev(db, req.user!, `crm.opportunity_${b.stage}`, "crm_opportunity", id, b);
      return r;
    });
  });
  app.get("/crm/pipeline", { schema: { ...C, summary: "Pipeline per stage: count, value, weighted value; win rate" }, preHandler: can("crm.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => {
      const stages = (await db.query(
        `SELECT stage, count(*)::int AS n, coalesce(sum(expected_value), 0)::numeric(20,4)::text AS value, coalesce(sum(expected_value * probability / 100), 0)::numeric(20,4)::text AS weighted
           FROM crm_opportunities WHERE company_id = $1 GROUP BY stage ORDER BY array_position(ARRAY['prospecting','proposal','negotiation','won','lost']::opp_stage[], stage)`, [q.companyId])).rows;
      const won = stages.find((s: any) => s.stage === "won")?.n ?? 0, lost = stages.find((s: any) => s.stage === "lost")?.n ?? 0;
      return { stages, winRate: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null };
    });
  });

  // ---------------------------------------------------------------- activities
  app.get("/crm/activities", { schema: { ...C, summary: "Activities (my open tasks first)" }, preHandler: can("crm.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, open: z.enum(["true", "false"]).optional(), leadId: zUuid.optional(), customerId: zUuid.optional(), opportunityId: zUuid.optional(), mine: z.enum(["true", "false"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT a.*, u.full_name AS owner_name, (a.done_at IS NULL AND a.due_at < now()) AS overdue FROM crm_activities a JOIN users u ON u.id = a.owner_id
        WHERE a.company_id = $1 AND ($2::boolean IS NULL OR (a.done_at IS NULL) = $2) AND ($3::uuid IS NULL OR a.lead_id = $3) AND ($4::uuid IS NULL OR a.customer_id = $4)
          AND ($5::uuid IS NULL OR a.opportunity_id = $5) AND ($6::uuid IS NULL OR a.owner_id = $6)
        ORDER BY (a.done_at IS NULL) DESC, a.due_at NULLS LAST, a.created_at DESC LIMIT 500`,
      [q.companyId, q.open === undefined ? null : q.open === "true", q.leadId ?? null, q.customerId ?? null, q.opportunityId ?? null, q.mine === "true" ? req.user!.userId : null])).rows);
  });
  app.post("/crm/activities", { schema: { ...C, summary: "Log a call/meeting/visit/note or schedule a task" }, preHandler: can("crm.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, kind: z.enum(["call", "meeting", "visit", "task", "email", "note"]), subject: z.string().min(2), details: z.string().max(4000).optional(),
      dueAt: z.string().datetime({ offset: true }).optional(), done: z.boolean().default(false), leadId: zUuid.optional(), opportunityId: zUuid.optional(), customerId: zUuid.optional(),
      ticketId: zUuid.optional(), ownerId: zUuid.optional() }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query(
      `INSERT INTO crm_activities (tenant_id, company_id, kind, subject, details, due_at, done_at, lead_id, opportunity_id, customer_id, ticket_id, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() END,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.user!.tenantId, b.companyId, b.kind, b.subject, b.details ?? null, b.dueAt ?? null, b.done, b.leadId ?? null, b.opportunityId ?? null, b.customerId ?? null, b.ticketId ?? null,
        b.ownerId ?? req.user!.userId, req.user!.userId])).rows[0]));
  });
  app.post("/crm/activities/:id/done", { schema: { ...C, summary: "Mark an activity done" }, preHandler: can("crm.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => {
      const r = (await db.query("UPDATE crm_activities SET done_at = coalesce(done_at, now()) WHERE id = $1 RETURNING *", [id])).rows[0];
      if (!r) throw E.notFound("crm_activities");
      return r;
    });
  });

  // ---------------------------------------------------------------- tickets (customer service)
  app.get("/crm/tickets", { schema: { ...C, summary: "Tickets with SLA status" }, preHandler: can("crm.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(), customerId: zUuid.optional() }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT t.*, p.code AS customer_code, p.name_ar AS customer_name, u.full_name AS assignee_name, l.lot_no, n.number AS ncr_number,
              (t.status IN ('open', 'in_progress') AND t.due_at < now()) AS breached
         FROM crm_tickets t JOIN parties p ON p.id = t.customer_id LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN lots l ON l.id = t.lot_id LEFT JOIN nonconformances n ON n.id = t.ncr_id
        WHERE t.company_id = $1 AND ($2::ticket_status IS NULL OR t.status = $2) AND ($3::uuid IS NULL OR t.customer_id = $3)
        ORDER BY (t.status IN ('open', 'in_progress')) DESC, t.due_at LIMIT 500`, [q.companyId, q.status ?? null, q.customerId ?? null])).rows);
  });
  app.post("/crm/tickets", { schema: { ...C, summary: "Open a ticket (a product complaint about a lot can open a quality non-conformance)" }, preHandler: can("crm.tickets.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, customerId: zUuid, kind: z.enum(["complaint", "inquiry", "service", "suggestion"]), priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
      subject: z.string().min(3), description: z.string().max(4000).optional(), lotId: zUuid.optional(), assignedTo: zUuid.optional(), openNcr: z.boolean().default(false) }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => {
      const u = req.user!;
      const number = await docNumber(db, u, b.companyId, "TK", new Date().toISOString().slice(0, 10));
      let ncrId: string | null = null;
      if (b.openNcr) {
        if (!b.lotId) throw E.validation([{ path: "lotId", message: "a lot is required to open a non-conformance" }]);
        if (!u.modules.has("quality")) throw E.moduleNotInPlan("quality");
        // quality decides on holding the lot; the complaint only opens the case with its evidence
        ncrId = (await db.query(`INSERT INTO nonconformances (tenant_id, company_id, number, lot_id, description, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [u.tenantId, b.companyId, await docNumber(db, u, b.companyId, "NCR", new Date().toISOString().slice(0, 10)), b.lotId, `شكوى عميل ${number}: ${b.subject}`, u.userId])).rows[0].id;
      }
      const t = (await db.query(
        `INSERT INTO crm_tickets (tenant_id, company_id, number, customer_id, kind, priority, subject, description, lot_id, ncr_id, assigned_to, due_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + make_interval(hours => $12), $13) RETURNING *`,
        [u.tenantId, b.companyId, number, b.customerId, b.kind, b.priority, b.subject, b.description ?? null, b.lotId ?? null, ncrId, b.assignedTo ?? null, SLA_HOURS[b.priority], u.userId])).rows[0];
      await ev(db, u, "crm.ticket_opened", "crm_ticket", t.id, { number, kind: b.kind, ncr: !!ncrId });
      return t;
    }));
  });
  app.post("/crm/tickets/:id/status", { schema: { ...C, summary: "Work on / resolve / close a ticket" }, preHandler: can("crm.tickets.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ status: z.enum(["in_progress", "resolved", "closed"]), resolution: z.string().min(3).max(4000).optional(), assignedTo: zUuid.optional() }), req.body);
    return tdb(req, async (db) => {
      const t = (await db.query("SELECT * FROM crm_tickets WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!t) throw E.notFound("crm_tickets");
      if (t.status === "closed") throw E.rule("TICKET_CLOSED", "التذكرة مغلقة", "Ticket is closed");
      const resolution = b.resolution ?? t.resolution;
      if (["resolved", "closed"].includes(b.status) && !resolution) throw E.validation([{ path: "resolution", message: "required to resolve" }]);
      const r = (await db.query(
        `UPDATE crm_tickets SET status = $2::ticket_status, resolution = $3, resolved_at = CASE WHEN $2::ticket_status IN ('resolved', 'closed') THEN coalesce(resolved_at, now()) END, assigned_to = coalesce($4, assigned_to)
          WHERE id = $1 RETURNING *`, [id, b.status, resolution, b.assignedTo ?? null])).rows[0];
      await ev(db, req.user!, `crm.ticket_${b.status}`, "crm_ticket", id, { resolution });
      return r;
    });
  });
  app.post("/crm/tickets/:id/feedback", { schema: { ...C, summary: "Customer satisfaction (1–5) after resolution" }, preHandler: can("crm.tickets.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }), req.body);
    return tdb(req, async (db) => {
      const r = (await db.query("UPDATE crm_tickets SET csat_score = $2, csat_comment = $3 WHERE id = $1 AND status IN ('resolved', 'closed') RETURNING *", [id, b.score, b.comment ?? null])).rows[0];
      if (!r) throw E.rule("TICKET_NOT_RESOLVED", "التقييم بعد حل التذكرة فقط", "Feedback only after resolution");
      return r;
    });
  });
  app.get("/crm/service-stats", { schema: { ...C, summary: "Customer service: open, SLA breaches, average resolution hours, satisfaction" }, preHandler: can("crm.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, from: zDate, to: zDate }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT count(*)::int AS tickets, count(*) FILTER (WHERE kind = 'complaint')::int AS complaints,
              count(*) FILTER (WHERE status IN ('open', 'in_progress'))::int AS open,
              count(*) FILTER (WHERE coalesce(resolved_at, now()) > due_at)::int AS sla_breached,
              round(avg(extract(epoch FROM resolved_at - created_at) / 3600) FILTER (WHERE resolved_at IS NOT NULL), 1)::text AS avg_resolution_hours,
              round(avg(csat_score), 2)::text AS csat_avg, count(csat_score)::int AS csat_responses
         FROM crm_tickets WHERE company_id = $1 AND created_at::date BETWEEN $2 AND $3`, [q.companyId, q.from, q.to])).rows[0]);
  });
}
