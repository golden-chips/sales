import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zPage, pageSql, paged } from "../../core/http.js";

export async function auditRoutes(app: FastifyInstance) {
  app.get("/audit-log", { schema: { tags: ["Audit"], summary: "Tenant audit trail (filter by entity, actor, action)" }, preHandler: can("core.audit.view") }, async (req) => {
    const q = parse(zPage.extend({ entityType: z.string().optional(), entityId: z.string().optional(), actorId: z.string().uuid().optional(), action: z.string().optional() }), req.query);
    const { limit, offset } = pageSql(q);
    return tdb(req, async (db) => {
      const where = `WHERE ($1::text IS NULL OR entity_type = $1) AND ($2::text IS NULL OR entity_id = $2) AND ($3::uuid IS NULL OR actor_id = $3) AND ($4::text IS NULL OR action LIKE $4 || '%')`;
      const args = [q.entityType ?? null, q.entityId ?? null, q.actorId ?? null, q.action ?? null];
      const total = Number((await db.query(`SELECT count(*) FROM audit_log ${where}`, args)).rows[0].count);
      const rows = (await db.query(
        `SELECT a.*, u.full_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ${where.replace(/entity_type|entity_id|actor_id|action/g, (m) => "a." + m)}
          ORDER BY a.id DESC LIMIT $5 OFFSET $6`, [...args, limit, offset])).rows;
      return paged(rows, total, q);
    });
  });
}
