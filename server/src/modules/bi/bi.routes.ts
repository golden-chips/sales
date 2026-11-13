import type { FastifyInstance } from "fastify";
import { z } from "zod";
import ExcelJS from "exceljs";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zDate } from "../../core/http.js";
import { AppError } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import * as bi from "./bi.service.js";

const B = { tags: ["BI & Reporting"] };
const zArea = z.enum(bi.AREAS);
const today = () => new Date().toISOString().slice(0, 10);
const zQuery = z.object({ companyId: zUuid, from: zDate.optional(), to: zDate.optional(), compare: z.enum(["previous_period", "previous_year"]).default("previous_period"),
  branchId: zUuid.optional(), warehouseId: zUuid.optional(), lang: z.enum(["ar", "en"]).default("ar"), format: z.enum(["xlsx", "csv"]).default("xlsx") });

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const changePct = (v: unknown, p: unknown) => (p === undefined || p === null || v === null || Number(p) === 0 ? null : Math.round(((Number(v) - Number(p)) / Math.abs(Number(p))) * 10000) / 100);

export async function biRoutes(app: FastifyInstance) {
  app.get("/bi/dashboards", { schema: { ...B, summary: "Dashboards available to me (by plan and permission)" }, preHandler: can("bi.dashboards.view") }, async (req) => {
    const u = req.user!;
    return bi.AREAS.filter((a) => u.modules.has(bi.AREA_ACCESS[a].module) && u.permissions.has(bi.AREA_ACCESS[a].permission));
  });

  app.get("/bi/dashboards/:area", { schema: { ...B, summary: "Live KPIs, comparison, series and tables; filters: period, branch, warehouse" }, preHandler: can("bi.dashboards.view") }, async (req) => {
    const { area } = parse(z.object({ area: zArea }), req.params);
    const q = parse(zQuery, req.query);
    return tdb(req, async (db) => bi.dashboard(db, req.user!, area, await bi.makeCtx(db, { ...q, from: q.from ?? `${today().slice(0, 7)}-01`, to: q.to ?? today() })));
  });

  app.get("/bi/dashboards/:area/export", { schema: { ...B, summary: "Export a dashboard (KPIs with comparison, series, tables) to Excel or CSV" }, preHandler: can("bi.dashboards.view") }, async (req, reply) => {
    const { area } = parse(z.object({ area: zArea }), req.params);
    const q = parse(zQuery, req.query);
    const d = await tdb(req, async (db) => {
      const r = await bi.dashboard(db, req.user!, area, await bi.makeCtx(db, { ...q, from: q.from ?? `${today().slice(0, 7)}-01`, to: q.to ?? today() }));
      await audit(db, { tenantId: req.user!.tenantId, actorType: "user", actorId: req.user!.userId, action: "bi.exported", entityType: "dashboard", entityId: null, after: { area, format: q.format, from: r.filters.from, to: r.filters.to } });
      return r;
    });
    const L = (x: { ar: string; en: string }) => (q.lang === "ar" ? x.ar : x.en);
    const kpiHead = q.lang === "ar" ? ["المؤشر", "القيمة", "الفترة السابقة", "التغير %"] : ["Indicator", "Value", "Previous", "Change %"];
    const name = `golden-erp-${area}-${d.filters.from}_${d.filters.to}`;
    if (q.format === "csv") {
      const lines: string[] = [`${area},${d.filters.from},${d.filters.to}`, "", kpiHead.join(",")];
      for (const k of d.kpis) lines.push([L(k), k.value, k.previous ?? "", changePct(k.value, k.previous) ?? ""].map(csvCell).join(","));
      for (const t of d.tables) { lines.push("", csvCell(L(t)), t.columns.map((c) => csvCell(L(c))).join(",")); for (const r of t.rows) lines.push(t.columns.map((c) => csvCell(r[c.key])).join(",")); }
      for (const s of d.series) { lines.push("", csvCell(L(s))); for (const p of s.points) lines.push(`${p.period},${p.value}`); }
      // BOM so Excel opens Arabic text correctly
      return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}.csv"`).send("﻿" + lines.join("\r\n"));
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = "GOLDEN ERP";
    const rtl = q.lang === "ar";
    const ws = wb.addWorksheet(q.lang === "ar" ? "المؤشرات" : "KPIs", { views: [{ rightToLeft: rtl }] });
    ws.addRow([`${area} · ${d.filters.from} → ${d.filters.to} (${q.compare})`]).font = { bold: true };
    ws.addRow(kpiHead).font = { bold: true };
    for (const k of d.kpis) ws.addRow([L(k), k.value === null ? null : Number(k.value), k.previous === undefined || k.previous === null ? null : Number(k.previous), changePct(k.value, k.previous)]);
    ws.columns.forEach((c, i) => { c.width = i === 0 ? 34 : 18; });
    for (const t of d.tables) {
      const s = wb.addWorksheet(L(t).slice(0, 31).replace(/[\\/?*[\]:]/g, " "), { views: [{ rightToLeft: rtl }] });
      s.addRow(t.columns.map((c) => L(c))).font = { bold: true };
      for (const r of t.rows) s.addRow(t.columns.map((c) => (c.format && c.format !== "days" && r[c.key] !== null && r[c.key] !== undefined && r[c.key] !== "" ? Number(r[c.key]) : r[c.key] ?? null)));
      s.columns.forEach((c) => { c.width = 20; });
    }
    for (const sr of d.series) {
      const s = wb.addWorksheet(L(sr).slice(0, 31).replace(/[\\/?*[\]:]/g, " "), { views: [{ rightToLeft: rtl }] });
      s.addRow([q.lang === "ar" ? "الشهر" : "Month", L(sr)]).font = { bold: true };
      for (const p of sr.points) s.addRow([p.period, Number(p.value)]);
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("content-disposition", `attachment; filename="${name}.xlsx"`).send(buf);
  });

  // ---------------------------------------------------------------- alerts
  app.get("/bi/alert-rules", { schema: { ...B, summary: "Threshold alert rules" }, preHandler: can("bi.dashboards.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT * FROM bi_alert_rules WHERE company_id = $1 ORDER BY area, name_ar", [q.companyId])).rows);
  });
  app.post("/bi/alert-rules", { schema: { ...B, summary: "Create an alert: KPI of a dashboard above / below a threshold" }, preHandler: can("bi.alerts.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, nameAr: z.string().min(2), area: zArea, metric: z.string().regex(/^[a-z_]{2,60}$/), operator: z.enum(["gt", "lt"]),
      threshold: z.union([z.string(), z.number()]).transform(String).refine((x) => /^-?\d{1,15}(\.\d{1,4})?$/.test(x), "number"), recipient: z.string().max(200).optional() }), req.body);
    bi.assertArea(req.user!, b.area);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query(
      `INSERT INTO bi_alert_rules (tenant_id, company_id, name_ar, area, metric, operator, threshold, recipient, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user!.tenantId, b.companyId, b.nameAr, b.area, b.metric, b.operator, b.threshold, b.recipient ?? null, req.user!.userId])).rows[0]));
  });
  app.delete("/bi/alert-rules/:id", { schema: { ...B, summary: "Delete an alert rule" }, preHandler: can("bi.alerts.manage") }, async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return tdb(req, async (db) => ({ deleted: (await db.query("DELETE FROM bi_alert_rules WHERE id = $1", [id])).rowCount === 1 }));
  });
  app.get("/bi/alerts", { schema: { ...B, summary: "Evaluate alert rules on month-to-date figures" }, preHandler: can("bi.dashboards.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, asOf: zDate.optional() }), req.query);
    return tdb(req, (db) => bi.evaluateAlerts(db, req.user!, q.companyId, q.asOf ?? today()));
  });
  app.post("/bi/alerts/notify", { schema: { ...B, summary: "Queue notifications for triggered alerts that have a recipient (once per day per rule)" }, preHandler: can("bi.alerts.manage") }, async (req) => {
    const b = parse(z.object({ companyId: zUuid, asOf: zDate.optional() }), req.body);
    return tdb(req, async (db) => {
      const res = await bi.evaluateAlerts(db, req.user!, b.companyId, b.asOf ?? today());
      let queued = 0;
      for (const a of res.filter((x) => x.triggered && x.recipient)) {
        const upd = await db.query("UPDATE bi_alert_rules SET last_triggered_at = now() WHERE id = $1 AND (last_triggered_at IS NULL OR last_triggered_at::date < current_date) RETURNING id", [a.id]);
        if (!upd.rowCount) continue;
        await db.query(`INSERT INTO notification_outbox (tenant_id, channel, recipient, template, payload, source_type, source_id) VALUES ($1,$2,$3,'bi_alert',$4,'bi_alert_rule',$5)`,
          [req.user!.tenantId, a.recipient!.includes("@") ? "email" : "whatsapp", a.recipient, JSON.stringify(a), a.id]);
        queued++;
      }
      return { evaluated: res.length, triggered: res.filter((x) => x.triggered).length, queued };
    });
  });

  // ---------------------------------------------------------------- scheduled reports (queued to the outbox; delivery needs an e-mail provider)
  app.get("/bi/schedules", { schema: { ...B, summary: "Report schedules" }, preHandler: can("bi.dashboards.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid }), req.query);
    return tdb(req, async (db) => (await db.query("SELECT * FROM bi_report_schedules WHERE company_id = $1 ORDER BY next_run_on", [q.companyId])).rows);
  });
  app.post("/bi/schedules", { schema: { ...B, summary: "Schedule a dashboard by e-mail (daily / weekly / monthly)" }, preHandler: can("bi.alerts.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, area: zArea, frequency: z.enum(["daily", "weekly", "monthly"]), recipient: z.string().email(), firstRunOn: zDate.optional() }), req.body);
    bi.assertArea(req.user!, b.area);
    return reply.code(201).send(await tdb(req, async (db) => (await db.query(
      `INSERT INTO bi_report_schedules (tenant_id, company_id, area, frequency, recipient, next_run_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user!.tenantId, b.companyId, b.area, b.frequency, b.recipient, b.firstRunOn ?? today(), req.user!.userId])).rows[0]));
  });
  app.post("/bi/schedules/run-due", { schema: { ...B, summary: "Build the snapshots of due schedules and queue them (idempotent per day)" }, preHandler: can("bi.alerts.manage") }, async (req) => {
    const b = parse(z.object({ companyId: zUuid, asOf: zDate.optional() }), req.body);
    const asOf = b.asOf ?? today();
    return tdb(req, async (db) => {
      const due = (await db.query("SELECT * FROM bi_report_schedules WHERE company_id = $1 AND is_active AND next_run_on <= $2 FOR UPDATE", [b.companyId, asOf])).rows;
      const out = [];
      for (const s of due) {
        const span = s.frequency === "daily" ? "1 day" : s.frequency === "weekly" ? "7 days" : "1 month";
        const r = (await db.query(`SELECT ($1::date - $2::interval + interval '1 day')::date::text AS f, ($1::date + $2::interval)::date::text AS next`, [asOf, span])).rows[0];
        let snapshot: unknown;
        try { snapshot = await bi.dashboard(db, req.user!, s.area, await bi.makeCtx(db, { companyId: b.companyId, from: r.f, to: asOf })); }
        catch (e) { if (e instanceof AppError && [402, 403].includes(e.statusCode)) { out.push({ id: s.id, skipped: e.code }); continue; } throw e; }
        await db.query(`INSERT INTO notification_outbox (tenant_id, channel, recipient, template, payload, source_type, source_id) VALUES ($1,'email',$2,'bi_report',$3,'bi_report_schedule',$4)`,
          [req.user!.tenantId, s.recipient, JSON.stringify(snapshot), s.id]);
        await db.query("UPDATE bi_report_schedules SET last_run_at = now(), next_run_on = $2 WHERE id = $1", [s.id, r.next]);
        out.push({ id: s.id, area: s.area, queued: true, nextRunOn: r.next });
      }
      return out;
    });
  });
}
