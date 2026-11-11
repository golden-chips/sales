import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { E } from "./errors.js";
import type { Db } from "../db/pool.js";
import { sha256 } from "./security.js";

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw E.validation(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })));
  return r.data;
}

export const zPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type Page = z.infer<typeof zPage>;
export const pageSql = (p: Page) => ({ limit: p.pageSize, offset: (p.page - 1) * p.pageSize });
export const paged = <T>(rows: T[], total: number, p: Page) => ({ data: rows, page: p.page, pageSize: p.pageSize, total });

export const zUuid = z.string().uuid();
export const zMoney = z.union([z.string(), z.number()]).transform((v) => String(v).trim())
  .refine((s) => /^\d{1,15}(\.\d{1,4})?$/.test(s), "amount must be a non-negative decimal with at most 4 fraction digits");
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

/** Whitelisted ORDER BY builder — never interpolate user input into SQL. */
export function orderBy(sort: string | undefined, allowed: Record<string, string>, def: string): string {
  if (!sort) return def;
  const desc = sort.startsWith("-");
  const col = allowed[desc ? sort.slice(1) : sort];
  return col ? `${col} ${desc ? "DESC" : "ASC"}` : def;
}

/**
 * Idempotency-Key support for unsafe operations. The stored response is
 * returned for an identical retry; a different payload with the same key is
 * rejected. Runs in the caller's transaction, guarded by an advisory lock.
 */
export async function idempotent<T>(
  req: FastifyRequest, reply: FastifyReply, db: Db, tenantId: string, fn: () => Promise<{ status: number; body: T }>,
) {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !key) {
    const r = await fn();
    return reply.code(r.status).send(r.body);
  }
  if (key.length < 8 || key.length > 200) throw E.validation([{ path: "Idempotency-Key", message: "length 8..200" }]);
  const route = `${req.method} ${req.routeOptions.url}`;
  const hash = sha256(JSON.stringify({ route, params: req.params, body: req.body ?? null }));
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${tenantId}:${key}`]);
  const prev = await db.query("SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1", [key]);
  if (prev.rows[0]) {
    if (prev.rows[0].request_hash !== hash)
      throw E.rule("IDEMPOTENCY_KEY_REUSED", "تم استخدام مفتاح التكرار لطلب مختلف", "Idempotency-Key was already used for a different request");
    reply.header("Idempotent-Replayed", "true");
    return reply.code(prev.rows[0].status_code).send(prev.rows[0].response_body);
  }
  const r = await fn();
  await db.query(
    "INSERT INTO idempotency_keys (tenant_id, key, route, request_hash, status_code, response_body) VALUES ($1,$2,$3,$4,$5,$6)",
    [tenantId, key, route, hash, r.status, JSON.stringify(r.body)],
  );
  return reply.code(r.status).send(r.body);
}
