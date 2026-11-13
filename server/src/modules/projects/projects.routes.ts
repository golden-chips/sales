// Projects & tasks (Phase 6d). Each project owns a cost centre: every journal
// line tagged with it (supplier invoices, expenses, payroll allocations…) is an
// actual cost of the project, so budget vs actual always agrees with the GL.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zMoney, zDate } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import type { Db } from "../../db/pool.js";

const P = { tags: ["Projects"] };
const id$ = z.object({ id: zUuid });

/** progress = tasks' progress weighted by estimated hours; actual cost = net debits on the project's cost centre (expense accounts) */
async function summary(db: Db, projectId: string) {
  const p = (await db.query(
    `SELECT p.*, cc.code AS cost_center_code, u.full_name AS manager_name, c.name_ar AS customer_name FROM projects p JOIN cost_centers cc ON cc.id = p.cost_center_id
       JOIN users u ON u.id = p.manager_id LEFT JOIN parties c ON c.id = p.customer_id WHERE p.id = $1`, [projectId])).rows[0];
  if (!p) throw E.notFound("projects");
  const t = (await db.query(
    `SELECT count(*)::int AS tasks, count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status <> 'done' AND due_date < current_date)::int AS overdue,
            CASE WHEN sum(estimate_hours) > 0 THEN round(sum(progress_pct * estimate_hours) / sum(estimate_hours), 1) END::text AS progress_pct
       FROM project_tasks WHERE project_id = $1`, [projectId])).rows[0];
  const cost = (await db.query(
    `SELECT coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0)::numeric(20,4)::text AS actual_cost,
            coalesce(-sum(l.debit - l.credit) FILTER (WHERE a.type = 'revenue'), 0)::numeric(20,4)::text AS revenue
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE l.cost_center_id = $1 AND e.status <> 'draft'`, [p.cost_center_id])).rows[0];
  const budgetUsed = Number(p.budget) > 0 ? Math.round((Number(cost.actual_cost) / Number(p.budget)) * 1000) / 10 : null;
  return { ...p, ...t, ...cost, budget_used_pct: budgetUsed, over_budget: Number(p.budget) > 0 && Number(cost.actual_cost) > Number(p.budget) };
}

