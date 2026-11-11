import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zDate } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { TEMPLATES, buildTemplate, parseWorkbook, runImport, type Kind } from "./import.service.js";

const T = { tags: ["Import"] };
const KINDS = Object.keys(TEMPLATES) as [Kind, ...Kind[]];

export async function importRoutes(app: FastifyInstance) {
  app.get("/import/kinds", { schema: { ...T, summary: "Importable data kinds and their columns" }, preHandler: can(null) }, async (req) =>
    KINDS.map((k) => ({ kind: k, titleAr: TEMPLATES[k].titleAr, permission: TEMPLATES[k].permission, allowed: req.user!.permissions.has(TEMPLATES[k].permission),
      columns: TEMPLATES[k].cols.map((c) => ({ key: c.key, ar: c.ar, en: c.en, required: !!c.required })) })));

  app.get("/import/templates/:kind", { schema: { ...T, summary: "Download the Excel template (.xlsx)" }, preHandler: can(null) }, async (req, reply) => {
    const { kind } = parse(z.object({ kind: z.enum(KINDS) }), req.params);
    const buf = await buildTemplate(kind);
    return reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="golden-erp-${kind}.xlsx"`).send(buf);
  });

  app.post("/import/:kind", {
    schema: { ...T, summary: "Preview (commit=false) or import (commit=true) an Excel file — all rows or none" },
    bodyLimit: 8 * 1024 * 1024, preHandler: can(null),
  }, async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(KINDS) }), req.params);
    const b = parse(z.object({ companyId: zUuid, fileBase64: z.string().min(10), commit: z.boolean().default(false), date: zDate.optional() }), req.body);
    const t = TEMPLATES[kind];
    const u = req.user!;
    const mod = t.permission.split(".")[0];
    if (!u.modules.has(mod)) throw E.moduleNotInPlan(mod);
    if (!u.permissions.has(t.permission)) throw E.forbidden(t.permission);
    const rows = await parseWorkbook(kind, b.fileBase64);
    return tdb(req, (db) => runImport(db, u, kind, b.companyId, rows, b.commit, { date: b.date }));
  });
}
