import type { Db } from "../db/pool.js";

export interface AuditInput {
  tenantId: string | null;
  actorType: "user" | "platform" | "system";
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  requestId?: string | null;
}

const SENSITIVE = new Set(["password_hash", "mfa_secret", "token_hash", "password"]);
function scrub(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(scrub);
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = SENSITIVE.has(k) ? "[redacted]" : scrub(x);
    return o;
  }
  return v;
}

/** Written in the SAME transaction as the change — if the change rolls back, so does its audit row. */
export async function audit(db: Db, a: AuditInput) {
  await db.query(
    `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, before_data, after_data, ip, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [a.tenantId, a.actorType, a.actorId, a.action, a.entityType, a.entityId ?? null,
     a.before === undefined ? null : JSON.stringify(scrub(a.before)), a.after === undefined ? null : JSON.stringify(scrub(a.after)),
     a.ip ?? null, a.requestId ?? null],
  );
}