export async function projectRoutes(app: FastifyInstance) {
  app.get("/projects", { schema: { ...P, summary: "Projects with progress and budget vs actual" }, preHandler: can("projects.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["planned", "active", "on_hold", "done", "cancelled"]).optional() }), req.query);
    return tdb(req, async (db) => {
      const ids = (await db.query("SELECT id FROM projects WHERE company_id = $1 AND ($2::project_status IS NULL OR status = $2) ORDER BY start_date DESC LIMIT 200", [q.companyId, q.status ?? null])).rows;
      const out = [];
      for (const r of ids) out.push(await summary(db, r.id));
      return out;
    });
  });
  app.post("/projects", { schema: { ...P, summary: "Create project (creates or links its cost centre)" }, preHandler: can("projects.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, code: z.string().regex(/^[A-Z0-9_-]{1,20}$/), nameAr: z.string().min(2), description: z.string().max(4000).optional(), customerId: zUuid.nullable().optional(),
      managerId: zUuid.optional(), startDate: zDate, endDate: zDate.optional(), budget: zMoney.default("0"), costCenterId: zUuid.optional() }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => {
      const u = req.user!;
      let cc = b.costCenterId;
      if (cc) { if (!(await db.query("SELECT 1 FROM cost_centers WHERE id = $1 AND company_id = $2", [cc, b.companyId])).rowCount) throw E.validation([{ path: "costCenterId", message: "not in this company" }]); }
      else cc = (await db.query("INSERT INTO cost_centers (tenant_id, company_id, code, name_ar) VALUES ($1,$2,$3,$4) RETURNING id", [u.tenantId, b.companyId, `PRJ-${b.code}`, `مشروع: ${b.nameAr}`])).rows[0].id;
      const p = (await db.query(
        `INSERT INTO projects (tenant_id, company_id, code, name_ar, description, customer_id, manager_id, start_date, end_date, budget, cost_center_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [u.tenantId, b.companyId, b.code, b.nameAr, b.description ?? null, b.customerId ?? null, b.managerId ?? u.userId, b.startDate, b.endDate ?? null, b.budget, cc, u.userId])).rows[0];
      await audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action: "project.created", entityType: "project", entityId: p.id, after: b });
      return summary(db, p.id);
    }));
  });
  app.get("/projects/:id", { schema: { ...P, summary: "Project with tasks, cost lines and budget vs actual" }, preHandler: can("projects.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => {
      const s = await summary(db, id);
      const tasks = (await db.query(`SELECT t.*, u.full_name AS assignee_name, (t.status <> 'done' AND t.due_date < current_date) AS overdue FROM project_tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.project_id = $1 ORDER BY t.due_date NULLS LAST, t.created_at`, [id])).rows;
      const costs = (await db.query(
        `SELECT e.entry_date::text AS date, e.number, a.code AS account_code, a.name_ar AS account_name, (l.debit - l.credit)::numeric(20,4)::text AS amount, coalesce(l.description, e.memo) AS description
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
          WHERE l.cost_center_id = $1 AND e.status <> 'draft' AND a.type IN ('expense', 'revenue') ORDER BY e.entry_date DESC, e.number LIMIT 300`, [s.cost_center_id])).rows;
      return { ...s, task_list: tasks, costs };
    });
  });
  app.patch("/projects/:id", { schema: { ...P, summary: "Update status, dates, budget, manager" }, preHandler: can("projects.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ status: z.enum(["planned", "active", "on_hold", "done", "cancelled"]).optional(), endDate: zDate.nullable().optional(), budget: zMoney.optional(), managerId: zUuid.optional() }), req.body);
    return tdb(req, async (db) => {
      const r = await db.query(`UPDATE projects SET status = coalesce($2, status), end_date = CASE WHEN $3 THEN $4::date ELSE end_date END, budget = coalesce($5, budget), manager_id = coalesce($6, manager_id)
          WHERE id = $1`, [id, b.status ?? null, b.endDate !== undefined, b.endDate ?? null, b.budget ?? null, b.managerId ?? null]);
      if (!r.rowCount) throw E.notFound("projects");
      await audit(db, { tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId, action: "project.updated", entityType: "project", entityId: id, after: b });
      return summary(db, id);
    });
  });
  app.post("/projects/:id/tasks", { schema: { ...P, summary: "Add task" }, preHandler: can("projects.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ title: z.string().min(2), assigneeId: zUuid.optional(), startDate: zDate.optional(), dueDate: zDate.optional(),
      estimateHours: z.number().positive().max(100000).default(1), budget: zMoney.default("0") }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query(
      `INSERT INTO project_tasks (tenant_id, project_id, title, assignee_id, start_date, due_date, estimate_hours, budget) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user!.tenantId, id, b.title, b.assigneeId ?? null, b.startDate ?? null, b.dueDate ?? null, b.estimateHours, b.budget])).rows[0]));
  });
  app.patch("/projects/tasks/:id", { schema: { ...P, summary: "Update task progress / status (the assignee may update their own task)" }, preHandler: can("projects.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ status: z.enum(["todo", "doing", "blocked", "done"]).optional(), progressPct: z.number().int().min(0).max(100).optional(), dueDate: zDate.optional(), assigneeId: zUuid.optional() }), req.body);
    return tdb(req, async (db) => {
      const t = (await db.query("SELECT * FROM project_tasks WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!t) throw E.notFound("project_tasks");
      if (!req.user!.permissions.has("projects.manage") && t.assignee_id !== req.user!.userId) throw E.forbidden("projects.manage");
      if ((b.assigneeId || b.dueDate) && !req.user!.permissions.has("projects.manage")) throw E.forbidden("projects.manage");
      const status = b.status ?? (b.progressPct === 100 ? "done" : t.status);
      const progress = status === "done" ? 100 : b.progressPct ?? t.progress_pct;
      return (await db.query("UPDATE project_tasks SET status = $2, progress_pct = $3, due_date = coalesce($4, due_date), assignee_id = coalesce($5, assignee_id) WHERE id = $1 RETURNING *",
        [id, status, progress, b.dueDate ?? null, b.assigneeId ?? null])).rows[0];
    });
  });
  app.get("/projects/my-tasks", { schema: { ...P, summary: "My open tasks across projects" }, preHandler: can("projects.view") }, async (req) => {
    return tdb(req, async (db) => (await db.query(
      `SELECT t.*, p.code AS project_code, p.name_ar AS project_name, (t.due_date < current_date) AS overdue FROM project_tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.assignee_id = $1 AND t.status <> 'done' ORDER BY t.due_date NULLS LAST`, [req.user!.userId])).rows);
  });
}
