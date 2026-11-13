import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zDate, idempotent, send } from "../../core/http.js";
import * as g from "./golive.service.js";
import { SCENARIOS } from "./uat.js";

const G = { tags: ["Go-live & UAT"] };
const today = () => new Date().toISOString().slice(0, 10);
const zItem = z.enum(["chart_of_accounts", "opening_balances", "uat", "go_live"]);

export async function goLiveRoutes(app: FastifyInstance) {
  app.get("/go-live/readiness", { schema: { ...G, summary: "Go-live readiness computed from the company's data, with links" }, preHandler: can("core.golive.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, (db) => g.readiness(db, req.user!, q.companyId));
  });
  app.get("/go-live/reconciliation", { schema: { ...G, summary: "Subledgers (customers, suppliers, stock, WIP, POS drawers) vs GL control accounts" }, preHandler: can("core.golive.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, asOf: zDate.optional() }), req.query);
    return tdb(req, (db) => g.reconciliation(db, q.companyId, q.asOf ?? today()));
  });
  app.get("/go-live/opening-documents", { schema: { ...G, summary: "Imported opening receivables/payables awaiting posting" }, preHandler: can("core.golive.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => ({
      receivables: (await db.query(`SELECT s.id, p.code, p.name_ar, s.invoice_date, s.due_date, s.total, s.opening_reference, s.status FROM sales_invoices s JOIN parties p ON p.id = s.customer_id
          WHERE s.company_id = $1 AND s.is_opening ORDER BY s.status, p.code`, [q.companyId])).rows,
      payables: (await db.query(`SELECT s.id, p.code, p.name_ar, s.invoice_date, s.due_date, s.total, s.supplier_invoice_no AS reference, s.status FROM supplier_invoices s JOIN parties p ON p.id = s.supplier_id
          WHERE s.company_id = $1 AND s.is_opening ORDER BY s.status, p.code`, [q.companyId])).rows,
    }));
  });
  app.post("/go-live/opening-documents/post", { schema: { ...G, summary: "Post all imported opening balances (importer ≠ poster)" }, preHandler: can("accounting.journal.post") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, cutoverDate: zDate.optional() }), req.body);
    return send(reply, await tdb(req, (db) => idempotent(req, db, req.user!.tenantId, async () => ({ status: 200, body: await g.postOpeningDocuments(db, req.user!, b.companyId, b.cutoverDate ?? today()) }))));
  });
  app.post("/go-live/signoffs", { schema: { ...G, summary: "Sign off a stage (chart of accounts, opening balances, UAT, go-live) — each needs its own permission" }, preHandler: can("core.golive.view") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, item: zItem, note: z.string().max(1000).optional() }), req.body);
    return reply.code(201).send(await tdb(req, (db) => g.signOff(db, req.user!, b.companyId, b.item, b.note)));
  });
  app.post("/go-live/signoffs/revoke", { schema: { ...G, summary: "Revoke a sign-off (with reason)" }, preHandler: can("core.golive.view") }, async (req) => {
    const b = parse(z.object({ companyId: zUuid, item: zItem, reason: z.string().min(3).max(500) }), req.body);
    return tdb(req, (db) => g.revokeSignOff(db, req.user!, b.companyId, b.item, b.reason));
  });

  // ---------------------------------------------------------------- UAT
  app.get("/uat/scenarios", { schema: { ...G, summary: "Acceptance scenarios with the latest result of each" }, preHandler: can("core.uat.record") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    const u = req.user!;
    return tdb(req, async (db) => {
      const latest = new Map((await db.query(
        `SELECT DISTINCT ON (scenario_key) r.scenario_key, r.status, r.notes, r.tested_at, u.full_name AS tester FROM uat_results r JOIN users u ON u.id = r.tester_id
          WHERE r.company_id = $1 ORDER BY scenario_key, tested_at DESC, r.id DESC`, [q.companyId])).rows.map((r: any) => [r.scenario_key, r]));
      const list = SCENARIOS.filter((s) => !s.module || u.modules.has(s.module)).map((s) => ({ ...s, latest: latest.get(s.key) ?? null }));
      const count = (st: string) => list.filter((s) => s.latest?.status === st).length;
      return { summary: { total: list.length, pass: count("pass"), fail: count("fail"), blocked: count("blocked"), notRun: list.filter((s) => !s.latest).length }, scenarios: list };
    });
  });
  app.post("/uat/results", { schema: { ...G, summary: "Record a test result (a failure must describe the problem)" }, preHandler: can("core.uat.record") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, scenarioKey: z.enum(SCENARIOS.map((s) => s.key) as [string, ...string[]]), status: z.enum(["pass", "fail", "blocked"]),
      notes: z.string().max(2000).optional() }).refine((x) => x.status === "pass" || (x.notes && x.notes.length >= 3), "notes required for fail/blocked"), req.body);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query(
      "INSERT INTO uat_results (tenant_id, company_id, scenario_key, status, notes, tester_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [req.user!.tenantId, b.companyId, b.scenarioKey, b.status, b.notes ?? null, req.user!.userId])).rows[0]));
  });
  app.get("/uat/results/:key", { schema: { ...G, summary: "History of one scenario" }, preHandler: can("core.uat.record") }, async (req) => {
    const { key } = parse(z.object({ key: z.string().max(60) }), req.params);
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT r.*, u.full_name AS tester FROM uat_results r JOIN users u ON u.id = r.tester_id WHERE r.company_id = $1 AND r.scenario_key = $2 ORDER BY r.tested_at DESC`,
      [q.companyId, key])).rows);
  });
}
